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
import { classifyHoleInput, keyedEditParts } from "../renderers/yamlover-editor/keys";
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
    const meta = (root as { meta?: unknown }).meta; // anchors ride the token (`&'…' 1`)
    return { kind: "scalar", value: (root as { value?: unknown }).value, ...(raw !== undefined ? { raw } : {}), ...(meta !== undefined ? { meta } : {}) } as unknown as Node;
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
      entryDecided: cursor.key !== null || cursor.ordinal === true,
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
  | { at: "after"; path: Path }
  | { at: "into"; path: Path }; // the inside of an EMPTY block container — its placeholder slot

/** Every caret-occupiable position of the DOCUMENT, in reading order — which is the VISUAL
 *  order: an omni's value line sits at its authored row (`meta.selfAt`) among its fields. */
export function positionsOf(doc: Document): Position[] {
  const out: Position[] = [];
  const rec = (n: Node, path: Path, from = 0, to = (n.entries ?? []).length): void => {
    for (let i = from; i < to; i++) {
      const e = n.entries![i];
      const p = [...path, i];
      if (e.key != null) out.push({ at: "key", path: p });
      if (isPointer(e.value)) continue; // pointer cells: later
      const v = e.value as Node;
      if (v.kind === "scalar") omni(v, p);
      // only a FLOW container has a gap — a closer bracket to stand after. A block container has
      // no closer and the projection draws no gap cell; a position no cell draws must not exist.
      // An EMPTY block container instead has an `into` — its clickable placeholder slot, so the
      // walk (and a click) can always reach the value waiting to be filled.
      else if (isContainer(v)) {
        if (!isFlow(v) && (v.entries ?? []).length === 0) out.push({ at: "into", path: p });
        rec(v, p);
        if (isFlow(v)) out.push({ at: "after", path: p });
      }
    }
  };
  /** the scalar's TOKEN at its authored row among its fields — the walk agrees with the eyes */
  const omni = (v: Node, p: Path): void => {
    const len = (v.entries ?? []).length;
    const at = Math.min(Math.max((v.meta as { selfAt?: number } | undefined)?.selfAt ?? 0, 0), len);
    rec(v, p, 0, at);
    out.push({ at: "token", path: p });
    rec(v, p, at, len);
  };
  const root = doc.root as Node;
  if (root.kind === "scalar") omni(root, []);
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
        if ((p.at === "after" || p.at === "into") && p.path.join(".") === prefix) return i;
        if (p.at === "token" && p.path.join(".") === prefix) return i + 1; // a scalar's fields follow its value line
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

/** Backspace at the START of a committed value in a BLOCK row — THE CONVERSION LADDER: a keyed
 *  row un-names (`k: v` → `- v`), a keyless row's scalar becomes the container's OWN value
 *  (`- v` → `v` at the container; only ONE scalar — a taken slot refuses, visibly). This is the
 *  explicit deletion of the row's MARKER: one press, one level of the entry's form. */
function applyUnmark(state: EditorState): EditorState {
  const { doc, cursor } = state;
  if (cursor.at !== "token" || cursor.path.length === 0) return refuse(state);
  const parentPath = cursor.path.slice(0, -1);
  const idx = cursor.path[cursor.path.length - 1];
  const container = nodeAt(doc, parentPath);
  const e = entryAt(doc, cursor.path);
  if (!container || !e || isFlow(container)) return refuse(state);
  if (e.key !== null) {
    // keyed → ordered: the name goes, the value stays (the mirror of naming it)
    return ok({
      ...state,
      doc: withNode(doc, parentPath, (n) => {
        const entries = [...(n.entries ?? [])];
        entries[idx] = { ...entries[idx], key: null } as Entry;
        return { ...n, entries } as Node;
      }),
    });
  }
  // ordered → the container's scalar VALUE
  if (isPointer(e.value)) return refuse(state);
  const v = e.value as Node;
  if (v.kind !== "scalar" || (v.entries ?? []).length > 0) return refuse(state); // a container cannot BE the value
  if (container.kind !== "mapping") return refuse(state); // only one scalar — the slot is taken
  const vv = v as unknown as { value?: unknown; raw?: string };
  const selfAt = idx > 0 ? { selfAt: idx } : {}; // the value stays on ITS row — order is kept
  return ok({
    ...state,
    doc: withNode(removeEntryAt(doc, parentPath, idx), parentPath, (n) => ({
      ...n, kind: "scalar", value: vv.value, ...(vv.raw !== undefined ? { raw: vv.raw } : {}),
      meta: { ...(n.meta ?? {}), ...selfAt },
    }) as unknown as Node),
    cursor: { at: "token", path: parentPath, text: cursor.text, caret: "start" },
  });
}

/** Is this position a VISUAL ROW's representative? Keys share their row with their value;
 *  everything inside a ONE-LINE flow container shares that container's row (only the outermost
 *  one-liner's gap represents it). The anchors, in order, ARE the document's rows. */
function isRowAnchor(doc: Document, p: Position): boolean {
  if (p.at === "key") return false;
  for (let len = 0; len < p.path.length; len++) {
    const n = nodeAt(doc, p.path.slice(0, len));
    if (n && isContainer(n) && isFlow(n) && !isSpread(n)) return false; // inside a one-liner
  }
  return true;
}

/** ↑/↓ — THE ROW WALK: vertical arrows move between VISUAL ROWS (anchor to anchor), never
 *  through the same row's key/value pair. A hole is its own row between anchors. Refuses at the
 *  document's top and bottom edges. */
function applyVertical(state: EditorState, dir: -1 | 1): EditorState {
  const committed = commitPending(state);
  if (committed === null) return refuse(state); // moving away never drops pending text
  const s = committed;
  const list = positionsOf(s.doc);
  const anchors: number[] = [];
  for (let i = 0; i < list.length; i++) if (isRowAnchor(s.doc, list[i])) anchors.push(i);
  if (anchors.length === 0) return refuse(state);
  const slot = cursorSlot(s.doc, s.cursor);
  let target: number | undefined;
  if (s.cursor.at === "hole") {
    // an `into` anchor IS this hole when the caret already stands in it — never a self-target
    const other = (a: number): boolean => JSON.stringify(toCursor(s.doc, list[a])) !== JSON.stringify(s.cursor);
    target = dir < 0 ? [...anchors].reverse().find((a) => a < slot && other(a)) : anchors.find((a) => a >= slot && other(a));
  } else {
    const mineIdx = anchors.findIndex((a) => a >= slot); // a key's row anchor is its value, just after it
    const mine = mineIdx === -1 ? anchors.length : mineIdx;
    const t = mine + dir;
    target = t >= 0 && t < anchors.length ? anchors[t] : undefined;
  }
  if (target === undefined) return refuse(state);
  const c = toCursor(s.doc, list[target]);
  return ok({ ...s, cursor: c.at === "token" || c.at === "key" ? { ...c, caret: "end" } : c });
}

function toCursor(doc: Document, p: Position): Cursor {
  if (p.at === "token") {
    const e = entryAt(doc, p.path);
    const v = (p.path.length === 0 ? (doc.root as Node) : (e?.value as Node)) as { raw?: string; value?: unknown };
    return { at: "token", path: p.path, text: String(v?.raw ?? v?.value ?? "") };
  }
  if (p.at === "key") return { at: "key", path: p.path, text: String(entryAt(doc, p.path)?.key ?? "") };
  if (p.at === "into") return { at: "hole", path: p.path, index: 0, text: "", key: null };
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
    // THE OMNI RULE: a bare scalar in a BLOCK container (no key, no `- `) is the container's OWN
    // value — `42` typed into a fresh file is the root value `42`, not `- 42`; typed after
    // `world:` + Enter it makes `world: 42`; typed among entries it makes the value-plus-fields
    // node (!!var). A `- ` decision (cursor.ordinal) opts OUT into a keyless entry instead.
    if (cursor.key === null && cursor.ordinal !== true && !isFlow(container)) {
      if (container.kind !== "mapping") return null; // the container already HAS a value
      const v = value as { value?: unknown; raw?: string; meta?: unknown };
      // the value keeps its AUTHORED position among the entries (`meta.selfAt`) — typed after
      // `key1: value1`, it serializes after it; order is committed labour too
      const selfAt = cursor.index > 0 ? { selfAt: cursor.index } : {};
      return {
        ...state,
        doc: withNode(doc, cursor.path, (n) => ({
          ...n, kind: "scalar", value: v.value,
          ...(v.raw !== undefined ? { raw: v.raw } : {}),
          meta: { ...(n.meta ?? {}), ...((v.meta as object) ?? {}), ...selfAt },
        }) as unknown as Node),
        cursor: { at: "token", path: cursor.path, text: cursor.text },
      };
    }
    const entry = { key: cursor.key, edge: "contain", value } as unknown as Entry;
    return {
      ...state,
      doc: insertEntry(doc, cursor.path, cursor.index, entry),
      cursor: { at: "token", path: [...cursor.path, cursor.index], text: cursor.text },
    };
  }
  if (cursor.at === "token") {
    const value = scalarFromText(cursor.text);
    // THE UPWARD CONVERSION: a value line retyped WITH ITS MARKER (`key2: scalar2`, `- scalar2`)
    // is not a scalar any more — it commits as an ENTRY on the same row (the inverse of the
    // Backspace ladder's keyed → ordered → scalar)
    if (!value) return tokenRowToEntry(state);
    // the token edit changes the node's VALUE — its fields (an omni's entries) and its meta are
    // committed labour and SURVIVE the edit; only the scalar spelling is replaced
    const v = value as { value?: unknown; raw?: string; meta?: object };
    const merge = (n: Node): Node => {
      const out = { ...n, kind: "scalar", value: v.value } as Record<string, unknown>;
      delete out.raw; // the OLD spelling must not shadow the new value
      if (v.raw !== undefined) out.raw = v.raw;
      const meta = { ...(n.meta ?? {}), ...(v.meta ?? {}) };
      if (Object.keys(meta).length > 0) out.meta = meta; else delete out.meta;
      return out as unknown as Node;
    };
    if (cursor.path.length === 0) return { ...state, doc: { ...doc, root: merge(doc.root as Node) } };
    return {
      ...state,
      doc: withNode(doc, cursor.path, merge),
    };
  }
  if (cursor.at === "key") {
    // an EMPTIED key commits as UN-NAMED (`key1: v` edited to `: v` becomes the keyless `- v`) —
    // refusing here would trap the caret in a cell it can only Backspace out of
    const k = cursor.text.trim();
    const parentPath = cursor.path.slice(0, -1);
    const idx = cursor.path[cursor.path.length - 1];
    const next = {
      ...state,
      doc: withNode(doc, parentPath, (n) => {
        const entries = [...(n.entries ?? [])];
        entries[idx] = { ...entries[idx], key: k === "" ? null : k } as Entry;
        return { ...n, entries } as Node;
      }),
    };
    if (k !== "") return next;
    // the key CELL is gone — the caret lands on the entry's value (a cell that exists)
    const val = entryAt(doc, cursor.path)?.value;
    const cursorAfter: Cursor = !val || isPointer(val)
      ? { at: "hole", path: parentPath, index: idx, text: "", key: null }
      : (val as Node).kind === "scalar" && ((val as Node).entries ?? []).length === 0
        ? { at: "token", path: cursor.path, text: String((val as { raw?: string }).raw ?? (val as { value?: unknown }).value ?? ""), caret: "start" }
        : isFlow(val as Node)
          ? { at: "after", path: cursor.path }
          : { at: "hole", path: cursor.path, index: 0, text: "", key: null };
    return { ...next, cursor: cursorAfter };
  }
  return state;
}

/** A token row retyped as `k: v` or `- v` — the node's VALUE becomes an ENTRY at its own row
 *  (`meta.selfAt`), the marker deciding its form. Null when the text is not exactly one entry,
 *  or the token does not stand in a block row. */
function tokenRowToEntry(state: EditorState): EditorState | null {
  const { doc, cursor } = state;
  if (cursor.at !== "token") return null;
  let parsed: Node;
  try {
    const root = parseYamlover(cursor.text, "<row>").root;
    if (isPointer(root)) return null;
    parsed = root as Node;
  } catch {
    return null;
  }
  if (parsed.kind !== "mapping" || (parsed.entries ?? []).length !== 1) return null;
  const entry = parsed.entries![0] as Entry;
  const node = nodeAt(doc, cursor.path);
  if (!node || node.kind !== "scalar") return null;
  const parent = cursor.path.length > 0 ? nodeAt(doc, cursor.path.slice(0, -1)) : null;
  if (parent && isFlow(parent)) return null; // flow rows have their own grammar
  const len = (node.entries ?? []).length;
  const at = Math.min(Math.max((node.meta as { selfAt?: number } | undefined)?.selfAt ?? 0, 0), len);
  const meta = { ...(node.meta ?? {}) } as Record<string, unknown>;
  delete meta.selfAt;
  const converted = {
    ...node,
    kind: "mapping",
    entries: [...(node.entries ?? []).slice(0, at), entry, ...(node.entries ?? []).slice(at)],
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  } as Record<string, unknown>;
  delete converted.value;
  delete converted.raw;
  if (Object.keys(meta).length === 0) delete converted.meta;
  const doc2 = cursor.path.length === 0
    ? { ...doc, root: converted as unknown as Node }
    : withNode(doc, cursor.path, () => converted as unknown as Node);
  return { ...state, doc: doc2 as Document, cursor: restCursor(entry.value as Node, [...cursor.path, at]) };
}

/** SPREAD, upward-closed: the container at `path` (when flow) AND every flow ancestor become K&R
 *  — a one-line container cannot contain a multi-line child, so spreading propagates UP. It never
 *  propagates DOWN: children keep their own layout, and a NEW token defaults to one line. Returns
 *  null when nothing on the path is a flow container (an unspreadable site). */
function spreadUp(doc: Document, path: Path): Document | null {
  let out = doc;
  let any = false;
  for (let len = path.length; len >= 0; len--) {
    const p = path.slice(0, len);
    const n = nodeAt(out, p);
    if (n && isContainer(n) && isFlow(n) && !isSpread(n)) { out = setSpread(out, p, true); any = true; }
    else if (n && isContainer(n) && isSpread(n)) { any = true; break; } // already spread above — closed
  }
  return any ? out : null;
}

/** The NEAREST flow container at or above `path` — the token the cursor is editing in. */
function nearestFlowPath(doc: Document, path: Path): Path | null {
  for (let len = path.length; len >= 0; len--) {
    const p = path.slice(0, len);
    const n = nodeAt(doc, p);
    if (n && isContainer(n) && isFlow(n)) return p;
  }
  return null;
}

/** Any spread container strictly INSIDE `n`? (Joining a parent around one would be unwritable.) */
function hasSpreadInside(n: Node): boolean {
  return (n.entries ?? []).some((e) => {
    if (isPointer(e.value)) return false;
    const v = e.value as Node;
    return isSpread(v) || hasSpreadInside(v);
  });
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
// THE WATCHDOG — no advertised key is ever dead
// ---------------------------------------------------------------------------- //

/** Every non-printable key the legend draws. */
export const WATCHDOG_KEYS: KeyInput[] = [
  { key: "Enter" }, { key: "Tab" }, { key: "Tab", shift: true }, { key: "Backspace" },
  { key: "ArrowLeft" }, { key: "ArrowRight" }, { key: "ArrowUp" }, { key: "ArrowDown" },
  { key: "," }, { key: "]" }, { key: "}" },
];

/** DEBUG WATCHDOG: for the given state, every key the grammar CLAIMS (one keystroke deep) must
 *  RESPOND — change the document, move the caret, or refuse visibly. `nop` intents are exempt
 *  (claimed-to-swallow: Enter must not type a newline — and the legend greys them out). Throws
 *  naming the dead key. Call it only in debug mode and in tests — it replays every legend key
 *  against the state; when debug is off it is simply never invoked, costing nothing. */
export function watchdog(state: EditorState): void {
  // the ROOT's JSON, not the serialized bytes: layout meta (a spread bit) changes the PROJECTION
  // while spelling the same bytes — that is a response, and bytes would miss it
  const before = JSON.stringify(state.doc.root);
  const cursorBefore = JSON.stringify(state.cursor);
  for (const k of WATCHDOG_KEYS) {
    const intent = interpret({ key: k.key, shift: k.shift }, siteOf(state));
    // `nop` is claimed-to-swallow; `join` may decline and fall through to the native char
    // delete (visible in the browser, invisible to this pure check) — both exempt BY CONTRACT
    if (intent === null || intent.kind === "nop" || intent.kind === "join") continue;
    const next = applyKey(state, k);
    const dead = !next.refused && JSON.stringify(next.doc.root) === before && JSON.stringify(next.cursor) === cursorBefore;
    if (dead) {
      throw new Error(
        `WATCHDOG: ${k.shift ? "⇧" : ""}${k.key} (intent "${intent.kind}") is advertised as allowed but DOES NOTHING\n` +
        `  at cursor ${cursorBefore}\n  in ${JSON.stringify(sourceOf(state.doc))}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------- //
// Copy / paste — REQUIREMENT 10: subtrees travel as their serialized text
// ---------------------------------------------------------------------------- //

/** The serialized SUBTREE under the caret — the token or container the cursor stands on (a hole
 *  holds nothing to copy). What goes to the clipboard is exactly what a file would hold. */
export function copySubtree(state: EditorState): string | null {
  const { doc, cursor } = state;
  if (cursor.at === "hole") return null;
  const v = cursor.path.length === 0 ? doc.root : entryAt(doc, cursor.path)?.value;
  if (!v || isPointer(v)) return null;
  return sourceOf({ ...doc, root: v } as Document).replace(/\n$/, "");
}

/** Paste INTO A HOLE: the clipboard parses as one yamlover document and its root splices in as
 *  the hole's value (named by the hole's key), under the SAME laws typing obeys — the empty block
 *  root takes it as the document, a bare scalar in a block container is the OMNI value, an
 *  unnamed element cannot land in `{`. A parse failure REFUSES — nothing lost, nothing dropped. */
export function pasteSubtree(state: EditorState, text: string): EditorState {
  const { doc, cursor } = state;
  if (cursor.at !== "hole" || cursor.text.trim() !== "" || text.trim() === "") return refuse(state);
  let node: Node;
  try {
    const root = parseYamlover(text, "<paste>").root;
    if (isPointer(root)) return refuse(state);
    node = root as Node;
  } catch {
    return refuse(state);
  }
  const container = nodeAt(doc, cursor.path);
  if (!container) return refuse(state);
  if (cursor.key === null && isFlow(container) && bracketOf(container) === "{") return refuse(state);
  if (cursor.key === null && cursor.ordinal !== true && !isFlow(container)) {
    if (container.kind !== "mapping") return refuse(state); // the container already HAS a value
    // the EMPTY container takes the paste as its whole value; among entries, a scalar paste is
    // the omni value and a container paste refuses (it could not have been typed there either)
    if ((container.entries ?? []).length === 0) {
      return ok({ ...state, doc: withNode(doc, cursor.path, () => node), cursor: restCursor(node, cursor.path) });
    }
    if (node.kind !== "scalar" || (node.entries ?? []).length > 0) return refuse(state);
    const v = node as { value?: unknown; raw?: string };
    const selfAt = cursor.index > 0 ? { selfAt: cursor.index } : {};
    return ok({
      ...state,
      doc: withNode(doc, cursor.path, (n) => ({ ...n, kind: "scalar", value: v.value, ...(v.raw !== undefined ? { raw: v.raw } : {}), meta: { ...(n.meta ?? {}), ...selfAt } }) as unknown as Node),
      cursor: { at: "token", path: cursor.path, text: String(v.raw ?? v.value ?? "") },
    });
  }
  const entry = { key: cursor.key, edge: "contain", value: node } as unknown as Entry;
  return ok({
    ...state,
    doc: insertEntry(doc, cursor.path, cursor.index, entry),
    cursor: restCursor(node, [...cursor.path, cursor.index]),
  });
}

/** Where the caret rests after a paste: on a scalar's token, past a container. */
function restCursor(node: Node, path: Path): Cursor {
  if (node.kind === "scalar" && (node.entries ?? []).length === 0) {
    const v = node as { raw?: string; value?: unknown };
    return { at: "token", path, text: String(v.raw ?? v.value ?? "") };
  }
  return { at: "after", path };
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
  // the table calls both arrow axes "move"; the vertical pair walks ROWS, not positions — and
  // BACKSPACE at a block value's start is the CONVERSION LADDER, not a walk
  const next = intent
    ? (intent.kind === "move" && (k.key === "ArrowUp" || k.key === "ArrowDown")
        ? applyVertical(state, intent.dir)
        : intent.kind === "move" && intent.dir === -1 && k.key === "Backspace" && state.cursor.at === "token"
          ? applyUnmark(state)
          : applyIntent(state, intent, site))
    : applyPrintable(state, k.key);
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
  // A CLOSED QUOTED KEY — `"name": rest` — is a key decision the plain classifier does not make
  // (quote-led text is a quote to it). keyedEditParts parses exactly this shape; quoted VALUES
  // need nothing (the scalar parser takes `"Eurasia"` with its quotes at any commit boundary).
  if ((!action || action.kind === "quote") && cursor.key === null && cursor.text.trimStart().startsWith('"')) {
    const kv = keyedEditParts(cursor.text.trimStart());
    if (kv?.quoted && (container === null || !isFlow(container) || bracketOf(container) === "{")) {
      return { ...state, cursor: { ...cursor, key: kv.key, text: kv.rest } };
    }
  }
  if (!action || action.kind === "text") return state;
  if (action.kind === "flowMap" || action.kind === "flowSeq") {
    const node = emptyFlow(action.kind === "flowSeq" ? "[" : "{");
    // at the EMPTY document root the token IS the document — `[1, 2]` typed into a fresh file is
    // the root value, not a block entry holding one (the same law production learned)
    if (cursor.path.length === 0 && cursor.key === null && cursor.ordinal !== true && (container?.entries ?? []).length === 0 && container && !isFlow(container)) {
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
    // `- k: …` — a keyless entry HOLDING a block mapping, the key naming its first pair (the
    // block seq-of-maps shape). The `- ` decision materializes here, on the first key.
    if (cursor.ordinal === true) {
      const child: Node = { kind: "mapping", entries: [] } as unknown as Node;
      const entry = { key: null, edge: "contain", value: child } as unknown as Entry;
      return {
        ...state,
        doc: insertEntry(doc, cursor.path, cursor.index, entry),
        cursor: { at: "hole", path: [...cursor.path, cursor.index], index: 0, text: "", key: action.key },
      };
    }
    return { ...state, cursor: { ...cursor, key: action.key, text: "" } };
  }
  if (action.kind === "ordinal") {
    return { ...state, cursor: { ...cursor, key: null, ordinal: true, text: "" } }; // `- ` — DECIDED keyless
  }
  return state; // quote/pointer/tag/block: D3
}

function applyIntent(state: EditorState, intent: Intent, site: Site): EditorState {
  const { doc, cursor } = state;
  switch (intent.kind) {
    case "nop": {
      // THE LEVEL RULE, descend half: Enter on an empty hole that already NAMED its key commits
      // `key:` with a nested BLOCK container as the value and steps inside (`world:` + Enter).
      // The shared dispatch table calls this site a nop because production resolves it inside its
      // classifier; yed2's key already left the text, so the decision lands here.
      if (cursor.at === "hole" && cursor.key !== null && cursor.text.trim() === "") {
        const child: Node = { kind: "mapping", entries: [] } as unknown as Node;
        const entry = { key: cursor.key, edge: "contain", value: child } as unknown as Entry;
        return ok({
          ...state,
          doc: insertEntry(doc, cursor.path, cursor.index, entry),
          cursor: { at: "hole", path: [...cursor.path, cursor.index], index: 0, text: "", key: null },
        });
      }
      return ok(state);
    }
    case "refuse":
      return refuse(state);

    case "move": {
      const committed = commitPending(state);
      // NOTHING IS EVER LOST: pending text that cannot land (an unnamed element in a `{`, a
      // token that is not one scalar) REFUSES the move — the caret stays with the text — instead
      // of abandoning the hole (the cursor is the only place a hole exists).
      if (committed === null) return refuse(state);
      const s = committed;
      const list = positionsOf(s.doc);
      const slot = list.length === 0 ? 0 : cursorSlot(s.doc, s.cursor);
      // a move that has nowhere to go REFUSES (the visible edge ring) — it never clamps to a
      // position behind the caret's back, and never reports motion that did not happen. When the
      // commit itself changed the document, that IS the response.
      const same = (c: Cursor): boolean => JSON.stringify(c) === JSON.stringify(s.cursor);
      let idx = s.cursor.at === "hole" ? (intent.dir > 0 ? slot : slot - 1) : slot + intent.dir;
      while (idx >= 0 && idx < list.length && same(toCursor(s.doc, list[idx]))) idx += intent.dir;
      if (idx < 0 || idx >= list.length) {
        // at the edge with nowhere to go: the commit's own change is a response; a commit that
        // rebuilt identical CONTENT is not — then the edge refuses, visibly
        const changed = JSON.stringify(s.doc.root) !== JSON.stringify(state.doc.root)
          || JSON.stringify(s.cursor) !== JSON.stringify(state.cursor);
        return changed ? ok(s) : refuse(state);
      }
      // the caret lands on the side it ARRIVED from: entering from the right ends at the end
      const c = toCursor(s.doc, list[idx]);
      return ok({ ...s, cursor: c.at === "token" || c.at === "key" ? { ...c, caret: intent.dir < 0 ? "end" : "start" } : c });
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
        const spreadDoc = spreadUp(s.doc, containerPath);
        if (spreadDoc === null) return refuse(state); // an unspreadable site
        s = { ...s, doc: spreadDoc };
      }
      return ok({ ...s, cursor: { at: "hole", path: containerPath, index, text: "", key: null } });
    }

    case "spreadOrClose": {
      const path = cursor.at === "hole" ? cursor.path : cursor.path.slice(0, -1);
      const spreadDoc = spreadUp(doc, path);
      if (spreadDoc === null) return refuse(state);
      if (spreadDoc === doc) {
        // ALREADY spread — the "or close" half: Enter on the empty cell exits past the token's
        // closer (the first Enter allocated the row; a second empty one leaves the token)
        const op = nearestFlowPath(doc, path);
        if (op === null) return refuse(state);
        return ok({ ...state, cursor: { at: "after", path: op } });
      }
      return ok({ ...state, doc: spreadDoc });
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
      if (cursor.path.length === 0) return refuse(state); // the document root has no sibling — visibly
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
      if (cursor.at === "hole" && cursor.ordinal === true) {
        return ok({ ...state, cursor: { ...cursor, ordinal: false } }); // the `- ` decision undone
      }
      return applyIntent(state, { kind: "removeLevel" }, site);
    }

    case "removeLevel": {
      if (cursor.at === "hole") {
        const container = nodeAt(doc, cursor.path);
        if (!container) return refuse(state);
        // a hole among ENTRIES, or the empty fields region of a SCALAR (the value is content —
        // Enter's descend must not make it deletable wholesale): the hole vanishes and the caret
        // steps back onto the previous position, its text intact, caret at the END
        if ((container.entries ?? []).length > 0 || container.kind === "scalar") {
          const list = positionsOf(doc);
          const slot = cursorSlot(doc, cursor);
          const idx = Math.max(0, slot - 1);
          if (list.length === 0) return ok({ ...state, cursor: { at: "hole", path: [], index: 0, text: "", key: null } });
          const c = toCursor(doc, list[idx]);
          return ok({ ...state, cursor: c.at === "token" || c.at === "key" ? { ...c, caret: "end" } : c });
        }
        // an EMPTY container: one level goes — remove it from its parent. At the ROOT that means
        // undoing the bracket: the document returns to the empty block mapping. (A scalar root
        // took the step-back branch above.)
        if (cursor.path.length === 0) {
          if (!isFlow(container)) return refuse(state); // already the empty document — the bottom, visibly
          return ok({ ...state, doc: { ...doc, root: { kind: "mapping", entries: [] } as unknown as Node }, cursor: { at: "hole", path: [], index: 0, text: "", key: null } });
        }
        const parentPath = cursor.path.slice(0, -1);
        const idx = cursor.path[cursor.path.length - 1];
        // ONE press, ONE level: the container goes, but a NAME the entry already carried is
        // committed labour — it survives as the named hole (`{key: [` + Backspace → `key: `),
        // and only the NEXT press un-names it (undoMarker).
        const named = entryAt(doc, cursor.path)?.key ?? null;
        return ok({
          ...state,
          doc: removeEntryAt(doc, parentPath, idx),
          cursor: { at: "hole", path: parentPath, index: idx, text: "", key: named },
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
          // the VALUE goes, the entry's name stays — the mirror of un-name (key → value stays)
          cursor: { at: "hole", path: parentPath, index: idx, text: "", key: e?.key ?? null },
        });
      }
      return refuse(state);
    }

    case "join": {
      // INNERMOST-first: joining collapses the nearest spread container the caret's first line
      // belongs to; a parent joins only after its children have (a one-liner cannot contain a
      // multi-liner, so a join around a spread child is refused visibly).
      const p = cursor.at === "token" || cursor.at === "key" ? cursor.path.slice(0, -1) : cursor.at === "hole" ? cursor.path : cursor.path;
      const op = nearestFlowPath(doc, p);
      if (op === null) return state; // not a join spot — the key falls through
      const token = nodeAt(doc, op);
      if (!token || !isSpread(token)) return state;
      const rest = (cursor.at === "hole" ? [...cursor.path, cursor.index] : cursor.path).slice(op.length);
      if (rest.some((i) => i !== 0)) return state;
      if (hasSpreadInside(token)) return refuse(state);
      return ok({ ...state, doc: setSpread(doc, op, false) });
    }

    case "keyCommit": {
      const committed = commitPending(state);
      if (!committed) return refuse(state);
      const spreadDoc = spreadUp(committed.doc, cursor.path.slice(0, -1));
      const s = spreadDoc !== null ? { ...committed, doc: spreadDoc } : committed;
      // Enter on a key means the naming is DONE — the caret steps onto the pair's VALUE (in a
      // block pair with an empty value, onto its `into` slot); staying put would be a dead key
      return applyIntent({ ...s, refused: false }, { kind: "move", dir: 1 }, site);
    }

    case "dedent": {
      // THE LEVEL RULE, climb half: Shift-Tab moves an (empty) hole out one level — the next
      // entry lands as a SIBLING of the container the hole was in.
      if (cursor.at !== "hole" || cursor.path.length === 0) return refuse(state);
      if (cursor.text.trim() !== "" || cursor.key !== null || cursor.ordinal === true) return refuse(state); // climb empty-handed
      const parentPath = cursor.path.slice(0, -1);
      return ok({ ...state, cursor: { at: "hole", path: parentPath, index: cursor.path[cursor.path.length - 1] + 1, text: "", key: null } });
    }

    case "indent": {
      // …and Tab is the climb's INVERSE: it re-enters the PREVIOUS sibling's value (`children:`
      // ⏎ ⇤ — oops — ⇥ puts the hole back inside children). Refused when there is nothing
      // before the hole to enter; always claimed, so Tab can never leak to the browser.
      if (cursor.at !== "hole") return refuse(state);
      if (cursor.text.trim() !== "" || cursor.key !== null || cursor.ordinal === true) return refuse(state); // indent empty-handed
      if (cursor.index === 0) return refuse(state);
      const container = nodeAt(doc, cursor.path);
      const prev = (container?.entries ?? [])[cursor.index - 1];
      if (!prev || isPointer(prev.value)) return refuse(state);
      const v = prev.value as Node;
      return ok({ ...state, cursor: { at: "hole", path: [...cursor.path, cursor.index - 1], index: (v.entries ?? []).length, text: "", key: null } });
    }

    case "commit": {
      // `k:` + Enter — the LEVEL RULE's descend spelled without the trailing space: the bare-colon
      // text is a key decision the plain classifier only makes when Enter confirms it
      if (cursor.at === "hole" && cursor.key === null) {
        const act = classifyHoleInput(cursor.text, true, /*enterPressed*/ true);
        if (act && act.kind === "keyed" && act.viaEnter) {
          const child: Node = { kind: "mapping", entries: [] } as unknown as Node;
          const entry = { key: act.key, edge: "contain", value: child } as unknown as Entry;
          return ok({
            ...state,
            doc: insertEntry(doc, cursor.path, cursor.index, entry),
            cursor: { at: "hole", path: [...cursor.path, cursor.index], index: 0, text: "", key: null },
          });
        }
      }
      const committed = commitPending(state);
      if (!committed) return refuse(state);
      const cur = committed.cursor;
      const entryPath = cur.at === "token" || cur.at === "key" ? cur.path
        : cursor.at === "hole" ? [...cursor.path, cursor.index] : cursor.path;
      // THE LEVEL RULE: Enter DESCENDS into what was just committed — the next hole opens INSIDE
      // the entry's value (an omni-in-waiting for a scalar; the IR holds scalar+entries natively),
      // and a same-level sibling costs one Shift-Tab (dedent). This is what every corpus script
      // is written against.
      const value = entryPath.length ? entryAt(committed.doc, entryPath)?.value : committed.doc.root;
      const depth = value && !isPointer(value) ? ((value as Node).entries ?? []).length : 0;
      return ok({ ...committed, cursor: { at: "hole", path: entryPath, index: depth, text: "", key: null } });
    }

    // Not implemented yet: tokenKey, quotedKey, reopenQuote, quoteExit*, nestValue. A key the
    // grammar CLAIMS must never fall through to the browser (a silent Tab would walk the focus
    // out of the editor) — an unimplemented intent REFUSES, visibly.
    default:
      return refuse(state);
  }
}
