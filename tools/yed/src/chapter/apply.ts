// THE CHAPTER EFFECT LAYER — pure transforms over the parser IR, the port of the legacy
// blocks.ts verbs. Every verb returns a whole new ChapterState; ops are NOT emitted here —
// the persistence diff (tools/server yed-sync diffToOps) derives them from the tree change.
// Two legacy laws fall out structurally:
//   - a title-only WRAP is IR-invisible (`- A` is the same line either way), so it diffs to
//     ZERO ops — the wrap lives on `meta.chapterWrapped`, which the diff canon never reads;
//   - an emptied wrapped container IS its scalar again (kind "scalar", entries []), so the
//     unwrap of a childless title is automatically the wrap's exact inverse.

import { isPointer } from "../../../parser/ts/src/ir.ts";
import { parseSchemaRef } from "../../../parser/ts/src/yamlover.ts";
import type { Document, Entry, Node, Path, Value } from "../state";
import { nodeAt } from "../state";
import { insertEntry, removeEntryAt, withNode, type Position } from "../apply";
import { chapterPositionsOf, positionIndex } from "./positions";
import { chapterSiteOf, type ChapterEdges } from "./site";
import { chapterInterpret, type ChapterIntent, type ChapterKey } from "./dispatch";
import { chunkModeOf, enclosingFormat, formatTargetPath, hasSelfValue, isChapterContainer, metaOf, tagContentOf, tagFor, type ChosenFormat } from "./format";

export interface ChapterState {
  doc: Document;
  /** The focused chapter position (a chapterPositionsOf member), or null before the first focus. */
  focus: Position | null;
  /** Where the caret lands INSIDE the focused cell after a programmatic move. */
  caret: number | "start" | "end" | null;
  refused: boolean;
  /** DOM-reset generations, keyed by path: a cell rewrites its contentEditable DOM only when
   *  its rev changes — bumped ONLY on programmatic text changes (split head, join survivor). */
  revs: Record<string, number>;
  log: string[];
}

export const pathKey = (p: Path): string => p.join(".");

export function initialChapterState(doc: Document): ChapterState {
  return { doc, focus: null, caret: null, refused: false, revs: {}, log: [] };
}

/** A prose text as an IR scalar: value only — the serializer owns the default spelling
 *  (bare / quoted / block), which is exactly the legacy proseScalar contract. */
export const proseNode = (text: string): Node => ({ kind: "scalar", value: text } as unknown as Node);
const proseEntry = (text: string): Entry => ({ key: null, edge: "contain", value: proseNode(text) } as unknown as Entry);

const ok = (s: ChapterState, next: Partial<ChapterState>, intent: string): ChapterState =>
  ({ ...s, refused: false, ...next, log: [...s.log.slice(-49), intent] });
const refuse = (s: ChapterState, intent: string): ChapterState =>
  ({ ...s, refused: true, log: [...s.log.slice(-49), `${intent}:refused`] });
const bumpRev = (revs: ChapterState["revs"], p: Path): ChapterState["revs"] =>
  ({ ...revs, [pathKey(p)]: (revs[pathKey(p)] ?? 0) + 1 });

const scalarText = (v: Value): string => String((v as Node & { value?: unknown }).value ?? "");

/** Replace a scalar node's TEXT, dropping any stale authored raw; entries and meta survive
 *  ("committed labour survives" — the omni's fields ride along a title edit). */
const withText = (doc: Document, path: Path, text: string): Document =>
  withNode(doc, path, (n) => {
    const { raw: _raw, ...rest } = n as Node & { raw?: string };
    return { ...rest, kind: "scalar", value: text } as unknown as Node;
  });

/** The user typed into a cell — the controlled-text channel (NOT an intent: text writes are
 *  per-keystroke, coalesced by the flush debounce). Bumps no rev: the cell's DOM already shows
 *  what was typed. An emptied TITLE drops the self line (the legacy setSelf(null) rule). */
export function commitChapterText(s: ChapterState, path: Path, text: string): ChapterState {
  const v = nodeAt(s.doc, path);
  if (!v) return s;
  if (text === "" && isChapterContainer(v) && (v as Node).kind === "scalar" && (v.entries ?? []).length > 0) {
    const doc = dropSelf(s.doc, path);
    // the title CELL vanishes with its self line — the caret must land somewhere (reported:
    // focus lost, editing dead until a click): the chapter's first remaining stop
    const list = chapterPositionsOf(doc);
    const inside = list.find((p) => isPrefix(path, p.path) && p.path.length > path.length) ?? list[0] ?? null;
    return ok(s, { doc, ...(inside ? { focus: inside, caret: "start" as const } : {}) }, "commitText:dropTitle");
  }
  return ok(s, { doc: withText(s.doc, path, text) }, "commitText");
}

/** An omni loses its self line: kind → mapping; selfAt / the wrap flag go with it. */
const dropSelf = (doc: Document, path: Path): Document =>
  withNode(doc, path, (n) => {
    const { value: _v, raw: _r, ...rest } = n as Node & { value?: unknown; raw?: string };
    const { selfAt: _s, chapterWrapped: _w, ...meta } = (n.meta ?? {}) as Record<string, unknown>;
    const entries = n.entries ?? [];
    const array = entries.length > 0 && entries.every((e) => e.key === null);
    return { ...rest, kind: "mapping", ...(array ? { array: true } : {}), meta: Object.keys(meta).length ? meta : undefined } as unknown as Node;
  });

// ---------------------------------------------------------------------------- //
// The verbs
// ---------------------------------------------------------------------------- //

export function splitProse(s: ChapterState, path: Path, head: string, tail: string): ChapterState {
  if (path.length === 0) return refuse(s, "splitProse"); // the root's self is a title, never a split target
  let doc = withText(s.doc, path, head);
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  doc = insertEntry(doc, parent, index + 1, proseEntry(tail));
  const tailPath = [...parent, index + 1];
  return ok(s, { doc, focus: { at: "token", path: tailPath }, caret: "start", revs: bumpRev(s.revs, path) }, "splitProse");
}

/** The bootstrap paragraph's first Enter (or first typed text committing): the body's first
 *  entry is born inside the empty chapter at `path`. */
export function createFirstChunk(s: ChapterState, path: Path, text: string): ChapterState {
  const node = nodeAt(s.doc, path);
  if (!node) return refuse(s, "createFirstChunk");
  let doc = s.doc;
  // the empty parse roots as a scalar with a NULL self (`value: null, raw: ""`) — that is an
  // empty CONTAINER, not content; growing it must not leave a literal `null` self line
  if (node.kind === "scalar" && !hasSelfValue(node)) doc = dropSelf(doc, path);
  const at = (node.entries ?? []).length;
  doc = insertEntry(doc, path, at, proseEntry(text));
  return ok(s, { doc, focus: { at: "token", path: [...path, at] }, caret: "end" }, "createFirstChunk");
}

/** THE JOIN LAW — WALK-ADJACENT (Stage 7.5): Backspace-at-start / Delete-at-end join the
 *  focused cell with the nearest walk stop in that direction (skipping `into` slots — a
 *  bootstrap is a virtual position, not content). Three cases:
 *    1. PROSE ↔ PROSE — the generic absorb, across parents included: the later entry is
 *       removed (an emptied untitled chapter container husk removes upward), the texts merge,
 *       the caret lands at the junction (a SOURCE offset). List items join only within the
 *       same list.
 *    2. TITLE-DISSOLVE — the partner (or the focus, for Backspace at a title's start) is a
 *       subchapter title that is NOT an ancestor of the prose endpoint: the chapter FLATTENS
 *       (description → ordinal chunk, children splice out last-first, the node is its plain
 *       scalar again — Tab-wrap's inverse applied by deletion), then case 1 merges the texts.
 *    3. Everything else REFUSES — the ring (descriptions, table cells, latex, atoms, source
 *       positions, a paragraph against its own chapter's heading).
 */
export function joinWalk(s: ChapterState, dir: 1 | -1): ChapterState {
  if (!s.focus) return refuse(s, "join");
  const list = chapterPositionsOf(s.doc);
  const i = positionIndex(list, s.focus);
  if (i < 0) return refuse(s, "join");
  let j = i + dir;
  while (j >= 0 && j < list.length && list[j].at === "into") j += dir;
  if (j < 0 || j >= list.length) return refuse(s, "join");
  const partner = list[j];
  const focusSite = chapterSiteOf(s.doc, s.focus);
  const partnerSite = chapterSiteOf(s.doc, partner);
  const isProse = (c: string): boolean => c === "prose" || c === "listItem";

  // case 1 — prose ↔ prose
  if (isProse(focusSite.cell) && isProse(partnerSite.cell)) {
    if (focusSite.cell === "listItem" || partnerSite.cell === "listItem") {
      const sameList = pathsEqual(s.focus.path.slice(0, -1), partner.path.slice(0, -1));
      if (!sameList || focusSite.cell !== partnerSite.cell) return refuse(s, "join");
    }
    const earlier = dir > 0 ? s.focus.path : partner.path;
    const later = dir > 0 ? partner.path : s.focus.path;
    return absorb(s, earlier, later);
  }

  // case 2 — the title dissolves in
  if (focusSite.cell === "title" && isProse(partnerSite.cell) && dir < 0) {
    // Backspace at a title's start: the title flattens into the preceding paragraph
    return dissolveInto(s, partner.path, s.focus.path);
  }
  if (isProse(focusSite.cell) && partnerSite.cell === "title") {
    if (isPrefix(partner.path, s.focus.path)) {
      // its OWN heading — Backspace at the chapter's first stop: the heading dissolves, its
      // text LEADING the merged paragraph (the caret sits at the junction, mid-deletion)
      if (partnerSite.materialized) return refuse(s, "join"); // an anchored subchapter never dissolves by keystroke
      const titlePath = partner.path;
      if (titlePath.length === 0) {
        // the ROOT title has no parent to flatten into — its self line drops and the text
        // merges into the focused chunk directly
        const root = nodeAt(s.doc, []);
        if (!root || !hasSelfValue(root)) return refuse(s, "join");
        const tText = scalarText(root);
        const cText = scalarText(nodeAt(s.doc, s.focus.path)!);
        let doc = dropSelf(s.doc, []);
        doc = withText(doc, s.focus.path, tText + cText);
        return ok(s, { doc, focus: { at: "token", path: s.focus.path }, caret: tText.length, revs: bumpRev(s.revs, s.focus.path) }, "join");
      }
      const flat = flattenChapter(s.doc, titlePath);
      if (flat === null) return refuse(s, "join");
      // the focus chunk was the title's child j — the flatten splices it to the parent
      const j = s.focus.path[titlePath.length];
      const rest = s.focus.path.slice(titlePath.length + 1);
      const prose = [...titlePath.slice(0, -1), titlePath[titlePath.length - 1] + 1 + j, ...rest];
      return absorb({ ...s, doc: flat.doc }, titlePath, prose);
    }
    // Delete: the prose is earlier, its text leads; Backspace: the title's text lands first
    return dissolveInto(s, s.focus.path, partner.path, dir < 0);
  }

  return refuse(s, "join");
}

const pathsEqual = (a: Path, b: Path): boolean => a.length === b.length && a.every((x, k) => x === b[k]);
const isPrefix = (p: Path, of: Path): boolean => p.length <= of.length && p.every((x, k) => x === of[k]);

/** Removal at `removed` shifts a sibling-or-later path by one at that depth. */
function adjustAfterRemoval(p: Path, removed: Path): Path {
  const parent = removed.slice(0, -1);
  if (p.length < removed.length) return p;
  if (!parent.every((x, k) => p[k] === x)) return p;
  const d = parent.length;
  if (p[d] > removed[d]) { const q = [...p]; q[d] = p[d] - 1; return q; }
  return p;
}

/** Case 1's transform: remove the later prose entry, husk-remove emptied untitled chapter
 *  containers upward, merge the texts into the earlier one, caret at the junction. */
function absorb(s: ChapterState, earlierPath: Path, laterPath: Path): ChapterState {
  const earlier = nodeAt(s.doc, earlierPath);
  const later = nodeAt(s.doc, laterPath);
  if (!earlier || !later) return refuse(s, "join");
  if (chunkModeOf(earlier) !== "prose" || chunkModeOf(later) !== "prose") return refuse(s, "join");
  const eText = scalarText(earlier);
  const lText = scalarText(later);
  let doc = removeEntryAt(s.doc, laterPath.slice(0, -1), laterPath[laterPath.length - 1]);
  let ePath = adjustAfterRemoval(earlierPath, laterPath);
  // THE HUSK LOOP: absorbing the last paragraph of an untitled group must not leave a ghost
  let husk = laterPath.slice(0, -1);
  while (husk.length > 0) {
    const container = nodeAt(doc, husk);
    if (!container || hasSelfValue(container) || (container.entries ?? []).length > 0) break;
    if (chunkModeOf(container) !== "chapter") break;
    doc = removeEntryAt(doc, husk.slice(0, -1), husk[husk.length - 1]);
    ePath = adjustAfterRemoval(ePath, husk);
    husk = husk.slice(0, -1);
  }
  doc = withText(doc, ePath, eText + lText);
  // THE CELL FOLD-BACK (splitCell's exact inverse): a table CELL whose chunks joined down to
  // ONE plain paragraph is that scalar cell again — Enter's split reverts by deletion,
  // leaving no one-item container husk (a split SCALAR row wraps to a one-cell array first,
  // so its joins fold back through this same path)
  let focusPath = ePath;
  const cellHost = ePath.slice(0, -1);
  if (cellHost.length > 0) {
    const fmt = enclosingFormat(doc, cellHost);
    const host = nodeAt(doc, cellHost);
    const only = (host?.entries ?? []).length === 1 ? host!.entries![0] : null;
    if (fmt === "row-cell" && host && !hasSelfValue(host)
        && only && only.key === null && (only.value as Node).kind === "scalar"
        && ((only.value as Node).entries ?? []).length === 0 && chunkModeOf(only.value) === "prose") {
      const text = scalarText(only.value);
      doc = withNode(doc, cellHost, (n) => {
        const { entries: _e, array: _a, raw: _r, ...rest } = n as Node & { entries?: unknown; array?: boolean; raw?: string };
        return { ...rest, kind: "scalar", value: text } as unknown as Node;
      });
      focusPath = cellHost;
    }
  }
  // bumpRev: only the OLD cell layer reads it — dies with it (Stage 7.5 step 5)
  return ok(s, { doc, focus: { at: "token", path: focusPath }, caret: eText.length, revs: bumpRev(s.revs, focusPath) }, "join");
}

/** Case 2's transform: flatten the subchapter at `titlePath`, then absorb its (now plain)
 *  scalar into the prose at `prosePath` — prose first unless `titleFirst`. */
function dissolveInto(s: ChapterState, prosePath: Path, titlePath: Path, titleFirst = false): ChapterState {
  const flat = flattenChapter(s.doc, titlePath);
  if (flat === null) return refuse(s, "join");
  // entries spliced out after the title shift a same-parent LATER prose path
  let p = prosePath;
  const parent = titlePath.slice(0, -1);
  if (isPrefix(parent, p) && p.length > parent.length && p[parent.length] > titlePath[parent.length]) {
    const q = [...p];
    q[parent.length] += flat.moved;
    p = q;
  }
  const mid = { ...s, doc: flat.doc };
  return titleFirst ? absorb(mid, titlePath, p) : absorb(mid, p, titlePath);
}

/** The unwrap core, shared by Shift-Tab and the join law: description → ordinal chunk,
 *  children out LAST-FIRST after the entry, the emptied node is its plain scalar (wrap
 *  cleared). Null when the node is not a flattenable titled chapter. Returns how many
 *  entries landed in the parent (same-parent path adjustment). */
function flattenChapter(doc: Document, path: Path): { doc: Document; moved: number } | null {
  if (path.length === 0) return null; // the root never flattens
  const v = nodeAt(doc, path);
  if (!v || (v as Node).kind !== "scalar" || !hasSelfValue(v)) return null;
  if (metaOf(v).style === "flow") return null;
  let out = doc;
  const node0 = nodeAt(out, path)!;
  const descIdx = (node0.entries ?? []).findIndex((e) => e.key === "description");
  if (descIdx >= 0) {
    const text = scalarText(node0.entries![descIdx].value);
    out = removeEntryAt(out, path, descIdx);
    out = insertEntry(out, path, descIdx, proseEntry(text));
  }
  const parent = path.slice(0, -1);
  const selfIdx = path[path.length - 1];
  let moved = 0;
  for (let guard = (nodeAt(out, path)?.entries ?? []).length; guard > 0; guard--) {
    const node = nodeAt(out, path)!;
    const entries = node.entries ?? [];
    if (entries.length === 0) break;
    const last = entries[entries.length - 1];
    out = removeEntryAt(out, path, entries.length - 1);
    out = insertEntry(out, parent, selfIdx + 1, last);
    moved++;
  }
  out = withNode(out, path, (n) => {
    const { chapterWrapped: _w, selfAt: _s, ...meta } = (n.meta ?? {}) as Record<string, unknown>;
    return { ...n, meta: Object.keys(meta).length ? meta : undefined } as unknown as Node;
  });
  return { doc: out, moved };
}

/** Tab on a paragraph: THIS chunk NESTS one level — it becomes the sole paragraph of a fresh
 *  UNTITLED group (`- x` → `- - x`). The title role is explicit (T titles the group). The
 *  group carries `meta.chapterWrapped` — the session's "born here" mark the deferred
 *  materialization watches (a group materializes once it gains a TITLE and body). */
export function nestParagraph(s: ChapterState, path: Path): ChapterState {
  if (path.length === 0) return refuse(s, "nest");
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  const container = nodeAt(s.doc, parent);
  const entry = container?.entries?.[index];
  if (!container || !entry) return refuse(s, "nest");
  if (entry.key !== null) return refuse(s, "nest"); // a KEYED chunk's key has no place in a group
  const mode = chunkModeOf(entry.value);
  if (mode !== "prose" && mode !== "latex") return refuse(s, "nest");
  const group: Node = {
    kind: "mapping", array: true,
    entries: [entry],
    meta: { chapterWrapped: true },
  } as unknown as Node;
  const doc = withNode(s.doc, parent, (n) => {
    const entries = [...(n.entries ?? [])];
    entries[index] = { key: null, edge: "contain", value: group } as unknown as Entry;
    return { ...n, entries } as Node;
  });
  return ok(s, { doc, focus: { at: "token", path: [...path, 0] }, caret: "end" }, "nest");
}

/** Shift-Tab on a title — the wrap's inverse: the flatten core shared with the join law. */
export function unwrapChapter(s: ChapterState, path: Path): ChapterState {
  const flat = flattenChapter(s.doc, path);
  if (flat === null) return refuse(s, "unwrap");
  return ok(s, { doc: flat.doc, focus: { at: "token", path }, caret: "end" }, "unwrap");
}

/** Move the entry at `path` under its PREVIOUS sibling (title-under-chapter / list nesting).
 *  A leaf previous item becomes an omni (its text above the new sublist) by construction. */
export function indentEntry(s: ChapterState, path: Path): ChapterState {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  if (index === 0) return refuse(s, "indent");
  const container = nodeAt(s.doc, parent);
  const entry = container?.entries?.[index];
  const prev = container?.entries?.[index - 1];
  if (!entry || !prev || isPointer(prev.value) || (prev.value as Node).kind === "blob") return refuse(s, "indent");
  let doc = removeEntryAt(s.doc, parent, index);
  const prevPath = [...parent, index - 1];
  const at = (nodeAt(doc, prevPath)?.entries ?? []).length;
  doc = insertEntry(doc, prevPath, at, entry);
  const newPath = [...prevPath, at];
  return ok(s, { doc, focus: { at: "token", path: newPath }, caret: "end" }, "indent");
}

/** Move the entry at `path` OUT of its parent, landing right after it. An UNTITLED group
 *  emptied by the move is a husk — it leaves with its last paragraph (the nest's inverse). */
export function dedentEntry(s: ChapterState, path: Path): ChapterState {
  if (path.length < 2) return refuse(s, "dedent");
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  const gpPath = parent.slice(0, -1);
  const parentIdx = parent[parent.length - 1];
  const entry = nodeAt(s.doc, parent)?.entries?.[index];
  if (!entry) return refuse(s, "dedent");
  let doc = removeEntryAt(s.doc, parent, index);
  doc = insertEntry(doc, gpPath, parentIdx + 1, entry);
  let newPath = [...gpPath, parentIdx + 1];
  const husk = nodeAt(doc, parent);
  if (husk && !hasSelfValue(husk) && (husk.entries ?? []).length === 0 && chunkModeOf(husk) === "chapter") {
    doc = removeEntryAt(doc, gpPath, parentIdx);
    newPath = [...gpPath, parentIdx];
  }
  return ok(s, { doc, focus: { at: "token", path: newPath }, caret: "end" }, "dedent");
}

/** The nearest DECLARED-table ancestor of a cell path — a fixed depth would miss a SCALAR
 *  row, whose single cell sits one level shallower than an array row's. */
function tableAncestor(s: ChapterState, cellPath: Path): Path | null {
  for (let up = 1; up <= cellPath.length; up++) {
    const anc = nodeAt(s.doc, cellPath.slice(0, -up));
    if (anc && chunkModeOf(anc) === "table") return cellPath.slice(0, -up);
  }
  return null;
}

/** Tab at the very last table cell: append a row of the table's width, caret in its first cell. */
export function appendRow(s: ChapterState, cellPath: Path): ChapterState {
  const tablePath = tableAncestor(s, cellPath);
  if (tablePath === null) return refuse(s, "appendRow");
  const table = nodeAt(s.doc, tablePath);
  if (!table) return refuse(s, "appendRow");
  const entries = table.entries ?? [];
  const header = entries.find((e) => e.key === "header");
  const firstRow = entries.find((e) => e.key === null && !isPointer(e.value));
  const current = nodeAt(s.doc, cellPath.slice(0, -1));
  const columns = Math.max(
    (header && (header.value as Node).entries?.length) ||
    (firstRow && (firstRow.value as Node).entries?.length) ||
    (current?.entries?.length ?? 1), 1);
  const cells = Array.from({ length: columns }, () => proseEntry(""));
  const row: Entry = { key: null, edge: "contain", value: { kind: "mapping", array: true, entries: cells } } as unknown as Entry;
  const at = entries.length;
  const doc = insertEntry(s.doc, tablePath, at, row);
  return ok(s, { doc, focus: { at: "token", path: [...tablePath, at, 0] }, caret: "start" }, "appendRow");
}

/** Backspace at the first position of an ALL-EMPTY row: the row leaves the table, and the
 *  LAST row's departure removes the emptied table itself (the husk) — so a table unwinds
 *  gradually the way every structure does. The caret lands on the walk stop before the row. */
export function deleteTableRow(s: ChapterState, cellPath: Path): ChapterState {
  const tablePath = tableAncestor(s, cellPath);
  if (tablePath === null) return refuse(s, "deleteRow");
  const rowIdx = cellPath[tablePath.length];
  const rowPath = [...tablePath, rowIdx];
  const list = chapterPositionsOf(s.doc);
  const first = list.findIndex((p) => isPrefix(rowPath, p.path));
  let doc = removeEntryAt(s.doc, tablePath, rowIdx);
  // the emptied table is a husk — it leaves with its last row (the ROOT table stays: its
  // boot cell takes the caret instead)
  const table = nodeAt(doc, tablePath);
  if (table && tablePath.length > 0 && !hasSelfValue(table) && (table.entries ?? []).length === 0) {
    doc = removeEntryAt(doc, tablePath.slice(0, -1), tablePath[tablePath.length - 1]);
  }
  // the stop BEFORE the removed row is untouched by the removal — it is the caret's home;
  // a row that led the document falls back to whatever the new walk starts with
  const prev = first > 0 ? list[first - 1] : null;
  const focus = prev ?? chapterPositionsOf(doc)[0] ?? null;
  return ok(s, { doc, focus, caret: "end" }, "deleteRow");
}

/** A new COLUMN: every row (the header included) gains a trailing empty cell; a SCALAR row
 *  becomes a two-cell array (its text, then the fresh cell). Caret: this row's new cell. */
export function appendColumn(s: ChapterState, cellPath: Path): ChapterState {
  const tablePath = tableAncestor(s, cellPath);
  if (tablePath === null) return refuse(s, "appendColumn");
  const table = nodeAt(s.doc, tablePath);
  if (!table) return refuse(s, "appendColumn");
  let doc = s.doc;
  let focusPath: Path | null = null;
  const myRowIdx = cellPath[tablePath.length];
  (table.entries ?? []).forEach((e, i) => {
    if (e.key !== null && e.key !== "header") return;
    if (isPointer(e.value) || (e.value as Node).kind === "blob") return;
    const rowPath = [...tablePath, i];
    const row = nodeAt(doc, rowPath)!;
    if (row.kind === "scalar" && (row.entries ?? []).length === 0) {
      // the scalar row's own text becomes its first cell
      doc = withNode(doc, rowPath, (n) => {
        const { value: _v, raw: _r, ...rest } = n as Node & { value?: unknown; raw?: string };
        return { ...rest, kind: "mapping", array: true, entries: [proseEntry(scalarText(n)), proseEntry("")] } as unknown as Node;
      });
      if (i === myRowIdx) focusPath = [...rowPath, 1];
    } else {
      const at = (row.entries ?? []).length;
      doc = insertEntry(doc, rowPath, at, proseEntry(""));
      if (i === myRowIdx) focusPath = [...rowPath, at];
    }
  });
  if (focusPath === null) return refuse(s, "appendColumn");
  return ok(s, { doc, focus: { at: "token", path: focusPath }, caret: "start" }, "appendColumn");
}

/** ↑/↓ inside a table move by COLUMN (the grid feel); at the top/bottom edge the caret LEAVES
 *  the table — the way out of table editing. */
function tableMove(s: ChapterState, dir: 1 | -1): ChapterState {
  const cellPath = s.focus!.path;
  const tablePath = tableAncestor(s, cellPath);
  if (tablePath === null) return moveFocus(s, dir);
  const table = nodeAt(s.doc, tablePath)!;
  const col = cellPath.length === tablePath.length + 2 ? cellPath[cellPath.length - 1] : 0;
  const rowIdx = cellPath[tablePath.length];
  // walkable rows, in reading order: the header first, then the keyless rows
  const rows = (table.entries ?? []).map((e, i) => ({ e, i }))
    .filter((x) => (x.e.key === "header" || x.e.key === null) && !isPointer(x.e.value) && (x.e.value as Node).kind !== "blob");
  const pos = rows.findIndex((x) => x.i === rowIdx);
  const next = pos + dir;
  if (pos >= 0 && next >= 0 && next < rows.length) {
    const target = rows[next];
    const targetRow = target.e.value as Node;
    const cells = targetRow.entries ?? [];
    const p = targetRow.kind === "scalar" && cells.length === 0
      ? [...tablePath, target.i]
      : [...tablePath, target.i, Math.min(col, Math.max(0, cells.length - 1))];
    return ok(s, { focus: { at: "token", path: p }, caret: "end" }, "move");
  }
  // the edge: LEAVE the table — step past its whole position range in the walk
  const list = chapterPositionsOf(s.doc);
  const inTable = (p: Position): boolean => isPrefix(tablePath, p.path) && p.path.length > tablePath.length;
  let idx = -1;
  for (let i = 0; i < list.length; i++) {
    if (!inTable(list[i])) continue;
    idx = i;
    if (dir < 0) break; // the first in-table stop; dir > 0 keeps scanning to the last
  }
  const out = idx + dir;
  if (idx < 0 || out < 0) return ok(s, {}, "move:edge");
  // ↓ at a table that ends the document: the fresh chunk lands right AFTER THE TABLE in the
  // table's OWN container — a table inside a subchapter grows the subchapter, never the root
  if (out >= list.length) {
    if (tablePath.length === 0) return appendTrailingChunk(s, "move"); // the root IS the table
    const parent = tablePath.slice(0, -1);
    const at = tablePath[tablePath.length - 1] + 1;
    const doc = insertEntry(s.doc, parent, at, proseEntry(""));
    return ok(s, { doc, focus: { at: "token", path: [...parent, at] }, caret: "start" }, "move:appendChunk");
  }
  return ok(s, { focus: list[out], caret: dir > 0 ? "start" : "end" }, "move");
}

/** ↓ past the DOCUMENT's last stop appends a fresh paragraph at the root and lands in it —
 *  "down at the end adds a chunk, always" (unless the caret already sits in a trailing empty
 *  paragraph — no empty-spam). */
function appendTrailingChunk(s: ChapterState, intent: string): ChapterState {
  // no empty-spam: stay when already on an empty PARAGRAPH (at any depth — ↓ from a fresh
  // empty never breeds another; cells and list items still deserve a chunk after them)
  const cur = s.focus?.at === "token" ? nodeAt(s.doc, s.focus.path) : null;
  if (cur && cur.kind === "scalar" && scalarText(cur) === "" && (cur.entries ?? []).length === 0
      && chapterSiteOf(s.doc, s.focus).cell === "prose") {
    return ok(s, {}, `${intent}:edge`);
  }
  const at = (nodeAt(s.doc, [])?.entries ?? []).length;
  const doc = insertEntry(s.doc, [], at, proseEntry(""));
  return ok(s, { doc, focus: { at: "token", path: [at] }, caret: "start" }, `${intent}:appendChunk`);
}

/** The flat document-order caret walk (also the table's cellWalk — same order). */
export function moveFocus(s: ChapterState, dir: 1 | -1, intent = "move"): ChapterState {
  const list = chapterPositionsOf(s.doc);
  if (list.length === 0) return s;
  const i = s.focus ? positionIndex(list, s.focus) : -1;
  if (i >= 0 && i === list.length - 1 && dir > 0 && intent === "move") return appendTrailingChunk(s, intent);
  const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.min(Math.max(i + dir, 0), list.length - 1);
  if (i >= 0 && next === i) return ok(s, {}, `${intent}:edge`); // at the top the caret stays put
  return ok(s, { focus: list[next], caret: dir > 0 ? "start" : "end" }, intent);
}

/** Enter on the title/description: to the next of THIS chapter's cells — description, the
 *  first paragraph, or a freshly created one when the body is empty. */
export function enterWalk(s: ChapterState): ChapterState {
  if (!s.focus) return refuse(s, "enterWalk");
  const list = chapterPositionsOf(s.doc);
  const i = positionIndex(list, s.focus);
  const next = list[i + 1];
  if (next && next.at === "into") {
    // the empty body: make the first paragraph (an entry is born; opening never writes, Enter does)
    return { ...createFirstChunk(s, next.path, ""), caret: "start" };
  }
  if (!next) return refuse(s, "enterWalk");
  return ok(s, { focus: next, caret: "start" }, "enterWalk");
}

// --- roles ---------------------------------------------------------------------------------- //

export function makeTitle(s: ChapterState, path: Path): ChapterState {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  const container = nodeAt(s.doc, parent);
  const entry = container?.entries?.[index];
  if (!container || !entry || entry.key !== null) return refuse(s, "role:title");
  // roles are CHAPTER moves: a list item / table cell never becomes its container's title
  if (enclosingFormat(s.doc, path) !== "chapter") return refuse(s, "role:title");
  // "a title exists" is a VALUE test — the empty document's scalar-null root has none
  if (hasSelfValue(container) || metaOf(container).style === "flow") return refuse(s, "role:title");
  const v = entry.value;
  if (isPointer(v) || (v as Node).kind !== "scalar" || (v.entries ?? []).length > 0 || scalarText(v).includes("\n")) return refuse(s, "role:title");
  const text = scalarText(v);
  let doc = removeEntryAt(s.doc, parent, index);
  doc = withNode(doc, parent, (n) => {
    const { array: _a, raw: _r, ...rest } = n as Node & { array?: boolean; raw?: string };
    return { ...rest, kind: "scalar", value: text } as unknown as Node;
  });
  return ok(s, { doc, focus: { at: "token", path: parent }, caret: "end" }, "role:title");
}

export function demoteTitle(s: ChapterState, path: Path): ChapterState {
  const v = nodeAt(s.doc, path);
  // the guard is the VALUE test: a title-only chapter (no body at all) demotes too
  if (!v || !hasSelfValue(v)) return refuse(s, "role:title");
  const text = scalarText(v);
  if (path.length > 0 && (v.entries ?? []).length === 0) {
    // a childless subchapter title IS one line — dissolving it is model-only (zero ops)
    const doc = withNode(s.doc, path, (n) => {
      const { chapterWrapped: _w, selfAt: _s, ...meta } = (n.meta ?? {}) as Record<string, unknown>;
      return { ...n, meta: Object.keys(meta).length ? meta : undefined } as unknown as Node;
    });
    return ok(s, { doc, focus: { at: "token", path }, caret: "end" }, "role:title");
  }
  let doc = dropSelf(s.doc, path);
  const entries = nodeAt(doc, path)?.entries ?? [];
  const descIdx = entries.findIndex((e) => e.key === "description");
  const pos = descIdx >= 0 ? descIdx + 1 : 0;
  doc = insertEntry(doc, path, pos, proseEntry(text));
  return ok(s, { doc, focus: { at: "token", path: [...path, pos] }, caret: "end" }, "role:title");
}

export function makeDescription(s: ChapterState, path: Path): ChapterState {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  const container = nodeAt(s.doc, parent);
  const entry = container?.entries?.[index];
  if (!container || !entry || entry.key !== null) return refuse(s, "role:desc");
  // roles are CHAPTER moves: a list item / table cell never becomes a description
  if (enclosingFormat(s.doc, path) !== "chapter") return refuse(s, "role:desc");
  if (metaOf(container).style === "flow") return refuse(s, "role:desc");
  if ((container.entries ?? []).some((e) => e.key === "description")) return refuse(s, "role:desc");
  const text = scalarText(entry.value);
  // created FIRST at index 0, the chunk removed second (now at index+1)
  let doc = insertEntry(s.doc, parent, 0, { key: "description", edge: "contain", value: proseNode(text) } as unknown as Entry);
  doc = removeEntryAt(doc, parent, index + 1);
  return ok(s, { doc, focus: { at: "token", path: [...parent, 0] }, caret: "end" }, "role:desc");
}

export function demoteDescription(s: ChapterState, path: Path): ChapterState {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  const entry = nodeAt(s.doc, parent)?.entries?.[index];
  if (!entry || entry.key !== "description") return refuse(s, "role:desc");
  const text = scalarText(entry.value);
  // the chunk takes the description's place: insert right after it, then remove the keyed entry
  let doc = insertEntry(s.doc, parent, index + 1, proseEntry(text));
  doc = removeEntryAt(doc, parent, index);
  return ok(s, { doc, focus: { at: "token", path: [...parent, index] }, caret: "end" }, "role:desc");
}

// --- format --------------------------------------------------------------------------------- //

export function promoteFormat(s: ChapterState, path: Path, chosen: ChosenFormat): ChapterState {
  const target = formatTargetPath(s.doc, path);
  const v = nodeAt(s.doc, target);
  if (!v) return refuse(s, "format");
  if (chosen === "chapter") {
    // "Normal" in a LIST is ITEM-LOCAL — labour-preserving: the focused item leaves the list
    // as a plain paragraph (the list splits around it; a single-item list dissolves), the
    // exact inverse of the leaf→bullets wrap. Never unformats the whole list.
    const where = enclosingFormat(s.doc, path);
    if (where === "bullets" || where === "numbered") return extractListItem(s, path);
    // elsewhere: untagged ≡ a subchapter — DROP the tag (and any stamped format)
    const doc = withNode(s.doc, target, (n) => {
      const { schema: _sch, derivedFormat: _df, ...meta } = (n.meta ?? {}) as Record<string, unknown>;
      return { ...n, meta: Object.keys(meta).length ? meta : undefined } as unknown as Node;
    });
    return ok(s, { doc, focus: s.focus, caret: s.caret }, "format:chapter");
  }
  const rootTag = tagContentOf(s.doc.root);
  const content = tagFor(rootTag, chosen);
  let schema: Value;
  try { schema = parseSchemaRef(content); } catch { return refuse(s, "format"); }
  const doc = withNode(s.doc, target, (n) => {
    const meta = { ...(n.meta ?? {}), schema, derivedFormat: `x-yamlover-${chosen}` };
    if ((n as Node).kind === "scalar" && (n.entries ?? []).length === 0) {
      // a LEAF paragraph: wrap the prose as the sole item of the new tagged container
      const { value: _v, raw: _r, ...rest } = n as Node & { value?: unknown; raw?: string };
      return { ...rest, kind: "mapping", array: true, entries: [proseEntry(scalarText(n))], meta } as unknown as Node;
    }
    return { ...n, meta } as unknown as Node;
  });
  // a wrapped leaf: the caret follows the prose into the one item
  const wasLeaf = (v as Node).kind === "scalar" && (v.entries ?? []).length === 0;
  const focus: Position = wasLeaf ? { at: "token", path: [...target, 0] } : (s.focus ?? { at: "token", path: target });
  return ok(s, { doc, focus, caret: "end" }, `format:${chosen}`);
}

/** A format command on the BOOT cell: the empty chapter's first entry is BORN as that kind —
 *  an empty paragraph (¶), or a tagged one-entry table/list whose single '' cell/item takes
 *  the caret (the table starts in its creation flow: Tab grows columns). */
function bootCreate(s: ChapterState, path: Path, chosen: ChosenFormat): ChapterState {
  if (chosen === "chapter") return { ...createFirstChunk(s, path, ""), caret: "start" };
  const content = tagFor(tagContentOf(s.doc.root), chosen);
  let schema: Value;
  try { schema = parseSchemaRef(content); } catch { return refuse(s, "format"); }
  const group: Node = {
    kind: "mapping", array: true,
    entries: [proseEntry("")],
    meta: { schema, derivedFormat: `x-yamlover-${chosen}` },
  } as unknown as Node;
  const at = (nodeAt(s.doc, path)?.entries ?? []).length;
  let doc = s.doc;
  const host = nodeAt(doc, path);
  if (host && host.kind === "scalar" && !hasSelfValue(host)) doc = dropSelf(doc, path); // the empty parse's null self
  doc = insertEntry(doc, path, at, { key: null, edge: "contain", value: group } as unknown as Entry);
  return ok(s, { doc, focus: { at: "token", path: [...path, at, 0] }, caret: "start" }, `format:${chosen}`);
}

/** "Normal" on a list item: the item exits as a plain paragraph, the list SPLITS around it
 *  (items before keep the list + tag; items after become a new list with the same tag); a
 *  single-item list dissolves entirely — the leaf→list wrap's exact inverse. */
function extractListItem(s: ChapterState, path: Path): ChapterState {
  const listPath = path.slice(0, -1);
  const index = path[path.length - 1];
  const list = nodeAt(s.doc, listPath);
  const item = list?.entries?.[index];
  if (!list || !item || item.key !== null) return refuse(s, "format:chapter");
  if (listPath.length === 0) return refuse(s, "format:chapter"); // the root is not a list entry
  const gpPath = listPath.slice(0, -1);
  const listIdx = listPath[listPath.length - 1];
  const before = (list.entries ?? []).slice(0, index);
  const after = (list.entries ?? []).slice(index + 1);
  const listOf = (items: Entry[]): Entry => ({
    key: null, edge: "contain",
    value: { ...list, entries: items } as unknown as Node,
  } as unknown as Entry);
  const replacement: Entry[] = [
    ...(before.length > 0 ? [listOf(before)] : []),
    item,
    ...(after.length > 0 ? [listOf(after)] : []),
  ];
  const doc = withNode(s.doc, gpPath, (n) => {
    const entries = [...(n.entries ?? [])];
    entries.splice(listIdx, 1, ...replacement);
    return { ...n, entries } as Node;
  });
  const newPath = [...gpPath, listIdx + (before.length > 0 ? 1 : 0)];
  return ok(s, { doc, focus: { at: "token", path: newPath }, caret: "end" }, "format:chapter");
}

// ---------------------------------------------------------------------------- //
// The dispatcher
// ---------------------------------------------------------------------------- //

/** Payload a cell attaches to a text-splitting intent (the caret's head/tail). */
export interface SplitPayload { head: string; tail: string }

export function applyChapterIntent(s: ChapterState, intent: ChapterIntent, split?: SplitPayload): ChapterState {
  const path = s.focus?.path ?? [];
  switch (intent.kind) {
    case "nop": return s;
    case "refuse": return refuse(s, "refuse");
    case "move": {
      // ↑/↓ inside a table are GRID moves (same column; the edges leave the table)
      const site = chapterSiteOf(s.doc, s.focus);
      return site.cell === "tableCell" ? tableMove(s, intent.dir) : moveFocus(s, intent.dir);
    }
    case "cellWalk": return moveFocus(s, intent.dir, "cellWalk");
    case "appendColumn": return appendColumn(s, path);
    case "enterWalk": return enterWalk(s);
    case "splitProse": {
      if (s.focus?.at === "into") {
        const born = createFirstChunk(s, s.focus.path, split?.head ?? "");
        return split && split.tail !== "" ? splitProse(born, born.focus!.path, split.head, split.tail) : born;
      }
      // Enter in a SCALAR table cell: the cell starts hosting the normal chapter flow —
      // it becomes a container of chunks (row-cell folds back to chapter rules, so the
      // paragraphs inside split/join/nest like any others from here on)
      const site = chapterSiteOf(s.doc, s.focus);
      if (site.cell === "tableCell") {
        const cell = nodeAt(s.doc, path);
        if (cell && cell.kind === "scalar" && (cell.entries ?? []).length === 0) {
          const text = split ?? { head: scalarText(cell), tail: "" };
          const chunks = (): Node =>
            ({ kind: "mapping", array: true, entries: [proseEntry(text.head), proseEntry(text.tail)] } as unknown as Node);
          if (site.enclosing === "row") {
            // a SCALAR row's entries are its CELLS — splitting it directly would mint a
            // phantom column (the reported defect). The row wraps to its ONE cell first,
            // and the chunks open INSIDE that cell (a chapter in the cell, as everywhere).
            const doc = withNode(s.doc, path, (n) => {
              const { value: _v, raw: _r, ...rest } = n as Node & { value?: unknown; raw?: string };
              const cellEntry = { key: null, edge: "contain", value: chunks() } as unknown as Entry;
              return { ...rest, kind: "mapping", array: true, entries: [cellEntry] } as unknown as Node;
            });
            return ok(s, { doc, focus: { at: "token", path: [...path, 0, 1] }, caret: "start" }, "splitCell");
          }
          const doc = withNode(s.doc, path, (n) => {
            const { value: _v, raw: _r, ...rest } = n as Node & { value?: unknown; raw?: string };
            return { ...rest, ...chunks() } as unknown as Node;
          });
          return ok(s, { doc, focus: { at: "token", path: [...path, 1] }, caret: "start" }, "splitCell");
        }
      }
      const text = split ?? { head: scalarText(nodeAt(s.doc, path) ?? proseNode("")), tail: "" };
      return splitProse(s, path, text.head, text.tail);
    }
    case "joinPrev": return joinWalk(s, -1);
    case "joinNext": return joinWalk(s, 1);
    case "nest": return nestParagraph(s, path);
    case "unwrap": return unwrapChapter(s, path);
    case "indent": return indentEntry(s, path);
    case "dedent": return dedentEntry(s, path);
    case "appendRow": return appendRow(s, path);
    case "deleteRow": return deleteTableRow(s, path);
    case "role": {
      // on the BOOT cell the role MATERIALIZES: an empty title to type into / a description
      if (s.focus?.at === "into") {
        if (intent.role === "title") {
          const doc = withNode(s.doc, path, (n) => ({ ...n, kind: "scalar", value: "" } as unknown as Node));
          return ok(s, { doc, focus: { at: "token", path }, caret: "start" }, "role:title");
        }
        let doc = s.doc;
        const host = nodeAt(doc, path);
        if (host && host.kind === "scalar" && !hasSelfValue(host)) doc = dropSelf(doc, path); // the empty parse's null self
        doc = insertEntry(doc, path, 0, { key: "description", edge: "contain", value: proseNode("") } as unknown as Entry);
        return ok(s, { doc, focus: { at: "token", path: [...path, 0] }, caret: "start" }, "role:desc");
      }
      const site = chapterSiteOf(s.doc, s.focus);
      if (intent.role === "title") return site.cell === "title" ? demoteTitle(s, path) : makeTitle(s, path);
      return site.cell === "description" ? demoteDescription(s, path) : makeDescription(s, path);
    }
    case "format": {
      // on the BOOT cell the format MATERIALIZES the first entry of that kind — no idle state
      if (s.focus?.at === "into") return bootCreate(s, path, intent.chosen);
      return promoteFormat(s, path, intent.chosen);
    }
  }
}

/** One keystroke through the chapter machine: site → interpret → apply. `null` intent means
 *  the key is NOT this grammar's — the caller lets the source grammar or the browser have it. */
export function applyChapterKey(s: ChapterState, k: ChapterKey, edges: ChapterEdges = {}, split?: SplitPayload): ChapterState | null {
  const site = chapterSiteOf(s.doc, s.focus, edges);
  const intent = chapterInterpret(k, site);
  if (intent === null) return null;
  return applyChapterIntent(s, intent, split);
}
