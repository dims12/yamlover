// The in-memory, schema-form editing model for ONE chapter entity (its title, description, and
// chunks). The WYSIWYG editor operates on this model — instant and correct — and a background sync
// (see chapter.tsx `useChapterSync`) reconciles it to the server as a coalesced batch of surgical
// ops (/api/edit), routing each part to its own backing file by its `concrete`/`path`.
//
// Why a model at all: editing straight against an uncontrolled contentEditable + per-op server
// round-trips was both LAGGY (file-write → reindex → SSE → refetch per keystroke) and WRONG (a
// split re-saved the head editor's stale DOM, un-truncating it). The model makes structural ops
// pure array mutations (instant), and `rev` lets the editor reset a chunk's DOM from the model when
// WE change its text (a split head) without clobbering the caret while the user types.

import { asLink } from "../render";
import { segsToStr, strToSegs } from "../paths";

/** One chunk of a chapter, as the editor holds it. */
export interface ChunkPart {
  id: string; // stable client id — React key + sync identity (assigned at build, survives edits)
  rev: number; // bumped ONLY when the MODEL changes `text` programmatically (a split) → editor resets its DOM
  editable: boolean; // an inlined prose scalar (marklower/markdown) → editable; else read-only
  text: string; // the editable source (prose); "" for a read-only part
  format: string | null; // text/marklower | text/markdown | … (an image/latex/pointer → read-only)
  concrete: string; // how the part is stored (from the marker): "yamlover" (inlined) or "file/…" (linked)
  path?: string; // set ⇒ LINKED (stored out-of-line at this node path); unset ⇒ INLINED in the chapter body
  marker: unknown; // the original chunk value (link marker / scalar) — re-rendered as-is for a read-only part
}

export interface ChapterModel {
  path: string; // the chapter's node path (the routing base for edits)
  title: string;
  description: string;
  chunks: ChunkPart[]; // the FULL ordered list (prose + read-only) so indices match the server body
}

/** One surgical edit the sync sends to `/api/edit`. */
export interface Edit {
  path: string;
  op: "set" | "replace" | "insert" | "remove";
  text?: string;
  index?: number; // insert position (for `op:"insert"`)
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

/** Append a key/index segment to a node path (root-safe: `:` + `title` → `:title`). */
export function childPath(path: string, seg: string | number): string {
  return segsToStr([...strToSegs(path), seg]);
}

let idSeq = 0;
const freshId = (): string => `ck${idSeq++}`;

/** A brand-new inlined prose chunk (a fresh id) — the tail of a split, or a blank added paragraph. */
export function newProsePart(text: string, format: string | null = "text/marklower"): ChunkPart {
  return { id: freshId(), rev: 0, editable: true, text, format, concrete: "yamlover", marker: null };
}

/** Build the editing model from a chapter node's `/api/json` value (depth 2): its title/description
 *  and its chunks as `$yamloverLink` markers. A chunk is EDITABLE when it is an inlined prose scalar
 *  — inlined meaning the marker's own containment slot (`<chapter>:chunks[i]`); a marker pointing
 *  elsewhere is a LINKED part (its `path` recorded) and stays read-only this iteration. */
export function buildChapterModel(node: { path: string; title: string | null; description: string | null; value: unknown }): ChapterModel {
  const v = (node.value ?? {}) as { chunks?: unknown };
  const rawChunks = Array.isArray(v.chunks) ? v.chunks : [];
  const chunks: ChunkPart[] = rawChunks.map((item, i) => {
    const link = asLink(item);
    const inlinedPath = childPath(node.path, "chunks") + `[${i}]`;
    const inlined = !link || link.path === inlinedPath; // linked ⇒ the marker points out of its own slot
    const type = link?.type;
    const format = link?.format ?? null;
    const editable = inlined && isEditableMarker(type, format);
    return {
      id: freshId(),
      rev: 0,
      editable,
      text: editable ? String(link?.value ?? item ?? "") : "",
      format,
      concrete: link?.concrete ?? "yamlover",
      path: inlined ? undefined : link?.path,
      marker: item,
    };
  });
  return { path: node.path, title: node.title ?? "", description: node.description ?? "", chunks };
}

/** A committed snapshot for diffing — the model's title/description and each chunk's id + text
 *  (only editable text can change; read-only parts are compared by id only). */
export function snapshotChapter(m: ChapterModel): ChapterModel {
  return { path: m.path, title: m.title, description: m.description, chunks: m.chunks.map((c) => ({ ...c })) };
}

/**
 * The minimal ordered edit list to turn `committed` into `current`, addressed by node path:
 *  - title/description change → `set`;
 *  - chunk id gone → `remove` (highest index first, so earlier removes don't shift later ones);
 *  - new chunk id → `insert` at its final position (forward order — each insertion makes room);
 *  - surviving editable chunk whose text changed → `replace` at its final index.
 * Indices are the position in the FULL chunk array (matching the server body). Reordering existing
 * chunks is not supported (the editor never moves them). The server applies the batch in this order.
 */
export function diffChapter(committed: ChapterModel, current: ChapterModel): Edit[] {
  const edits: Edit[] = [];
  const base = current.path;
  if (current.title !== committed.title) edits.push({ path: childPath(base, "title"), op: "set", text: current.title });
  if (current.description !== committed.description) edits.push({ path: childPath(base, "description"), op: "set", text: current.description });

  const curIds = current.chunks.map((c) => c.id);
  const curById = new Map(current.chunks.map((c) => [c.id, c]));
  const comById = new Map(committed.chunks.map((c) => [c.id, c]));
  const shadow = committed.chunks.map((c) => c.id); // committed order; mutated as ops apply → live indices

  const chunkAt = (i: number): string => `${childPath(base, "chunks")}[${i}]`;
  const chunksKey = (): string => childPath(base, "chunks");

  // 1) removals — highest current index first
  const removeIdx = shadow.map((id, i) => (curById.has(id) ? -1 : i)).filter((i) => i >= 0).sort((a, b) => b - a);
  for (const idx of removeIdx) {
    edits.push({ path: chunkAt(idx), op: "remove" });
    shadow.splice(idx, 1);
  }

  // 2) insertions — forward, at each new chunk's final position
  for (let p = 0; p < curIds.length; p++) {
    const id = curIds[p];
    if (shadow.includes(id)) continue;
    edits.push({ path: chunksKey(), op: "insert", index: p, text: curById.get(id)!.text });
    shadow.splice(p, 0, id);
  }

  // 3) replacements — surviving editable chunks whose text changed, at their final index
  for (let j = 0; j < curIds.length; j++) {
    const cur = curById.get(curIds[j])!;
    const com = comById.get(curIds[j]);
    if (com && cur.editable && cur.text !== com.text) edits.push({ path: chunkAt(j), op: "replace", text: cur.text });
  }
  return edits;
}
