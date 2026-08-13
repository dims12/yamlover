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

import { interpret, type Intent, type Site } from "./grammar/dispatch";
import { classifyHoleInput, keyedEditParts, quoteSource, unquoteSource } from "./grammar/keys";
import { isProvisionalValue, markerTemplate, nullScalar, pointerTemplate, quotedTemplate, type Template } from "./template";
import { joinPortions, portionsOfRaw } from "./grammar/portions";
import {
  blockRawOf, bracketOf, dialectOf, entryAt, isContainer, isFlow, isSpread, nodeAt, sourceOf, trySourceOf,
  type Cursor, type Document, type EditorState, type Entry, type Node, type Path, type RefEntry, type Value,
} from "./state";
import { parseSchemaRef, parseYamlover, unquoteKey } from "../../parser/ts/src/yamlover.ts";
import { schemaTagToken } from "../../parser/ts/src/serialize-yamlover.ts";
import { anchorBody, keyRawWorthKeeping } from "../../parser/ts/src/serialize-common.ts";
import { makeAnchor, parsePointer, renderPointer } from "../../parser/ts/src/pointer.ts";
import { isPointer, type Anchor, type Pointer } from "../../parser/ts/src/ir.ts";
import { formatFromMetaTag, proseFormatOfTag } from "./chapter/format";
import { schemaTextOf } from "./state";

// ---------------------------------------------------------------------------- //
// Immutable IR surgery
// ---------------------------------------------------------------------------- //

/** Exported for the CHAPTER machine (src/chapter/) — the same immutable surgery, one source. */
export function withNode(doc: Document, path: Path, fn: (n: Node) => Node): Document {
  const rec = (v: Node, p: Path): Node => {
    if (p.length === 0) return fn(v);
    const entries = [...(v.entries ?? [])];
    const e = entries[p[0]];
    entries[p[0]] = { ...e, value: rec(e.value as Node, p.slice(1)) } as Entry;
    return { ...v, entries } as Node;
  };
  return { ...doc, root: rec(doc.root as Node, path) };
}

export function insertEntry(doc: Document, containerPath: Path, index: number, entry: Entry): Document {
  return withNode(doc, containerPath, (n) => {
    const entries = [...(n.entries ?? [])];
    entries.splice(index, 0, entry);
    return { ...n, entries } as Node;
  });
}

export function removeEntryAt(doc: Document, containerPath: Path, index: number): Document {
  return withNode(doc, containerPath, (n) => {
    const entries = [...(n.entries ?? [])];
    entries.splice(index, 1);
    return { ...n, entries } as Node;
  });
}

/** Replace the VALUE of the entry at `path` — withNode's twin for values a Node walk cannot
 *  reach (a pointer leaf, or a container BECOMING a pointer). The entry's edge follows the
 *  value's kind (`ref` for a pointer), the IR invariant. Never the root — the parser refuses
 *  a top-level pointer, and the callers gate that before coming here. */
function withValue(doc: Document, path: Path, value: Value): Document {
  return withNode(doc, path.slice(0, -1), (n) => {
    const entries = [...(n.entries ?? [])];
    const idx = path[path.length - 1];
    entries[idx] = { ...entries[idx], value, edge: isPointer(value) ? "ref" : "contain" } as Entry;
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

/** A value read in VALUE POSITION — the parse of `x: <text>`, the fallback for NAMED holes
 *  whose text is not a standalone scalar. Under the FLAT-ROW gate (`flat` — a block container
 *  in a flat-rows dialect) a `key2: value` tail commits as the STRUCTURE the file grammar
 *  reads: the flat chain, its segments already wearing the yamlover/key/flat concrete
 *  (docs/language/flattening) — paste parity with typing's live pivot; the quote face is the
 *  escape for a scalar CONTAINING `: `. Without the gate the non-scalar refuses (YAML ZCZ6:
 *  no one-line nested mapping — flow containers, json dialects). */
function valueScalarFromText(text: string, flat: boolean): Node | null {
  const t = text.trim();
  if (t === "" || t.includes("\n")) return null;
  try {
    const v = (parseYamlover("x: " + t, "<cell>").root as Node).entries?.[0]?.value;
    if (!v || isPointer(v)) return null;
    if ((v as Node).kind !== "scalar" || ((v as Node).entries ?? []).length > 0) {
      if (!flat || (v as Node).kind !== "mapping" || isFlow(v as Node)) return null;
      return v as Node;
    }
    const s = v as { value?: unknown; raw?: string; meta?: unknown };
    return { kind: "scalar", value: s.value, ...(s.raw !== undefined ? { raw: s.raw } : {}) } as unknown as Node;
  } catch {
    return null;
  }
}

/** A Pointer from a typed RAW (the text after `*`): parsed base+steps plus the SPACED display
 *  raw, so both the serializer and the sync's compact respell are total over it. Null when the
 *  text is not a pointer the wire can carry — empty, unparsable, or the bare current-scope
 *  nothing (`*` alone names nothing). */
export function pointerFromText(text: string): Pointer | null {
  const t = text.trim();
  if (t === "") return null;
  try {
    const p = parsePointer(t);
    if (p.steps.length === 0 && p.base.scope === "current") return null; // `*` alone — no target
    return { ...p, raw: renderPointer(p) };
  } catch {
    return null;
  }
}

/** The full RAW a ref cursor's portions currently spell (no `*`): the committed portions with
 *  the active cell's LIVE text folded in, joined under the scope ladder. */
export function refRawOf(cursor: { text: string; ref?: RefEntry }): string {
  const r = cursor.ref;
  if (!r) return cursor.text;
  const cells = [...r.portions];
  cells[r.active] = cursor.text;
  return joinPortions(cells, r.ladder);
}

/** Seed a RefEntry from an existing raw (a retarget) or a typed rest (the hole's `*` decision):
 *  the spelling decomposes into portions, the caret takes the LAST cell. */
export function refFromRaw(raw: string): { ref: RefEntry; text: string } {
  const { ladder, portions } = portionsOfRaw(raw);
  const cells = portions.length ? portions : [""];
  return { ref: { ladder, portions: cells, active: cells.length - 1 }, text: cells[cells.length - 1] };
}

/** A click on an IDLE portion cell: the active cell's text stands (commitless, like the arrow
 *  walk), the clicked one opens with the caret at its end. */
export function focusPortion(state: EditorState, index: number): EditorState {
  const { cursor } = state;
  if ((cursor.at !== "hole" && cursor.at !== "pick") || !cursor.ref) return state;
  const r = cursor.ref;
  const portions = [...r.portions];
  portions[r.active] = cursor.text;
  const active = Math.max(0, Math.min(index, portions.length - 1));
  return { ...state, refused: false, cursor: { ...cursor, ref: { ...r, portions, active }, text: portions[active], caret: "end" } };
}

/** An empty flow container node, bracket authored by the key typed. */
function emptyFlow(bracket: "{" | "["): Node {
  return { kind: "mapping", entries: [], ...(bracket === "[" ? { array: true } : {}), meta: { style: "flow" } } as unknown as Node;
}

/** IDENTITY meta — `!!<…>` schema, `!!yo`, `!!set`, `&` anchors — is committed labour: a
 *  structural edit that replaces a node WHOLESALE (clearing to empty, pasting over, typing a
 *  fresh flow bracket) carries it onto the replacement. The replacement's OWN fields win (a
 *  pasted tagged clipboard keeps its tag); representation meta (`style`, …) does not carry. */
function keepIdentityMeta(prev: Value | null | undefined, next: Node): Node {
  if (!prev || isPointer(prev)) return next;
  const pm = ((prev as Node).meta ?? {}) as Record<string, unknown>;
  const nm = (next.meta ?? {}) as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const k of ["schema", "yo", "set", "anchors", "derivedFormat"]) {
    if (pm[k] !== undefined && nm[k] === undefined) keep[k] = pm[k];
  }
  if (Object.keys(keep).length === 0) return next;
  return { ...next, meta: { ...keep, ...nm } } as Node;
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
    // the QUOTED cell at entry stage — the same `quoted` rows as a value's paired cell (the
    // shielding included: flow separators inside the quotes are content)
    if (cursor.quote !== undefined) {
      return { ...base, cell: "quoted", container: kind, textEmpty: cursor.text === "", entryDecided: false, entryCommitted: false, quote: cursor.quote };
    }
    // the `*` (or `&`) decision made: the hole's face is the PORTION cells — a reference being
    // entered, or (anchorEntry) the container's bookmark BODY
    if (cursor.ref) {
      return {
        ...base,
        cell: "portion",
        container: kind,
        textEmpty: cursor.text.trim() === "",
        entryDecided: true,
        portionFirst: cursor.ref.active === 0,
        portionLast: cursor.ref.active === cursor.ref.portions.length - 1,
        ladder: cursor.ref.ladder,
        ...(cursor.anchor === true ? { anchorEntry: true as const } : {}),
      };
    }
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
    // the QUOTED cell (the paired-closer template): its own rows — the matching quote at the
    // end steps past the projected closer, everything else is shielded text
    if (cursor.quote !== undefined) {
      return { ...base, cell: "quoted", container: containerKind(parent), textEmpty: cursor.text === "", entryCommitted: true, quote: cursor.quote };
    }
    // the template-cells adapter: a token cursor standing in a PROVISIONAL value cell (a
    // temporary null entry) is the classic marked VALUE HOLE for the grammar — the value_hole
    // rows apply verbatim (applyKey dematerializes before dispatch; this mapping keeps the
    // LEGEND and the watchdog honest on the resting view)
    const provEntry = entryAt(doc, cursor.path);
    if ((provEntry?.meta as { temporary?: boolean | "ordinal" } | undefined)?.temporary && isProvisionalValue(provEntry?.value)) {
      return {
        ...base,
        cell: containerKind(parent) === "block" ? "holeEntry" : "holeValue",
        container: containerKind(parent),
        textEmpty: cursor.text.trim() === "",
        entryDecided: true,
        entryCommitted: false,
      };
    }
    // a cursor text WITH a newline is a `|`/`>` BLOCK spelling being edited in the textarea —
    // an <input> can never hold one, so the bit is unambiguous
    const blockToken = cursor.text.includes("\n") ? { blockToken: true } : {};
    return { ...base, cell: "token", container: containerKind(parent), textEmpty: cursor.text.trim() === "", entryCommitted: true, ...blockToken };
  }
  if (cursor.at === "key") {
    const parent = nodeAt(doc, cursor.path.slice(0, -1));
    return { ...base, cell: "key", container: containerKind(parent), textEmpty: cursor.text.trim() === "", entryCommitted: true };
  }
  if (cursor.at === "tag") {
    const parent = cursor.path.length ? nodeAt(doc, cursor.path.slice(0, -1)) : null;
    return { ...base, cell: "tag", container: containerKind(parent), textEmpty: cursor.text.trim() === "", entryCommitted: true };
  }
  if (cursor.at === "anchors") {
    const parent = cursor.path.length ? nodeAt(doc, cursor.path.slice(0, -1)) : null;
    return { ...base, cell: "anchors", container: containerKind(parent), textEmpty: cursor.text.trim() === "", entryCommitted: true };
  }
  if (cursor.at === "ptr") {
    const parent = nodeAt(doc, cursor.path.slice(0, -1));
    return { ...base, cell: "atom", container: containerKind(parent), entryCommitted: true };
  }
  if (cursor.at === "pick") {
    const parent = nodeAt(doc, cursor.path.slice(0, -1));
    // the portion face (the normal path); a ref-less pick is a host-synthesized whole-raw commit
    if (cursor.ref) {
      return {
        ...base,
        cell: "portion",
        container: containerKind(parent),
        textEmpty: cursor.text.trim() === "",
        entryCommitted: true,
        portionFirst: cursor.ref.active === 0,
        portionLast: cursor.ref.active === cursor.ref.portions.length - 1,
        ladder: cursor.ref.ladder,
      };
    }
    return { ...base, cell: "pick", container: containerKind(parent), textEmpty: cursor.text.trim() === "", entryCommitted: true };
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
  | { at: "tag"; path: Path }   // the node's editable `!!<…>` tag cell — before its value
  | { at: "token"; path: Path }
  | { at: "anchors"; path: Path; index?: number } // the node's `&` anchor rows — ONE stop, after its value (a click names the row)
  | { at: "after"; path: Path }
  | { at: "into"; path: Path;
      /** the VACANT-HEAD face requested (the keyrow slot's click): the hole opens ON the key
       *  row, not as the row below — mirrors the hole cursor's `head` bit */
      head?: true }  // the inside of an EMPTY block container — its placeholder slot
  | { at: "ptr"; path: Path };  // a pointer ATOM — walkable, focusable, not text-editable

/** Every caret-occupiable position of the DOCUMENT, in reading order — which is the VISUAL
 *  order: an omni's value line sits at its authored row (`meta.selfAt`) among its fields. */
export function positionsOf(doc: Document): Position[] {
  const out: Position[] = [];
  const anchored = (v: Node): boolean => ((((v.meta ?? {}) as { anchors?: unknown[] }).anchors ?? []).length) > 0;
  const rec = (n: Node, path: Path, from = 0, to = (n.entries ?? []).length): void => {
    for (let i = from; i < to; i++) {
      const e = n.entries![i];
      const p = [...path, i];
      if (e.key != null) out.push({ at: "key", path: p });
      if (isPointer(e.value)) { out.push({ at: "ptr", path: p }); continue; } // the atom IS the position
      // the node's `!!<…>` TAG is a position of its own, before the value — the authored order
      if (((e.value as Node).meta ?? ({} as { schema?: unknown })).schema !== undefined) out.push({ at: "tag", path: p });
      const v = e.value as Node;
      if (v.kind === "scalar") omni(v, p);
      // only a FLOW container has a gap — a closer bracket to stand after. A block container has
      // no closer and the projection draws no gap cell; a position no cell draws must not exist.
      // EVERY empty container instead has an `into` — its clickable inner slot, so the walk
      // (and a click) can always reach the value waiting to be filled: `{}` must never be a wall.
      else if (isContainer(v)) {
        // BLOCK `&` anchors are HEAD rows (the serializer's own order — the walk agrees with
        // the eyes); a flow token keeps them inline after its closer gap
        // the way IN, part one: a KEYED block child's HEAD slot (right of the colon — the ▏
        // affordance, ON the key's own row, so it walks before the anchor head-rows). The walk
        // must reach every cell the eye sees (the arrow keys are not the mouse's poor cousin):
        // standing here opens the hole at position 0 — where a bare scalar makes the OMNI
        // self value (`a: 11` over existing fields), the same landing the click gives.
        // the YAML order: the anchor stands where the value BEGINS (`b: &x` + rows below) -
        // before the head slot, right of the colon
        if (!isFlow(v) && anchored(v)) out.push({ at: "anchors", path: p });
        if ((v.entries ?? []).length > 0 && !isFlow(v) && e.key != null) out.push({ at: "into", path: p });
        // the way IN, part two: an EMPTY container's placeholder slot — its own row below
        if ((v.entries ?? []).length === 0) out.push({ at: "into", path: p });
        rec(v, p);
        if (isFlow(v)) {
          out.push({ at: "after", path: p });
          if (anchored(v)) out.push({ at: "anchors", path: p });
        }
      }
      // anything else (a blob, an unknown kind) is an opaque ATOM — walkable and deletable
      // like a pointer, never editable; a value with no position would be an invisible wall
      else {
        if (anchored(v)) out.push({ at: "anchors", path: p }); // left of the value - the YAML order
        out.push({ at: "ptr", path: p });
      }
    }
  };
  /** the scalar's TOKEN at its authored row among its fields — the walk agrees with the eyes;
   *  its `&` anchors come right AFTER the token (the value line's own decorations) */
  const omni = (v: Node, p: Path): void => {
    const len = (v.entries ?? []).length;
    const at = Math.min(Math.max((v.meta as { selfAt?: number } | undefined)?.selfAt ?? 0, 0), len);
    rec(v, p, 0, at);
    // the YAML order: the anchor stands LEFT of the value (`a: &b 12`) - the walk agrees
    if (anchored(v)) out.push({ at: "anchors", path: p });
    out.push({ at: "token", path: p });
    rec(v, p, at, len);
  };
  const root = doc.root as Node;
  if ((root.meta ?? ({} as { schema?: unknown })).schema !== undefined) out.push({ at: "tag", path: [] });
  if (root.kind === "scalar") omni(root, []);
  else {
    if (!isFlow(root) && anchored(root)) out.push({ at: "anchors", path: [] });
    rec(root, []);
    if (isFlow(root)) {
      out.push({ at: "after", path: [] });
      if (anchored(root)) out.push({ at: "anchors", path: [] });
    }
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
  // the pick cursor stands ON the same position its atom occupies — normalize before matching
  const cur: Cursor = cursor.at === "pick" ? { at: "ptr", path: cursor.path } : cursor;
  const i = list.findIndex((p) => samePos(cur, p));
  return i < 0 ? list.length : i;
}

/** Backspace at the START of a committed value in a BLOCK row — THE CONVERSION LADDER: a keyed
 *  row un-names (`k: v` → `- v`), a keyless row's scalar becomes the container's OWN value
 *  (`- v` → `v` at the container; only ONE scalar — a taken slot refuses, visibly). This is the
 *  explicit deletion of the row's MARKER: one press, one level of the entry's form. */
function applyUnmark(state: EditorState): EditorState {
  const { doc, cursor } = state;
  const d = dialectOf(state);
  if (cursor.at !== "token" || cursor.path.length === 0) return refuse(state);
  const parentPath = cursor.path.slice(0, -1);
  const idx = cursor.path[cursor.path.length - 1];
  const container = nodeAt(doc, parentPath);
  const e = entryAt(doc, cursor.path);
  if (!container || !e || isFlow(container)) return refuse(state);
  if (!d.ordinals) return refuse(state); // the ladder's rungs are block forms this dialect lacks
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
  if (p.at === "key") {
    // a key shares its row with its value — EXCEPT a block container's key (`pats:`), whose row
    // holds no value at all: without the key as anchor the row is invisible to the vertical
    // walk, and ↓ from the row above skips straight past it (reported)
    const n = nodeAt(doc, p.path);
    return n != null && isContainer(n) && !isFlow(n);
  }
  if (p.at === "tag") return false; // a tag shares its node's visual row (the inline spelling)
  // a KEYED block child's HEAD slot (right of the colon) shares the KEY's row — the key is
  // that row's anchor; only an EMPTY container's `into` is a row of its own (the placeholder)
  if (p.at === "into") {
    const n = nodeAt(doc, p.path);
    if (n && (n.entries ?? []).length > 0) return false;
  }
  // a KEYED block child's `&` anchors ride the KEY's row too (the normalized anchor home is
  // the entry's own row) — the key stays that row's one anchor
  if (p.at === "anchors" && p.path.length > 0) {
    const e = entryAt(doc, p.path);
    const v = e?.value;
    if (e?.key != null && v !== undefined && !isPointer(v) && (v as Node).kind === "mapping" && !isFlow(v as Node)) return false;
  }
  // a ONE-LINE empty container's row is represented by its `into` slot — the gap past its closer
  // would double the row up. A SPREAD empty container's closer takes its OWN row, so its gap
  // stays an anchor (↓ from inside lands on the `}` row, where `,` opens the next sibling).
  if (p.at === "after") {
    const n = nodeAt(doc, p.path);
    if (n && !isSpread(n) && (n.entries ?? []).length === 0) return false;
  }
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
    // …but a CONTAINER's key (or tag) row holds no value, so it has no anchor of its own: the
    // first anchor at-or-after it already lies on the NEXT visual row — stepping down lands on
    // that anchor itself, never skips past it (reported: ↓ from a nested `pats:` key jumped two
    // rows). Same-row test: the anchor's position sits at the cursor's own entry path.
    const ownRow =
      (state.cursor.at !== "key" && state.cursor.at !== "tag") ||
      (mineIdx !== -1 && list[anchors[mine]].path.join(".") === state.cursor.path.join("."));
    const t = dir > 0 && !ownRow ? mine : mine + dir;
    target = t >= 0 && t < anchors.length ? anchors[t] : undefined;
  }
  if (target === undefined) return refuse(state);
  const c = toCursor(s.doc, list[target]);
  return ok({ ...s, cursor: c.at === "token" || c.at === "key" || c.at === "tag" || c.at === "anchors" ? { ...c, caret: "end" } : c });
}

/** A block scalar's EDIT TEXT — the reparseable spelling: the authored header, then the body
 *  re-indented by the parser's step. This is what the cursor holds while a `|`/`>` scalar is
 *  edited (the de-indented raw is NOT reparseable and, flattened into an input, stripped the
 *  newlines — the corruption this closes). Null: not a block scalar. */
export function blockEditText(v: Value): string | null {
  const b = blockRawOf(v);
  if (b === null) return null;
  return b.header + "\n" + b.lines.map((l) => (l === "" ? "" : "  " + l)).join("\n");
}

/** The edit text split back: the header line and the DE-INDENTED body (the textarea's value).
 *  Null: not a block spelling. */
export function blockBodyOf(text: string): { header: string; body: string } | null {
  const nl = text.indexOf("\n");
  const header = nl === -1 ? text : text.slice(0, nl);
  if (!/^[|>][+-]?$/.test(header)) return null;
  const body = nl === -1 ? "" : text.slice(nl + 1);
  return { header, body: body.split("\n").map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n") };
}

/** The inverse — the textarea's body re-composed under the header as the cursor's edit text. */
export function blockTextFrom(header: string, body: string): string {
  if (body === "") return header;
  return header + "\n" + body.split("\n").map((l) => (l === "" ? "" : "  " + l)).join("\n");
}

function toCursor(doc: Document, p: Position): Cursor {
  if (p.at === "token") {
    const e = entryAt(doc, p.path);
    const v = (p.path.length === 0 ? (doc.root as Node) : (e?.value as Node)) as { raw?: string; value?: unknown };
    // a PROVISIONAL row's value cell opens EMPTY — the template's "type the value here",
    // never the spelled `null` nobody typed (the template-cells doctrine)
    if ((e?.meta as { temporary?: boolean | "ordinal" } | undefined)?.temporary && isProvisionalValue(e?.value)) {
      return { at: "token", path: p.path, text: "" };
    }
    // a simply-QUOTED scalar reopens as the paired-closer cell — its INNER text, the closer
    // projected from the style (editing `"hi"` and entering it are the same face)
    const q = typeof v?.raw === "string" ? unquoteSource(v.raw) : null;
    if (q !== null) return { at: "token", path: p.path, text: q.inner, quote: q.quote };
    const block = v ? blockEditText(v as Value) : null;
    return { at: "token", path: p.path, text: block ?? String(v?.raw ?? v?.value ?? "") };
  }
  if (p.at === "key") return { at: "key", path: p.path, text: String(entryAt(doc, p.path)?.key ?? "") };
  if (p.at === "tag") {
    const v = p.path.length === 0 ? (doc.root as Node) : (entryAt(doc, p.path)?.value ?? null);
    return { at: "tag", path: p.path, text: (v !== null ? schemaTextOf(v) : null) ?? "" };
  }
  if (p.at === "anchors") {
    const v = p.path.length === 0 ? (doc.root as Node) : (entryAt(doc, p.path)?.value ?? null);
    const first = v !== null && !isPointer(v) ? (((v as Node).meta ?? {}) as { anchors?: Anchor[] }).anchors?.[0] : undefined;
    return { at: "anchors", path: p.path, index: 0, text: first !== undefined ? anchorBody(first) : "" };
  }
  if (p.at === "into") {
    // walking/clicking IN lands the VACANT-HEAD face when the container hangs off a key (the
    // cell right of the colon); a keyless/root container keeps the plain row hole
    const e = entryAt(doc, p.path);
    const head = e?.key != null && !isFlow(nodeAt(doc, p.path) ?? ({} as Node)) ? { head: true as const } : {};
    return { at: "hole", path: p.path, index: 0, text: "", key: null, ...head };
  }
  if (p.at === "ptr") return { at: "ptr", path: p.path };
  return { at: "after", path: p.path };
}

// ---------------------------------------------------------------------------- //
// Commit points
// ---------------------------------------------------------------------------- //

/** Land the cursor's pending content into the document. Returns null when the pending content
 *  cannot land (an unnamed element in a `{`, a token that is not a scalar) — the caller refuses.
 *  Exported for the page's whole-document actions (copy commits first; a failure is the ring). */
/** The hole's key plus its AUTHORED spelling (EntryMeta.keyRaw) as entry fields — the keyRaw
 *  rides only when it differs from the canonical emission (the parser's one representation
 *  law), so a plainly-typed key stays meta-free. Every entry a hole materializes goes
 *  through here — quoted keys survive whichever boundary lands them. */
function keyFields(cursor: { key: string | null; keyRaw?: string; flat?: true }): Pick<Entry, "key" | "meta"> {
  const meta = {
    ...(cursor.key !== null && cursor.keyRaw !== undefined && keyRawWorthKeeping(cursor.keyRaw, cursor.key)
      ? { keyRaw: cursor.keyRaw } : {}),
    // a FLAT-ROW segment commits its concrete — the serializer re-emits the authored fold
    ...(cursor.key !== null && cursor.flat === true ? { keyConcrete: "yamlover/key/flat" } : {}),
  };
  return { key: cursor.key, ...(Object.keys(meta).length > 0 ? { meta } : {}) };
}

/** A committed value makes the FLAT-chain intermediates above it committed labour: the pivot
 *  marks them `meta.temporary` (the whole chain is ONE gesture, withheld from the wire until
 *  a real value lands — the template-cells law), and the first commit under them clears the
 *  flag along the path, so the sync flushes the chain as one insert spelling the fold. */
function unTempAlong(doc: Document, path: Path): Document {
  let out = doc;
  for (let i = 1; i <= path.length; i++) {
    const p = path.slice(0, i);
    const e = entryAt(out, p);
    if ((e?.meta as { temporary?: boolean | "ordinal" } | undefined)?.temporary !== true) continue;
    out = withNode(out, p.slice(0, -1), (n) => {
      const entries = [...(n.entries ?? [])];
      const idx = p[p.length - 1];
      const { temporary: _t, ...rest } = (entries[idx].meta ?? {}) as Record<string, unknown>;
      const { meta: _m, ...bare } = entries[idx] as Entry & { meta?: unknown };
      entries[idx] = (Object.keys(rest).length > 0 ? { ...bare, meta: rest } : bare) as Entry;
      return { ...n, entries } as Node;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------- //
// THE TEMPLATE-CELLS ADAPTER (template.ts): the provisional value cell is a materialized
// VIEW of the classic marked hole. Between keys the DECIDED entry stands in the document
// (null value, `meta.temporary`, drawn as real cells); for every key it DEMATERIALIZES back
// to the marked-hole cursor, the untouched hole machine runs, and the result REMATERIALIZES.
// The old grammar therefore stays byte-identical by construction; the deliberate divergences
// (walk-away withholds instead of minting `""`, the quoted cell, the materialized pick) are
// implemented as such and only as such.
// ---------------------------------------------------------------------------------------- //

interface Provisional { parentPath: Path; idx: number; entry: Entry }

/** The materialized-view detector: a token/pick cursor standing at a `temporary` entry whose
 *  value is still the untouched provisional null. */
function provisionalOf(state: EditorState): Provisional | null {
  const c = state.cursor;
  if (c.at !== "token" && c.at !== "pick") return null;
  if (c.at === "token" && c.quote !== undefined) return null; // the quoted cell runs its own rows
  if (c.at === "pick" && c.ref === undefined) return null;
  if (c.path.length === 0) return null;
  const e = entryAt(state.doc, c.path);
  if (!e || !(e.meta as { temporary?: boolean | "ordinal" } | undefined)?.temporary || !isProvisionalValue(e.value)) return null;
  return { parentPath: c.path.slice(0, -1), idx: c.path[c.path.length - 1], entry: e };
}

/** View → state: the provisional entry leaves the document and the classic marked hole
 *  returns, pending text (and a pick's portions) riding the cursor as they always did. */
function dematerialize(state: EditorState, prov: Provisional): EditorState {
  const c = state.cursor;
  const meta = (prov.entry.meta ?? {}) as { keyRaw?: string; keyConcrete?: string; temporary?: boolean | "ordinal" };
  const hole: Cursor = {
    at: "hole", path: prov.parentPath, index: prov.idx,
    text: c.at === "token" || c.at === "pick" ? c.text : "",
    key: prov.entry.key,
    ...(meta.keyRaw !== undefined ? { keyRaw: meta.keyRaw } : {}),
    ...(meta.keyConcrete !== undefined ? { flat: true as const } : {}),
    // the `- ` DECISION is recorded in the temporary flag's spelling — a keyless entry a
    // plain hole's `*` materialized must NOT dematerialize into an ordinal (the omni and
    // whole-value rules branch on it)
    ...(meta.temporary === "ordinal" ? { ordinal: true as const } : {}),
    ...(c.at === "pick" && c.ref !== undefined ? { ref: c.ref } : {}),
  };
  return { ...state, doc: removeEntryAt(state.doc, prov.parentPath, prov.idx), cursor: hole };
}

/** Materialize a template at the hole: the entry lands (temporary when wire-illegal), the
 *  caret takes the template's cell. `text` carries the hole's pending text into the cell. */
function materializeTemplate(state: EditorState, hole: Cursor & { at: "hole" }, t: Template, text = ""): EditorState {
  const keyMeta = keyFields(hole).meta as Record<string, unknown> | undefined;
  const meta = { ...(keyMeta ?? {}), ...(t.temporary ? { temporary: hole.ordinal === true ? "ordinal" : true } : {}) };
  const entry = {
    key: hole.key, edge: "contain", value: t.value,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  } as unknown as Entry;
  const entryPath = [...hole.path, hole.index];
  const cursor = t.cursor(entryPath);
  return {
    ...state,
    doc: insertEntry(state.doc, hole.path, hole.index, entry),
    cursor: cursor.at === "token" ? { ...cursor, text } : cursor,
  };
}

/** State → view: a resting MARKED hole (key or `- ` decided; a `*` ref; a bare opening
 *  quote in value position) materializes its template. Everything undecided — a keyless
 *  unquoted hole, an anchor body, a flow-map pair with no name yet — stays the hole. */
function rematerialize(state: EditorState): EditorState {
  const c = state.cursor;
  if (c.at !== "hole" || c.anchor === true) return state;
  const container = nodeAt(state.doc, c.path);
  if (!container) return state;
  const flowMapUnnamed = isFlow(container) && bracketOf(container) === "{" && c.key === null && c.ordinal !== true;
  const marked = c.key !== null || c.ordinal === true;
  const seqValue = isFlow(container) && bracketOf(container) === "[";
  if (c.ref !== undefined) {
    // the `*` decision — the SAME materialized-entry law: the entry exists (null, temporary),
    // the portions render as the value template over the PICK cursor
    if (flowMapUnnamed || !dialectOf(state).pointers) return state;
    const t = pointerTemplate();
    const withRef = materializeTemplate(state, c, t);
    return { ...withRef, cursor: { ...(withRef.cursor as Cursor & { at: "pick" }), text: c.text, ref: c.ref,
      ...(c.caret !== undefined ? { caret: c.caret } : {}) } };
  }
  const bare = c.text.trimStart(); // the `, "` habit — leading space is formatting, not content
  if (c.head === true && (bare === '"' || bare === "'")) {
    // the VACANT HEAD takes the quote as the OMNI SELF value's opening: the container becomes
    // the empty quoted scalar (its entries survive — the omni form), the paired cell opens in
    // place on the key row
    const q = bare as '"' | "'";
    return {
      ...state,
      doc: withNode(state.doc, c.path, (n) => ({ ...n, kind: "scalar", value: "", raw: quoteSource("", q) } as unknown as Node)),
      cursor: { at: "token", path: c.path, text: "", quote: q },
    };
  }
  if ((marked || seqValue) && (bare === '"' || bare === "'")) {
    // the quote decision in VALUE position — the paired-closer cell (`""` is wire-legal)
    return materializeTemplate(state, { ...c, text: "" }, quotedTemplate(bare as '"' | "'"));
  }
  if (marked) {
    const m = materializeTemplate(state, c, markerTemplate(), c.text);
    return c.caret !== undefined
      ? { ...m, cursor: { ...(m.cursor as Cursor & { at: "token" }), caret: c.caret as "start" | "end" } }
      : m;
  }
  return state;
}

/** After an adapter round-trip: a marked hole the move walked AWAY from used to mint `""` —
 *  the new law keeps the DECIDED row as its temporary entry instead (withheld by the sync).
 *  Detect the abandoned slot (nothing landed there, the caret is elsewhere) and restore it. */
function restoreAbandoned(base: EditorState, next: EditorState, prov: Provisional): EditorState {
  const c = next.cursor;
  const atSlot = (c.at === "hole" && samePath(c.path, prov.parentPath) && c.index === prov.idx)
    || ((c.at === "token" || c.at === "pick" || c.at === "key" || c.at === "ptr") && samePath(c.path, [...prov.parentPath, prov.idx]));
  if (atSlot) return next; // the machine answered AT the slot (undo, commit, conversion) — its answer stands
  if (provisionalOf(next) !== null) return next; // the row TRAVELED with the caret (indent/dedent moved the hole)
  const parent = nodeAt(next.doc, prov.parentPath);
  if (!parent) return next; // the slot's container itself is gone — nothing to restore into
  const had = (nodeAt(base.doc, prov.parentPath)?.entries ?? []).length;
  if ((parent.entries ?? []).length !== had) return next; // something landed (a commit) — it stands
  return { ...next, doc: insertEntry(next.doc, prov.parentPath, prov.idx, prov.entry) };
}

const samePath = (a: Path, b: Path): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function commitPending(state: EditorState): EditorState | null {
  // the template-cells adapter: a PROVISIONAL entry commits through the classic hole machine.
  // The one deliberate divergence — WALK-AWAY with nothing typed used to mint `k: ""`; the
  // decided row now STAYS its temporary entry, drawn locally and withheld from the wire.
  const provC = provisionalOf(state);
  if (provC !== null) {
    if (state.cursor.at === "token" && state.cursor.text.trim() === "") return state; // withheld
    return commitPending(dematerialize(state, provC));
  }
  const { doc } = state;
  let { cursor } = state;
  const d = dialectOf(state);
  if (cursor.at === "hole") {
    // an OPEN quoted cell commits as its spelled token — the walk-away closes the quote
    if (cursor.quote !== undefined) {
      const { quote: qq, ...rest } = cursor;
      cursor = { ...rest, text: quoteSource(cursor.text, qq) };
      state = { ...state, cursor };
    }
    // nothing pending — and a DECIDED empty hole (`k: `, `- `) is no longer minted into `""`:
    // its materialized temporary row is the resting state (the walk-away law)
    if (!cursor.ref && cursor.text.trim() === "") return state;
    const container = nodeAt(doc, cursor.path);
    if (!container) return null;
    if (cursor.key === null && bracketOf(container) === "{" && isFlow(container)) return null; // an unnamed pair cannot land in `{`
    // THE `&` DECISION: the portions spell a BOOKMARK BODY for the hole's CONTAINER — the
    // own-line `&: path` law (docs/language/pointers/bookmarks: the line attaches to the node
    // whose block holds it). The commit RECURSES through the anchors-row machinery (the ADD
    // slot) — makeAnchor, setAnchors and the refusal ring live there once — and then restores
    // the hole at its own index: the bookmark is a decoration, the user's place is the hole.
    if (cursor.anchor === true && cursor.ref !== undefined) {
      const raw = refRawOf(cursor).trim();
      if (raw === "") return null; // nothing to bookmark — the ring
      const len = ((((container as Node).meta ?? {}) as { anchors?: Anchor[] }).anchors ?? []).length;
      const committed = commitPending({ ...state, cursor: { at: "anchors", path: cursor.path, index: len, text: raw } });
      if (committed === null) return null; // not a bookmark SPELLING (a position claim rings)
      const { anchor: _a, ref: _r, caret: _c, ...hole } = cursor;
      return { ...committed, cursor: { ...hole, text: "" } };
    }
    // A REFERENCE: `*`-led text commits as a POINTER value, never a scalar. A pointer has no
    // SELF-VALUE form (the parser refuses a top-level pointer, and an omni's self line is a
    // scalar), so the omni diversion does not apply: a bare pointer lands as the KEYLESS
    // member it is (`*x` ≡ `- *x` — the chapter pointer-array case, legacy parity). The one
    // wholesale exception mirrors the scalar law: the EMPTY container a `k:` ⏎ descend
    // opened takes the pointer as the entry's whole value (`k: *x` in two gestures) — never
    // the ROOT, which must stay a document.
    if ((cursor.ref !== undefined || cursor.text.trim().startsWith("*")) && d.pointers) {
      // the portion face joins its cells; a legacy flat `*`-text commits its tail verbatim
      const raw = cursor.ref !== undefined ? refRawOf(cursor) : cursor.text.trim().slice(1);
      const ptr = pointerFromText(raw);
      if (!ptr) return null; // not a pointer the wire can carry — the ring, the text stands
      if (cursor.key === null && cursor.ordinal !== true && !isFlow(container)
          && container.kind === "mapping" && (container.entries ?? []).length === 0 && cursor.path.length > 0) {
        return { ...state, doc: unTempAlong(withValue(doc, cursor.path, ptr), cursor.path), cursor: { at: "ptr", path: cursor.path } };
      }
      const entry = { ...keyFields(cursor), edge: "ref", value: ptr } as unknown as Entry;
      return {
        ...state,
        doc: unTempAlong(insertEntry(doc, cursor.path, cursor.index, entry), cursor.path),
        cursor: { at: "ptr", path: [...cursor.path, cursor.index] },
      };
    }
    if (cursor.text.trim() !== "" && !d.scalarToken(cursor.text.trim())) return null; // not a scalar SPELLING here — visibly
    const flatHere = d.flatRows && d.blockContext && !isFlow(container);
    const value = cursor.text.trim() === "" ? scalarFromText('""')!
      : scalarFromText(cursor.text) ?? (cursor.key !== null ? valueScalarFromText(cursor.text, flatHere) : null);
    if (!value) return null;
    // THE OMNI RULE: a bare scalar in a BLOCK container (no key, no `- `) is the container's OWN
    // value — `42` typed into a fresh file is the root value `42`, not `- 42`; typed after
    // `world:` + Enter it makes `world: 42`; typed among entries it makes the value-plus-fields
    // node (!!var). A `- ` decision (cursor.ordinal) opts OUT into a keyless entry instead.
    if (cursor.key === null && cursor.ordinal !== true && !isFlow(container)) {
      // WRITE-ONCE (docs/language/flattening): a NULL-valued, childless node may still take its
      // value — the descend into a committed `a: b: c:` null leaf is never a dead end
      const nullChildless = container.kind === "scalar"
        && (container as { value?: unknown }).value === null && (container.entries ?? []).length === 0;
      if (container.kind !== "mapping" && !nullChildless) return null; // the container already HAS a value
      if ((container.entries ?? []).length > 0 && !d.omniValue) return null; // no value-plus-fields form here
      const v = value as { value?: unknown; raw?: string; meta?: unknown };
      // the value keeps its AUTHORED position among the entries (`meta.selfAt`) — typed after
      // `key1: value1`, it serializes after it; order is committed labour too
      const selfAt = cursor.index > 0 ? { selfAt: cursor.index } : {};
      return {
        ...state,
        doc: unTempAlong(withNode(doc, cursor.path, (n) => {
          const { raw: _r, ...bare } = n as Node & { raw?: string }; // a spelled `~`'s raw must not shadow the new value
          return {
            ...bare, kind: "scalar", value: v.value,
            ...(v.raw !== undefined ? { raw: v.raw } : {}),
            meta: { ...(n.meta ?? {}), ...((v.meta as object) ?? {}), ...selfAt },
          } as unknown as Node;
        }), cursor.path),
        cursor: { at: "token", path: cursor.path, text: cursor.text },
      };
    }
    const entry = { ...keyFields(cursor), edge: "contain", value } as unknown as Entry;
    const doc2 = unTempAlong(insertEntry(doc, cursor.path, cursor.index, entry), cursor.path);
    // a FLAT chain landed whole (a pasted `a: b: 12`): the caret takes the LEAF token — where
    // typing the same text stroke by stroke would have left it
    if ((value as Node).kind === "mapping") {
      let leafPath = [...cursor.path, cursor.index];
      let leaf: Value = value;
      while (!isPointer(leaf) && (leaf as Node).kind === "mapping" && ((leaf as Node).entries ?? []).length === 1) {
        leafPath = [...leafPath, 0];
        leaf = (leaf as Node).entries![0].value;
      }
      const land: Cursor = isPointer(leaf) ? { at: "ptr", path: leafPath }
        : (leaf as Node).kind === "scalar" ? toCursor(doc2, { at: "token", path: leafPath })
        : { at: "key", path: leafPath, text: String(entryAt(doc2, leafPath)?.key ?? "") };
      return { ...state, doc: doc2, cursor: land };
    }
    return {
      ...state,
      doc: doc2,
      cursor: { at: "token", path: [...cursor.path, cursor.index], text: cursor.text },
    };
  }
  if (cursor.at === "pick") {
    const e = entryAt(doc, cursor.path);
    if (!e || !isPointer(e.value)) return null;
    const prev = e.value as Pointer;
    // a typed/pasted leading sigil is tolerated — the cell edits the RAW, the `*` is chrome
    // the portion face joins its cells; on the flat face a typed/pasted leading sigil is
    // tolerated - the cell edits the RAW, the `*` is chrome
    const t = cursor.ref !== undefined ? refRawOf(cursor).trim() : cursor.text.trim().replace(/^\*/, "");
    if (t === prev.raw) return state; // unchanged — leaving is not an edit
    const ptr = pointerFromText(t);
    if (!ptr) return null; // not a pointer — the ring, the text stands
    // SEMANTICALLY unchanged (the same target respelled — a kit reduce re-spelling an
    // authored `pets[1]` as `pets: 1`) is a no-op too: an unasked spelling rewrite must
    // never reach the disk
    try {
      if (prev.base !== undefined && ptr.raw === renderPointer(prev)) return state;
    } catch { /* an unrenderable prev — fall through to the real retarget */ }
    return { ...state, doc: withValue(doc, cursor.path, ptr), cursor: { at: "ptr", path: cursor.path } };
  }
  if (cursor.at === "token") {
    // a QUOTED cell commits its INNER text in its quote style — any content is a string
    // (never a row conversion, never a refusal: the quotes shield everything); the STYLE is
    // authored labour and rides the raw, never re-canonicalized away
    const value = cursor.quote !== undefined
      ? ({ kind: "scalar", value: cursor.text, raw: quoteSource(cursor.text, cursor.quote) } as unknown as Node)
      : scalarFromText(cursor.text);
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
    if (k === "" && !d.ordinals) return null; // this dialect has no keyless rows — the emptied key refuses
    if (k !== "" && !d.bareKey(k) && entryAt(doc, cursor.path)?.key !== k) return null; // a bare spelling this dialect refuses
    const parentPath = cursor.path.slice(0, -1);
    const idx = cursor.path[cursor.path.length - 1];
    const next = {
      ...state,
      doc: withNode(doc, parentPath, (n) => {
        const entries = [...(n.entries ?? [])];
        const e0 = entries[idx] as Entry;
        // a RENAME invalidates the authored key spelling — strip keyRaw so the serializer
        // never has to fall back on its reparse guard (an unchanged key keeps it)
        let meta = e0.meta as Record<string, unknown> | undefined;
        if (k !== e0.key && meta?.keyRaw !== undefined) {
          const { keyRaw: _kr, ...rest } = meta;
          meta = Object.keys(rest).length > 0 ? rest : undefined;
        }
        entries[idx] = { ...e0, key: k === "" ? null : k, ...(meta !== undefined ? { meta } : {}) } as Entry;
        if (meta === undefined) delete (entries[idx] as { meta?: unknown }).meta;
        return { ...n, entries } as Node;
      }),
    };
    if (k !== "") return next;
    // the key CELL is gone — the caret lands on the entry's value (a cell that exists)
    const val = entryAt(doc, cursor.path)?.value;
    const cursorAfter: Cursor = !val
      ? { at: "hole", path: parentPath, index: idx, text: "", key: null }
      : isPointer(val)
      ? { at: "ptr", path: cursor.path }
      : (val as Node).kind === "scalar" && ((val as Node).entries ?? []).length === 0
        ? { at: "token", path: cursor.path, text: String((val as { raw?: string }).raw ?? (val as { value?: unknown }).value ?? ""), caret: "start" }
        : isFlow(val as Node)
          ? { at: "after", path: cursor.path }
          : { at: "hole", path: cursor.path, index: 0, text: "", key: null };
    return { ...next, cursor: cursorAfter };
  }
  if (cursor.at === "tag") {
    const text = cursor.text.replace(/ /g, " ").trim();
    const node = cursor.path.length === 0 ? (doc.root as Node) : (entryAt(doc, cursor.path)?.value as Node | undefined);
    if (!node || isPointer(node as unknown as Parameters<typeof isPointer>[0])) return null;
    // an EMPTIED tag commits as the DROP (the `!!<…>` line goes, the node stays) — refusing
    // would trap the caret in a cell it can only Backspace out of, the key cell's own rule
    if (text === "") return dropTag(state, cursor.path);
    let schema: ReturnType<typeof parseSchemaRef>;
    try { schema = parseSchemaRef(text); } catch { return null; } // not a tag SPELLING — the caller refuses
    try { schemaTagToken(schema); } catch { return null; }        // unrepresentable content refuses too
    // the folded format rides along, the way the wire stamps it (chapter/format's fold)
    const df = formatFromMetaTag(text) ?? proseFormatOfTag(text);
    const stamp = (n: Node): Node => {
      const meta = { ...(n.meta ?? {}), schema } as Record<string, unknown>;
      if (df != null) meta.derivedFormat = df; else delete meta.derivedFormat;
      return { ...n, meta } as unknown as Node;
    };
    return {
      ...state,
      doc: cursor.path.length === 0 ? { ...doc, root: stamp(doc.root as Node) } : withNode(doc, cursor.path, stamp),
    };
  }
  if (cursor.at === "anchors") {
    const node = cursor.path.length === 0 ? (doc.root as Node) : (entryAt(doc, cursor.path)?.value as Node | undefined);
    if (!node || isPointer(node as unknown as Parameters<typeof isPointer>[0])) return null;
    const anchors = [...((((node as Node).meta ?? {}) as { anchors?: Anchor[] }).anchors ?? [])];
    const text = cursor.text.trim();
    const isAdd = cursor.index >= anchors.length;
    if (text === "") {
      if (isAdd) return state; // the untouched ADD slot — nothing pending
      // an emptied row commits as that anchor's REMOVAL (one row, one anchor)
      anchors.splice(cursor.index, 1);
      const next = setAnchors(state, cursor.path, anchors);
      return anchors.length === 0
        ? { ...next, cursor: landOnNode(next.doc, cursor.path) } // the stop is gone — land on the node
        : { ...next, cursor: { at: "anchors", path: cursor.path, index: Math.min(cursor.index, anchors.length - 1), text: anchorBody(anchors[Math.min(cursor.index, anchors.length - 1)]) } };
    }
    let a: Anchor;
    try { a = makeAnchor(text, (m: string): never => { throw new Error(m); }); } catch { return null; } // not an anchor SPELLING — refuses
    if (isAdd) anchors.push(a); else anchors[cursor.index] = a;
    return { ...setAnchors(state, cursor.path, anchors), cursor: { ...cursor, text: anchorBody(a) } };
  }
  return state;
}

/** Rewrite the node's anchor list (empty ⇒ the meta key leaves). */
function setAnchors(state: EditorState, path: Path, anchors: Anchor[]): EditorState {
  const { doc } = state;
  const put = (n: Node): Node => {
    const meta = { ...(n.meta ?? {}) } as Record<string, unknown>;
    if (anchors.length > 0) meta.anchors = anchors; else delete meta.anchors;
    const out = { ...n } as Record<string, unknown>;
    if (Object.keys(meta).length > 0) out.meta = meta; else delete out.meta;
    return out as unknown as Node;
  };
  return { ...state, doc: path.length === 0 ? { ...doc, root: put(doc.root as Node) } : withNode(doc, path, put) };
}

/** The caret's landing on a node's OWN first cell — used when a decoration cell (tag, the last
 *  anchor row) disappears from under it: a cell that exists, the key cell's rule. */
function landOnNode(doc: Document, path: Path): Cursor {
  const val = path.length === 0 ? (doc.root as Node) : (entryAt(doc, path)?.value ?? null);
  return val === null || isPointer(val)
    ? { at: "ptr", path }
    : (val as Node).kind === "scalar" && ((val as Node).entries ?? []).length === 0
      ? { at: "token", path, text: String((val as { raw?: string }).raw ?? (val as { value?: unknown }).value ?? ""), caret: "start" }
      : isFlow(val as Node)
        ? { at: "after", path }
        : { at: "hole", path, index: 0, text: "", key: null };
}

/** Drop the node's `!!<…>` tag (+ the stamped derivedFormat). The tag cell disappears with it,
 *  so the caret lands on the node's own first cell — a cell that exists (the key cell's rule). */
function dropTag(state: EditorState, path: Path): EditorState {
  const { doc } = state;
  const strip = (n: Node): Node => {
    const { schema: _s, derivedFormat: _d, ...meta } = (n.meta ?? {}) as Record<string, unknown>;
    const out = { ...n } as Record<string, unknown>;
    if (Object.keys(meta).length > 0) out.meta = meta; else delete out.meta;
    return out as unknown as Node;
  };
  const nextDoc = path.length === 0 ? { ...doc, root: strip(doc.root as Node) } : withNode(doc, path, strip);
  return { ...state, doc: nextDoc, cursor: landOnNode(nextDoc, path) };
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
  const d = dialectOf(state);
  if (!d.blockContext) return null;                                    // block rows only
  if (entry.key === null && !d.ordinals) return null;                  // no keyless rows here
  if (entry.key !== null && !d.bareKey(entry.key)) return null;        // this dialect wants the key quoted
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

/** The DRY-RUN verdict for one key at this state: does it ACT (change the document or move the
 *  caret), only REFUSE (the ring), or fall through entirely? The legend lights EXACTLY the
 *  acting keys — enabled means acts, never "would ring". */
export function keyVerdict(state: EditorState, k: KeyInput): "acts" | "refuses" | "none" {
  const next = applyKey(state, k);
  if (next === state) return "none";
  if (JSON.stringify(next.doc.root) !== JSON.stringify(state.doc.root)) return "acts";
  if (JSON.stringify(next.cursor) !== JSON.stringify(state.cursor)) return "acts";
  return next.refused ? "refuses" : "none";
}

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
  if (!v) return null;
  if (isPointer(v)) return "*" + ((v as { raw?: string }).raw ?? ""); // the authored round-trip spelling
  // a subtree with no text form (a blob inside — a link atom's bytes live elsewhere) copies
  // NOTHING rather than a banner — the caller rings
  const text = trySourceOf({ ...doc, root: v } as Document);
  return text !== null ? text.replace(/\n$/, "") : null;
}

/** Paste INTO A HOLE: the clipboard parses as one yamlover document and its root splices in as
 *  the hole's value (named by the hole's key), under the SAME laws typing obeys — the empty block
 *  root takes it as the document, a bare scalar in a block container is the OMNI value, an
 *  unnamed element cannot land in `{`. A parse failure REFUSES — nothing lost, nothing dropped. */
export function pasteSubtree(state: EditorState, text: string): EditorState {
  // the template-cells adapter: a paste into the PROVISIONAL value cell is the classic paste
  // into the marked hole (the pick face keeps its old refusal — only the token view adapts)
  const prov = provisionalOf(state);
  if (prov !== null && state.cursor.at === "token") {
    const base = dematerialize(state, prov);
    return restoreAbandoned(base, rematerialize(pasteSubtree(base, text)), prov);
  }
  if (state.cursor.at !== "hole" || state.cursor.text.trim() !== "" || text.trim() === "") return refuse(state);
  let node: Node;
  try {
    const root = parseYamlover(text, "<paste>").root;
    if (isPointer(root)) return refuse(state);
    node = root as Node;
  } catch {
    return refuse(state);
  }
  return pasteParsed(state, node);
}

/** The one-value paste laws over an ALREADY-PARSED root (paste.ts hands sniffed JSON5 docs in
 *  here too — they never had a yamlover text form to re-parse). */
export function pasteParsed(state: EditorState, node: Node): EditorState {
  const provP = provisionalOf(state);
  if (provP !== null && state.cursor.at === "token") {
    const base = dematerialize(state, provP);
    return restoreAbandoned(base, rematerialize(pasteParsed(base, node)), provP);
  }
  const { doc, cursor } = state;
  if (cursor.at !== "hole" || cursor.text.trim() !== "") return refuse(state);
  const container = nodeAt(doc, cursor.path);
  if (!container) return refuse(state);
  if (cursor.key === null && isFlow(container) && bracketOf(container) === "{") return refuse(state);
  // BLOCK structure has no one-line spelling — into a flow token it refuses rather than being
  // silently reshaped (a flow-styled paste nests fine)
  if (isFlow(container) && node.kind !== "scalar" && (node.entries ?? []).length > 0 && !isFlow(node)) return refuse(state);
  if (cursor.key === null && cursor.ordinal !== true && !isFlow(container)) {
    if (container.kind !== "mapping") return refuse(state); // the container already HAS a value
    // the EMPTY container takes the paste as its whole value; among entries, a scalar paste is
    // the omni value and a container paste refuses (it could not have been typed there either)
    if ((container.entries ?? []).length === 0) {
      // the paste replaces the container's CONTENT; its identity meta (tag/yo/set/anchors)
      // survives — unless the clipboard brings its own, which wins
      return ok({ ...state, doc: withNode(doc, cursor.path, (n) => keepIdentityMeta(n, node)), cursor: restCursor(node, cursor.path) });
    }
    if (!dialectOf(state).omniValue) return refuse(state); // no value-plus-fields form here — the same law typing obeys
    if (node.kind !== "scalar" || (node.entries ?? []).length > 0) return refuse(state);
    const v = node as { value?: unknown; raw?: string };
    const selfAt = cursor.index > 0 ? { selfAt: cursor.index } : {};
    return ok({
      ...state,
      doc: withNode(doc, cursor.path, (n) => ({ ...n, kind: "scalar", value: v.value, ...(v.raw !== undefined ? { raw: v.raw } : {}), meta: { ...(n.meta ?? {}), ...selfAt } }) as unknown as Node),
      cursor: { at: "token", path: cursor.path, text: String(v.raw ?? v.value ?? "") },
    });
  }
  const entry = { ...keyFields(cursor), edge: "contain", value: node } as unknown as Entry;
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
export interface Edges { atStart: boolean; atEnd: boolean; firstLine?: boolean; lastLine?: boolean; offset?: number }

/** The cursor's text replaced wholesale (a controlled input's onChange — native caret, selection,
 *  mid-text edits and text-level paste all included), then the hole classifier runs. */
export function applyText(state: EditorState, text: string): EditorState {
  // the template-cells adapter (see applyKey): the provisional cell's text runs through the
  // classic marked-hole classifier — `{`, `*`, quotes and nested `k: ` decide there
  const prov = provisionalOf(state);
  if (prov !== null) {
    const base = dematerialize(state, prov);
    return restoreAbandoned(base, rematerialize(applyTextCore(base, text)), prov);
  }
  return rematerialize(applyTextCore(state, text));
}

function applyTextCore(state: EditorState, text: string): EditorState {
  const { cursor } = state;
  // a PORTION cell's leading whitespace is formatting, never content (the hole's own rule:
  // the space after a committed `:` belongs to the previous portion's styling)
  if ((cursor.at === "hole" || cursor.at === "pick") && cursor.ref !== undefined) {
    return ok({ ...state, cursor: { ...cursor, text: text.replace(/^\s+/, "") } });
  }
  if (cursor.at === "token" || cursor.at === "key" || cursor.at === "tag" || cursor.at === "anchors" || cursor.at === "pick") return ok({ ...state, cursor: { ...cursor, text } });
  if (cursor.at !== "hole") return state;
  return classifyHole(ok({ ...state, cursor: { ...cursor, text } }));
}

const ok = (s: EditorState): EditorState => ({ ...s, refused: false });
const refuse = (s: EditorState): EditorState => ({ ...s, refused: true });

export function applyKey(state: EditorState, k: KeyInput, edges?: Edges): EditorState {
  // THE TEMPLATE-CELLS ADAPTER (template.ts): a PROVISIONAL value cell is a materialized VIEW
  // of the classic marked hole — every key round-trips through the untouched hole machine
  // (dematerialize → the old grammar → rematerialize), so the key economics, the corpus and
  // the Backspace ladder are byte-identical BY CONSTRUCTION. Only the QUOTED cell and the
  // materialized PICK run their own (new) rows.
  const prov = provisionalOf(state);
  const base = prov !== null ? dematerialize(state, prov) : state;
  const next = applyKeyCore(base, k, edges);
  // truly unhandled stays IDENTITY — the host reads `next === state` as "the browser's key"
  // (the native caret must move inside the cell) and the watchdog/legend as "not claimed";
  // a reconstructed deep-equal state would replant the caret and blind them both
  if (next === base) return state;
  const out = rematerialize(next);
  return prov !== null ? restoreAbandoned(base, out, prov) : out;
}

function applyKeyCore(state: EditorState, k: KeyInput, edges?: Edges): EditorState {
  const before = sourceOf(state.doc);
  const site = {
    ...siteOf(state),
    ...(edges ? { caretAtStart: edges.atStart, caretAtEnd: edges.atEnd } : {}),
    ...(edges?.firstLine !== undefined ? { caretFirstLine: edges.firstLine } : {}),
    ...(edges?.lastLine !== undefined ? { caretLastLine: edges.lastLine } : {}),
    ...(edges?.offset !== undefined ? { caretOffset: edges.offset } : {}),
  };
  const intent = interpret({ key: k.key, shift: k.shift }, site);
  // the table calls both arrow axes "move"; the vertical pair walks ROWS, not positions — and
  // BACKSPACE at a block value's start is the CONVERSION LADDER, not a walk
  const next = intent
    ? (intent.kind === "move" && (k.key === "ArrowUp" || k.key === "ArrowDown")
        ? applyVertical(state, intent.dir)
        : intent.kind === "move" && intent.dir === -1 && k.key === "Backspace" && state.cursor.at === "token" && state.cursor.quote === undefined
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
  // a PORTION cell: a space typed into the EMPTY cell is formatting (the `: ` habit), consumed
  if ((cursor.at === "hole" || cursor.at === "pick") && cursor.ref !== undefined) {
    if (ch === " " && cursor.text === "") return ok(state);
    return ok({ ...state, cursor: { ...cursor, text: cursor.text + ch } });
  }
  if (cursor.at === "token" || cursor.at === "key" || cursor.at === "tag" || cursor.at === "anchors" || cursor.at === "pick") {
    return ok({ ...state, cursor: { ...cursor, text: cursor.text + ch } });
  }
  if (cursor.at !== "hole") return refuse(state); // a gap takes no text — visibly
  return classifyHole(ok({ ...state, cursor: { ...cursor, text: cursor.text + ch } }));
}

/** Run the hole's text through the classifier; structural prefixes commit structure EAGERLY.
 *  DIALECT gates live here and in the commit points — the classifier itself stays shared. */
function classifyHole(state: EditorState): EditorState {
  const { doc, cursor } = state;
  if (cursor.at !== "hole") return state;
  if (cursor.quote !== undefined) return state; // inside the quoted cell EVERYTHING is content
  const d = dialectOf(state);
  const container = nodeAt(doc, cursor.path);
  const entryStage = d.blockContext && container !== null && !isFlow(container);
  const action = classifyHoleInput(cursor.text, entryStage && cursor.key === null);
  // a QUOTE at the ENTRY stage opens the SAME paired-closer cell a value position gets — only
  // the interpreter inside differs (the closed token returns to the hole's text, where `: `
  // may name the pair — a quoted KEY — or Enter commits it as the scalar). Value positions
  // (a `- `/`k: ` marked hole, a seq element, the vacant head) take theirs in rematerialize.
  {
    const bareQ = cursor.text.trimStart();
    const seqCtx = container !== null && isFlow(container) && bracketOf(container) === "[";
    if (cursor.key === null && cursor.ordinal !== true && cursor.head !== true && !seqCtx
        && (bareQ === '"' || bareQ === "'")) {
      return { ...state, cursor: { ...cursor, quote: bareQ as '"' | "'", text: "" } };
    }
  }
  // A CLOSED QUOTED KEY — `"name": rest` — is a key decision the plain classifier does not make
  // (quote-led text is a quote to it). keyedEditParts parses exactly this shape; quoted VALUES
  // need nothing (the scalar parser takes `"Eurasia"` with its quotes at any commit boundary).
  if ((!action || action.kind === "quote") && cursor.key === null && cursor.text.trimStart().startsWith('"')) {
    const kv = keyedEditParts(cursor.text.trimStart());
    if (kv?.quoted && (container === null || !isFlow(container) || bracketOf(container) === "{")) {
      return { ...state, cursor: { ...cursor, key: kv.key, keyRaw: kv.keyRaw, text: kv.rest } };
    }
  }
  // `b: &…` — the BOOKMARK in the VALUE place: the bookmark belongs to the ENTRY's OWN node
  // (`b:` + its `&: path` line — the own-line law), so the value materializes as the
  // descend's empty container and the `&` decision continues INSIDE it, where the portion
  // face (and its completion) lives. The old inline back door (`&'p: q' 1` typed as literal
  // text) yields to the face — bookmarks are entered, not spelled.
  if (cursor.key !== null && d.anchors && d.blockContext && cursor.text.trimStart().startsWith("&")
      && container !== null && !isFlow(container)) {
    const child: Node = { kind: "mapping", entries: [] } as unknown as Node;
    const entry = { ...keyFields(cursor), edge: "contain", value: child } as unknown as Entry;
    return classifyHole(ok({
      ...state,
      doc: insertEntry(doc, cursor.path, cursor.index, entry),
      // `head: true` — the face STAYS on the key row (the anchor's normalized home), it never
      // jumps to a row below; the committed bookmark displays right there too (keyRowOwns)
      cursor: { at: "hole", path: [...cursor.path, cursor.index], index: 0, text: cursor.text.trimStart(), key: null, head: true },
    }));
  }
  if (!action || action.kind === "text") return state;
  if (action.kind === "flowMap" || action.kind === "flowSeq") {
    const node = emptyFlow(action.kind === "flowSeq" ? "[" : "{");
    // at the EMPTY document root the token IS the document — `[1, 2]` typed into a fresh file is
    // the root value, not a block entry holding one (the same law production learned)
    if (cursor.path.length === 0 && cursor.key === null && cursor.ordinal !== true && (container?.entries ?? []).length === 0 && container && !isFlow(container)) {
      return { ...state, doc: { ...doc, root: keepIdentityMeta(doc.root, node) }, cursor: { at: "hole", path: [], index: 0, text: "", key: null } };
    }
    const entry = { ...keyFields(cursor), edge: "contain", value: node } as unknown as Entry;
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
    // the pair is ALREADY NAMED — `key2: ` typed in the VALUE place extends the key path: a
    // FLAT ROW (docs/language/flattening — `a: b: c` paves `a`→`b`→`c`). The entry lands
    // holding a fresh block mapping and the SAME hole continues inside it as the next
    // segment, wearing the flat concrete so the serializer re-emits the fold on one line.
    // The QUOTE face is the escape — a scalar CONTAINING `: ` is entered quoted, exactly the
    // file's own spelling. Dialects without flat rows keep the old reading: the text is
    // content (YAML ZCZ6: no one-line nested mapping).
    if (cursor.key !== null) {
      if (!d.flatRows || !d.blockContext || container === null || isFlow(container)
          || cursor.ref !== undefined || cursor.ordinal === true) return state;
      if (!d.bareKey(action.key)) return refuse(state);
      const child: Node = { kind: "mapping", entries: [] } as unknown as Node;
      // the intermediate rides `meta.temporary` like any half-built row: the WHOLE chain is one
      // gesture, withheld from the wire until its leaf value commits — then it flushes as ONE
      // insert whose payload spells the fold (the sync's `flat` op), never a bare `key1:` line
      // followed by a nested child that would split the authored row for good
      const kf = keyFields(cursor);
      const entry = { ...kf, meta: { ...(kf.meta ?? {}), temporary: true }, edge: "contain", value: child } as unknown as Entry;
      const { head: _h, keyRaw: _kr, caret: _c, ...base } = cursor;
      return classifyHole(ok({
        ...state,
        doc: insertEntry(doc, cursor.path, cursor.index, entry),
        cursor: { ...base, path: [...cursor.path, cursor.index], index: 0, text: "", key: action.key, flat: true },
      }));
    }
    if (!d.bareKey(action.key)) return refuse(state); // this dialect wants the key QUOTED — visibly
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
    return { ...state, cursor: { ...cursor, key: action.key, keyRaw: undefined, text: "" } };
  }
  if (action.kind === "ordinal") {
    if (!d.ordinals) return state; // the dash stays TEXT — in json it is a number's sign
    return { ...state, cursor: { ...cursor, key: null, ordinal: true, text: "" } }; // `- ` — DECIDED keyless
  }
  if (action.kind === "metaTag") {
    // `!!<` typed in an entry hole: the TAG CELL materializes eagerly on a fresh empty scalar
    // entry (the same eager-structure law as `{` / `[`), caret in the tag's inner text; the
    // committed tag then stamps the entry, and Enter walks on to type its value. MINTED, so
    // no raw — the serializer spells the default (raw-first would keep a `""` verbatim).
    const value = { kind: "scalar", value: "" } as unknown as Value;
    const entry = { ...keyFields(cursor), edge: "contain", value } as unknown as Entry;
    return {
      ...state,
      doc: insertEntry(doc, cursor.path, cursor.index, entry),
      cursor: { at: "tag", path: [...cursor.path, cursor.index], text: "" },
    };
  }
  if (action.kind === "pointer" && d.pointers) {
    // the `*` DECISION: the hole becomes the reference's PORTION cells (state.ts RefEntry) -
    // the entry's shape is decided (a pointer value), and the portions accumulate in the
    // cursor alone until the joined reference parses on commit (cursor-level commits)
    return { ...state, cursor: { ...cursor, ...refFromRaw(action.rest) } };
  }
  if (action.kind === "anchor" && d.anchors && cursor.ordinal !== true) {
    // the `&` DECISION: the SAME portion cells, spelling a BOOKMARK body for the hole's
    // CONTAINER (siteOf reports anchorEntry - the `[` fold is off; the commit routes through
    // the anchors-row machinery and restores the hole)
    return { ...state, cursor: { ...cursor, anchor: true, ...refFromRaw(action.rest) } };
  }
  return state; // quote/block (and a dialect-refused pointer/anchor): D3
}

function applyIntent(state: EditorState, intent: Intent, site: Site): EditorState {
  const { doc, cursor } = state;
  switch (intent.kind) {
    case "nop": {
      // THE ROW-ALLOCATION gesture: Enter on the VACANT-HEAD face (the cell right of the
      // colon) drops the head bit — the SAME hole re-renders as its own templatized row
      // below, the text editor's new-row expectation. Modifications are never blocked; the
      // template changes with the input.
      if (cursor.at === "hole" && cursor.head === true) {
        const { head: _h, ...rest } = cursor;
        return ok({ ...state, cursor: rest });
      }
      // THE LEVEL RULE, descend half: Enter on an empty hole that already NAMED its key commits
      // `key:` with a nested BLOCK container as the value and steps inside (`world:` + Enter).
      // The shared dispatch table calls this site a nop because production resolves it inside its
      // classifier; yed2's key already left the text, so the decision lands here.
      if (cursor.at === "hole" && cursor.key !== null && cursor.text.trim() === "") {
        // the descended-into child is a BLOCK mapping where the dialect has block context,
        // else a flow `{}` (json's `"k": {` — Enter still acts, never a dead key)
        const child: Node = dialectOf(state).blockContext
          ? ({ kind: "mapping", entries: [] } as unknown as Node)
          : emptyFlow("{");
        const entry = { ...keyFields(cursor), edge: "contain", value: child } as unknown as Entry;
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
      return ok({ ...s, cursor: c.at === "token" || c.at === "key" || c.at === "tag" || c.at === "anchors" ? { ...c, caret: intent.dir < 0 ? "end" : "start" } : c });
    }

    case "nextElement": {
      if (cursor.at === "hole" && cursor.text.trim() === "" && cursor.key === null) return refuse(state); // nothing to separate
      const committed = commitPending(state);
      if (!committed) return refuse(state);
      const cur = committed.cursor;
      const entryPath = cur.at === "token" || cur.at === "key" || cur.at === "ptr" ? cur.path : cursor.at === "hole" ? [...cursor.path, cursor.index] : cursor.path;
      const containerPath = entryPath.slice(0, -1);
      const index = entryPath[entryPath.length - 1] + 1;
      let s = committed;
      if (intent.spread && dialectOf(state).spread) { // a no-spread dialect DEGRADES to the plain sibling — never a dead key
        const spreadDoc = spreadUp(s.doc, containerPath);
        if (spreadDoc === null) return refuse(state); // an unspreadable site
        s = { ...s, doc: spreadDoc };
      }
      return ok({ ...s, cursor: { at: "hole", path: containerPath, index, text: "", key: null } });
    }

    case "spreadOrClose": {
      const path = cursor.at === "hole" ? cursor.path : cursor.path.slice(0, -1);
      if (!dialectOf(state).spread) return refuse(state); // no K&R rows in this dialect — visibly
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

    case "siblingBefore": {
      // Enter at the HEAD of a committed row: the row is pushed DOWN — the fresh sibling hole
      // opens BEFORE this entry, caret in it (the text-editor gesture). The ROOT token has no
      // row above it — THE LEVEL RULE's descend applies there instead.
      if (cursor.at !== "token") return refuse(state);
      if (cursor.path.length === 0) return applyIntent(state, { kind: "commit", submit: true }, site);
      const committed = commitPending(state);
      if (!committed) return refuse(state);
      const cur = committed.cursor;
      const entryPath = cur.at === "token" || cur.at === "key" || cur.at === "ptr" ? cur.path : cursor.path;
      return ok({ ...committed, cursor: { at: "hole", path: entryPath.slice(0, -1), index: entryPath[entryPath.length - 1], text: "", key: null } });
    }

    case "reopenToken": {
      if (cursor.at !== "after") return refuse(state);
      const token = nodeAt(doc, cursor.path);
      if (!token) return refuse(state);
      return ok({ ...state, cursor: { at: "hole", path: cursor.path, index: (token.entries ?? []).length, text: "", key: null } });
    }

    case "quoteClose": {
      // the ENTRY-stage quoted cell closes back INTO the hole: the spelled token becomes the
      // hole's text, where `: ` may then name the pair (the quoted-key recovery) or Enter
      // commits the scalar — the same continuation the typed spelling always had
      if (cursor.at === "hole" && cursor.quote !== undefined) {
        const { quote: qq, ...rest } = cursor;
        return ok({ ...state, cursor: { ...rest, text: quoteSource(cursor.text, qq) } });
      }
      // the matching quote at the cell's end: the string COMMITS and the caret steps past the
      // projected closer — the `]`/`}` law applied to the paired-quote template
      if (cursor.at !== "token" || cursor.quote === undefined) return refuse(state);
      const committed = commitPending(state);
      if (committed === null) return refuse(state); // unreachable — quoted content always lands
      return ok({ ...committed, cursor: { at: "token", path: cursor.path, text: quoteSource(cursor.text, cursor.quote), caret: "end" } });
    }

    case "undoMarker": {
      if (cursor.at === "hole" && cursor.quote !== undefined) {
        // the entry-stage quote decision undone — back to the plain hole (the inner text stands)
        const { quote: _q, ...rest } = cursor;
        return ok({ ...state, cursor: rest });
      }
      if (cursor.at === "token" && cursor.quote !== undefined) {
        // the QUOTE decision undone (one press, one level): a named/ordinal row returns to its
        // provisional value cell; a flow-seq element's entry goes back to the hole
        const entry = entryAt(doc, cursor.path);
        const parentPath = cursor.path.slice(0, -1);
        const idx = cursor.path[cursor.path.length - 1];
        const parent = parentPath.length === 0 ? (doc.root as Node) : nodeAt(doc, parentPath);
        // no ENTRY owns this cell (the ROOT scalar) — the quote decision has no marker to fall
        // back to, so the press is the ordinary level removal (the empty-token ladder)
        if (!entry || !parent || cursor.path.length === 0) return applyIntent(state, { kind: "removeLevel" }, site);
        if (entry.key === null && isFlow(parent) && bracketOf(parent) === "[") {
          return ok({ ...state, doc: removeEntryAt(doc, parentPath, idx),
            cursor: { at: "hole", path: parentPath, index: idx, text: "", key: null } });
        }
        // the OMNI HEAD's quote undone: the self value goes, the container returns with its
        // fields intact (committed labour) — the caret back in the vacant head
        if (!isPointer(entry.value) && ((entry.value as Node).entries ?? []).length > 0) {
          return ok({
            ...state,
            doc: withNode(doc, cursor.path, (n) => {
              const { value: _v, raw: _r, ...rest } = n as Record<string, unknown>;
              return { ...rest, kind: "mapping" } as unknown as Node;
            }),
            cursor: { at: "hole", path: cursor.path, index: 0, text: "", key: null, head: true },
          });
        }
        return ok({
          ...state,
          doc: withNode(doc, parentPath, (n) => {
            const entries = [...(n.entries ?? [])];
            entries[idx] = { ...entries[idx], value: nullScalar() as unknown as Value,
              meta: { ...((entries[idx] as Entry).meta ?? {}),
                temporary: (entries[idx] as Entry).key === null ? "ordinal" as const : true } } as Entry;
            return { ...n, entries } as Node;
          }),
          cursor: { at: "token", path: cursor.path, text: "" },
        });
      }
      if (cursor.at === "hole" && cursor.ref !== undefined) {
        // the `*` (or `&`) decision undone - back to the plain empty hole (the portions lived
        // only in the cursor, so nothing else changes; one press, one level)
        const { ref: _ref, anchor: _anchor, caret: _caret, ...rest } = cursor;
        return ok({ ...state, cursor: { ...rest, text: "" } });
      }
      if (cursor.at === "hole" && cursor.key !== null) {
        // un-naming also undoes the FLAT decision — the restored text re-pivots if retyped
        const { flat: _f, ...rest } = cursor;
        return ok({ ...state, cursor: { ...rest, key: null, text: cursor.key } });
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
          return ok({ ...state, cursor: c.at === "token" || c.at === "key" || c.at === "tag" || c.at === "anchors" ? { ...c, caret: "end" } : c });
        }
        // an EMPTY container: one level goes — remove it from its parent. At the ROOT that means
        // undoing the bracket: the document returns to the empty block mapping. (A scalar root
        // took the step-back branch above.)
        if (cursor.path.length === 0) {
          if (!isFlow(container)) return refuse(state); // already the empty document — the bottom, visibly
          return ok({ ...state, doc: { ...doc, root: keepIdentityMeta(doc.root, { kind: "mapping", entries: [] } as unknown as Node) }, cursor: { at: "hole", path: [], index: 0, text: "", key: null } });
        }
        const parentPath = cursor.path.slice(0, -1);
        const idx = cursor.path[cursor.path.length - 1];
        // ONE press, ONE level: the container goes, but a NAME the entry already carried is
        // committed labour — it survives as the named hole (`{key: [` + Backspace → `key: `),
        // and only the NEXT press un-names it (undoMarker). A FLAT segment's concrete is part
        // of that labour: the restored hole keeps the flat bit, so the ladder stays symmetric.
        const removed = entryAt(doc, cursor.path);
        const named = removed?.key ?? null;
        const wasFlat = (removed?.meta as { keyConcrete?: string } | undefined)?.keyConcrete !== undefined;
        return ok({
          ...state,
          doc: removeEntryAt(doc, parentPath, idx),
          cursor: { at: "hole", path: parentPath, index: idx, text: "", key: named,
            ...(named !== null && wasFlat ? { flat: true as const } : {}) },
        });
      }
      if (cursor.at === "tag") {
        // Backspace on the (emptied) tag cell: the TAG goes — one press, one level; the node stays
        return ok(dropTag(state, cursor.path));
      }
      if (cursor.at === "anchors") {
        // Backspace on the (emptied) anchor row: THAT anchor goes — one press, one row
        const committed = commitPending({ ...state, cursor: { ...cursor, text: "" } });
        return committed === null ? refuse(state) : ok(committed);
      }
      if (cursor.at === "token" || cursor.at === "key" || cursor.at === "ptr" || cursor.at === "pick") {
        if (cursor.path.length === 0) {
          // the ROOT clears to the empty document — its identity meta (a data island's tag) stays
          return ok({ ...state, doc: { ...doc, root: keepIdentityMeta(doc.root, { kind: "mapping", entries: [] } as unknown as Node) }, cursor: { at: "hole", path: [], index: 0, text: "", key: null } });
        }
        const parentPath = cursor.path.slice(0, -1);
        const idx = cursor.path[cursor.path.length - 1];
        const e = entryAt(doc, cursor.path);
        if (cursor.at === "key") {
          // un-name: the key goes, the value stays (one press, one level). The caret lands on
          // a cell that EXISTS for the value's kind — a token cursor on a container would be a
          // position no cell draws (the ladder's caret fell to <body> — the reported trap).
          const val = e?.value;
          const landing: Cursor = !val
            ? { at: "hole", path: parentPath, index: idx, text: "", key: null }
            : isPointer(val)
            ? { at: "ptr", path: cursor.path }
            : (val as Node).kind === "scalar" && ((val as Node).entries ?? []).length === 0
              ? { at: "token", path: cursor.path, text: String((val as { raw?: string }).raw ?? (val as { value?: unknown }).value ?? "") }
              : isFlow(val as Node)
                ? { at: "after", path: cursor.path }
                : { at: "hole", path: cursor.path, index: 0, text: "", key: null };
          return ok({
            ...state,
            doc: withNode(doc, parentPath, (n) => {
              const entries = [...(n.entries ?? [])];
              entries[idx] = { ...entries[idx], key: null } as Entry;
              return { ...n, entries } as Node;
            }),
            cursor: landing,
          });
        }
        // an EMPTIED LEAF value cell: the press eats the MARKER too — `a: 11` deleted char by
        // char reads `a: |` and the next press gives `a|`, the text editor's expectation. The
        // characters were the value's level (already deleted one by one); stopping at a named
        // null row would charge an extra press for a level the eye cannot see. A CONTAINER or
        // an omni's fields are real levels and keep the name for one press (committed labour).
        if (cursor.at === "token" && e !== undefined && e !== null && !isPointer(e.value)
            && (e.value as Node).kind === "scalar" && ((e.value as Node).entries ?? []).length === 0) {
          const spelling = (e.meta as { keyRaw?: string } | undefined)?.keyRaw ?? e.key ?? "";
          return ok({
            ...state,
            doc: removeEntryAt(doc, parentPath, idx),
            cursor: { at: "hole", path: parentPath, index: idx, text: spelling, key: null },
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
      const spreadDoc = dialectOf(state).spread ? spreadUp(committed.doc, cursor.path.slice(0, -1)) : null;
      const s = spreadDoc !== null ? { ...committed, doc: spreadDoc } : committed;
      // Enter on a key means the naming is DONE — the caret DESCENDS into the value's HEAD: a
      // fresh hole at the first position, the same landing the typing flow's `k:` ⏎ gives. For
      // an EMPTY container that is what the old value-walk reached anyway (the `into` slot);
      // for a NON-EMPTY one the walk stopped at the first child's cell instead, which left the
      // container's head unreachable — no way back in for its self value, a bookmark, or a new
      // first entry (the reported "all keystrokes are just jumping"). A scalar's hole opens in
      // its fields region at the self line (the commit tail's own rule); a POINTER holds no
      // children, so the hole opens AFTER the entry (the sibling rule); a FLOW value keeps the
      // walk — flow rows edit through their own cells, block-style holes do not exist there.
      if (s.cursor.at === "key" && cursor.at === "key" && site.container === "block") {
        const value = entryAt(s.doc, cursor.path)?.value;
        if (value !== undefined && !isPointer(value) && !isFlow(value as Node)) {
          const node = value as Node;
          const len = (node.entries ?? []).length;
          const at = node.kind === "scalar"
            ? Math.min(Math.max((node.meta as { selfAt?: number } | undefined)?.selfAt ?? 0, 0), len)
            : 0;
          return ok({ ...s, cursor: { at: "hole", path: cursor.path, index: at, text: "", key: null } });
        }
        if (value !== undefined && isPointer(value)) {
          return ok({ ...s, cursor: { at: "hole", path: cursor.path.slice(0, -1), index: cursor.path[cursor.path.length - 1] + 1, text: "", key: null } });
        }
      }
      // the un-named commit (an emptied key) picked its own landing; flow values keep the walk
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

    case "tokenKey": {
      // `:` past a flow token's closer — the TOKEN becomes the entry's KEY (`{}: 12`,
      // `[256, 256]: v`): the committed token re-opens as the NAMED hole, its one-line
      // spelling the authored key token (EntryMeta.keyRaw — the bytes survive). A spread
      // token has no one-line spelling and refuses; so does a named or multi-line one.
      if (cursor.at !== "after") return refuse(state);
      const tokenValue: Value | null = cursor.path.length === 0 ? doc.root : (entryAt(doc, cursor.path)?.value ?? null);
      if (!tokenValue || isPointer(tokenValue)) return refuse(state);
      if (!isFlow(tokenValue as Node) || isSpread(tokenValue as Node)) return refuse(state);
      const token = (() => {
        try { return sourceOf({ ...doc, root: tokenValue } as Document).replace(/\n$/, ""); } catch { return null; }
      })();
      if (token === null || token.includes("\n")) return refuse(state);
      const key = (() => { try { return unquoteKey(token); } catch { return null; } })();
      if (key === null || key === "") return refuse(state);
      const keyRaw = keyRawWorthKeeping(token, key) ? { keyRaw: token } : {};
      if (cursor.path.length === 0) {
        // the ROOT token: the `{`-at-empty-root decision UNDOES — the document becomes the
        // block mapping whose first pair the token names (`{}` + `:` → `{}: …`)
        return ok({
          ...state,
          doc: { ...doc, root: keepIdentityMeta(doc.root, { kind: "mapping", entries: [] } as unknown as Node) },
          cursor: { at: "hole", path: [], index: 0, text: "", key, ...keyRaw },
        });
      }
      const e = entryAt(doc, cursor.path);
      if (!e || e.key !== null || e.nullKey === true) return refuse(state);
      const parentPath = cursor.path.slice(0, -1);
      const idx = cursor.path[cursor.path.length - 1];
      return ok({
        ...state,
        doc: removeEntryAt(doc, parentPath, idx),
        cursor: { at: "hole", path: parentPath, index: idx, text: "", key, ...keyRaw },
      });
    }

    case "pick": {
      // Enter on a pointer atom OPENS the reference for editing: the pick cursor holds the
      // spaced display raw, the pointer stays in the document (no remove+insert churn against
      // the sync flush). An opaque atom (a blob) has no raw to edit — refuse, visibly.
      if (cursor.at !== "ptr") return refuse(state);
      const v = entryAt(doc, cursor.path)?.value;
      if (!v || !isPointer(v)) return refuse(state);
      // the raw decomposes into PORTION cells (state.ts RefEntry), caret in the last one
      return ok({ ...state, cursor: { at: "pick", path: cursor.path, ...refFromRaw((v as Pointer).raw ?? ""), caret: "end" } });
    }

    // ---- the PORTION grammar - a reference entered as cells, wholly in the cursor ---------- //
    case "portionSplit": {
      if ((cursor.at !== "hole" && cursor.at !== "pick") || !cursor.ref) return refuse(state);
      const r = cursor.ref;
      const off = Math.min(site.caretOffset ?? cursor.text.length, cursor.text.length);
      const portions = [...r.portions];
      portions[r.active] = cursor.text.slice(0, off);
      portions.splice(r.active + 1, 0, cursor.text.slice(off));
      return ok({ ...state, cursor: { ...cursor, ref: { ...r, portions, active: r.active + 1 }, text: cursor.text.slice(off), caret: "start" } });
    }
    case "portionMerge": {
      if ((cursor.at !== "hole" && cursor.at !== "pick") || !cursor.ref) return refuse(state);
      const r = cursor.ref;
      const portions = [...r.portions];
      portions[r.active] = cursor.text;
      const i = intent.dir < 0 ? r.active - 1 : r.active;
      if (i < 0 || i + 1 >= portions.length) return refuse(state);
      const junction = portions[i].length; // the caret lands at the JOIN, like a text-editor join
      const merged = portions[i] + portions[i + 1];
      portions.splice(i, 2, merged);
      return ok({ ...state, cursor: { ...cursor, ref: { ...r, portions, active: i }, text: merged, caret: junction } });
    }
    case "portionFold": {
      // `[` in an empty portion: the index belongs to the PREVIOUS portion - `pets` `:` `[`
      // spells `pets[|]`, never the non-canonical `pets: [1]`; the pair projects, caret inside
      if ((cursor.at !== "hole" && cursor.at !== "pick") || !cursor.ref) return refuse(state);
      const r = cursor.ref;
      if (r.active === 0 || cursor.text.trim() !== "") return refuse(state);
      const portions = [...r.portions];
      const merged = portions[r.active - 1] + "[]";
      portions.splice(r.active - 1, 2, merged);
      return ok({ ...state, cursor: { ...cursor, ref: { ...r, portions, active: r.active - 1 }, text: merged, caret: merged.length - 1 } });
    }
    case "portionMove": {
      // arrows walk BETWEEN portion cells commitlessly - the leaving cell's text just stands
      if ((cursor.at !== "hole" && cursor.at !== "pick") || !cursor.ref) return refuse(state);
      const r = cursor.ref;
      const portions = [...r.portions];
      portions[r.active] = cursor.text;
      const active = r.active + intent.dir;
      if (active < 0 || active >= portions.length) return refuse(state);
      return ok({ ...state, cursor: { ...cursor, ref: { ...r, portions, active }, text: portions[active], caret: intent.dir < 0 ? "end" : "start" } });
    }
    case "scope": {
      // the ladder climbs/descends (clamped 0..3) - more colons, wider scope
      if ((cursor.at !== "hole" && cursor.at !== "pick") || !cursor.ref) return refuse(state);
      const r = cursor.ref;
      const ladder = Math.min(3, Math.max(0, r.ladder + intent.dir)) as RefEntry["ladder"];
      if (ladder === r.ladder) return refuse(state);
      return ok({ ...state, cursor: { ...cursor, ref: { ...r, ladder } } });
    }

    case "commit": {
      // an ANCHOR row commits in place — the caret stays on the row (or lands on the node when
      // the emptied row was the last one); descending into the node would make no sense here.
      // The `&` ENTRY face is the same in-place law: the bookmark is a decoration, no entry was
      // born, so the level rule's descend has nothing to enter — the restored hole IS the landing
      if (cursor.at === "anchors" || (cursor.at === "hole" && cursor.anchor === true)) {
        const committed = commitPending(state);
        if (committed === null) return refuse(state);
        // an UNCHANGED body's Enter is "done here" — the caret steps to the neighbouring
        // position (the value, per the YAML order). A same-state return would be a DEAD
        // advertised key (the watchdog's catch): every commit must answer visibly. Sameness
        // is the SERIALIZED text (a re-spelled anchor only sheds its parse spans).
        if (cursor.at === "anchors"
            && JSON.stringify(committed.cursor) === JSON.stringify(cursor)
            && sourceOf(committed.doc) === sourceOf(doc)) {
          return applyIntent(ok(committed), { kind: "move", dir: 1 }, site);
        }
        return ok(committed);
      }
      // `k:` + Enter — the LEVEL RULE's descend spelled without the trailing space: the bare-colon
      // text is a key decision the plain classifier only makes when Enter confirms it
      if (cursor.at === "hole" && cursor.key === null && cursor.ref === undefined) {
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
      // `k2:` + Enter in a NAMED hole — the same descend THROUGH THE FOLD (docs/language/
      // flattening): the chain extends by the typed segment and Enter opens its block below.
      // Without this, committing the bare-colon text landed the segment as a NULL leaf and the
      // level rule descended into the scalar — where every commit refused (the reported dead
      // end with the empty token cell).
      if (cursor.at === "hole" && cursor.key !== null && cursor.ref === undefined && cursor.ordinal !== true) {
        const act = classifyHoleInput(cursor.text, false, /*enterPressed*/ true);
        const d2 = dialectOf(state);
        const container2 = nodeAt(doc, cursor.path);
        if (act && act.kind === "keyed" && act.viaEnter
            && d2.flatRows && d2.blockContext && container2 !== null && !isFlow(container2)) {
          if (!d2.bareKey(act.key)) return refuse(state);
          const kf = keyFields(cursor);
          const mid = { ...kf, meta: { ...(kf.meta ?? {}), temporary: true }, edge: "contain",
            value: { kind: "mapping", entries: [] } } as unknown as Entry;
          const seg = { ...keyFields({ key: act.key, flat: true }), edge: "contain",
            value: { kind: "mapping", entries: [] } } as unknown as Entry;
          const doc2 = insertEntry(insertEntry(doc, cursor.path, cursor.index, mid), [...cursor.path, cursor.index], 0, seg);
          return ok({
            ...state,
            doc: doc2,
            cursor: { at: "hole", path: [...cursor.path, cursor.index, 0], index: 0, text: "", key: null },
          });
        }
      }
      // `|`/`>` + Enter — BLOCK-SCALAR BIRTH: the header allocates the block cell. A valid ""
      // scalar materializes per the hole's shape and the cursor takes the header-with-newline
      // spelling (siteOf's blockToken bit → the textarea face) — the document stays valid, the
      // incomplete body lives in the cursor, exactly the hole doctrine.
      if (cursor.at === "hole" && cursor.ref === undefined) {
        const act = classifyHoleInput(cursor.text, true, /*enterPressed*/ true);
        if (act && act.kind === "block") {
          const container = nodeAt(doc, cursor.path);
          if (!container) return refuse(state);
          if (isFlow(container)) return refuse(state); // a block scalar has no flow spelling
          if (!/^[|>][+-]?$/.test(act.header)) return refuse(state); // digit indicators: no edit-text form (blockBodyOf)
          const blockCursor = (path: Path): Cursor => ({ at: "token", path, text: act.header + "\n" });
          if (cursor.key === null && cursor.ordinal !== true) {
            // the OMNI landing, the same diversion a bare scalar takes: the EMPTY container's
            // whole value; among entries the self line at its authored row; a taken slot refuses
            if (container.kind !== "mapping") return refuse(state);
            if ((container.entries ?? []).length === 0) {
              return ok({
                ...state,
                doc: withNode(doc, cursor.path, (n) => keepIdentityMeta(n, { kind: "scalar", value: "", entries: [] } as unknown as Node)),
                cursor: blockCursor(cursor.path),
              });
            }
            if (!dialectOf(state).omniValue) return refuse(state);
            const selfAt = cursor.index > 0 ? { selfAt: cursor.index } : {};
            return ok({
              ...state,
              doc: withNode(doc, cursor.path, (n) => ({ ...n, kind: "scalar", value: "", meta: { ...(n.meta ?? {}), ...selfAt } }) as unknown as Node),
              cursor: blockCursor(cursor.path),
            });
          }
          const entry = { ...keyFields(cursor), edge: "contain", value: { kind: "scalar", value: "", entries: [] } } as unknown as Entry;
          return ok({
            ...state,
            doc: unTempAlong(insertEntry(doc, cursor.path, cursor.index, entry), cursor.path),
            cursor: blockCursor([...cursor.path, cursor.index]),
          });
        }
      }
      const committed = commitPending(state);
      if (!committed) return refuse(state);
      const cur = committed.cursor;
      const entryPath = cur.at === "token" || cur.at === "key" || cur.at === "ptr" ? cur.path
        : cursor.at === "hole" ? [...cursor.path, cursor.index] : cursor.path;
      // THE LEVEL RULE: Enter DESCENDS into what was just committed — the next hole opens INSIDE
      // the entry's value (an omni-in-waiting for a scalar; the IR holds scalar+entries natively),
      // and a same-level sibling costs one Shift-Tab (dedent). This is what every corpus script
      // is written against.
      const value = entryPath.length ? entryAt(committed.doc, entryPath)?.value : committed.doc.root;
      // THE SIBLING RULE (docs/server/yamlover-editor pointer_committed): a reference holds no children,
      // so its Enter opens the hole AFTER it — the one exception to the level rule's descend
      if (value && isPointer(value) && entryPath.length > 0) {
        return ok({ ...committed, cursor: { at: "hole", path: entryPath.slice(0, -1), index: entryPath[entryPath.length - 1] + 1, text: "", key: null } });
      }
      const node = value && !isPointer(value) ? (value as Node) : null;
      const len = node ? (node.entries ?? []).length : 0;
      // the hole opens on the row RIGHT AFTER the value line — at the omni's `selfAt` among its
      // fields (a fresh scalar has none: index 0), never past fields that already sit below the
      // line (the production editor's enterInto inserts at selfAt too — the reported parity break)
      const at = node && node.kind === "scalar"
        ? Math.min(Math.max((node.meta as { selfAt?: number } | undefined)?.selfAt ?? 0, 0), len)
        : len;
      return ok({ ...committed, cursor: { at: "hole", path: entryPath, index: at, text: "", key: null } });
    }

    // Not implemented yet: nestValue. A key the grammar
    // CLAIMS must never fall through to the browser (a silent Tab would walk the focus out
    // of the editor) — an unimplemented intent REFUSES, visibly.
    default:
      return refuse(state);
  }
}
