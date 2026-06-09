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

/** An annotation of a material — a marked segment + optional note, reverse-linked server-side. */
export interface Annotation {
  path: string; // the annotation's own node path
  selector?: { type?: string; exact?: string; prefix?: string; suffix?: string; color?: string; [k: string]: unknown };
  body?: string;
  created?: string;
}

/** The annotations whose `target` is the material at `path` (the engine's reverse link). */
export function fetchAnnotations(path: string): Promise<Annotation[]> {
  return getJson<Annotation[]>(`/api/annotations?path=${encodeURIComponent(path)}`);
}

/** Save a new annotation of the material at `target` (its JSON path); returns the created path. */
export function saveAnnotation(a: { target: string; selector: Record<string, unknown>; body?: string }): Promise<{ path: string }> {
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

/** Delete the annotation at its node path (`/annotations/<id>.yamlover`). */
export function deleteAnnotation(path: string): Promise<void> {
  return fetch(`/api/annotate?path=${encodeURIComponent(path)}`, { method: "DELETE" }).then(async (res) => {
    if (!res.ok) throw new Error(((await res.json().catch(() => null))?.error) || `HTTP ${res.status}`);
  });
}
