// Typed wrappers over the server's JSON API.

export interface TreeNode {
  path: string;
  label: string;
  type: string;
  format: string | null;
  concrete: string | null; // how it is stored; `dir` → a plain-folder icon
  hasChildren: boolean;
  children: TreeNode[];
}

export interface NodeJson {
  path: string;
  type: string;
  format?: string | null; // schema `format`; with `type` it keys the renderer
  concrete: string | null;
  documentPath?: string; // the document (nearest yamlover entity) this node is in —
                         // the anchor a document-relative (`/…`) link resolves against
  title: string | null;
  description: string | null;
  value: unknown;
  relations?: Record<string, unknown>; // named up-edges (+ `..`) as ref markers
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body as T;
}

/** Server info: the ROOT path as given on the CLI (breadcrumb head; "" if omitted). */
export function fetchInfo(): Promise<{ root: string }> {
  return getJson<{ root: string }>("/api/info");
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
  return getJson<TaskInfo[]>("/api/tasks");
}

/** The TOC subtree rooted at `path`, `depth` levels deep (server default 3). */
export function fetchTree(path = "/", depth?: number): Promise<TreeNode> {
  const q = new URLSearchParams({ path });
  if (depth != null) q.set("depth", String(depth));
  return getJson<TreeNode>(`/api/tree?${q}`);
}

export function fetchNode(
  path: string,
  depth?: number,
  opts?: { binary?: boolean },
): Promise<NodeJson> {
  const q = new URLSearchParams({ path });
  if (depth != null) q.set("depth", String(depth));
  if (opts?.binary) q.set("binary", "1"); // request a binary leaf's base64 bytes
  return getJson<NodeJson>(`/api/json?${q}`);
}

/** URL of a file-backed node's raw bytes (image / pdf / html / djvu source). */
export function blobUrl(path: string): string {
  return `/api/blob?path=${encodeURIComponent(path)}`;
}

/** The node's instance schema, one level deep (nested containers as link markers). */
export function fetchSchema(path: string, depth?: number): Promise<unknown> {
  const q = new URLSearchParams({ path });
  if (depth != null) q.set("depth", String(depth));
  return getJson<unknown>(`/api/schema?${q}`);
}

/** A tag as the annotation API hands it around: its node path, display name (the taxonomy key),
 *  and explicit color — null for a named tag, whose hue the client derives from the name. */
export interface TagRef {
  path: string;
  name: string;
  color: string | null;
}

/** An annotation of a material — ONE TAG APPLICATION: a marked segment (or the whole node, when
 *  `selector` is absent) tagged by `tag`, with an optional per-application comment. `tag` is
 *  null only for legacy annotations saved before tags carried the color. */
export interface Annotation {
  path: string; // the annotation's own node path
  tag?: TagRef | null;
  selector?: { type?: string; exact?: string; prefix?: string; suffix?: string; [k: string]: unknown };
  description?: string;
  created?: string;
}

/** The annotations whose `target` is the material at `path` (the engine's reverse link). */
export function fetchAnnotations(path: string): Promise<Annotation[]> {
  return getJson<Annotation[]>(`/api/annotations?path=${encodeURIComponent(path)}`);
}

/** Save a new annotation — apply the tag at `tag` to the material at `target` (JSON paths),
 *  optionally narrowed to `selector` and commented by `description`; returns the created path. */
export function saveAnnotation(a: { target: string; tag: string; selector?: Record<string, unknown>; description?: string }): Promise<{ path: string }> {
  return fetch("/api/annotate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) }).then(
    async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      return body as { path: string };
    },
  );
}

/** The result of pasting/uploading a file: the new file's node path, and (for a chapter) the
 *  chapter it was added to plus the chunk pointer appended. */
export interface PasteResult {
  path: string; // the uploaded file's node path
  chapter?: string; // the chapter the chunk was appended to (chapter paste only)
  pointer?: string; // the `*…` chunk pointer appended (chapter paste only)
  dir?: string; // the enclosing directory the file landed in (directory/member paste)
  open?: boolean; // true when the page was a MEMBER of a directory → open the new file
}

/** Upload a pasted file onto the page at `target` (a directory or a chapter). */
export function pasteFile(target: string, filename: string, contentBase64: string): Promise<PasteResult> {
  return fetch("/api/paste", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: target, filename, contentBase64 }),
  }).then(async (res) => {
    const body = await res.json();
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body as PasteResult;
  });
}

/** Delete the annotation at its node path (a standalone `<…>.yamlover` file, any directory). */
export function deleteAnnotation(path: string): Promise<void> {
  return fetch(`/api/annotate?path=${encodeURIComponent(path)}`, { method: "DELETE" }).then(async (res) => {
    if (!res.ok) throw new Error(((await res.json().catch(() => null))?.error) || `HTTP ${res.status}`);
  });
}
