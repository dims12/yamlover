// The projectional editor's HOST — everything that is not drawing.
//
// Fetches the node at unlimited depth (immune to a finite `?depth=` URL setting), builds the
// mutable cell model (model.ts) ONCE, and stays authoritative while mounted: every keystroke
// mutates the model instantly and appends the mirroring surgical ops to the op queue (ops.ts),
// which flushes in the background and on lock/unmount. NodeView already pauses SSE refetches while
// unlocked, so nothing rebuilds the model under the caret.
//
// The host knows nothing about how a node LOOKS. Two projections draw the same model: the source
// view (editor.tsx — rows of tokens, the yamlover typing grammar) and the chapter view (prose,
// headings, sections). They share the tree, the ops, the focus machinery and the action surface;
// only the cells differ. That is why this file has no JSX.

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { fetchNode, rekeyNode, type Edit } from "../../api";
import { parseYamlover } from "../../../../../parser/ts/src/yamlover.ts";
import { acceptsAsScalar, acceptsAsFlowScalar } from "../value-editors";
import { focusEnd, focusStart, placeCaret } from "../caret";
import * as M from "./model";
import { enqueue, useOpSync, type OpQueue } from "./ops";
import { keyedEditParts, normalizeSpaces, quoteSource, type HoleAction } from "./keys";
import * as P from "./paste";
import { FlowCells, MetaTagCell, NodeCells, PointerCell, RootHole, ScalarCell, YedCtx, type YedActions, type YedCtxType } from "./cells";

export interface FocusReq {
  key: string; // a cell key (node id, or `<id>:meta` / `<id>:self`)
  at: FocusAt;
}
/** Where the caret lands: an end of the cell, or a visible-character offset (a prose join lands
 *  the caret at the junction of the two merged paragraphs). */
export type FocusAt = "start" | "end" | number;
type FocusRef = { current: FocusReq | null };

/** Focus a cell with the caret at `at`. A TEXTAREA (the block-scalar cell) needs its own caret
 *  API — the contentEditable range routines clobber a textarea's focus in real browsers. */
function focusCell(el: HTMLElement, at: FocusAt): void {
  if (typeof at === "number") { placeCaret(el, at); return; }
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
      // as in `quotedKey`: a FLOW MAP's entry is decided from birth, so the question is whether it
      // has a KEY yet — `{abc: 1}` names this entry, it does not open a nested mapping inside it
      if (!entry.decided || (container.flow === "map" && entry.key === null)) {
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

/** Everything a projection needs to draw the model and act on it. */
export interface YedHost {
  /** The model root — null until the fetch lands. */
  root: M.MNode | null;
  /** Bumped on every step; a projection keys its re-render off this. */
  version: number;
  /** The action surface the cells call (see `YedActions` in cells.tsx). */
  act: YedActions;
  /** The context value a projection provides to its cells. */
  ctx: YedCtxType;
  /** The projection's root element — cells are looked up under it. */
  rootEl: React.MutableRefObject<HTMLDivElement | null>;
  /** Flush the pending ops now (lock / navigation). */
  flush: () => Promise<void>;
  /** The edited node's path — the op-routing base. */
  path: string;
  /** The live model (mutable) — a projection composing its own mutations reads it here. */
  rootRef: React.MutableRefObject<M.MNode | null>;
  /** The pending caret placement, applied against the cell map after the next render. A projection
   *  sets this inside a `step` so the caret follows its own structural edit. */
  focusReq: FocusRef;
  /** One atomic editor step: mutate the model, queue the mirroring ops, re-render (and focus). */
  step: (fn: (root: M.MNode) => Edit[]) => void;
  /** The edited node's CONCRETE from the fetch (`dir/yamlover`, `file/yamlover`, …; null until it
   *  lands) — a projection's storage-form branch point (a dir-concrete chapter materializes
   *  fresh subchapters as subdirectories). */
  concreteRef: React.MutableRefObject<string | null>;
}

/** Load `path`, build its model, and return the host driving it. */
export function useYedHost(path: string, onNavigate: (p: string) => void): YedHost {
  const [root, setRoot] = useState<M.MNode | null>(null);
  const rootRef = useRef<M.MNode | null>(null);
  const queue = useRef<OpQueue>({ pending: [] });
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const cellMap = useRef(new Map<string, HTMLElement>());
  const focusReq = useRef<FocusReq | null>(null);
  const rootEl = useRef<HTMLDivElement | null>(null);
  // the DOCUMENT holding the edited node — a `*:` (document-scoped) pointer's spelling base
  const docPathRef = useRef(path);
  const concreteRef = useRef<string | null>(null);

  // the editor's own unlimited-depth fetch — the model needs the WHOLE subtree
  useEffect(() => {
    let live = true;
    fetchNode(path, null)
      .then((n) => {
        if (!live) return;
        docPathRef.current = n.documentPath ?? path;
        concreteRef.current = n.concrete ?? null;
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
    // a typed space is a space, never the browser's U+00A0 — and LEADING whitespace is not content
    // in a hole (the same rule classifyHoleInput applies): a flow cell reached past a `, ` would
    // otherwise commit ` 2` and render `[1,  2]`
    const text = normalizeSpaces(rawText).replace(/^\s+/, "");
    // FLOW context accepts what a flow cell can hold (`'a, b'`, `0xff`); BLOCK context keeps the
    // stricter bare-token rule, where an unquoted comma or bracket must be quoted
    const spine0 = rootRef.current ? M.findEntry(rootRef.current, entryId) : null;
    const inFlow = !!spine0?.parents[spine0.parents.length - 1].container.flow;
    if (!(inFlow ? acceptsAsFlowScalar(text) : acceptsAsScalar(text))) return false;
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
        const holder = spine ? spine.parents[spine.parents.length - 1].container : null;
        if (holder && holder.entries.some((o) => o !== spine!.entry && o.decided && o.key === keyStr)) {
          ok = false; // duplicate key in this node — keys are unique
          return [];
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
        // The entry hole's quoted token IS the entry's key — its value cell opens beside it. A FLOW
        // MAP's entry is `decided` from birth (it is an element the moment `{` opens it), so
        // decidedness cannot stand in for "the key is chosen": ask about the KEY. Without this,
        // `{"abc":` fell through to the value-position branch below and replaced the quoted token
        // with a nested BLOCK mapping — inside flow braces that renders as nothing, so the key the
        // user had just typed vanished off the screen.
        if (!spine.entry.decided || (holder?.flow === "map" && spine.entry.key === null)) {
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
    rekey(entryId, newKey) {
      const r = rootRef.current;
      if (!r) return false;
      const spine = M.findEntry(r, entryId);
      if (!spine || spine.entry.key === null) return false;
      const trimmed = normalizeSpaces(newKey).trim();
      if (trimmed === "") return false;
      if (trimmed === spine.entry.key) return true; // unchanged — accept as a no-op
      const { container } = spine.parents[spine.parents.length - 1];
      if (container.entries.some((o) => o !== spine.entry && o.decided && o.key === trimmed)) return false; // dup key
      const oldPath = M.pathOfSpine(path, spine); // the node's CURRENT server path (its OLD key)
      const nodeId = spine.entry.node.id;
      // optimistic rename — the caret stays in the key cell; the rekey persists via its OWN
      // endpoint (a dir-member move or an inline key-token rewrite), NOT an /api/edit op
      step((rr) => {
        const sp = M.findEntry(rr, entryId);
        if (sp) {
          sp.entry.key = trimmed;
          sp.entry.quotedKey = !/^[^\s"'*&!#|>@`,[\]{}:][^:#]*$/.test(trimmed); // quote a spacey/metachar key
          sp.entry.node.rev++;
        }
        focusReq.current = { key: nodeId + ":key", at: "end" };
        return [];
      });
      // sequence AFTER any pending body edits (so the entry exists on disk), then rename key/dir.
      // A rare server rejection (a race with an external edit) is reconciled by the unlock refetch.
      void flushRef.current().then(() => rekeyNode(oldPath, trimmed)).catch(() => {});
      return true;
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
    flowNext(entryId, text, spread = false) {
      // A typed `,` inside a flow container: commit this cell (an empty one is allowed — an
      // authored `[a, , b]` keeps its hole), then open a fresh element AFTER it. The fresh entry
      // is undecided, so a flow MAP's next pair can type `k: ` / `"k":` through the ordinary
      // grammar — applyHoleAction and quotedKey already special-case `container.flow === "map"`.
      if (text.trim() !== "" && !acceptsAsFlowScalar(text)) return false;
      if (text.trim() !== "" && !holeCommit(entryId, text, false)) return false;
      step((r) => {
        const spine = M.findEntry(r, entryId);
        if (!spine) return [];
        const { container } = spine.parents[spine.parents.length - 1];
        // ENTER also SPREADS the token to K&R — a concrete switch to json5p. Skipped silently when
        // json5p cannot hold the subtree (a keyed+keyless mixture): the element still lands, on the
        // one line it already had, which is the editor showing the result rather than narrating it.
        if (spread) M.setSpread(container, true);
        // the token's own value changed shape (one line ⇄ rows), so a PERSISTED one must be
        // rewritten whole — the only edit the server accepts for a flow value. Taken BEFORE the
        // fresh hole is inserted: an undecided seq hole serializes as `""`, and the user has not
        // typed that element yet (its own commit will re-emplace the token again).
        const edits = spread ? M.flowReshape(path, r, container.id) : [];
        const hole = M.insertHoleAfter(r, container.id, entryId);
        if (hole) focusReq.current = { key: hole.node.id, at: "start" };
        return edits;
      });
      return true;
    },
    flowSpread(entryId) {
      // Enter in the still-empty cell of a freshly opened `{`/`[`: allocate the row and STAY in the
      // cell. Closing here would commit `[]` and strand the caret past the closer, which is not
      // what a newline means — and used to be a dead end.
      let ok = false;
      step((r) => {
        const spine = M.findEntry(r, entryId);
        if (!spine) return [];
        const { container } = spine.parents[spine.parents.length - 1];
        if (container.jsonp) {
          // already spread: this Enter only means "stay here" (the caret is the point)
          ok = true;
          focusReq.current = { key: spine.entry.node.id, at: "start" };
          return [];
        }
        ok = M.setSpread(container, true);
        if (!ok) return [];
        // the cell MOVES (from the opener's row into its own), so it remounts and loses focus —
        // hand it back explicitly or the caret is lost, which is the trap in another costume
        focusReq.current = { key: spine.entry.node.id, at: "start" };
        return M.flowReshape(path, r, container.id);
      });
      return ok;
    },
    flowReopen(nodeId) {
      // Backspace just past the closer of an EMPTY token (`[]`): put a cell back INSIDE it, which
      // is exactly where the caret came from. No op — the hole is client-side until something is
      // typed, and then the whole token re-emplaces.
      let ok = false;
      step((r) => {
        const found = M.findNode(r, nodeId);
        if (!found || !found.node.flow || found.node.entries.length > 0) return [];
        const hole = M.insertHoleAt(r, nodeId, 0);
        if (hole) { focusReq.current = { key: hole.node.id, at: "start" }; ok = true; }
        return [];
      });
      return ok;
    },
    flowJoin(nodeId) {
      let ok = false;
      step((r) => {
        const found = M.findNode(r, nodeId);
        if (!found || !found.node.jsonp) return [];
        ok = M.setSpread(found.node, false);
        if (!ok) return [];
        // the closer ROW the caret was standing on is gone once the token is one line, so hand the
        // caret to the same after-cell in its new home — otherwise focus falls to <body> and the
        // join becomes a trap (the edit corpus catches exactly this)
        focusReq.current = { key: nodeId + ":flowafter", at: "start" };
        return M.flowReshape(path, r, found.node.id);
      });
      return ok;
    },
    flowKeyed(nodeId) {
      // A `:` typed just past a flow token's closer makes the TOKEN the entry's key — the
      // `[256, 256]: *…` shape the parser reads (splitKV scans a leading flow token whole and
      // treats it as a key exactly when a `:` follows). The key is the token's SOURCE TEXT, so the
      // container collapses back to a value hole and the caret opens beside it.
      let ok = true;
      step((r) => {
        const found = M.findNode(r, nodeId);
        if (!found) { ok = false; return []; }
        const { node, spine } = found;
        const token = M.serializeMNode(node);
        if (!token || token.includes("\n")) { ok = false; return []; }
        if (!spine) {
          // the ROOT was the token: the document becomes a mapping whose FIRST key is it. The
          // closer already committed the token as the document's VALUE, so that line has to go
          // first — the same clearing emplace `restructureKeyed` uses for a root scalar.
          const wasCommitted = node.entries.some((e) => e.committed);
          node.kind = "container";
          node.flow = undefined;
          node.entries = [];
          node.scalar = undefined;
          node.dirty = false;
          node.rev++;
          const hole = M.insertHoleAt(r, node.id, 0);
          if (hole) {
            hole.decided = true;
            hole.key = token;
            focusReq.current = { key: hole.node.id, at: "start" };
          }
          return wasCommitted ? [{ path, op: "emplace", yamlover: '""' }] : [];
        }
        const { container } = spine.parents[spine.parents.length - 1];
        if (container.flow) { ok = false; return []; } // no keys inside a flow token
        // A COMMITTED element already stands on disk as `- [12, 13]`; turning it into a key is a
        // different line shape, which this surface cannot express as one surgical op. Refuse rather
        // than emit something incoherent — the ring says "not here", and the token stays.
        if (spine.entry.committed) { ok = false; return []; }
        if (container.entries.some((o) => o !== spine.entry && o.decided && o.key === token)) { ok = false; return []; }
        spine.entry.decided = true;
        spine.entry.key = token;
        node.kind = "hole";
        node.flow = undefined;
        node.entries = [];
        node.scalar = undefined;
        node.dirty = false;
        node.rev++;
        focusReq.current = { key: node.id, at: "start" };
        return [];
      });
      return ok;
    },
    flowClose(entryId, text, closer) {
      let ok = true;
      const spine0 = M.findEntry(rootRef.current!, entryId);
      const container0 = spine0?.parents[spine0.parents.length - 1].container;
      if (!container0?.flow) return false;
      if ((container0.flow === "seq") !== (closer === "]")) return false; // the wrong closer rings
      if (text.trim() !== "") {
        if (!acceptsAsFlowScalar(text)) return false;
        if (!holeCommit(entryId, text, false)) return false;
      }
      step((r) => {
        const spine = M.findEntry(r, entryId);
        if (!spine) { ok = false; return []; }
        const { container, index } = spine.parents[spine.parents.length - 1];
        const edits: Edit[] = [];
        // an EMPTY uncommitted hole is dropped rather than written as `""` — the user typed the
        // closer to END the token, not to author a blank element
        if (text.trim() === "" && !spine.entry.committed && spine.entry.node.kind === "hole") {
          edits.push(...M.removeEntry(path, r, entryId));
          // …and if that was the ONLY hole, the token is EMPTY — `{}` / `[]`, which is real content
          // (the only spelling those values have). No cell holds text, so nothing else would ever
          // push it to the server: commit the container itself.
          if (container.entries.length === 0) {
            const owner = M.findNode(r, container.id)?.spine?.entry;
            if (owner) { if (!owner.committed) edits.push(...M.commitSpine(path, r, owner.id)); }
            else edits.push({ path, op: "emplace", yamlover: M.serializeMNode(container) }); // the ROOT is the token
          }
        }
        void index;
        focusReq.current = { key: container.id + ":flowafter", at: "start" };
        return edits;
      });
      return ok;
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
        // (a committed flow container accepts inserts now: the whole token re-emplaces —
        // model.ts flowAncestor — so there is no interior address to get wrong)
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
        // INSIDE A FLOW CONTAINER there is no level to descend into — a one-line token has no
        // rows. Ask the PARENT, before any conversion: converting first turned the element into a
        // block container with an invisible hole (FlowCells draws no bodies), and `valueToken`
        // then rendered the whole token as `[""]`. `commitText` has always asked the parent; this
        // path was the gap. A fresh element opens instead, which is what Enter means in flow.
        const parentFlow = spine ? spine.parents[spine.parents.length - 1].container : null;
        if (parentFlow?.flow) {
          const hole = M.insertHoleAfter(r, parentFlow.id, spine!.entry.id);
          if (hole) focusReq.current = { key: hole.node.id, at: "start" };
          return [];
        }
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
        // A whole FLOW TOKEN is ONE VALUE, not a run of sibling entries: `[12, 13, 14]` pasted
        // into a hole is a single element that happens to be a sequence, so it becomes the hole's
        // value. Splicing its members as siblings would turn the token the user copied into
        // three separate block rows.
        if (parsed.meta?.style === "flow" && !lone) {
          const edits = P.pasteValueAt(path, r, entryId, parsed);
          if (edits === null) { ok = false; return []; }
          if (!spine.entry.decided) spine.entry.decided = true; // an entry-stage hole becomes the element
          focusReq.current = { key: spine.entry.node.id, at: "end" };
          return edits;
        }
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
        // NO TRAPS: emptying a FLOW container undoes the `[` / `{` that opened it, exactly as
        // Backspace undoes a `- ` / `key:` decision. Without this the brackets stayed on screen
        // with nothing inside to type into and nothing focusable — a dead end reachable in two
        // keystrokes. The container returns to the hole it came from, caret restored.
        if (container.flow && container.entries.length === 1) {
          const edits = M.removeEntry(path, r, entryId);
          // the ROOT's hole IS the empty container (the same rule `dismantle` follows): giving the
          // root kind "hole" matched no branch in editor.tsx, so the view rendered NOTHING and the
          // caret fell to <body> — `[` then Backspace in a fresh document was a dead end
          container.kind = container === r ? "container" : "hole";
          container.flow = undefined;
          container.rev++;
          focusReq.current = { key: container.id, at: "start" };
          return edits;
        }
        const prev = index > 0 ? container.entries[index - 1] : null;
        focusReq.current = prev ? { key: prev.node.id, at: "end" } : null;
        return M.removeEntry(path, r, entryId);
      });
    },
    focusCellKey(key, at) {
      const el = cellMap.current.get(key);
      if (el) focusCell(el, at);
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
    // LAZY reads of the mutable model — always current, no memo churn
    holderOf: (nodeId) => (rootRef.current ? M.holderPathOfNode(path, rootRef.current, nodeId) : path),
    docPath: () => docPathRef.current,
    entryIdOfNode: (nodeId) => (rootRef.current ? M.findNode(rootRef.current, nodeId)?.spine?.entry.id ?? null : null),
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

  return { root, version, act, ctx, rootEl, flush, path, rootRef, focusReq, step, concreteRef };
}
