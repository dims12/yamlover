// Typed wrappers over the server's JSON API.

import { api } from "./base"; // prefixes every server path with the served base path (--base-path)
import { strToSegs } from "./paths";
import type { BoardStructure, CompartmentAt } from "../board-model";
import { decodeEnvelope, fetchContent } from "./content";
import { deriveNodeJson } from "./derive-node";

export interface TreeNode {
  path: string;
  label: string;
  type: string;
  format: string | null;
  valueType?: string | null; // renderer dispatch facets (docs/language/logical-graph/matching)
  hasKeyed?: boolean;
  hasOrdinal?: boolean;
  concrete: string | null; // how it is stored; `dir` → a plain-folder icon
  hasChildren: boolean;
  children: TreeNode[];
  value?: string; // the scalar self-value, one line and capped — shown dim after the label
  match?: boolean; // queryFilter only: this row is one of the query's matches
}

export interface NodeJson {
  path: string;
  type: string;
  format?: string | null; // schema `format`; with the facets it keys the renderer (docs/language/logical-graph/matching)
  valueType?: string | null; // the scalar self-VALUE's type (null|boolean|integer|number|string|binary), or null
  hasKeyed?: boolean; // owns ≥1 keyed element
  hasOrdinal?: boolean; // owns ≥1 ordinal (keyless) element
  concrete: string | null;
  documentPath?: string; // the document (nearest yamlover entity) this node is in —
                         // the anchor a document-relative (`/…`) link resolves against
  title: string | null;
  description: string | null;
  // The node is DEGRADED: its source failed to parse and the value below is the fallback
  // (raw text / plain directory mapping). The banner shows it; the editor stays shut —
  // saving would overwrite the unparsable original (the server refuses too).
  parseError?: { file: string; message: string };
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
  tail?: string[]; // a container's LEFTOVER comments — own-line remarks after its last entry
                   // (the tail rule, parser comments.ts): rendered inside the block, after the
                   // entries, at the comment tab stop
  raw?: string;       // a scalar's authored SOURCE token — rendered faithfully so `"~"` reads as a
                      // string not null, `0xff`/`True` keep their spelling
  repr?: string;      // the node's REPRESENTATION concrete (../repr): `yaml/flow` for a container
                      // authored on one line, `yaml/single`/`yaml/hex`/… for a scalar. Carried only
                      // when it is not the default for the value — absent means "the canonical one"
  block?: { chomp?: "strip" | "keep"; indent?: number }; // a literal/folded scalar's qualifiers (docs/language/concretes/04-yaml)
  concrete?: string;  // an INLINE CONCRETE SWITCH — `json5p` for a flow token written K&R, i.e.
                      // spanning lines (docs/language/concretes/00-storage/00-inlined). Present only where the
                      // switch HAPPENS; below it the language lock makes the concrete derivable, so
                      // a renderer reads it once and draws the whole subtree that way.
  keyConcrete?: string; // `yamlover/key/flat` when this key was a flat-row segment (docs/language/flattening)
};
export type CommentMap = Record<string, CommentBucket | string[]>;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body as T;
}

/** Server info: the ROOT path as given on the CLI (breadcrumb head; "" if omitted), plus the
 *  server's read-only posture (`--read-only`; the SPA reads the injected global instead). */
export function fetchInfo(): Promise<{ root: string; readOnly?: boolean }> {
  return getJson<{ root: string; readOnly?: boolean }>(api("/api/info"));
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

/** The dead prose-link TARGET set (the link invariant's client half — see dead-links.ts). */
export function fetchDeadLinks(): Promise<{ targets: string[] }> {
  return getJson<{ targets: string[] }>(api("/api/dead-links"));
}

/** The TOC subtree rooted at `path`, `depth` levels deep (server default 3). */
export function fetchTree(path = ":", depth?: number): Promise<TreeNode> {
  const q = new URLSearchParams({ path });
  if (depth != null) q.set("depth", String(depth));
  return getJson<TreeNode>(api(`/api/tree?${q}`));
}

export async function fetchNode(
  path: string,
  depth?: number | null, // a finite level, `null` = `.inf` (unlimited), or omit for the server default
  opts?: { binary?: boolean },
): Promise<NodeJson> {
  // THE ONE WIRE: the server speaks yamlover (/api/content); the old NodeJson shape every
  // renderer consumes is DERIVED here, client-side — proven equivalent by the
  // wire-equivalence gate. Bytes never ride the text wire: `binary` fetches them raw from
  // /api/blob and splices the old marker shape.
  const content = await fetchContent(path, depth);
  const node = deriveNodeJson(content, depth);
  if (!opts?.binary) return node;
  const res = await fetch(blobUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const payload = { format: node.format ?? null, size: buf.length, base64: btoa(bin) };
  if (node.type === "binary") return { ...node, value: { $yamloverBinary: payload } };
  // a blob-backed OMNI (an image carrying overlay entries): the bytes fill the mixed
  // marker's self-value slot, entries and base64 together — the old ?binary=1 contract
  const marker = (node.value as Record<string, { value?: unknown }> | null)?.$yamloverMixed;
  if (marker) marker.value = { $yamloverBinary: payload };
  return node;
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

/** An annotation of a material — ONE TAG APPLICATION (docs/annotations): the whole node, or a
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
                 // CHUNK when the fragment hangs off a chunk (docs/annotations/storage). Drives the delete
                 // target, the `#`-anchor, and which element the highlight is scoped to.
  inline?: boolean; // an INLINE token membership (docs/documents/marklower/grammar) — delete carries the selector
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

/** Evaluate a colon-grammar QUERY (docs/language/pointers/queries / engine `query` op) at `at` (default: the root `:`),
 *  returning the matched node paths in canonical colon form. A malformed query rejects (the
 *  server answers 400). Reused by the tag-picker typeahead and, later, by find-usages. */
export function query(q: string, at = ":"): Promise<string[]> {
  const params = new URLSearchParams({ q, path: at });
  return getJson<{ results: string[] }>(api(`/api/query?${params}`)).then((r) => r.results);
}

/** Evaluate a QUERY like {@link query}, but get each match as a TreeNode row (metadata only,
 *  `children: []` — the chevron lazy-loads them like any TOC row). The breadcrumb dropdown's
 *  candidate source. */
export function queryTree(q: string, at = ":"): Promise<TreeNode[]> {
  const params = new URLSearchParams({ q, path: at, shape: "tree" });
  return getJson<{ results: TreeNode[] }>(api(`/api/query?${params}`)).then((r) => r.results);
}

/** Evaluate a QUERY into the FILTERED-TOC shape: ONE pruned tree from the root containing
 *  the matches plus ALL their containment ancestors (normal TOC child order, each match row
 *  flagged `match`) plus each match's own children one level deep (so the TOC shows what
 *  lies below the matched path), the matched paths in evaluator walk order, and whether the
 *  server's match cap clipped the set. */
export function queryFilter(q: string, at = ":"): Promise<{ root: TreeNode; matches: string[]; truncated: boolean }> {
  const params = new URLSearchParams({ q, path: at, shape: "filter" });
  return getJson<{ root: TreeNode; matches: string[]; truncated: boolean }>(api(`/api/query?${params}`));
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
  ontos: string;
  sidecars: string;
  width?: number; // reading width (ch) — the project layer; browser settings override it
  theme?: string; // ui palette (dark | light) — the project layer; browser settings override it
}
export interface ConfigPayload {
  source: string; // raw settings.yo text ("" if the file does not exist yet)
  settings: ConfigSettings; // parsed (defaults overlaid)
  path: string; // the hidden config file's colon path
}

/** Read the project config — `<root>/.yo/settings.yo` — for the parsed settings (e.g. the
 *  tags location, used by the annotate flow). The config is EDITED through the ordinary yamlover data
 *  view + `/api/edit` now; the server reloads its settings on any change to that file. */
export function fetchConfig(): Promise<ConfigPayload> {
  return getJson<ConfigPayload>(api("/api/config"));
}

/** Create a FRAGMENT — a marked region in the node at `target` (docs/annotations). Returns its slug
 *  and full node path, which is then the `target` for {@link annotate}. `imageBase64` is an
 *  optional PNG crop for image-like selections; `slug` an optional USER-CHOSEN key (the
 *  picker's key field — the server refuses a taken one, and mints a slug when absent). */
export function createFragment(target: string, selector: Record<string, unknown>, imageBase64?: string, slug?: string): Promise<{ slug: string; fragmentPath: string }> {
  return postJson(api("/api/fragment"), { target, selector, ...(imageBase64 ? { imageBase64 } : {}), ...(slug ? { slug } : {}) });
}

/** Apply the tag at `tag` to the node at `target` (a whole node OR a fragment path) — appends to
 *  the target's `yamlover-annotations`. `description`/`params` make it a parametrized annotation. */
export function annotate(a: { target: string; tag: string; description?: string; params?: Record<string, unknown>; selector?: Record<string, unknown> }): Promise<{ ok: true }> {
  return postJson(api("/api/annotate"), a);
}

// ---- the tag board (TICKETS.md §3; board-model.ts is the pure policy both sides share) ---- //

/** One resolved board card — a direct member's display stub plus its current tag paths. */
export interface BoardCard {
  path: string;
  title: string;
  priority: string | null;
  assignee: string | null;
  due: string | null;
  tags: string[];
  key?: string; // a keyed compartment item keeps its key
}

/** One resolved compartment: its tags as refs, its items as cards. */
export interface BoardCompartmentView {
  tags: TagRef[];
  items: BoardCard[];
}

/** The resolved board GET/POST /api/board answer: lanes of compartments plus the BACKLOG
 *  (direct members referenced by no compartment). `seeded` = still displayed from the legacy
 *  `workflow:`/`lanes:` seed, not yet materialized as `yo: lanes:`. */
export interface BoardResolved {
  seeded: boolean;
  lanes: BoardCompartmentView[][];
  backlog: BoardCard[];
}

/** The board at `path`, resolved (reconciled in memory for display — the GET never writes). */
export function fetchBoard(path: string): Promise<BoardResolved> {
  return getJson<BoardResolved>(api(`/api/board?path=${encodeURIComponent(path)}`));
}

/** Persist the board's STRUCTURE wholesale (add/remove lanes/compartments, set compartment
 *  tags, manual item moves) — the server reconciles, writes `yo: lanes:`, and answers resolved. */
export function saveBoardStructure(path: string, structure: BoardStructure): Promise<BoardResolved> {
  return postJson(api("/api/board"), { path, op: "structure", structure });
}

/** The MOVE GESTURE — the board's only retagging verb: untag/tag `task` by the source and
 *  destination compartments' deltas, restructure, reconcile. `null` = the backlog. */
export function boardMove(path: string, task: string, from: CompartmentAt, to: CompartmentAt): Promise<BoardResolved> {
  return postJson(api("/api/board"), { path, op: "move", task, from, to });
}

/** The silent structure fix on view-open: reconcile and (materialized boards only) write when
 *  changed; a still-seeded legacy board is reconciled in memory and never dirtied. */
export function boardReconcile(path: string): Promise<BoardResolved> {
  return postJson(api("/api/board"), { path, op: "reconcile" });
}

/** Create a named tag at the project's default ontos location (settings.yo; `/ontos` by
 *  default) — the picker's create-on-miss. Idempotent: an existing tag at that path is returned
 *  as-is; a non-tag node already occupying the path is an error. */
export function createOnto(name: string): Promise<TagRef> {
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

/** The report of an engine-mediated move: where the node went and which source files had
 *  inbound pointers rewritten (`unrewritten` lists the ones the engine could not fix). */
export interface MvResult {
  from: string;
  to: string;
  editedFiles: string[];
  unrewritten: unknown[];
}

/** Move a file-/directory-backed node (POST /api/mv): relocates the FS object and rewrites
 *  inbound pointers. `from`/`to` are canonical colon paths (keyed segments only — the route
 *  rejects positions); drop-policy.ts pre-screens what the client may even offer. */
export function moveNode(from: string, to: string): Promise<MvResult> {
  return postJson(api("/api/mv"), { from, to });
}

/** Rename a node's KEY (POST /api/rekey). One verb, two backends routed server-side by storage:
 *  an fs-backed member (a real directory/file) is renamed on disk via `mv` (inbound pointers
 *  rewritten); an inline keyed entry has its key token rewritten in the body. `path` is the
 *  node's current colon path (last segment = the old key); `key` is the new key. Returns the
 *  node's new path. */
export function rekeyNode(path: string, key: string): Promise<{ path: string }> {
  return postJson(api("/api/rekey"), { path, key });
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

/** Upload a pasted file WITHOUT appending it to the page's body: it lands in the nearest enclosing
 *  directory and the caller writes its own reference to `result.path` — how an image pasted into an
 *  open prose chunk becomes a marklower embed token in the sentence rather than a chunk after it. */
export function pasteFileInline(target: string, filename: string, contentBase64: string): Promise<PasteResult> {
  return postPaste({ path: target, filename, contentBase64, inline: true });
}

/** Paste plain TEXT onto the page at `target`: a chapter gains it as a new chunk; anywhere else
 *  it becomes a new chapter .yo file in the nearest enclosing directory. */
export function pasteText(target: string, text: string): Promise<PasteResult> {
  return postPaste({ path: target, text });
}

/** Paste RICH content (an HTML selection: text + images + heading-nested subchapters) onto the
 *  page at `target`. A chapter appends the chunks and subchapters; anywhere else a new chapter
 *  is created — directory-backed when files are present, a standalone .yo file otherwise.
 *  `rich` is the RichNode tree from paste-html.ts (images already inline as base64 files). */
export function pasteRich(target: string, rich: unknown): Promise<PasteResult> {
  return postPaste({ path: target, rich });
}

/** One surgical yamlover edit. `path` is the node's own path — each segment a key or an ABSOLUTE
 *  entry index. A node has four facets: its scalar value, its keyed entries, its ordinal entries,
 *  and its `!!<…>` meta tag.
 *   - `op:"emplace"` — replace only the facets `yamlover` carries; the rest of the node stands, and
 *                      an omitted `meta` leaves its tag alone. The verb for editing in place.
 *   - `op:"replace"` — drop all four facets and assign `yamlover`. An omitted `meta` drops the tag.
 *   - `op:"insert"`  — the new entry takes the position `path` names; an index past the end appends.
 *   - `op:"remove"`  — delete the node at `path`.
 *  `yamlover` is valid inline yamlover SOURCE — escape prose with {@link escapeYamloverScalar}, not
 *  by hand. `concrete`/`name` apply only where content is born. */
export interface Edit {
  path: string;
  op: "emplace" | "replace" | "insert" | "remove";
  yamlover?: string;
  meta?: string | null;
  concrete?: string;
  name?: string;
  /** insert only: create a KEYED entry (`key: value`) at the position — keeps authored order,
   *  unlike a fresh keyed emplace (which the server splices at the top of the block). */
  key?: string;
  /** insert only: the payload's first row is a FLAT continuation of the key
   *  (docs/language/flattening) — the splicer joins them as ONE row (`key1: key2: value`)
   *  when the payload's shape allows, else falls back to the nested splice. */
  flat?: boolean;
  /** scalar emplace only: the self-value LINE's authored position — the number of entries that
   *  precede it. A fresh self line splices there instead of at the top of the block. */
  at?: number;
}

/** Send a BATCH of edits (the background sync's coalesced flush) — applied in order, grouped by
 *  backing file server-side, one reindex per touched file. */
export function editChunks(edits: Edit[]): Promise<{ ok: true }> {
  return postJson(api("/api/edit"), { edits });
}

/** The node's yamlover SOURCE — the yed editor's load: the raw body at a document root, a
 *  re-serialized subtree deeper. */
export function fetchSource(path: string): Promise<{ source: string }> {
  return getJson<{ source: string }>(api(`/api/source?${new URLSearchParams({ path })}`));
}

/** Render a STANDALONE yamlover text (no file behind it — the browser-settings document) exactly
 *  as a served node renders. Stateless; always unlimited depth. Rejects on a parse error.
 *  The server answers with a CONTENT ENVELOPE (the one wire); the NodeJson derives here. */
export async function previewSource(source: string): Promise<NodeJson> {
  const res = await fetch(api("/api/preview"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = String((JSON.parse(text) as { error?: string }).error ?? text); } catch { /* raw */ }
    throw new Error(msg);
  }
  return deriveNodeJson(decodeEnvelope(text), null);
}

/** Apply surgical {@link Edit}s to a STANDALONE yamlover text, returning the new text — the
 *  caller persists it (the browser-settings document goes back into localStorage). Stateless;
 *  rejects with the source untouched on a malformed edit. */
export function editText(source: string, edits: Edit[]): Promise<{ source: string }> {
  return postJson(api("/api/edit-text"), { source, edits });
}

/** Create an OBJECT of a schema (the right-click context menu) — an `insert` carrying the schema as
 *  its `meta` tag and a body template. The server reads `parent` to decide where the content is
 *  born: a document's body gains a CHILD (inline, or a linked file/dir plus a `*` pointer), while a
 *  plain directory gains a MEMBER. Returns the new object's node path (navigate to it). */
export function createObject(schema: string, parent: string, concrete: string, title?: string): Promise<{ path: string }> {
  const name = title || defaultObjectTitle(schema);
  return postJson<{ ok: true; path: string }>(api("/api/edit"), {
    path: parent,
    op: "insert",
    concrete,
    name,
    meta: `*${schema}`,
    yamlover: objectBody(name),
  });
}

/** Create a generic NODE — an UNTAGGED, EMPTY yamlover document (no schema meta, no body: an
 *  empty document is not an empty-string scalar). The editor opens it as a root hole ready for
 *  the first token. `concrete` picks the storage form (`file/yamlover` | `dir/.yo` | `dir/index.yo`); the
 *  parent decides member vs linked child, exactly like {@link createObject}. Returns the new
 *  node's path (navigate to it). */
export function createNode(parent: string, concrete: string, name = "New node"): Promise<{ path: string }> {
  return postJson<{ ok: true; path: string }>(api("/api/edit"), { path: parent, op: "insert", concrete, name });
}

/** The default title for a new object of `schema` — "New <last segment>" (e.g. "New chapter"). */
function defaultObjectTitle(schema: string): string {
  const segs = strToSegs(schema);
  return "New " + String(segs[segs.length - 1] ?? "object");
}

/** A fresh object's body source: a title and one empty prose chunk, so it is immediately editable.
 *  The title is the omni node's scalar SELF-VALUE — a bare quoted line, no `title:` key
 *  (docs/documents/chapter). (The server no longer knows what a chapter is — the body template lives with the
 *  client that offers the schema.) */
function objectBody(title: string): string {
  return `${JSON.stringify(title)}\n- ""`;
}

/** Remove the application of `tag` from the node at `target` (a whole node OR a fragment path) —
 *  splices the matching element out of its `yamlover-annotations`. */
export function deleteAnnotation(target: string, tag: string, selector?: Record<string, unknown>): Promise<void> {
  const q = new URLSearchParams({ target, tag, ...(selector ? { selector: JSON.stringify(selector) } : {}) });
  return fetch(api(`/api/annotate?${q}`), { method: "DELETE" }).then(async (res) => {
    if (!res.ok) throw new Error(((await res.json().catch(() => null))?.error) || `HTTP ${res.status}`);
  });
}
