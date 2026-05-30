// Typed wrappers over the server's JSON API.

export interface TreeNode {
  path: string;
  label: string;
  type: string;
  format: string | null;
  hasChildren: boolean;
  children: TreeNode[];
}

export interface NodeJson {
  path: string;
  type: string;
  concrete: string | null;
  title: string | null;
  description: string | null;
  value: unknown;
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

/** The node's instance schema, one level deep (nested containers as link markers). */
export function fetchSchema(path: string, depth?: number): Promise<unknown> {
  const q = new URLSearchParams({ path });
  if (depth != null) q.set("depth", String(depth));
  return getJson<unknown>(`/api/schema?${q}`);
}
