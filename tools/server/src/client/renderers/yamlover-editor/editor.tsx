// <YamloverEditor> — the MPS-inspired projectional editor behind the UNLOCKED yamlover data view.
// Fetches its own copy of the node at unlimited depth (immune to a finite ?depth= URL setting),
// builds the mutable cell model (model.ts) ONCE, and stays authoritative while mounted: every
// keystroke mutates the model instantly and appends the mirroring surgical ops to the op queue
// (ops.ts), which flushes in the background and on lock/unmount. NodeView already pauses SSE
// refetches while unlocked, so nothing rebuilds the model under the caret.

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { fetchNode, type Edit } from "../../api";
import { parseYamlover } from "../../../../../parser/ts/src/yamlover.ts";
import { acceptsAsScalar } from "../value-editors";
import { focusEnd, focusStart } from "../caret";
import * as M from "./model";
import { enqueue, useOpSync, type OpQueue } from "./ops";
import { keyedEditParts, normalizeSpaces, quoteSource, type HoleAction } from "./keys";
import { enumeratePointerTargets } from "./pointer-hints";
import * as P from "./paste";
import { FlowCells, MetaTagCell, NodeCells, PointerCell, RootHole, ScalarCell, YedCtx, type YedActions, type YedCtxType } from "./cells";

interface FocusReq {
  key: string; // a cell key (node id, or `<id>:meta` / `<id>:self`)
  at: "start" | "end";
}
type FocusRef = { current: FocusReq | null };

/** Focus a cell with the caret at `at`. A TEXTAREA (the block-scalar cell) needs its own caret
 *  API — the contentEditable range routines clobber a textarea's focus in real browsers. */
function focusCell(el: HTMLElement, at: "start" | "end"): void {
  if (el instanceof HTMLTextAreaElement) {
    el.focus();
    const n = at === "end" ? el.value.length : 0;
    el.setSelectionRange(n, n);
    return;
  }
  (at === "end" ? focusEnd : focusStart)(el);
}

/** The decoded value of a scalar source token (drives the colour class); undefined if not scalar. */
function scalarValueOf(src: string): unknown {
  try {
    const p = parseYamlover(src, "<cell>").root;
    return p.kind === "scalar" ? p.value : undefined;
  } catch { return undefined; }
}

/** Materialize the structure a hole's typed prefix decided (keys.ts). In an UNDECIDED entry hole
 *  the action shapes the ENTRY (`- ` / `k:` / `!!<`); in a decided (value) hole the nesting
 *  actions open a fresh block container instead. Emits no ops — structure reaches the server when
 *  its first real content commits (commitSpine). Returns null when the action is REJECTED (a
 *  duplicate key — keys are unique per node). */
function applyHoleAction(root: M.MNode, entryId: string, action: HoleAction, focusReq: FocusRef): Edit[] | null {
  const spine = M.findEntry(root, entryId);
  if (!spine || !action || action.kind === "text") return [];
  const entry = spine.entry;
  const node = entry.node;
  const { container } = spine.parents[spine.parents.length - 1];
  const focus = (key: string, at: "start" | "end") => { focusReq.current = { key, at }; };
  if (action.kind === "keyed" && !entry.decided && container.entries.some((o) => o !== entry && o.decided && o.key === action.key)) {
    return null; // duplicate key in this node → error_flash, the typed text stays
  }
  const nestWith = (key: string | null): void => {
    node.kind = "container";
    node.rev++;
    const inner = M.insertHoleAt(root, node.id, 0);
    if (inner) {
      if (key !== null || entry.decided) { inner.decided = true; inner.key = key; }
      focus(inner.node.id, "start");
    }
  };
  switch (action.kind) {
    case "ordinal":
      if (container.flow) { node.rev++; focus(node.id, "start"); return []; } // flow has no `- ` markers
      if (!entry.decided) { entry.decided = true; node.rev++; focus(node.id, "start"); return []; }
      nestWith(null); // `- ` in value position opens a nested sequence
      return [];
    case "keyed":
      if (!entry.decided) {
        entry.decided = true;
        entry.key = action.key;
        node.rev++;
        if (action.viaEnter && !container.flow) {
          // `k:` + Enter — the value lives on the NEXT rows: a nested block, indented hole
          node.kind = "container";
          const child = M.insertHoleAt(root, node.id, 0);
          if (child) focus(child.node.id, "start");
        } else {
          focus(node.id, "start"); // `k: ` + space — the value cell inline on this row
        }
        return [];
      }
      nestWith(action.key); // `k: ` in value position opens a nested mapping
      return [];
    case "quote":
      // in an UNDECIDED entry hole the entry stays undecided — the closed quote may yet become a
      // KEY (`"value": `) or the node's bare scalar line; flow cells are plain values
      if (container.flow) entry.decided = true;
      node.kind = "scalar";
      node.scalar = { src: quoteSource(action.rest, action.quote), value: action.rest, quote: action.quote };
      node.dirty = true;
      node.rev++;
      focus(node.id, "end");
      return [];
    case "flowMap":
    case "flowSeq": {
      entry.decided = true;
      node.kind = "container";
      node.flow = action.kind === "flowSeq" ? "seq" : "map";
      node.rev++;
      const inner = M.insertHoleAt(root, node.id, 0);
      if (inner) focus(inner.node.id, "start");
      return [];
    }
    case "pointer":
      entry.decided = true;
      node.kind = "pointer";
      node.pointer = { raw: action.rest, refPath: null };
      node.dirty = true;
      node.rev++;
      focus(node.id, "end");
      return [];
    case "metaTag":
      entry.decided = true;
      node.metaTag = "";
      node.rev++;
      focus(node.id + ":meta", "start");
      return [];
    case "block":
      // like `quote`: a bare `|`/`>` block in an entry hole is the node's scalar LINE on commit;
      // the typed header (`|`, `|-`, `>-`, …) IS the authored header — commits keep it
      if (container.flow) entry.decided = true;
      node.kind = "scalar";
      node.scalar = { src: action.header, value: "", block: true };
      node.dirty = true;
      node.rev++;
      focus(node.id, "start");
      return [];
  }
}

export function YamloverEditor({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const [root, setRoot] = useState<M.MNode | null>(null);
  const rootRef = useRef<M.MNode | null>(null);
  const queue = useRef<OpQueue>({ pending: [] });
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const cellMap = useRef(new Map<string, HTMLElement>());
  const focusReq = useRef<FocusReq | null>(null);
  const rootEl = useRef<HTMLDivElement | null>(null);

  // the editor's own unlimited-depth fetch — the model needs the WHOLE subtree
  useEffect(() => {
    let live = true;
    fetchNode(path, null)
      .then((n) => {
        if (!live) return;
        const m = M.buildModel(n);
        rootRef.current = m;
        setRoot(m);
        // a fresh node (an empty document, or the legacy lone scalar) opens ready to type
        if (m.kind === "scalar") focusReq.current = { key: m.id, at: "end" };
        else if (m.kind === "container" && m.entries.length === 0 && !m.selfValue) focusReq.current = { key: m.id, at: "start" };
      })
      .catch(() => { /* the locked view surfaces fetch errors; stay on the spinner */ });
    return () => { live = false; };
  }, [path]);

  const flush = useOpSync(queue, version);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => void flushRef.current(), []); // lock / navigation → best-effort flush

  /** One atomic editor step: mutate the model, queue the mirroring ops, re-render (and focus). */
  const step = useCallback((fn: (root: M.MNode) => Edit[]) => {
    const r = rootRef.current;
    if (!r) return;
    enqueue(queue.current, fn(r));
    bump();
  }, []);

  /** Commit a hole's plain text — the shared core of `holeText` (blur) and `holeSubmit` (Enter,
   *  which additionally opens the follow-up hole). A BARE token in an UNDECIDED entry hole is
   *  the containing node's scalar SELF-VALUE line (rejected when it already has one — at most
   *  one scalar line per block); a decided VALUE hole (and any flow cell) commits the entry. */
  const holeCommit = useCallback((entryId: string, rawText: string, submit: boolean): boolean => {
    const text = normalizeSpaces(rawText); // a typed space is a space, never the browser's U+00A0
    if (!acceptsAsScalar(text)) return false;
    let ok = true;
    step((r) => {
      const spine = M.findEntry(r, entryId);
      if (!spine) return [];
      const { container } = spine.parents[spine.parents.length - 1];
      const scalar = { src: text, value: scalarValueOf(text) };
      if (!spine.entry.decided && !container.flow) {
        if (container.selfValue) { ok = false; return []; } // a second bare scalar line — rejected
        const edits = M.commitHoleAsSelf(path, r, entryId, scalar);
        if (submit) {
          const hole = M.insertHoleAt(r, container.id, container.selfAt);
          if (hole) focusReq.current = { key: hole.node.id, at: "start" };
        }
        return edits;
      }
      spine.entry.decided = true;
      // setNodeToken routes both worlds: an uncommitted spine commits whole (insert); a hole on
      // an entry ALREADY committed (a `key: ""` restructure placeholder) emplaces the value
      const edits = M.setNodeToken(path, r, spine.entry.node.id, { src: text, value: scalar.value });
      // THE LEVEL RULE on submit: descend into the just-committed entry's node
      if (submit && !container.flow) {
        const n = spine.entry.node;
        n.selfValue = n.scalar!;
        n.selfAt = 0;
        n.scalar = undefined;
        n.kind = "container";
        n.omniPending = spine.entry.committed; // its self line is a plain scalar server-side
        const hole = M.insertHoleAt(r, n.id, 0);
        if (hole) focusReq.current = { key: hole.node.id, at: "start" };
      }
      return edits;
    });
    return ok;
  }, [path, step]);

  /** `scalar_committed`'s recovery: a committed token (or the omni SELF-VALUE) whose text was
   *  re-edited into `key: value` / `key:` RESTRUCTURES — the scalar line leaves and a keyed
   *  entry takes its place at the same position (a mistyped `species>` is not a dead end).
   *  False when the text is not a keyed line, its value is not a scalar, or the key exists. */
  const restructureKeyed = useCallback((nodeId: string, text: string, self: boolean): boolean => {
    const kv = keyedEditParts(text);
    if (!kv || (kv.rest !== "" && !acceptsAsScalar(kv.rest))) return false;
    let ok = false;
    step((r) => {
      const found = M.findNode(r, nodeId);
      if (!found) return [];
      const { node, spine } = found;
      const edits: Edit[] = [];
      let at = 0;
      if (self) {
        if (!node.selfValue || node.entries.some((e) => e.key === kv.key)) return [];
        at = node.selfAt;
        edits.push(...M.setSelfValue(path, r, nodeId, null)); // the self line leaves
      } else if (node.kind === "scalar" && spine === null) {
        // the ROOT scalar document becomes a container; the scalar line is dropped server-side
        node.kind = "container";
        node.scalar = undefined;
        node.rev++;
        edits.push({ path, op: "emplace", yamlover: '""' });
      } else if (node.kind === "scalar") {
        // a committed ENTRY scalar: the whole entry is REPLACED by the keyed mapping (an
        // empty value serializes as `key: ""` until the value cell commits over it)
        node.kind = "container";
        node.scalar = undefined;
        node.rev++;
      } else return [];
      const entry = M.insertHoleAt(r, node.id, at);
      if (!entry) return [];
      entry.decided = true;
      entry.key = kv.key;
      if (kv.quoted) entry.quotedKey = true; // `"key": value` keeps its quoted key on disk
      if (kv.rest !== "") {
        entry.node.kind = "scalar";
        entry.node.scalar = { src: kv.rest, value: scalarValueOf(kv.rest) };
        entry.node.rev++;
        focusReq.current = { key: entry.node.id, at: "end" };
      } else {
        focusReq.current = { key: entry.node.id, at: "start" };
      }
      ok = true;
      if (!self && spine !== null && spine.entry.committed) {
        // one atomic replace: the scalar entry becomes the keyed mapping in place
        entry.committed = true;
        return [{ path: M.pathOfSpine(path, spine), op: "replace", yamlover: M.serializeMNode(node) }];
      }
      if (kv.rest !== "") edits.push(...M.commitSpine(path, r, entry.id));
      return edits;
    });
    return ok;
  }, [path, step]);

  const act = useMemo<YedActions>(() => ({
    commitToken(nodeId, rawSrc) {
      const src = normalizeSpaces(rawSrc); // a typed space is a space, never the browser's U+00A0
      if (!acceptsAsScalar(src)) return restructureKeyed(nodeId, src, false);
      step((r) => M.setNodeToken(path, r, nodeId, { src, value: scalarValueOf(src) }));
      return true;
    },
    commitText(nodeId, text, submit = false) {
      let ok = true;
      step((r) => {
        const found = M.findNode(r, nodeId);
        if (!found) return [];
        const { node, spine } = found;
        const s = node.scalar;
        // a block cell keeps its AUTHORED header (`|`, `|-`, `>`, …) over the edited lines; only
        // a text that cannot live in block form falls back to a quoted line
        const blockSrc = s?.quote ? null : M.blockSrcWith(s?.block ? M.blockHeader(s.src) : "|", text);
        const scalar: M.MScalar = s?.quote
          ? { src: quoteSource(text, s.quote), value: text, quote: s.quote }
          : blockSrc !== null
            ? { src: blockSrc, value: text, block: true }
            : { src: JSON.stringify(text), value: text, quote: '"' };
        if (spine && !spine.entry.decided) {
          const { container } = spine.parents[spine.parents.length - 1];
          if (!container.flow) {
            // a bare (quoted/block) token in an entry hole is the node's scalar LINE — kept as-is
            if (container.selfValue) { ok = false; return []; }
            node.scalar = scalar;
            const edits = M.commitHoleAsSelf(path, r, spine.entry.id, scalar);
            if (submit) {
              const hole = M.insertHoleAt(r, container.id, container.selfAt);
              if (hole) focusReq.current = { key: hole.node.id, at: "start" };
            }
            return edits;
          }
          spine.entry.decided = true; // flow cells are plain values
        }
        const edits = M.setNodeToken(path, r, nodeId, scalar);
        // THE LEVEL RULE on submit: descend into the just-committed node (never inside flow)
        if (submit && !(spine && spine.parents[spine.parents.length - 1].container.flow)) {
          const n = node;
          if (n.kind === "scalar") {
            const sc = n.scalar!;
            n.selfValue = sc.value === "" || sc.value == null ? null : sc;
            n.selfAt = 0;
            n.scalar = undefined;
            n.kind = "container";
            if (spine && spine.entry.committed && n.selfValue) n.omniPending = true;
          }
          if (n.kind === "container" && !n.flow) {
            const hole = M.insertHoleAt(r, n.id, n.selfValue ? n.selfAt : 0);
            if (hole) focusReq.current = { key: hole.node.id, at: "start" };
          }
        }
        return edits;
      });
      return ok;
    },
    quoteClose(nodeId, inner) {
      step((r) => {
        const found = M.findNode(r, nodeId);
        if (!found) return [];
        const s = found.node.scalar;
        if (!s?.quote) return [];
        // `quoted_token_closed`: nothing committed yet — the caret jumps after the closing quote
        found.node.scalar = { ...s, src: quoteSource(inner, s.quote), value: inner, closed: true };
        focusReq.current = { key: nodeId + ":after", at: "start" };
        return [];
      });
    },
    quotedKey(nodeId) {
      let ok = true;
      step((r) => {
        const found = M.findNode(r, nodeId);
        if (!found) return [];
        const { node, spine } = found;
        const keyStr = String(node.scalar?.value ?? "");
        if (keyStr === "") return [];
        if (spine) {
          const { container } = spine.parents[spine.parents.length - 1];
          if (container.entries.some((o) => o !== spine.entry && o.decided && o.key === keyStr)) {
            ok = false; // duplicate key in this node — keys are unique
            return [];
          }
        }
        const asKeyedHole = (container: M.MNode): void => {
          const hole = M.insertHoleAt(r, container.id, 0);
          if (hole) {
            hole.decided = true;
            hole.key = keyStr;
            hole.quotedKey = true;
            focusReq.current = { key: hole.node.id, at: "start" };
          }
        };
        if (!spine) {
          // ROOT: the quoted token becomes the first entry's KEY
          node.kind = "container";
          node.scalar = undefined;
          node.dirty = false;
          node.rev++;
          asKeyedHole(node);
          return [];
        }
        if (!spine.entry.decided) {
          // the entry hole's quoted token IS the entry's key — its value cell opens beside it
          spine.entry.decided = true;
          spine.entry.key = keyStr;
          spine.entry.quotedKey = true;
          node.kind = "hole";
          node.scalar = undefined;
          node.dirty = false;
          node.rev++;
          focusReq.current = { key: node.id, at: "start" };
          return [];
        }
        // value position: a fresh nested mapping opening with the quoted key
        node.kind = "container";
        node.scalar = undefined;
        node.dirty = false;
        node.rev++;
        asKeyedHole(node);
        return [];
      });
      return ok;
    },
    commitPointer(nodeId, raw) {
      const text = normalizeSpaces(raw).trim();
      if (text === "") return false;
      // the CANONICAL spaced form (`: pets[1]`) is what documents display — accept it and every
      // other parseable spelling; the op goes out BARE (ops carry `*\S*` only — server guard)
      const bare = M.barePointer(text);
      if (bare === null || /\s/.test(bare)) return false; // unparsable, or a quoted spaced key the wire can't carry
      step((r) => M.setNodeToken(path, r, nodeId, { pointer: text }));
      return true;
    },
    commitSelfToken(nodeId, rawSrc) {
      const src = normalizeSpaces(rawSrc);
      if (src !== "" && !acceptsAsScalar(src)) return restructureKeyed(nodeId, src, true);
      step((r) => M.setSelfValue(path, r, nodeId, src === "" ? null : { src, value: scalarValueOf(src) }));
      return true;
    },
    commitSelfQuoted(nodeId, text, quote) {
      step((r) => M.setSelfValue(path, r, nodeId, { src: quoteSource(text, quote), value: text, quote }));
    },
    commitSelfText(nodeId, text, submit = false) {
      // a BLOCK self-value: the authored header is kept over the edited lines; empty clears
      step((r) => {
        const found = M.findNode(r, nodeId);
        if (!found) return [];
        const node = found.node;
        const prev = node.selfValue;
        const blockSrc = M.blockSrcWith(prev?.block ? M.blockHeader(prev.src) : "|", text);
        const scalar: M.MScalar | null =
          text === "" ? null
          : blockSrc !== null ? { src: blockSrc, value: text, block: true }
          : { src: JSON.stringify(text), value: text, quote: '"' };
        const edits = M.setSelfValue(path, r, nodeId, scalar);
        if (submit) {
          const hole = M.insertHoleAt(r, node.id, node.selfAt);
          if (hole) focusReq.current = { key: hole.node.id, at: "start" };
        }
        return edits;
      });
    },
    commitMeta(nodeId, content) {
      focusReq.current = { key: nodeId, at: "start" }; // on to the value cell
      step((r) => M.setMetaTag(path, r, nodeId, content));
    },
    holeAction(entryId, action) {
      let ok = true;
      step((r) => {
        const edits = applyHoleAction(r, entryId, action, focusReq);
        if (edits === null) { ok = false; return []; }
        return edits;
      });
      return ok;
    },
    quoteReopen(nodeId) {
      // Backspace from the after-quote cell steps back INSIDE the quotes — still uncommitted
      step((r) => {
        const found = M.findNode(r, nodeId);
        if (!found || !found.node.scalar) return [];
        found.node.scalar = { ...found.node.scalar, closed: false };
        focusReq.current = { key: nodeId, at: "end" };
        return [];
      });
    },
    undoDecision(entryId) {
      // Backspace in an EMPTY value hole UNDOES the last structural token (colon / dash) of an
      // uncommitted entry — never the whole entry
      step((r) => {
        const spine = M.findEntry(r, entryId);
        if (!spine || spine.entry.committed || !spine.entry.decided) return [];
        const entry = spine.entry;
        const node = entry.node;
        if (entry.key !== null && entry.quotedKey) {
          // the quoted key returns to its closed-quote token, caret after the closing quote
          node.kind = "scalar";
          node.scalar = { src: JSON.stringify(entry.key), value: entry.key, quote: '"', closed: true };
          node.dirty = true;
          node.rev++;
          entry.key = null;
          entry.quotedKey = false;
          entry.decided = false;
          focusReq.current = { key: node.id + ":after", at: "start" };
          return [];
        }
        if (entry.key !== null) {
          // the plain key's text returns to the hole, ready to re-edit
          node.kind = "hole";
          node.scalar = undefined;
          node.prefill = entry.key;
          node.rev++;
          entry.key = null;
          entry.decided = false;
          focusReq.current = { key: node.id, at: "end" };
          return [];
        }
        // an undone dash: back to the plain entry hole
        entry.decided = false;
        node.rev++;
        focusReq.current = { key: node.id, at: "start" };
        return [];
      });
    },
    rootHole(action) {
      step((r) => {
        if (!action || action.kind === "text") return [];
        switch (action.kind) {
          case "quote":
            r.kind = "scalar";
            r.scalar = { src: quoteSource(action.rest, action.quote), value: action.rest, quote: action.quote };
            r.dirty = true;
            r.rev++;
            focusReq.current = { key: r.id, at: "end" };
            return []; // the emplace fires on commit
          case "block":
            r.kind = "scalar";
            r.scalar = { src: action.header, value: "", block: true }; // the typed header is the authored one
            r.dirty = true;
            r.rev++;
            focusReq.current = { key: r.id, at: "start" };
            return [];
          case "pointer":
            r.kind = "pointer";
            r.pointer = { raw: action.rest, refPath: null };
            r.dirty = true;
            r.rev++;
            focusReq.current = { key: r.id, at: "end" };
            return [];
          case "metaTag":
            r.metaTag = "";
            r.rev++;
            focusReq.current = { key: r.id + ":meta", at: "start" };
            return [];
          case "flowMap":
          case "flowSeq": {
            // `{` / `[` at the root work exactly like anywhere else: the ROOT becomes a flow
            // container with the closer projected and the first inner cell holding the caret
            r.kind = "container";
            r.flow = action.kind === "flowSeq" ? "seq" : "map";
            r.rev++;
            const inner = M.insertHoleAt(r, r.id, 0);
            if (inner) focusReq.current = { key: inner.node.id, at: "start" };
            return [];
          }
          case "ordinal":
          case "keyed": {
            // the document's FIRST entry: `- ` / `k: ` decide it
            const hole = M.insertHoleAt(r, r.id, 0);
            if (!hole) return [];
            if (action.kind === "keyed") {
              hole.decided = true;
              hole.key = action.key;
              if (action.viaEnter) {
                // `pets:` + Enter — the value opens as a nested block on the next row
                hole.node.kind = "container";
                const child = M.insertHoleAt(r, hole.node.id, 0);
                if (child) { focusReq.current = { key: child.node.id, at: "start" }; return []; }
              }
            } else hole.decided = true;
            focusReq.current = { key: hole.node.id, at: "start" };
            return [];
          }
        }
      });
    },
    rootText(rawText) {
      const text = normalizeSpaces(rawText);
      const r = rootRef.current;
      if (!r || !acceptsAsScalar(text)) return false;
      step((rr) => M.setNodeToken(path, rr, rr.id, { src: text, value: scalarValueOf(text) }));
      return true;
    },
    dismantle(nodeId) {
      step((r) => {
        const node = nodeId === r.id ? r : M.findNode(r, nodeId)?.node;
        if (!node || !node.dirty) return []; // persisted cells don't dismantle — they edit
        // a block cell dismantles back to its typed HEADER text (the pre-Enter hole state), so
        // continued Backspaces eat the header characters one by one
        const prefill = node.scalar?.block ? M.blockHeader(node.scalar.src) : undefined;
        node.scalar = undefined;
        node.pointer = undefined;
        node.flow = undefined;
        node.entries = [];
        node.kind = nodeId === r.id ? "container" : "hole"; // the root's hole IS the empty container
        node.dirty = false;
        node.prefill = prefill;
        node.rev++;
        focusReq.current = { key: node.id, at: prefill !== undefined ? "end" : "start" };
        return [];
      });
    },
    holeText(entryId, text) {
      return holeCommit(entryId, text, false);
    },
    holeSubmit(entryId, text) {
      return holeCommit(entryId, text, true);
    },
    nestValue(entryId) {
      // Enter in an EMPTY inline value hole: the value becomes a nested BLOCK — an
      // indented entry hole on the next row (the `pets: ` + Enter path)
      step((r) => {
        const spine = M.findEntry(r, entryId);
        if (!spine || spine.entry.node.kind !== "hole") return [];
        const { container } = spine.parents[spine.parents.length - 1];
        if (container.flow) return [];
        const node = spine.entry.node;
        node.kind = "container";
        node.rev++;
        const child = M.insertHoleAt(r, node.id, 0);
        if (child) focusReq.current = { key: child.node.id, at: "start" };
        return [];
      });
    },
    enterAfter(entryId) {
      step((r) => {
        const spine = M.findEntry(r, entryId);
        if (!spine) return [];
        const { container } = spine.parents[spine.parents.length - 1];
        if (container.flow && spine.entry.committed) return []; // no inserts into committed flow (starter)
        const hole = M.insertHoleAfter(r, container.id, entryId);
        if (hole) focusReq.current = { key: hole.node.id, at: "start" };
        return [];
      });
    },
    enterInto(nodeId) {
      // THE LEVEL RULE: descend into the node — its value becomes the omni self line and the
      // fresh hole opens inside it, one level deeper (Shift-Tab climbs back out)
      step((r) => {
        const found = M.findNode(r, nodeId);
        if (!found) return [];
        const { node, spine } = found;
        if (node.kind === "scalar") {
          // the token becomes the omni self-value (same source line); an EMPTY scalar (the
          // fresh-node body) just becomes a bare container
          const s = node.scalar!;
          node.selfValue = s.value === "" || s.value == null ? null : s;
          node.selfAt = 0;
          node.scalar = undefined;
          node.kind = "container";
          // server-side the entry is still a plain scalar — flag the omni re-emplace
          if (spine && spine.entry.committed && node.selfValue) node.omniPending = true;
        }
        if (node.kind !== "container" || node.flow) return [];
        const hole = M.insertHoleAt(r, node.id, node.selfValue ? node.selfAt : 0);
        if (hole) focusReq.current = { key: hole.node.id, at: "start" };
        return [];
      });
    },
    indent(entryId) {
      step((r) => {
        const spine = M.findEntry(r, entryId);
        const edits = M.indentEntry(path, r, entryId);
        // the FOCUS FOLLOWS the moved entry — the caret stays in the same cell at its new depth
        if (spine) focusReq.current = { key: spine.entry.node.id, at: "end" };
        return edits;
      });
    },
    dedent(entryId) {
      step((r) => {
        const spine = M.findEntry(r, entryId);
        const edits = M.dedentEntry(path, r, entryId);
        if (spine) focusReq.current = { key: spine.entry.node.id, at: "end" };
        return edits;
      });
    },
    pasteEntry(entryId, text) {
      const doc = P.tryParse(text);
      if (!doc || P.pasteBlockers(doc.root)) return false;
      let ok = true;
      step((r) => {
        const spine = M.findEntry(r, entryId);
        if (!spine) { ok = false; return []; }
        const { container, index } = spine.parents[spine.parents.length - 1];
        const parsed = doc.root;
        const lone = P.isLoneScalar(parsed);
        if (container.flow && !lone) { ok = false; return []; } // no block structure inside flow
        if (!spine.entry.decided) {
          // ENTRY stage — a lone (multi-line) scalar is the container's scalar LINE, exactly
          // like typing the token; structure splices as siblings at the hole's position
          if (lone) {
            if (container.selfValue) { ok = false; return []; }
            const edits = M.commitHoleAsSelf(path, r, entryId, P.scalarFromIR(parsed));
            const hole = M.insertHoleAt(r, container.id, container.selfAt);
            if (hole) focusReq.current = { key: hole.node.id, at: "start" };
            return edits;
          }
          const holeEntry = spine.entry;
          container.entries.splice(index, 1); // consume the hole (uncommitted — no ops)
          const edits = P.pasteEntriesAt(path, r, container.id, index, parsed);
          if (edits === null) {
            container.entries.splice(index, 0, holeEntry); // refused — the hole survives untouched
            ok = false;
            return [];
          }
          const last = container.entries[index + (parsed.entries?.length ?? 0) - 1];
          const hole = M.insertHoleAfter(r, container.id, last?.id ?? null); // continue below (holeSubmit's rule)
          if (hole) focusReq.current = { key: hole.node.id, at: "start" };
          return edits;
        }
        // VALUE stage — the parsed root is the entry's value
        if (lone) {
          const scalar = P.scalarFromIR(parsed);
          const edits = M.setNodeToken(path, r, spine.entry.node.id, scalar);
          focusReq.current = { key: spine.entry.node.id, at: "end" };
          return edits;
        }
        const edits = P.pasteValueAt(path, r, entryId, parsed);
        if (edits === null) { ok = false; return []; }
        const hole = M.insertHoleAfter(r, container.id, spine.entry.id);
        if (hole) focusReq.current = { key: hole.node.id, at: "start" };
        return edits;
      });
      return ok;
    },
    pasteRoot(text) {
      const doc = P.tryParse(text);
      if (!doc || P.pasteBlockers(doc.root)) return false;
      let ok = true;
      step((r) => {
        const edits = P.pasteRootDocument(path, r, doc);
        if (edits === null) { ok = false; return []; }
        const last = r.entries[r.entries.length - 1];
        focusReq.current = last ? { key: last.node.id, at: "end" } : { key: r.id, at: "end" };
        return edits;
      });
      return ok;
    },
    removeEmpty(entryId) {
      step((r) => {
        const spine = M.findEntry(r, entryId);
        if (!spine) return [];
        const { container, index } = spine.parents[spine.parents.length - 1];
        const prev = index > 0 ? container.entries[index - 1] : null;
        focusReq.current = prev ? { key: prev.node.id, at: "end" } : null;
        return M.removeEntry(path, r, entryId);
      });
    },
    focusSibling(from, dir) {
      const cells = Array.from(rootEl.current?.querySelectorAll<HTMLElement>("[data-yed-cell]") ?? []);
      const i = cells.indexOf((from.closest("[data-yed-cell]") as HTMLElement) ?? from);
      const next = cells[i + dir];
      if (next) focusCell(next, dir < 0 ? "end" : "start");
    },
  }), [path, step, holeCommit, restructureKeyed]);

  const ctx = useMemo<YedCtxType>(() => ({
    rootPath: path,
    act,
    registerCell: (key, el) => { if (el) cellMap.current.set(key, el); else cellMap.current.delete(key); },
    onNavigate,
    // a LAZY read of the mutable model — always current, no memo churn
    pointerTargets: (excludeNodeId) => (rootRef.current ? enumeratePointerTargets(rootRef.current, excludeNodeId) : []),
  }), [path, act, onNavigate]);

  // apply the pending focus request once the fresh cells are in the DOM
  useLayoutEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    const el = cellMap.current.get(req.key);
    if (el) {
      focusReq.current = null;
      focusCell(el, req.at);
    }
  });

  if (!root) return <div className="code yed">…</div>;
  const last = root.entries[root.entries.length - 1];
  const tailIsHole = !!last && !last.decided && !last.committed;
  return (
    <YedCtx.Provider value={ctx}>
      <div className="code yed" ref={rootEl} data-version={version}>
        {(root.metaTag !== null || root.setTag) && (
          <div className="yed-row"><MetaTagCell node={root} /></div>
        )}
        {root.kind === "scalar" ? (
          <div className="yed-row"><ScalarCell node={root} entryId={null} /></div>
        ) : root.kind === "pointer" ? (
          <div className="yed-row"><PointerCell node={root} entryId={null} /></div>
        ) : root.kind === "container" && root.flow ? (
          // the whole document as a flow container (`{` / `[` typed in the root hole)
          <div className="yed-row"><FlowCells node={root} /></div>
        ) : root.kind === "container" && root.entries.length === 0 && !root.selfValue ? (
          // an EMPTY document: one hole, the whole typing grammar applied to the root
          <div className="yed-row"><RootHole node={root} /></div>
        ) : (
          <>
            <NodeCells node={root} />
            {root.kind === "container" && !tailIsHole && (
              // the append affordance: one click opens a fresh entry hole at the end
              <div className="yed-row">
                <button
                  type="button"
                  className="yed-tail"
                  title="add an entry"
                  onClick={() => (last ? act.enterAfter(last.id) : act.enterInto(root.id))}
                >＋</button>
              </div>
            )}
          </>
        )}
      </div>
    </YedCtx.Provider>
  );
}
