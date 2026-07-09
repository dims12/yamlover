// The in-memory, schema-form editing model for ONE chapter entity (its title, description, and
// positional body). The WYSIWYG editor operates on this model — instant and correct — and a
// background sync (see chapter.tsx `useChapterSync`) reconciles it to the server as a coalesced
// batch of surgical ops (/api/edit), routing each part to its own backing file by its `concrete`/`path`.
//
// A chapter is an OMNI node (CHAPTER.md): optional keyed `title`/`description`, then a POSITIONAL
// body whose elements are chunks (renderable blocks) and subchapters (the recursion), interleaved.
// An element's edit address is its ABSOLUTE entry index (`<chapter>[i]`), in which the keyed
// title/description count too — the same index the node path uses, so an edit path is a plain
// yamlover path. Subchapters ride in the body as read-only parts so those indices stay aligned.
//
// Why a model at all: editing straight against an uncontrolled contentEditable + per-op server
// round-trips was both LAGGY (file-write → reindex → SSE → refetch per keystroke) and WRONG (a
// split re-saved the head editor's stale DOM, un-truncating it). The model makes structural ops
// pure array mutations (instant), and `rev` lets the editor reset a chunk's DOM from the model when
// WE change its text (a split head) without clobbering the caret while the user types.

import { asLink, scalarValue } from "../render";
import { segsToStr, strToSegs } from "../paths";

const MIXED_KEY = "$yamloverMixed"; // an omni/mix node's ordered entries (render.tsx / engine-api.ts)

/** One element of a chapter's body, as the editor holds it — a chunk OR a subchapter link. */
export interface ChunkPart {
  id: string; // stable client id — React key + sync identity (assigned at build, survives edits)
  rev: number; // bumped ONLY when the MODEL changes `text` programmatically (a split) → editor resets its DOM
  editable: boolean; // an inlined prose scalar (marklower/markdown) → editable; else read-only
  text: string; // the editable source (prose); "" for a read-only part
  format: string | null; // text/marklower | text/markdown | … (an image/latex/pointer → read-only)
  concrete: string; // how the part is stored (from the marker): "yamlover" (inlined) or "file/…" (linked)
  subchapter: boolean; // a nested chapter/subtask body element → rendered as a navigable link, never edited
  navPath?: string; // a subchapter's own node path (for the descend link); set ⇒ subchapter
  title?: string; // a subchapter's title label
  marker: unknown; // the original element value (link marker / scalar) — re-rendered as-is for a read-only part
  absIndex: number; // the part's ABSOLUTE entry index — an edit path segment (keyed entries count too)
}

export interface ChapterModel {
  path: string; // the chapter's node path (the routing base for edits)
  title: string;
  description: string;
  chunks: ChunkPart[]; // the FULL ordered body (chunks + subchapters), in source order
  entryCount: number; // ALL entries, keyed ones included — the abs index an appended entry takes
}

/** One surgical edit the sync sends to `/api/edit` (see api.ts `Edit` for the op semantics). */
export interface Edit {
  path: string;
  op: "emplace" | "replace" | "insert" | "remove";
  yamlover?: string;
}

/** A prose string as yamlover VALUE source: a literal block scalar (`|-`, or `|` when the text ends
 *  in a newline, so the chomping matches), else one double-quoted line when a block would not round
 *  trip — a first content line that is empty or indented. The client twin of the server's
 *  `escapeScalarSrc`: `/api/edit` takes yamlover source, and prose is not yamlover until escaped. */
export function escapeYamloverScalar(text: string): string {
  const first = text.split("\n").find((l) => l.trim().length > 0);
  if (!first || /^\s/.test(first)) return JSON.stringify(text);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const head = text.endsWith("\n") ? "|" : "|-";
  return [head, ...body.split("\n").map((l) => (l.trim().length ? "  " + l : ""))].join("\n");
}

/** The chunk formats that have an in-place editor (chunk-editors.tsx `chunkEditorFor`): marklower
 *  (the bare-string default), markdown, and LaTeX. Kept in sync with that registry. */
export function isEditableChunkFormat(format: string | null | undefined): boolean {
  return format == null || format === "text/marklower" || format === "text/markdown" || format === "text/x-latex";
}

/** A chunk marker the editor turns into an editable field — a string of an editable format. An
 *  image/pointer/diagram chunk is read-only. */
function isEditableMarker(type: string | undefined, format: string | null | undefined): boolean {
  return type === "string" && isEditableChunkFormat(format);
}

/** True for a body element whose (type, format) makes it a nested chapter/subtask — a subchapter. */
export function isSubchapter(format: string | null | undefined): boolean {
  return format === "x-yamlover-chapter" || format === "x-yamlover-task";
}

/** Append a key/index segment to a node path (root-safe: `:` + `title` → `:title`; `:` + 0 → `[0]`). */
export function childPath(path: string, seg: string | number): string {
  return segsToStr([...strToSegs(path), seg]);
}

/** The body elements with their ABSOLUTE entry index — the index an edit path segment carries, in
 *  which the keyed `title`/`description` count too (CHAPTER.md). An untitled chapter projects as a
 *  plain array, where the two indexes coincide. */
export function chapterBodyEntries(value: unknown): { value: unknown; absIndex: number }[] {
  if (Array.isArray(value)) return value.map((v, i) => ({ value: v, absIndex: i }));
  const mixed = (value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as
    | { entries?: { key: string | null; value: unknown }[] }
    | undefined;
  if (!mixed?.entries) return [];
  return mixed.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.key == null).map(({ e, i }) => ({ value: e.value, absIndex: i }));
}

/** How many entries the chapter has in all — the absolute index an APPENDED entry will take. */
export function chapterEntryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const mixed = (value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as { entries?: unknown[] } | undefined;
  return mixed?.entries?.length ?? 0;
}

/** One element of a chapter's rendered FLOW — everything the page shows, in source order. */
export type FlowKind = "title" | "description" | "subchapter" | "chunk";
export interface FlowItem {
  kind: FlowKind;
  value: unknown; // the entry value (a `$yamloverLink` marker or an inline scalar)
}

/** The chapter's full rendered stream in SOURCE order — the keyed `title`/`description` entries and
 *  the keyless body (chunks + subchapter links) interleaved exactly where the author placed them, so
 *  the renderer never hoists the heading or forces subchapters to the end (CHAPTER.md — position is
 *  the author's). Any OTHER keyed entry (a directory member surfaced as a key, a task planning field)
 *  is skipped: it is not chapter body content. An untitled chapter (plain-array projection) is all
 *  keyless — chunks and subchapter links, in order. */
export function chapterFlow(value: unknown): FlowItem[] {
  const kindOf = (v: unknown): FlowKind => (isSubchapter(asLink(v)?.format) ? "subchapter" : "chunk");
  if (Array.isArray(value)) return value.map((v) => ({ kind: kindOf(v), value: v }));
  const mixed = (value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as
    | { entries?: { key: string | null; value: unknown }[] }
    | undefined;
  if (!mixed?.entries) return [];
  const out: FlowItem[] = [];
  for (const e of mixed.entries) {
    if (e.key === "title") out.push({ kind: "title", value: e.value });
    else if (e.key === "description") out.push({ kind: "description", value: e.value });
    else if (e.key == null) out.push({ kind: kindOf(e.value), value: e.value });
    // else: another keyed entry (directory member / task field) — not chapter body content
  }
  return out;
}

/** The plain text of a title/description flow entry — a keyed scalar projects (at depth 1) as a
 *  depth-0 link marker, so unwrap it; an ANNOTATED one projects as an omni marker laid over the
 *  scalar, so peel that too (else the heading reads `[object Object]`); tolerate a raw string. */
export function flowText(value: unknown): string {
  const v = scalarValue(asLink(value)?.value ?? value);
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

let idSeq = 0;
const freshId = (): string => `ck${idSeq++}`;

/** A brand-new inlined prose chunk (a fresh id) — the tail of a split, or a blank added paragraph.
 *  Its `absIndex` is unknown until the diff places it (-1). */
export function newProsePart(text: string, format: string | null = "text/marklower"): ChunkPart {
  return { id: freshId(), rev: 0, editable: true, text, format, concrete: "yamlover", subchapter: false, marker: null, absIndex: -1 };
}

/** Build the editing model from a chapter node's `/api/json` value (depth 1): its title/description
 *  and its body elements as `$yamloverLink` markers. A body element is EDITABLE when it is an inlined
 *  prose scalar (its marker points at its OWN slot `<chapter>[i]`); a subchapter or a marker pointing
 *  elsewhere (a `*…` file/pointer chunk) is a read-only part this iteration. */
export function buildChapterModel(node: { path: string; title: string | null; description: string | null; value: unknown }): ChapterModel {
  const body = chapterBodyEntries(node.value);
  const chunks: ChunkPart[] = body.map(({ value: item, absIndex }) => {
    const link = asLink(item);
    const format = link?.format ?? null;
    if (isSubchapter(format)) {
      return { id: freshId(), rev: 0, editable: false, text: "", format, concrete: link?.concrete ?? "yamlover", subchapter: true, navPath: link?.path, title: link?.title, marker: item, absIndex };
    }
    // an inlined scalar chunk's marker points at its own containment slot (`<chapter>[i]`); a pointer
    // chunk's marker points elsewhere (the target file) → linked, and read-only this iteration.
    const inlined = !link || (typeof link.path === "string" && link.path.startsWith(node.path + "["));
    const type = link?.type;
    const editable = inlined && isEditableMarker(type, format);
    return {
      id: freshId(),
      rev: 0,
      editable,
      text: editable ? String(link?.value ?? item ?? "") : "",
      format,
      concrete: link?.concrete ?? "yamlover",
      subchapter: false,
      marker: item,
      absIndex,
    };
  });
  return { path: node.path, title: node.title ?? "", description: node.description ?? "", chunks, entryCount: chapterEntryCount(node.value) };
}

/** A committed snapshot for diffing — the model's title/description and each part's id + text
 *  (only editable text can change; read-only parts are compared by id only). */
export function snapshotChapter(m: ChapterModel): ChapterModel {
  return { path: m.path, title: m.title, description: m.description, chunks: m.chunks.map((c) => ({ ...c })), entryCount: m.entryCount };
}

/**
 * The minimal ordered edit list to turn `committed` into `current`, addressed by node path:
 *  - title/description changed → `emplace` its new value; emptied → `remove` the key;
 *  - part id gone → `remove` (last first, so an earlier remove never moves a pending one);
 *  - new part id → `insert` at the absolute index it takes (forward — each insertion makes room);
 *  - surviving editable chunk whose text changed → `emplace`, which keeps the chunk's annotations
 *    and its `!!<…>` tag (only its scalar facet is replaced).
 * Every index is the ABSOLUTE entry index — keyed entries (title/description) consume indices too —
 * so an edit path is a plain yamlover path. Reordering existing parts is not supported (the editor
 * never moves them). The server applies the batch in this order, re-scanning the source per op.
 */
export function diffChapter(committed: ChapterModel, current: ChapterModel): Edit[] {
  const edits: Edit[] = [];
  const base = current.path;
  // a heading is one line: quote it rather than open a block scalar (`title: |-` reads badly)
  const scalar = (path: string, text: string): Edit =>
    text ? { path, op: "emplace", yamlover: JSON.stringify(text) } : { path, op: "remove" };
  // A keyed entry consumes an absolute index. Emptying `title` REMOVES it, sliding every later entry
  // down one; a fresh key is appended at the end, so it shifts nothing before it.
  let shift = 0; // existing entries sliding down as a key before them is removed
  let added = 0; // a fresh key, appended after them
  for (const key of ["title", "description"] as const) {
    if (current[key] === committed[key]) continue;
    edits.push(scalar(childPath(base, key), current[key]));
    if (!current[key] && committed[key]) shift -= 1;
    else if (current[key] && !committed[key]) added += 1;
  }

  const curIds = current.chunks.map((c) => c.id);
  const curById = new Map(current.chunks.map((c) => [c.id, c]));
  const comById = new Map(committed.chunks.map((c) => [c.id, c]));
  // The committed body, each element with the ABSOLUTE index it will have when its op is applied.
  // The server re-scans the source per op, so a removal shifts every later index down and an
  // insertion shifts them up — the shadow tracks exactly that.
  const shadow = committed.chunks.map((c) => ({ id: c.id, abs: c.absIndex + shift }));
  let entryCount = committed.entryCount + shift + added; // the abs index an APPEND lands on
  const bodyAt = (abs: number): string => childPath(base, abs);

  // 1) removals — last first, so an earlier removal never moves a pending one
  for (let i = shadow.length - 1; i >= 0; i--) {
    if (curById.has(shadow[i].id)) continue;
    edits.push({ path: bodyAt(shadow[i].abs), op: "remove" });
    shadow.splice(i, 1);
    for (let j = i; j < shadow.length; j++) shadow[j].abs -= 1;
    entryCount -= 1;
  }

  // 2) insertions — forward, each at the absolute index its element takes. Past the last entry the
  //    path names the chapter itself, which the server reads as "append".
  for (let p = 0; p < curIds.length; p++) {
    const id = curIds[p];
    if (shadow.some((sh) => sh.id === id)) continue;
    const abs = p < shadow.length ? shadow[p].abs : entryCount;
    edits.push({ path: p < shadow.length ? bodyAt(abs) : base, op: "insert", yamlover: escapeYamloverScalar(curById.get(id)!.text) });
    for (let j = p; j < shadow.length; j++) shadow[j].abs += 1;
    shadow.splice(p, 0, { id, abs });
    entryCount += 1;
  }

  // 3) replacements — surviving editable chunks whose text changed. `emplace`, so a chunk carrying
  //    annotations (an omni overlay on its prose) keeps them, and a tagged chunk keeps its tag.
  for (let j = 0; j < curIds.length; j++) {
    const cur = curById.get(curIds[j])!;
    const com = comById.get(curIds[j]);
    if (com && cur.editable && cur.text !== com.text) {
      edits.push({ path: bodyAt(shadow[j].abs), op: "emplace", yamlover: escapeYamloverScalar(cur.text) });
    }
  }

  // Record where the batch leaves each element: a freshly inserted part had no absolute index, and
  // the NEXT diff (against the snapshot taken of `current`) must address it by the one it now has.
  current.chunks.forEach((c, j) => { c.absIndex = shadow[j].abs; });
  current.entryCount = entryCount;
  return edits;
}
