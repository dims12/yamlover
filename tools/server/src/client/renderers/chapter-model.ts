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

import { asLink, asMixed, scalarValue } from "../render";
import { fragmentOf, isAncestorPath, segsToStr, strToSegs } from "../paths";

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
  title: string; // the omni node's scalar SELF-VALUE (CHAPTER.md) — consumes NO entry index
  description: string;
  chunks: ChunkPart[]; // the FULL ordered body (chunks + subchapters), in source order
  entryCount: number; // ALL entries, keyed ones included — the abs index an appended entry takes
  legacyTitleKeyed: boolean; // an unmigrated keyed `title:` entry exists — a title edit migrates it out
  needsMeta: boolean; // not YET tagged a chapter (a plain folder being written as one) — the first edit stamps it
}

/** One surgical edit the sync sends to `/api/edit` (see api.ts `Edit` for the op semantics). */
export interface Edit {
  path: string;
  op: "emplace" | "replace" | "insert" | "remove";
  yamlover?: string;
  meta?: string | null; // the `!!<…>` schema pointer: set it, `null` to drop it, omit to leave it alone
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

/** The chapter schema, and the `!!<…>` CONTENT `/api/edit`'s `meta` field wants for it (a `*`
 *  pointer — the same spelling `create.ts` uses for a creatable chapter child). Editing a
 *  formatless container AS a chapter stamps this on the document root with the first edit, which
 *  is what makes a plain folder become one (the server materializes its body in the same op). */
export const CHAPTER_SCHEMA = "::yamlover:$defs:chapter";
export const CHAPTER_META = "*" + CHAPTER_SCHEMA;

/** Append a key/index segment to a node path (root-safe: `:` + `title` → `:title`; `:` + 0 → `[0]`). */
export function childPath(path: string, seg: string | number): string {
  return segsToStr([...strToSegs(path), seg]);
}

/** A body element's RENDER SLOT — where it sits on the PAGE, as an index chain from the page root
 *  (`""` at the root, `"[3]"` for its 4th entry, `"[3][1]"` for that subchapter's 2nd entry). A page
 *  that inlines subchapters needs this because an inlined element's identity on the page is its
 *  render position, which is not always a path continuation of the page root (a `*`-pointer
 *  subchapter's node lives elsewhere in the tree). */
export const childSlot = (slot: string, absIndex: number): string => `${slot}[${absIndex}]`;

/** The in-page anchor id for a chapter element: its PATH continuation from the page root — matching
 *  today's `fragmentOf(basePath, chunk.path)` exactly, so existing `#[1]` deep links keep working —
 *  falling back to its RENDER SLOT when the element's node lives OUTSIDE the page's own subtree.
 *  That fallback is load-bearing once subchapters inline: `fragmentOf` is a blind prefix-length
 *  slice, so `fragmentOf(":a:b", ":dogs")` silently returns `""` (every such element would collide
 *  on the empty id). Root pages take the `fragmentOf` branch for everything, so nothing shifts. */
export function anchorOf(base: string, nodePath: string | null | undefined, slot: string): string {
  if (nodePath && (base === ":" || base === nodePath || isAncestorPath(base, nodePath))) return fragmentOf(base, nodePath);
  return slot;
}

/** The body elements with their ABSOLUTE entry index — the index an edit path segment carries, in
 *  which the keyed `title`/`description` count too (CHAPTER.md). An untitled chapter projects as a
 *  plain array, where the two indexes coincide. */
export function chapterBodyEntries(value: unknown): { value: unknown; absIndex: number }[] {
  if (Array.isArray(value)) return value.map((v, i) => ({ value: v, absIndex: i }));
  const mixed = (value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as
    | { entries?: { key: string | null; anchor?: boolean; value: unknown }[] }
    | undefined;
  if (!mixed?.entries) return [];
  return mixed.entries.map((e, i) => ({ e, i })).filter(({ e }) => isBodyEntry(e)).map(({ e, i }) => ({ value: e.value, absIndex: i }));
}

/** How many entries the chapter has in all — the absolute index an APPENDED entry will take.
 *  The title (the omni self-value) is not an entry and never counts. */
export function chapterEntryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const mixed = (value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as { entries?: unknown[] } | undefined;
  return mixed?.entries?.length ?? 0;
}

/** True when the projection still carries a LEGACY keyed `title:` entry (an unmigrated file) —
 *  a title edit then also removes that key, migrating the file to the self-value form. */
export function hasKeyedTitle(value: unknown): boolean {
  const mixed = (value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as
    | { entries?: { key: string | null }[] }
    | undefined;
  return !!mixed?.entries?.some((e) => e.key === "title");
}

/** One element of a chapter's rendered FLOW — everything the page shows, in source order. */
export type FlowKind = "title" | "description" | "subchapter" | "chunk";
export interface FlowItem {
  kind: FlowKind;
  value: unknown; // the entry value (a `$yamloverLink` marker or an inline scalar)
  absIndex: number; // its ABSOLUTE entry index (-1 for the omni self-value, which consumes none)
}

/** An ANNOTATION OVERLAY key — a tag application / fragment set laid OVER a value (ANNOTATIONS.md).
 *  Per CHAPTER.md these "are not body, so a scalar carrying only those stays a chunk". */
const isOverlayKey = (k: string | null): boolean => k === "yamlover-annotations" || k === "yamlover-fragments";

/** A POSITIONAL body element. `key == null` is an inline `- item`; `anchor: true` is a member the
 *  BODY positioned by pointer (`- *file` consumed — a dir subchapter, a pointer chunk): its key is
 *  derived storage provenance, not an authored keyed field (META.md §body.yo), so it is body too —
 *  the same rule the projectional editor applies (yed-load.ts). Checked BEFORE the title/description
 *  keys so a member whose storage name happens to be `title` stays a body element. */
const isBodyEntry = (e: { key: string | null; anchor?: boolean }): boolean => e.key == null || e.anchor === true;

/** A body element's kind. A subchapter that ran out of depth budget arrives as a `$yamloverLink`
 *  carrying its own `format`; an INLINED one (any deeper fetch) arrives as a `$yamloverMixed`
 *  marker carrying `format` but NO `path`, and an untagged all-keyless one as a bare array. So the
 *  rule is CHAPTER.md's own: a CONTAINER body element is a subchapter — unless an explicit tag (a
 *  table, a typographical list) says it is content, or its only entries are annotation overlays,
 *  which leave a scalar a scalar. A leaf is always a chunk. */
export function bodyKindOf(v: unknown): FlowKind {
  const link = asLink(v);
  if (link) {
    if (link.format != null) return isSubchapter(link.format) ? "subchapter" : "chunk";
    // UNTAGGED at the depth boundary (a not-yet-stamped chapter, mid-write): the same structural
    // rule as the mixed branch below — a container body element IS a subchapter. Ordinal entries
    // only: an annotated scalar's keyed overlays must leave it the chunk it is.
    return link.hasOrdinal ? "subchapter" : "chunk";
  }
  const mixed = asMixed(v);
  if (mixed) {
    if (mixed.format != null) return isSubchapter(mixed.format) ? "subchapter" : "chunk"; // tagged: the tag decides
    // untagged: a CONTAINER is a subchapter — but overlay keys are not body, so a scalar wearing
    // only an annotation/fragment overlay is still the chunk it was
    return mixed.entries.some((e) => !isOverlayKey(e.key)) ? "subchapter" : "chunk";
  }
  return Array.isArray(v) ? "subchapter" : "chunk";
}

/** The chapter's full rendered stream in SOURCE order — the title (the omni node's scalar
 *  SELF-VALUE, CHAPTER.md), the keyed `description` entry, and the keyless body (chunks +
 *  subchapter links) interleaved exactly where the author placed them, so the renderer never hoists
 *  the heading or forces subchapters to the end (position is the author's; the self-value's
 *  authored position rides the marker's `selfAt`). Any OTHER keyed entry (a directory member
 *  surfaced as a key, a task planning field) is skipped: it is not chapter body content. An
 *  untitled chapter (plain-array projection) is all keyless — chunks and subchapter links, in
 *  order. A legacy keyed `title` entry still flows as the title. */
export function chapterFlow(value: unknown): FlowItem[] {
  if (Array.isArray(value)) return value.map((v, i) => ({ kind: bodyKindOf(v), value: v, absIndex: i }));
  const mixed = (value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as
    | { kind?: string; value?: unknown; selfAt?: number; entries?: { key: string | null; anchor?: boolean; value: unknown }[] }
    | undefined;
  if (!mixed?.entries) return [];
  const self = mixed.kind === "omni" && typeof mixed.value === "string" && mixed.value !== "" ? mixed.value : null;
  const selfAt = typeof mixed.selfAt === "number" ? mixed.selfAt : 0;
  const out: FlowItem[] = [];
  let placed = self == null;
  for (let i = 0; i < mixed.entries.length; i++) {
    if (!placed && i >= selfAt) { out.push({ kind: "title", value: self, absIndex: -1 }); placed = true; }
    const e = mixed.entries[i];
    if (isBodyEntry(e)) out.push({ kind: bodyKindOf(e.value), value: e.value, absIndex: i });
    else if (e.key === "title") out.push({ kind: "title", value: e.value, absIndex: i }); // legacy keyed title
    else if (e.key === "description") out.push({ kind: "description", value: e.value, absIndex: i });
    // else: another keyed entry (task planning field, an unconsumed directory member) — not body
  }
  if (!placed) out.push({ kind: "title", value: self, absIndex: -1 });
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
export function buildChapterModel(node: { path: string; title: string | null; description: string | null; value: unknown; format?: string | null }): ChapterModel {
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
  return {
    path: node.path,
    title: node.title ?? "",
    description: node.description ?? "",
    chunks,
    entryCount: chapterEntryCount(node.value),
    legacyTitleKeyed: hasKeyedTitle(node.value),
    // a node ALREADY tagged chapter-or-task keeps its own schema (never re-stamp a task as a
    // chapter — `$defs/task` narrows the body to subtasks); anything else is being written as a
    // chapter for the first time and gains the tag with its first edit
    needsMeta: !isSubchapter(node.format ?? null),
  };
}

/** A committed snapshot for diffing — the model's title/description and each part's id + text
 *  (only editable text can change; read-only parts are compared by id only). */
export function snapshotChapter(m: ChapterModel): ChapterModel {
  return { path: m.path, title: m.title, description: m.description, chunks: m.chunks.map((c) => ({ ...c })), entryCount: m.entryCount, legacyTitleKeyed: m.legacyTitleKeyed, needsMeta: m.needsMeta };
}

/**
 * The minimal ordered edit list to turn `committed` into `current`, addressed by node path:
 *  - title changed → `emplace` the chapter node ITSELF with the scalar — the title is the omni
 *    node's SELF-VALUE (CHAPTER.md), so it consumes no index; an empty payload drops the line
 *    server-side. A legacy keyed `title:` entry is removed alongside (migrate-on-edit).
 *  - description changed → `emplace` its new value; emptied → `remove` the key;
 *  - part id gone → `remove` (last first, so an earlier remove never moves a pending one);
 *  - new part id → `insert` at the absolute index it takes (forward — each insertion makes room);
 *  - surviving editable chunk whose text changed → `emplace`, which keeps the chunk's annotations
 *    and its `!!<…>` tag (only its scalar facet is replaced).
 * Every index is the ABSOLUTE entry index — a keyed entry (description) consumes an index too —
 * so an edit path is a plain yamlover path. Reordering existing parts is not supported (the editor
 * never moves them). The server applies the batch in this order, re-scanning the source per op.
 */
export function diffChapter(committed: ChapterModel, current: ChapterModel): Edit[] {
  const edits: Edit[] = [];
  const base = current.path;
  // a heading is one line: quote it rather than open a block scalar (`title: |-` reads badly)
  const scalar = (path: string, text: string): Edit =>
    text ? { path, op: "emplace", yamlover: JSON.stringify(text) } : { path, op: "remove" };
  // A keyed entry consumes an absolute index. Emptying `description` REMOVES it, sliding every
  // later entry down one; a fresh key is appended at the end, so it shifts nothing before it.
  let shift = 0; // existing entries sliding down as a key before them is removed
  let added = 0; // a fresh key, appended after them
  // A formatless container being written AS a chapter: the first batch stamps the document's root
  // `!!<*::yamlover:$defs:chapter>`. The server takes `meta` at an empty path either alone
  // (setRootTag) or riding the title emplace (setRootTag + setRootSelfValue) — and materializes a
  // bodyless directory's `.yo/body.yo` in the same op, so a plain folder becomes a
  // chapter with one edit. Like `legacyTitleKeyed`, this is migrate-on-first-edit.
  const stamp = current.needsMeta ? CHAPTER_META : undefined;
  if (current.title !== committed.title) {
    // the self-value emplace (empty drops the title line) — index-neutral by design
    edits.push({ path: base, op: "emplace", yamlover: JSON.stringify(current.title), ...(stamp ? { meta: stamp } : {}) });
    if (committed.legacyTitleKeyed) {
      edits.push({ path: childPath(base, "title"), op: "remove" }); // migrate the keyed title out
      current.legacyTitleKeyed = false;
      shift -= 1;
    }
  }
  if (current.description !== committed.description) {
    edits.push(scalar(childPath(base, "description"), current.description));
    if (!current.description && committed.description) shift -= 1;
    else if (current.description && !committed.description) added += 1;
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
  // The stamp rides the title emplace when there is one; otherwise it leads the batch as its own
  // op, so the very first content edit (a paragraph, no title) still makes the folder a chapter.
  if (stamp && edits.length) {
    if (!edits.some((e) => e.meta !== undefined)) edits.unshift({ path: base, op: "emplace", meta: stamp });
    current.needsMeta = false;
  }
  return edits;
}
