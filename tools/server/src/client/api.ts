// Typed wrappers over the server's JSON API.

import { api } from "./base"; // prefixes every server path with the served base path (--base-path)

export interface TreeNode {
  path: string;
  label: string;
  type: string;
  format: string | null;
  valueType?: string | null; // renderer dispatch facets (TYPES.md §9)
  hasKeyed?: boolean;
  hasOrdinal?: boolean;
  concrete: string | null; // how it is stored; `dir` → a plain-folder icon
  hasChildren: boolean;
  children: TreeNode[];
}

export interface NodeJson {
  path: string;
  type: string;
  format?: string | null; // schema `format`; with the facets it keys the renderer (TYPES.md §9)
  valueType?: string | null; // the scalar self-VALUE's type (null|boolean|integer|number|string|binary), or null
  hasKeyed?: boolean; // owns ≥1 keyed element
  hasOrdinal?: boolean; // owns ≥1 ordinal (keyless) element
  concrete: string | null;
  documentPath?: string; // the document (nearest yamlover entity) this node is in —
                         // the anchor a document-relative (`/…`) link resolves against
  title: string | null;
  description: string | null;
  value: unknown;
  // Retained source comments to render with the value, keyed by each node's fragment
  // continuation FROM THIS node (`/key`, `[i]`, nested): `{ leading?: string[], trailing?:
  // string[] }`. `$head` = the file banner; `$tail` = this node's leftover comments. Texts
  // are the comment bodies (sigils stripped) — the renderer adds `#` / `//` per syntax.
  comments?: CommentMap;
  relations?: Record<string, unknown>; // named up-edges (+ `..`) as ref markers
}

export type CommentBucket = {
  leading?: string[];
  trailing?: string[];
  pointer?: string;   // a ref's authored pointer text, canonical colon form (no `*`)
  anchors?: string[]; // the node's `&` path-anchor bodies (no `&`)
  tag?: string;       // the node's yamlover type tag (`!!set` / `!!mix` / `!!var`)
  blankBefore?: boolean; // a blank source line precedes this entry — render an empty line
  valueTrailing?: string[]; // a comment trailing the node's own self-value line (omni `5 # …`)
};
export type CommentMap = Record<string, CommentBucket | string[]>;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body as T;
}

/** Server info: the ROOT path as given on the CLI (breadcrumb head; "" if omitted). */
export function fetchInfo(): Promise<{ root: string }> {
  return getJson<{ root: string }>(api("/api/info"));
}

/** A long-running server task (indexing, hashing, …) — mirrors server/tasks.ts. Updates ride
 *  /api/events as `{type:"task", task}` frames; this shape is also what GET /api/tasks lists. */
export interface TaskInfo {
  id: string;
  label: string;
  state: "running" | "done" | "error";
  progress: { done: number; total?: number; message?: string };
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** Server tasks in flight (or just finished) — the snapshot a freshly loaded page needs. */
export function fetchTasks(): Promise<TaskInfo[]> {
  return getJson<TaskInfo[]>(api("/api/tasks"));
}

/** The TOC subtree rooted at `path`, `depth` levels deep (server default 3). */
export function fetchTree(path = ":", depth?: number): Promise<TreeNode> {
  const q = new URLSearchParams({ path });
  if (depth != null) q.set("depth", String(depth));
  return getJson<TreeNode>(api(`/api/tree?${q}`));
}

export function fetchNode(
  path: string,
  depth?: number | null, // a finite level, `null` = `.inf` (unlimited), or omit for the server default
  opts?: { binary?: boolean },
): Promise<NodeJson> {
  const q = new URLSearchParams({ path });
  setDepth(q, depth);
  if (opts?.binary) q.set("binary", "1"); // request a binary leaf's base64 bytes
  return getJson<NodeJson>(api(`/api/json?${q}`));
}

/** Encode a render depth into the query: `null` → `.inf` (unlimited), a finite
 *  level → its number, `undefined` → nothing (let the server pick its default). */
function setDepth(q: URLSearchParams, depth?: number | null): void {
  if (depth === null) q.set("depth", ".inf");
  else if (depth !== undefined) q.set("depth", String(depth));
}

/** URL of a file-backed node's raw bytes (image / pdf / html / djvu source). */
export function blobUrl(path: string): string {
  return api(`/api/blob?path=${encodeURIComponent(path)}`);
}

/** URL of a lazily-generated thumbnail of a file-backed blob, fitted within `w`×`h`. The server
 *  generates + caches it on first request and 415s a format it can't decode (the caller then
 *  shows the type glyph). */
export function thumbUrl(path: string, w: number, h: number): string {
  return api(`/api/thumb?path=${encodeURIComponent(path)}&w=${w}&h=${h}`);
}

/** The node's instance schema. `depth` follows {@link fetchNode}: a finite level,
 *  `null` = `.inf`, or omit for the server default. */
export function fetchSchema(path: string, depth?: number | null): Promise<unknown> {
  const q = new URLSearchParams({ path });
  setDepth(q, depth);
  return getJson<unknown>(api(`/api/schema?${q}`));
}

/** A tag as the annotation API hands it around: its node path, display name (the taxonomy key),
 *  and explicit color — null for a named tag, whose hue the client derives from the name. */
export interface TagRef {
  path: string;
  name: string;
  color: string | null;
}

/** An annotation of a material — ONE TAG APPLICATION (ANNOTATIONS.md): the whole node, or a
 *  fragment within it (then `selector` carries that fragment's region and `fragmentSlug` its
 *  key, and `imageUrl` its crop), tagged by `tag` with optional `description` / `params`. */
export interface Annotation {
  tag?: TagRef | null;
  selector?: { type?: string; exact?: string; prefix?: string; suffix?: string; [k: string]: unknown };
  fragmentSlug?: string; // set when the tag is on a fragment (the region) rather than the whole node
  imageUrl?: string; // an image-like fragment's crop (a /api/blob URL)
  description?: string;
  params?: Record<string, unknown>;
  created?: string;
  node?: string; // the CLIENT path of the node this annotation/fragment lives ON — the chapter, or a
                 // CHUNK when the fragment hangs off a chunk (ANNOTATIONS.md §3). Drives the delete
                 // target, the `#`-anchor, and which element the highlight is scoped to.
  path?: string; // a transient client marker only ("(preview)"/"(pending)"); annotations have no node path
}

/** The annotations whose `target` is the material at `path` (the engine's reverse link). */
export function fetchAnnotations(path: string): Promise<Annotation[]> {
  return getJson<Annotation[]>(api(`/api/annotations?path=${encodeURIComponent(path)}`));
}

/** The materials filed under the tag at `path` — `$yamloverLink` markers, annotations already
 *  resolved to their `target` and deduped (the explorer's member list for a tag page). */
export function fetchTagged(path: string): Promise<unknown[]> {
  return getJson<unknown[]>(api(`/api/tagged?path=${encodeURIComponent(path)}`));
}

/** Evaluate a colon-grammar QUERY (QUERY.md / engine `query` op) at `at` (default: the root `:`),
 *  returning the matched node paths in canonical colon form. A malformed query rejects (the
 *  server answers 400). Reused by the tag-picker typeahead and, later, by find-usages. */
export function query(q: string, at = ":"): Promise<string[]> {
  const params = new URLSearchParams({ q, path: at });
  return getJson<{ results: string[] }>(api(`/api/query?${params}`)).then((r) => r.results);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
  return json as T;
}

/** The parsed project config (IMPORTS.md / engine settings). Mirrors the engine `Settings` —
 *  flat: locations are project paths (`:annotations`), sidecars an enum. */
export interface ConfigSettings {
  uri?: string;
  exports: string[];
  annotations: string;
  tags: string;
  sidecars: string;
}
export interface ConfigPayload {
  source: string; // raw settings.yamlover text ("" if the file does not exist yet)
  settings: ConfigSettings; // parsed (defaults overlaid)
  path: string; // the hidden config file's colon path
}

/** Read the project config — `<root>/.yamlover/settings.yamlover`. Gives the settings editor the
 *  RAW source (the node projection drops comments) plus the parsed settings. */
export function fetchConfig(): Promise<ConfigPayload> {
  return getJson<ConfigPayload>(api("/api/config"));
}

/** Save edited config source. The server validates it parses (a broken config must never break
 *  serving) before writing, then reloads its write-path defaults. Returns the reparsed settings. */
export function saveConfig(source: string): Promise<{ ok: true; settings: ConfigSettings }> {
  return postJson(api("/api/config"), { source });
}

/** Create a FRAGMENT — a marked region in the node at `target` (ANNOTATIONS.md). Returns its slug
 *  and full node path, which is then the `target` for {@link annotate}. `imageBase64` is an
 *  optional PNG crop for image-like selections. */
export function createFragment(target: string, selector: Record<string, unknown>, imageBase64?: string): Promise<{ slug: string; fragmentPath: string }> {
  return postJson(api("/api/fragment"), { target, selector, ...(imageBase64 ? { imageBase64 } : {}) });
}

/** Apply the tag at `tag` to the node at `target` (a whole node OR a fragment path) — appends to
 *  the target's `yamlover-annotations`. `description`/`params` make it a parametrized annotation. */
export function annotate(a: { target: string; tag: string; description?: string; params?: Record<string, unknown> }): Promise<{ ok: true }> {
  return postJson(api("/api/annotate"), a);
}

/** Persist a board directory's LANE configuration — `lanes` is the lanes, each a list of tag
 *  client-paths (1 = a plain lane, N = N sublanes). Rewrites the directory's board overlay
 *  (`.yamlover/body.yamlover` `lanes:`) and reindexes; the open board re-reads it over SSE. */
export function saveBoardLanes(path: string, lanes: string[][]): Promise<{ ok: true }> {
  return postJson(api("/api/board"), { path, lanes });
}

/** Create a named tag at the project's default tags location (settings.yamlover; `/tags` by
 *  default) — the picker's create-on-miss. Idempotent: an existing tag at that path is returned
 *  as-is; a non-tag node already occupying the path is an error. */
export function createTag(name: string): Promise<TagRef> {
  return fetch(api("/api/tag"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).then(
    async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      return body as TagRef;
    },
  );
}

/** Install the bundled LLM-agent guidance docs (AGENTS.md + CLAUDE.md) into the served project
 *  root — so an AI agent co-editing this directory has the authoring/safety rules. The guidance is
 *  a marker-fenced block: a missing file is `created`, an existing file gets it `appended` after
 *  the human's own rules, a stale block is `updated` in place, and an up-to-date one is `exists`.
 *  The human's own text is never overwritten, so the call is safe to repeat (idempotent). */
export function installAgentDocs(): Promise<{
  files: { name: string; status: "created" | "appended" | "updated" | "exists" }[];
}> {
  return postJson(api("/api/agent-docs"), {});
}

/** The result of pasting/uploading a file or text: the new file's node path (for a text chunk,
 *  the chapter it joined), and (for a chapter) the chapter path plus any chunk pointer appended. */
export interface PasteResult {
  path: string; // the new file's node path (a text chunk: the chapter's own path)
  chapter?: string; // the chapter the chunk was appended to (chapter paste only)
  pointer?: string; // the `*…` chunk pointer appended (chapter FILE paste only)
  dir?: string; // the enclosing directory the file landed in (directory/member paste)
  open?: boolean; // true when the page was a MEMBER of a directory → open the new file
}

function postPaste(body: Record<string, unknown>): Promise<PasteResult> {
  return fetch(api("/api/paste"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => {
    const json = await res.json();
    if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
    return json as PasteResult;
  });
}

/** Upload a pasted file onto the page at `target` (a directory or a chapter). */
export function pasteFile(target: string, filename: string, contentBase64: string): Promise<PasteResult> {
  return postPaste({ path: target, filename, contentBase64 });
}

/** Paste plain TEXT onto the page at `target`: a chapter gains it as a new chunk; anywhere else
 *  it becomes a new chapter .yamlover file in the nearest enclosing directory. */
export function pasteText(target: string, text: string): Promise<PasteResult> {
  return postPaste({ path: target, text });
}

/** Paste RICH content (an HTML selection: text + images + heading-nested subchapters) onto the
 *  page at `target`. A chapter appends the chunks and subchapters; anywhere else a new chapter
 *  is created — directory-backed when files are present, a standalone .yamlover file otherwise.
 *  `rich` is the RichNode tree from paste-html.ts (images already inline as base64 files). */
export function pasteRich(target: string, rich: unknown): Promise<PasteResult> {
  return postPaste({ path: target, rich });
}

/** One surgical chapter edit (the unlocked WYSIWYG editor's background sync). `path` is the leaf's
 *  node path; the server routes each edit to its own backing file:
 *   - `op:"set"`     — a `…:title` / `…:description` scalar to `text`;
 *   - `op:"replace"` — the prose chunk at body rank `…[rank]` with `text`;
 *   - `op:"insert"`  — a new chunk into the chapter at body rank `index` (`text` may be "");
 *   - `op:"remove"`  — the body element at `…[rank]`.
 *  Only prose chunks (marklower / markdown) are text-editable — a file/pointer or non-prose chunk 400s. */
export interface ChapterEdit {
  path: string;
  op: "set" | "replace" | "insert" | "remove";
  text?: string;
  index?: number;
}

/** Send a single chapter edit. */
export function editChunk(path: string, op: ChapterEdit["op"], text = "", index?: number): Promise<{ ok: true }> {
  return postJson(api("/api/edit"), { path, op, text, index });
}

/** Send a BATCH of chapter edits (the background sync's coalesced flush) — applied in order,
 *  grouped by backing file server-side, one reindex per touched file. */
export function editChunks(edits: ChapterEdit[]): Promise<{ ok: true }> {
  return postJson(api("/api/edit"), { edits });
}

/** Create an OBJECT of a schema (the right-click context menu): a CHILD of a compatible parent
 *  (concrete `yamlover` inline, or `file/yamlover`/`dir/yamlover` linked), or a MEMBER of a directory
 *  (`file/yamlover`/`dir/yamlover`). Returns the new object's node path (navigate to it). */
export function createObject(schema: string, parent: string, concrete: string, title?: string): Promise<{ path: string }> {
  return postJson(api("/api/create"), { schema, parent, concrete, ...(title ? { title } : {}) });
}

/** Remove the application of `tag` from the node at `target` (a whole node OR a fragment path) —
 *  splices the matching element out of its `yamlover-annotations`. */
export function deleteAnnotation(target: string, tag: string): Promise<void> {
  const q = new URLSearchParams({ target, tag });
  return fetch(api(`/api/annotate?${q}`), { method: "DELETE" }).then(async (res) => {
    if (!res.ok) throw new Error(((await res.json().catch(() => null))?.error) || `HTTP ${res.status}`);
  });
}
