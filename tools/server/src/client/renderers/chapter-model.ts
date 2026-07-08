// The in-memory, schema-form editing model for ONE chapter entity (its title, description, and
// positional body). The WYSIWYG editor operates on this model — instant and correct — and a
// background sync (see chapter.tsx `useChapterSync`) reconciles it to the server as a coalesced
// batch of surgical ops (/api/edit), routing each part to its own backing file by its `concrete`/`path`.
//
// A chapter is an OMNI node (CHAPTER.md): optional keyed `title`/`description`, then a POSITIONAL
// body whose elements are chunks (renderable blocks) and subchapters (the recursion), interleaved.
// The body has no `chunks`/`children` wrapper any more — an element's edit address is its POSITIONAL
// RANK (`<chapter>[rank]`) among the body items, which lines up 1:1 with the source `- ` items.
// Subchapters ride in the body as read-only parts so those ranks stay aligned with the server.
//
// Why a model at all: editing straight against an uncontrolled contentEditable + per-op server
// round-trips was both LAGGY (file-write → reindex → SSE → refetch per keystroke) and WRONG (a
// split re-saved the head editor's stale DOM, un-truncating it). The model makes structural ops
// pure array mutations (instant), and `rev` lets the editor reset a chunk's DOM from the model when
// WE change its text (a split head) without clobbering the caret while the user types.

import { asLink } from "../render";
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
}

export interface ChapterModel {
  path: string; // the chapter's node path (the routing base for edits)
  title: string;
  description: string;
  chunks: ChunkPart[]; // the FULL ordered body (chunks + subchapters) so ranks match the server body
}

/** One surgical edit the sync sends to `/api/edit`. */
export interface Edit {
  path: string;
  op: "set" | "replace" | "insert" | "remove";
  text?: string;
  index?: number; // insert position (body rank; for `op:"insert"`)
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

/** The ordered body elements of a chapter value — the positional items of its projection. A titled
 *  chapter projects as a `$yamloverMixed` marker (title/description are keyed, the body is keyless);
 *  an untitled chapter (body only) projects as a plain array. Either way, the body is the KEYLESS
 *  elements in source order. */
export function chapterBody(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const mixed = (value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as
    | { entries?: { key: string | null; value: unknown }[] }
    | undefined;
  if (mixed?.entries) return mixed.entries.filter((e) => e.key == null).map((e) => e.value);
  return [];
}

let idSeq = 0;
const freshId = (): string => `ck${idSeq++}`;

/** A brand-new inlined prose chunk (a fresh id) — the tail of a split, or a blank added paragraph. */
export function newProsePart(text: string, format: string | null = "text/marklower"): ChunkPart {
  return { id: freshId(), rev: 0, editable: true, text, format, concrete: "yamlover", subchapter: false, marker: null };
}

/** Build the editing model from a chapter node's `/api/json` value (depth 1): its title/description
 *  and its body elements as `$yamloverLink` markers. A body element is EDITABLE when it is an inlined
 *  prose scalar (its marker points at its OWN slot `<chapter>[i]`); a subchapter or a marker pointing
 *  elsewhere (a `*…` file/pointer chunk) is a read-only part this iteration. */
export function buildChapterModel(node: { path: string; title: string | null; description: string | null; value: unknown }): ChapterModel {
  const body = chapterBody(node.value);
  const chunks: ChunkPart[] = body.map((item) => {
    const link = asLink(item);
    const format = link?.format ?? null;
    if (isSubchapter(format)) {
      return { id: freshId(), rev: 0, editable: false, text: "", format, concrete: link?.concrete ?? "yamlover", subchapter: true, navPath: link?.path, title: link?.title, marker: item };
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
    };
  });
  return { path: node.path, title: node.title ?? "", description: node.description ?? "", chunks };
}

/** A committed snapshot for diffing — the model's title/description and each part's id + text
 *  (only editable text can change; read-only parts are compared by id only). */
export function snapshotChapter(m: ChapterModel): ChapterModel {
  return { path: m.path, title: m.title, description: m.description, chunks: m.chunks.map((c) => ({ ...c })) };
}

/**
 * The minimal ordered edit list to turn `committed` into `current`, addressed by node path:
 *  - title/description change → `set`;
 *  - part id gone → `remove` (highest rank first, so earlier removes don't shift later ones);
 *  - new part id → `insert` at its final rank (forward order — each insertion makes room);
 *  - surviving editable chunk whose text changed → `replace` at its final rank.
 * A rank is the position in the FULL body array (matching the server's positional items). Reordering
 * existing parts is not supported (the editor never moves them). The server applies the batch in this
 * order, addressing each body element as `<chapter>[rank]` (insert targets the chapter itself).
 */
export function diffChapter(committed: ChapterModel, current: ChapterModel): Edit[] {
  const edits: Edit[] = [];
  const base = current.path;
  if (current.title !== committed.title) edits.push({ path: childPath(base, "title"), op: "set", text: current.title });
  if (current.description !== committed.description) edits.push({ path: childPath(base, "description"), op: "set", text: current.description });

  const curIds = current.chunks.map((c) => c.id);
  const curById = new Map(current.chunks.map((c) => [c.id, c]));
  const comById = new Map(committed.chunks.map((c) => [c.id, c]));
  const shadow = committed.chunks.map((c) => c.id); // committed order; mutated as ops apply → live ranks

  const bodyAt = (i: number): string => childPath(base, i); // `<chapter>[rank]`

  // 1) removals — highest current rank first
  const removeIdx = shadow.map((id, i) => (curById.has(id) ? -1 : i)).filter((i) => i >= 0).sort((a, b) => b - a);
  for (const idx of removeIdx) {
    edits.push({ path: bodyAt(idx), op: "remove" });
    shadow.splice(idx, 1);
  }

  // 2) insertions — forward, at each new part's final rank (targets the chapter itself)
  for (let p = 0; p < curIds.length; p++) {
    const id = curIds[p];
    if (shadow.includes(id)) continue;
    edits.push({ path: base, op: "insert", index: p, text: curById.get(id)!.text });
    shadow.splice(p, 0, id);
  }

  // 3) replacements — surviving editable chunks whose text changed, at their final rank
  for (let j = 0; j < curIds.length; j++) {
    const cur = curById.get(curIds[j])!;
    const com = comById.get(curIds[j]);
    if (com && cur.editable && cur.text !== com.text) edits.push({ path: bodyAt(j), op: "replace", text: cur.text });
  }
  return edits;
}
