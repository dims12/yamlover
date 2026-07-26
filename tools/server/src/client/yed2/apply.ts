// yed2 — the PURE edit layer. One entry point: `applyKey(state, key)`. The key's MEANING comes
// from the SAME dispatch table the keyboard legend displays (`interpret`, dispatch.ts) — the
// keycaps on screen are literally the function being run. The meaning's EFFECT is implemented
// here, once per intent, as a pure function over the parser IR: state in, state out, no mutation.
//
// THE INVARIANT (state.ts): the document is always valid; incompleteness lives in the cursor.
// A structural keystroke COMMITS eagerly (typing `{` puts an empty `{}` into the document — the
// diff pane narrates it); pending text rides the cursor until a boundary (comma, closer, Enter)
// lands it. A keystroke the state cannot take REFUSES visibly (`state.refused`) and changes
// nothing else — never a silent swallow, never a half-applied edit.

import { interpret, type Intent, type Site } from "../renderers/yamlover-editor/dispatch";
import { classifyHoleInput } from "../renderers/yamlover-editor/keys";
import {
  bracketOf, entryAt, isContainer, isFlow, isSpread, nodeAt, sourceOf,
  type Cursor, type Document, type EditorState, type Entry, type Node, type Path,
} from "./state";
import { parseYamlover } from "../../../../parser/ts/src/yamlover.ts";
import { isPointer } from "../../../../parser/ts/src/ir.ts";

// ---------------------------------------------------------------------------- //
// Immutable IR surgery
// ---------------------------------------------------------------------------- //

function withNode(doc: Document, path: Path, fn: (n: Node) => Node): Document {
  const rec = (v: Node, p: Path): Node => {
    if (p.length === 0) return fn(v);
    const entries = [...(v.entries ?? [])];
    const e = entries[p[0]];
    entries[p[0]] = { ...e, value: rec(e.value as Node, p.slice(1)) } as Entry;
    return { ...v, entries } as Node;
  };
  return { ...doc, root: rec(doc.root as Node, path) };
}

function insertEntry(doc: Document, containerPath: Path, index: number, entry: Entry): Document {
  return withNode(doc, containerPath, (n) => {
    const entries = [...(n.entries ?? [])];
    entries.splice(index, 0, entry);
    return { ...n, entries } as Node;
  });
}

function removeEntryAt(doc: Document, containerPath: Path, index: number): Document {
  return withNode(doc, containerPath, (n) => {
    const entries = [...(n.entries ?? [])];
    entries.splice(index, 1);
    return { ...n, entries } as Node;
  });
}

/** A scalar IR node from a typed source token; null when the token is not one scalar. */
function scalarFromText(text: string): Node | null {
  const t = text.trim();
  if (t === "") return null;
  try {
    const root = parseYamlover(t, "<cell>").root;
    if (isPointer(root) || root.kind !== "scalar" || (root.entries ?? []).length > 0) return null;
    const raw = (root as { raw?: string }).raw;
    return { kind: "scalar", value: (root as { value?: unknown }).value, ...(raw !== undefined ? { raw } : {}) } as unknown as Node;
  } catch {
    return null;
  }
}

/** An empty flow container node, bracket authored by the key typed. */
function emptyFlow(bracket: "{" | "["): Node {
  return { kind: "mapping", entries: [], ...(bracket === "[" ? { array: true } : {}), meta: { style: "flow" } } as unknown as Node;
}

// ---------------------------------------------------------------------------- //
// Site derivation — what the legend shows IS what applyKey consults
// ---------------------------------------------------------------------------- //

const containerKind = (n: Node | null): Site["container"] =>
  n && isFlow(n) ? (bracketOf(n) === "[" ? "flowSeq" : "flowMap") : "block";

export function siteOf(state: EditorState): Site {
  const { doc, cursor } = state;
  const base = { textEmpty: true, caretAtStart: true, caretAtEnd: true, entryDecided: true, entryCommitted: false };
  if (cursor.at === "hole") {
    const container = nodeAt(doc, cursor.path);
    const kind = containerKind(container);
    return {
      ...base,
      cell: kind === "block" ? "holeEntry" : "holeValue",
      container: kind,
      textEmpty: cursor.text.trim() === "",
      entryDecided: cursor.key !== null,
    };
  }
  if (cursor.at === "token") {
    const parent = cursor.path.length ? nodeAt(doc, cursor.path.slice(0, -1)) : null;
    return { ...base, cell: "token", container: containerKind(parent), textEmpty: cursor.text.trim() === "", entryCommitted: true };
  }
  if (cursor.at === "key") {
    const parent = nodeAt(doc, cursor.path.slice(0, -1));
    return { ...base, cell: "key", container: containerKind(parent), textEmpty: cursor.text.trim() === "", entryCommitted: true };
  }
  // after — the gap past the container at cursor.path
  const token = nodeAt(doc, cursor.path);
  const outer = cursor.path.length ? nodeAt(doc, cursor.path.slice(0, -1)) : null;
  const outerKind = containerKind(outer);
  return {
    ...base,
    cell: "gapClose",
    container: "block",
    outer: outerKind === "block" ? undefined : outerKind === "flowSeq" ? "seq" : "map",
    tokenEmpty: (token?.entries ?? []).length === 0,
    entryCommitted: true,
  };
}

// ---------------------------------------------------------------------------- //
// Cursor positions — ONE enumeration, used by movement and by the cells
// ---------------------------------------------------------------------------- //

export type Position =
  | { at: "key"; path: Path }
  | { at: "token"; path: Path }
  | { at: "after"; path: Path };

/** Every caret-occupiable position of the DOCUMENT, in reading order. */
export function positionsOf(doc: Document): Position[] {
  const out: Position[] = [];
  const rec = (n: Node, path: Path): void => {
    for (let i = 0; i < (n.entries ?? []).length; i++) {
      const e = n.entries![i];
      const p = [...path, i];
      if (e.key != null) out.push({ at: "key", path: p });
      if (isPointer(e.value)) continue; // D3: pointer cells
      const v = e.value as Node;
      if (v.kind === "scalar") out.push({ at: "token", path: p });
      else if (isContainer(v)) { rec(v, p); out.push({ at: "after", path: p }); }
    }
  };
  const root = doc.root as Node;
  if (root.kind === "scalar") out.push({ at: "token", path: [] });
  else {
    rec(root, []);
    if (isFlow(root)) out.push({ at: "after", path: [] });
  }
  return out;
}

const samePos = (a: Position | Cursor, b: Position): boolean =>
  a.at === b.at && "path" in a && a.path.join(".") === b.path.join(".");

/** The cursor as a Position (a hole sits between its container's entries). */
function cursorSlot(doc: Document, cursor: Cursor): number {
  const list = positionsOf(doc);
  if (cursor.at === "hole") {
    // after the position of the entry BEFORE the hole (or the container's own key/opening)
    if (cursor.index === 0) {
      // before the container's first entry: the slot right after the container's opener — find
      // the first position INSIDE the container, else the container's `after`
      const prefix = cursor.path.join(".");
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.path.join(".").startsWith(prefix) && p.path.length > cursor.path.length) return i;
        if (p.at === "after" && p.path.join(".") === prefix) return i;
      }
      return list.length;
    }
    const prevPath = [...cursor.path, cursor.index - 1].join(".");
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].path.join(".") === prevPath || list[i].path.join(".").startsWith(prevPath + ".")) return i + 1;
    }
    return list.length;
  }
  const i = list.findIndex((p) => samePos(cursor, p));
  return i < 0 ? list.length : i;
}

function toCursor(doc: Document, p: Position): Cursor {
  if (p.at === "token") {
    const e = entryAt(doc, p.path);
    const v = (p.path.length === 0 ? (doc.root as Node) : (e?.value as Node)) as { raw?: string; value?: unknown };
    return { at: "token", path: p.path, text: String(v?.raw ?? v?.value ?? "") };
  }
  if (p.at === "key") return { at: "key", path: p.path, text: String(entryAt(doc, p.path)?.key ?? "") };
  return { at: "after", path: p.path };
}

// ---------------------------------------------------------------------------- //
// Commit points
// ---------------------------------------------------------------------------- //

/** Land the cursor's pending content into the document. Returns null when the pending content
 *  cannot land (an unnamed element in a `{`, a token that is not a scalar) — the caller refuses. */
function commitPending(state: EditorState): EditorState | null {
  const { doc, cursor } = state;
  if (cursor.at === "hole") {
    if (cursor.text.trim() === "" && cursor.key === null) return state; // nothing pending
    const container = nodeAt(doc, cursor.path);
    if (!container) return null;
    if (cursor.key === null && bracketOf(container) === "{" && isFlow(container)) return null; // an unnamed pair cannot land in `{`
    const value = cursor.text.trim() === "" ? scalarFromText('""')! : scalarFromText(cursor.text);
    if (!value) return null;
    const entry = { key: cursor.key, edge: "contain", value } as unknown as Entry;
    return {
      ...state,
      doc: insertEntry(doc, cursor.path, cursor.index, entry),
      cursor: { at: "token", path: [...cursor.path, cursor.index], text: cursor.text },
    };
  }
  if (cursor.at === "token") {
    const value = scalarFromText(cursor.text);
    if (!value) return null;
    if (cursor.path.length === 0) return { ...state, doc: { ...doc, root: value } };
    return {
      ...state,
      doc: withNode(doc, cursor.path, () => value),
    };
  }
  if (cursor.at === "key") {
    const k = cursor.text.trim();
    if (k === "") return null;
    const parentPath = cursor.path.slice(0, -1);
    const idx = cursor.path[cursor.path.length - 1];
    return {
      ...state,
      doc: withNode(doc, parentPath, (n) => {
        const entries = [...(n.entries ?? [])];
        entries[idx] = { ...entries[idx], key: k } as Entry;
        return { ...n, entries } as Node;
      }),
    };
  }
  return state;
}

/** The OUTERMOST flow container on the cursor's path — the token a spread applies to. */
function outerFlowPath(doc: Document, path: Path): Path | null {
  for (let len = 0; len <= path.length; len++) {
    const p = path.slice(0, len);
    const n = nodeAt(doc, p);
    if (n && isContainer(n) && isFlow(n)) return p;
  }
  return null;
}

function setSpread(doc: Document, path: Path, on: boolean): Document {
  return withNode(doc, path, (n) => {
    const meta = { ...(n.meta ?? {}) } as Record<string, unknown>;
    if (on) { meta.concrete = "json5p"; delete meta.style; }
    else { delete meta.concrete; meta.style = "flow"; }
    return { ...n, meta } as Node;
  });
}

// ---------------------------------------------------------------------------- //
// applyKey — interpret, then one implementation per intent
// ---------------------------------------------------------------------------- //

export interface KeyInput { key: string; shift?: boolean }
export interface Edges { atStart: boolean; atEnd: boolean }

/** The cursor's text replaced wholesale (a controlled input's onChange — native caret, selection,
 *  mid-text edits and text-level paste all included), then the hole classifier runs. */
export function applyText(state: EditorState, text: string): EditorState {
  const { cursor } = state;
  if (cursor.at === "token" || cursor.at === "key") return ok({ ...state, cursor: { ...cursor, text } });
  if (cursor.at !== "hole") return state;
  return classifyHole(ok({ ...state, cursor: { ...cursor, text } }));
}

const ok = (s: EditorState): EditorState => ({ ...s, refused: false });
const refuse = (s: EditorState): EditorState => ({ ...s, refused: true });

export function applyKey(state: EditorState, k: KeyInput, edges?: Edges): EditorState {
  const before = sourceOf(state.doc);
  const site = { ...siteOf(state), ...(edges ? { caretAtStart: edges.atStart, caretAtEnd: edges.atEnd } : {}) };
  const intent = interpret({ key: k.key, shift: k.shift }, site);
  const next = intent ? applyIntent(state, intent, site) : applyPrintable(state, k.key);
  if (next === state) return state; // truly unhandled
  const after = sourceOf(next.doc);
  const entry = {
    key: k.key.length === 1 ? k.key : `{${k.shift ? "⇧" : ""}${k.key}}`,
    intent: intent ? intent.kind : k.key.length === 1 ? "text" : "(none)",
    before, after,
  };
  return { ...next, log: after !== before || intent ? [...state.log, entry].slice(-50) : state.log };
}

/** A printable character: text goes to the cursor, then the classifier may materialize structure
 *  (`{` `[` open containers, `k: ` names the pair) — keys.ts, the same classifier as production. */
function applyPrintable(state: EditorState, ch: string): EditorState {
  if (ch.length !== 1) return state;
  const { cursor } = state;
  if (cursor.at === "token" || cursor.at === "key") {
    return ok({ ...state, cursor: { ...cursor, text: cursor.text + ch } });
  }
  if (cursor.at !== "hole") return refuse(state); // a gap takes no text — visibly
  return classifyHole(ok({ ...state, cursor: { ...cursor, text: cursor.text + ch } }));
}

/** Run the hole's text through the classifier; structural prefixes commit structure EAGERLY. */
function classifyHole(state: EditorState): EditorState {
  const { doc, cursor } = state;
  if (cursor.at !== "hole") return state;
  const container = nodeAt(doc, cursor.path);
  const entryStage = container !== null && !isFlow(container);
  const action = classifyHoleInput(cursor.text, entryStage && cursor.key === null);
  if (!action || action.kind === "text") return state;
  if (action.kind === "flowMap" || action.kind === "flowSeq") {
    const node = emptyFlow(action.kind === "flowSeq" ? "[" : "{");
    // at the EMPTY document root the token IS the document — `[1, 2]` typed into a fresh file is
    // the root value, not a block entry holding one (the same law production learned)
    if (cursor.path.length === 0 && cursor.key === null && (container?.entries ?? []).length === 0 && container && !isFlow(container)) {
      return { ...state, doc: { ...doc, root: node }, cursor: { at: "hole", path: [], index: 0, text: "", key: null } };
    }
    const entry = { key: cursor.key, edge: "contain", value: node } as unknown as Entry;
    // inside a spread token the new container spreads too — json5p expands everything under the
    // switch; rendering derives it from the ancestors, nothing to store on the child
    return {
      ...state,
      doc: insertEntry(doc, cursor.path, cursor.index, entry),
      cursor: { at: "hole", path: [...cursor.path, cursor.index], index: 0, text: "", key: null },
    };
  }
  if (action.kind === "keyed") {
    if (container && isFlow(container) && bracketOf(container) === "[") return refuse(state); // a seq has no keys
    return { ...state, cursor: { ...cursor, key: action.key, text: "" } };
  }
  if (action.kind === "ordinal") {
    return { ...state, cursor: { ...cursor, key: null, text: "" } }; // `- ` — explicit keyless
  }
  return state; // quote/pointer/tag/block: D3
}

function applyIntent(state: EditorState, intent: Intent, site: Site): EditorState {
  const { doc, cursor } = state;
  switch (intent.kind) {
    case "nop":
      return ok(state);
    case "refuse":
      return refuse(state);

    case "move": {
      const committed = commitPending(state);
      const s = committed ?? state; // pending that cannot land yet just stays; movement is free
      const list = positionsOf(s.doc);
      if (list.length === 0) return ok(s);
      const slot = cursorSlot(s.doc, s.cursor);
      const idx = s.cursor.at === "hole"
        ? (intent.dir > 0 ? Math.min(slot, list.length - 1) : Math.max(slot - 1, 0))
        : Math.max(0, Math.min(slot + intent.dir, list.length - 1));
      return ok({ ...s, cursor: toCursor(s.doc, list[idx]) });
    }

    case "nextElement": {
      if (cursor.at === "hole" && cursor.text.trim() === "" && cursor.key === null) return refuse(state); // nothing to separate
      const committed = commitPending(state);
      if (!committed) return refuse(state);
      const cur = committed.cursor;
      const entryPath = cur.at === "token" || cur.at === "key" ? cur.path : cursor.at === "hole" ? [...cursor.path, cursor.index] : cursor.path;
      const containerPath = entryPath.slice(0, -1);
      const index = entryPath[entryPath.length - 1] + 1;
      let s = committed;
      if (intent.spread) {
        const op = outerFlowPath(s.doc, containerPath);
        if (op !== null) s = { ...s, doc: setSpread(s.doc, op, true) };
        else return refuse(state); // an unspreadable site
      }
      return ok({ ...s, cursor: { at: "hole", path: containerPath, index, text: "", key: null } });
    }

    case "spreadOrClose": {
      const path = cursor.at === "hole" ? cursor.path : cursor.path.slice(0, -1);
      const op = outerFlowPath(doc, path);
      if (op === null) return refuse(state);
      return ok({ ...state, doc: setSpread(doc, op, true) });
    }

    case "closeToken": {
      const committed = state.cursor.at === "hole" && state.cursor.text.trim() === "" && state.cursor.key === null
        ? state // an untouched hole is dropped by closing, not written
        : commitPending(state);
      if (!committed) return refuse(state);
      const tokenPath = cursor.at === "hole" ? cursor.path : cursor.path.slice(0, -1);
      const token = nodeAt(committed.doc, tokenPath);
      if (!token || !isFlow(token) || bracketOf(token) !== (intent.closer === "]" ? "[" : "{")) return refuse(state);
      return ok({ ...committed, cursor: { at: "after", path: tokenPath } });
    }

    case "siblingAfter": {
      if (cursor.at !== "after") return refuse(state);
      if (cursor.path.length === 0) return ok(state); // the document root has no sibling
      const containerPath = cursor.path.slice(0, -1);
      return ok({ ...state, cursor: { at: "hole", path: containerPath, index: cursor.path[cursor.path.length - 1] + 1, text: "", key: null } });
    }

    case "reopenToken": {
      if (cursor.at !== "after") return refuse(state);
      const token = nodeAt(doc, cursor.path);
      if (!token) return refuse(state);
      return ok({ ...state, cursor: { at: "hole", path: cursor.path, index: (token.entries ?? []).length, text: "", key: null } });
    }

    case "undoMarker": {
      if (cursor.at === "hole" && cursor.key !== null) {
        return ok({ ...state, cursor: { ...cursor, key: null, text: cursor.key } });
      }
      return applyIntent(state, { kind: "removeLevel" }, site);
    }

    case "removeLevel": {
      if (cursor.at === "hole") {
        const container = nodeAt(doc, cursor.path);
        if (!container) return refuse(state);
        if ((container.entries ?? []).length > 0) {
          // the hole vanishes; the caret steps onto the previous position
          const list = positionsOf(doc);
          const slot = cursorSlot(doc, cursor);
          const idx = Math.max(0, slot - 1);
          return ok({ ...state, cursor: list.length ? toCursor(doc, list[idx]) : { at: "hole", path: [], index: 0, text: "", key: null } });
        }
        // an EMPTY container: one level goes — remove it from its parent. At the ROOT that means
        // undoing the bracket itself: the document returns to the empty block mapping.
        if (cursor.path.length === 0) {
          if (!isFlow(container)) return ok(state); // already the empty document
          return ok({ ...state, doc: { ...doc, root: { kind: "mapping", entries: [] } as unknown as Node }, cursor: { at: "hole", path: [], index: 0, text: "", key: null } });
        }
        const parentPath = cursor.path.slice(0, -1);
        const idx = cursor.path[cursor.path.length - 1];
        return ok({
          ...state,
          doc: removeEntryAt(doc, parentPath, idx),
          cursor: { at: "hole", path: parentPath, index: idx, text: "", key: null },
        });
      }
      if (cursor.at === "token" || cursor.at === "key") {
        if (cursor.path.length === 0) {
          return ok({ ...state, doc: { ...doc, root: { kind: "mapping", entries: [] } as unknown as Node }, cursor: { at: "hole", path: [], index: 0, text: "", key: null } });
        }
        const parentPath = cursor.path.slice(0, -1);
        const idx = cursor.path[cursor.path.length - 1];
        const e = entryAt(doc, cursor.path);
        if (cursor.at === "key") {
          // un-name: the key goes, the value stays (one press, one level)
          return ok({
            ...state,
            doc: withNode(doc, parentPath, (n) => {
              const entries = [...(n.entries ?? [])];
              entries[idx] = { ...entries[idx], key: null } as Entry;
              return { ...n, entries } as Node;
            }),
            cursor: { at: "token", path: cursor.path, text: String((e?.value as { raw?: string; value?: unknown })?.raw ?? (e?.value as { value?: unknown })?.value ?? "") },
          });
        }
        return ok({
          ...state,
          doc: removeEntryAt(doc, parentPath, idx),
          cursor: { at: "hole", path: parentPath, index: idx, text: "", key: null },
        });
      }
      return refuse(state);
    }

    case "join": {
      const p = cursor.at === "token" || cursor.at === "key" ? cursor.path.slice(0, -1) : cursor.at === "hole" ? cursor.path : cursor.path;
      const op = outerFlowPath(doc, p);
      if (op === null) return state; // not a join spot — the key falls through
      const token = nodeAt(doc, op);
      if (!token || !isSpread(token)) return state;
      // only from the head of the token's FIRST line: every level down to the cursor is index 0
      const rest = (cursor.at === "hole" ? [...cursor.path, cursor.index] : cursor.path).slice(op.length);
      if (rest.some((i) => i !== 0)) return state;
      return ok({ ...state, doc: setSpread(doc, op, false) });
    }

    case "keyCommit": {
      const committed = commitPending(state);
      if (!committed) return refuse(state);
      const op = outerFlowPath(committed.doc, cursor.path.slice(0, -1));
      return ok(op !== null ? { ...committed, doc: setSpread(committed.doc, op, true) } : committed);
    }

    case "commit": {
      const committed = commitPending(state);
      if (!committed) return refuse(state);
      const cur = committed.cursor;
      const entryPath = cur.at === "token" || cur.at === "key" ? cur.path
        : cursor.at === "hole" ? [...cursor.path, cursor.index] : cursor.path;
      return ok({ ...committed, cursor: { at: "hole", path: entryPath.slice(0, -1), index: entryPath[entryPath.length - 1] + 1, text: "", key: null } });
    }

    // D3: tokenKey, quotedKey, reopenQuote, quoteExit*, nestValue, indent/dedent
    default:
      return state;
  }
}
