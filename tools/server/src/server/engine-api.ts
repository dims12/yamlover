/**
 * engine-api.ts — the JSON API, backed by the new yamlover ENGINE.
 *
 * This replaces the legacy `loadEntity` materializer (./yamlover.ts) with the engine:
 * `walkDir` (directory concrete → IR) + `Store` (SQLite property-graph index). It emits the
 * SAME response shapes the React client already consumes (TreeNode, the `$yamloverLink` /
 * `$yamloverRef` / `$yamloverBinary` markers, the schema view), so the UI works "as it was".
 *
 * Endpoints (path is JSON-space: `/key[0]/sub`):
 *   GET /api/info                         breadcrumb head (root label)
 *   GET /api/tree?path&depth              the TOC subtree
 *   GET /api/json?path&depth&binary       the node value (depth-limited; nested = link markers)
 *   GET /api/schema?path&depth            the instance schema
 *   GET /api/blob?path                    a file-backed node's raw bytes
 *
 * The on-disk index lives at <root>/.yamlover/index.db (created on startup); it is a derived
 * cache, rebuilt on a short TTL so external edits show up on reload.
 */

import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store, buildIndex } from "../../../engine/ts/src/index.ts";
import type { NodeRow } from "../../../engine/ts/src/index.ts";
import { buildGitIgnore } from "./gitignore.js";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;
interface Options { gitignore?: boolean } // honor .gitignore for stray files (default: true)

// Marker keys + types the client recognizes (must match src/client expectations).
const LINK_KEY = "$yamloverLink";
const REF_KEY = "$yamloverRef";
const BINARY_KEY = "$yamloverBinary";
type Seg = string | number;
type Kind = "object" | "array" | "scalar" | "binary";

export function createHandlers(dataRoot: string, opts: Options = {}): Handler {
  const rootName = path.basename(path.resolve(dataRoot)) || "/";
  const dbPath = path.join(dataRoot, ".yamlover", "index.db");
  // Skip git-ignored strays (node_modules, build output, …) so serving the project root works.
  const ignore = opts.gitignore === false ? undefined : buildGitIgnore(dataRoot);

  // Build the index ONCE at startup; then every request is answered from the open SQLite Store
  // (indexed lookups — sub-millisecond). The index is the SOURCE OF TRUTH, not a per-request
  // cache: we do NOT re-walk the filesystem on a timer — that made a click block on a full
  // re-walk + re-hash. Picking up external edits live is the FS-watcher milestone (ENGINE.md
  // Phase 3e); for now a restart (or a future /api/reindex) refreshes. `rebuild()` is kept for
  // that, invoked once here.
  let current: Store;
  const rebuild = (): void => {
    buildIndex(dataRoot, { ignore }); // walk → IR → write <root>/.yamlover/index.db
    const fresh = new Store(dbPath);
    const old = current;
    current = fresh;
    old?.close();
  };
  rebuild();
  const store = (): Store => current;

  return (req, res, url) => {
    try {
      const s = store();

      // Create an annotation (the only WRITE path): persist it as a yamlover file under the
      // served root's `annotations/`, then re-index so it joins the graph (reverse-linked to its
      // material). Body: { target, selector, body? } — target is the material's JSON path.
      if (req.method === "POST" && url.pathname === "/api/annotate") {
        readBody(req)
          .then((data) => {
            const annPath = writeAnnotation(dataRoot, data as AnnotationInput);
            rebuild();
            sendJson(res, 201, { path: annPath });
          })
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      const segs = strToSegs(url.searchParams.get("path") || "/");
      const p = storePath(segs);
      const depth = parseDepth(url.searchParams.get("depth"));

      if (url.pathname === "/api/info") {
        sendJson(res, 200, { root: rootName });
        return;
      }

      // The annotations whose `target` is this material (the engine's reverse link).
      if (url.pathname === "/api/annotations") {
        sendJson(res, 200, annotationsFor(s, segs));
        return;
      }

      if (url.pathname === "/api/tree") {
        const row = s.node(p);
        if (!row) return notFound(res, url);
        const label = segs.length === 0 ? rootName : labelFor(s, p, segs[segs.length - 1]);
        sendJson(res, 200, buildTree(s, segs, label, depth ?? 3));
        return;
      }

      if (url.pathname === "/api/blob") {
        const file = path.join(dataRoot, ...segs.map(String));
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return notFound(res, url);
        const data = fs.readFileSync(file);
        res.statusCode = 200;
        res.setHeader("Content-Type", s.node(p)?.format ?? formatFromExt(file) ?? "application/octet-stream");
        res.setHeader("Content-Length", String(data.length));
        res.end(data);
        return;
      }

      const row = s.node(p);
      if (!row) return notFound(res, url);
      const viewDepth = depth ?? 1;
      const kind = displayKind(s, p, row);

      if (url.pathname === "/api/json") {
        const wantBytes = kind === "binary" && url.searchParams.get("binary") === "1";
        sendJson(res, 200, {
          path: segsToStr(segs),
          type: tocType(s, p, row),
          format: row.format ?? null,
          concrete: null, // per-node concrete not yet tracked by the engine (icon falls back to type)
          documentPath: documentPath(s, segs), // nearest enclosing document root (for `/…` links)
          title: titleOf(s, p),
          description: null,
          value: wantBytes ? binaryContent(dataRoot, segs, row) : projectValue(s, segs, viewDepth, true),
          relations: buildRelations(s, segs),
        });
      } else if (url.pathname === "/api/schema") {
        sendJson(res, 200, projectSchema(s, segs, viewDepth, true));
      } else {
        notFound(res, url);
      }
    } catch (exc) {
      sendJson(res, 400, { error: (exc as Error).message || String(exc) });
    }
  };
}

// --------------------------------------------------------------------------- //
// Projection (Store rows → the client's value / schema / tree / marker shapes)
// --------------------------------------------------------------------------- //

/** A node's display kind: a container (mapping/with-children) is object|array; a blob is
 *  binary; a childless scalar is scalar. (An `!!omni` scalar-with-fields reads as a container.) */
function displayKind(s: Store, p: string, row: NodeRow): Kind {
  if (row.type === "blob") return "binary";
  if (s.hasChildren(p)) return row.is_array ? "array" : "object";
  if (row.type === "scalar") return "scalar";
  return row.is_array ? "array" : "object"; // empty container
}

/** The (type) label shown in the TOC/header: object|array|binary for containers/blobs, else
 *  the scalar's JSON-ish type (string/integer/number/boolean/null). */
function tocType(s: Store, p: string, row: NodeRow): string {
  const k = displayKind(s, p, row);
  if (k === "object" || k === "array" || k === "binary") return k;
  return scalarType(row.value);
}

function scalarType(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return "string";
}

/** A node value as plain JSON-able data. `depth` limits nesting; a container past the budget,
 *  or any non-top binary, becomes a `$yamloverLink` marker the client navigates on click. */
function projectValue(s: Store, segs: Seg[], depth: number, top: boolean): unknown {
  const p = storePath(segs);
  const row = s.node(p)!;
  const k = displayKind(s, p, row);
  if (!top && depth <= 0) return linkMarker(s, segs);
  if (k === "binary" && !top) return linkMarker(s, segs);
  if (k === "binary") return { size: row.size, format: row.format }; // top binary header
  // ALL entries in order — containment recursed, a `*`/`~` pointer entry shown as a link marker
  // to its target (so a `chunks` array mixing inline blocks and `*sample.png` pointers is whole).
  const kids = s.entries(p);
  const project = (c: { to: string; label: string | null; pos: number | null; kind: string }) =>
    c.kind === "contain"
      ? projectValue(s, [...segs, c.label ?? c.pos ?? 0], depth - 1, false)
      : linkMarker(s, storePathToSegs(c.to)); // pointer → a marker to where it resolves
  if (k === "array") return kids.map(project);
  if (k === "object") {
    const out: Record<string, unknown> = {};
    if (row.type === "scalar") out.$value = row.value; // omni: keep the scalar self-value
    for (const c of kids) out[c.label ?? String(c.pos)] = project(c);
    return out;
  }
  return row.value; // scalar
}

/** The instance schema (every value `v` → `{const: v}`); containers past depth = link markers. */
function projectSchema(s: Store, segs: Seg[], depth: number, top: boolean): unknown {
  const p = storePath(segs);
  const row = s.node(p)!;
  const k = displayKind(s, p, row);
  if ((k === "object" || k === "array") && depth <= 0) return linkMarker(s, segs);
  if (k === "binary" && !top) return linkMarker(s, segs);
  const schema: Record<string, unknown> = { type: k === "scalar" ? scalarType(row.value) : k };
  if (row.format) schema.format = row.format;
  const kids = s.entries(p);
  const sub = (c: { to: string; label: string | null; pos: number | null; kind: string }) =>
    c.kind === "contain" ? projectSchema(s, [...segs, c.label ?? c.pos ?? 0], depth - 1, false) : linkMarker(s, storePathToSegs(c.to));
  if (k === "object") {
    const props: Record<string, unknown> = {};
    for (const c of kids) props[c.label ?? String(c.pos)] = sub(c);
    schema.properties = props;
  } else if (k === "array") {
    schema.prefixItems = kids.map(sub);
    schema.items = false;
  } else if (k === "binary") {
    schema.const = { size: row.size, format: row.format };
  } else {
    schema.const = row.value;
  }
  const t = titleOf(s, p);
  if (t) schema.title = t;
  return schema;
}

/** A `$yamloverLink` marker for the node at `segs` (a navigable summary). */
function linkMarker(s: Store, segs: Seg[]): Record<string, unknown> {
  const p = storePath(segs);
  const row = s.node(p)!;
  const k = displayKind(s, p, row);
  const info: Record<string, unknown> = { kind: k, type: tocType(s, p, row), path: segsToStr(segs) };
  if (row.format) info.format = row.format;
  const title = titleOf(s, p);
  if (title) info.title = title;
  if (k === "binary") info.size = row.size;
  else if (k === "scalar") info.value = row.value;
  else info.count = s.children(p).length;
  return { [LINK_KEY]: info };
}

/** The relations panel: the node's outgoing `*`/`~` edges (named), led by the parent `..`. A
 *  relation NAME may repeat — a paper tagged under two tags carries two `~slug` edges with the
 *  same slug to different targets — so colliding names are de-duplicated with a ` (n)` suffix,
 *  keeping every edge (the client keys tag badges by the target, so the suffix is invisible). */
function buildRelations(s: Store, segs: Seg[]): Record<string, unknown> {
  const p = storePath(segs);
  const out: Record<string, unknown> = {};
  const put = (label: string, marker: unknown) => {
    let k = label;
    for (let i = 2; k in out; i++) k = `${label} (${i})`;
    out[k] = marker;
  };
  if (segs.length > 0) put("..", linkMarker(s, segs.slice(0, -1)));
  for (const e of s.relationships(p).out) {
    if (e.label && e.kind !== "derived") put(e.label, e.to ? linkMarker(s, storePathToSegs(e.to)) : { [REF_KEY]: { text: e.label, path: null } });
  }
  return out;
}

/** A binary leaf's bytes as a base64 payload (only when the leaf itself is selected). */
function binaryContent(dataRoot: string, segs: Seg[], row: NodeRow): Record<string, unknown> {
  const file = path.join(dataRoot, ...segs.map(String));
  const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  return { [BINARY_KEY]: { format: row.format ?? null, size: row.size ?? bytes.length, base64: bytes.toString("base64") } };
}

interface TreeNode {
  path: string; label: string; type: string; format: string | null;
  concrete: string | null; hasChildren: boolean; children: TreeNode[];
}

/** The TOC subtree rooted at `segs`, `depth` levels deep (every node listed). */
function buildTree(s: Store, segs: Seg[], label: string, depth: number): TreeNode {
  const p = storePath(segs);
  const row = s.node(p)!;
  const node: TreeNode = {
    path: segsToStr(segs),
    label,
    type: tocType(s, p, row),
    format: row.format ?? null,
    concrete: null,
    hasChildren: s.hasChildren(p),
    children: [],
  };
  if (s.hasChildren(p) && depth > 0) {
    for (const c of s.children(p)) {
      const seg = c.label ?? c.pos ?? 0;
      node.children.push(buildTree(s, [...segs, seg], labelFor(s, c.to, seg), depth - 1));
    }
  }
  return node;
}

/** A node's tree label: an instance `title` child, else the key / `[index]`. */
function labelFor(s: Store, p: string, keyOrIdx: Seg): string {
  const t = titleOf(s, p);
  if (t) return t;
  return typeof keyOrIdx === "number" ? `[${keyOrIdx}]` : keyOrIdx;
}

// --------------------------------------------------------------------------- //
// Annotations — graph-native: each is a yamlover object under `<root>/annotations/`, pointing
// (`target: *//…`) at its material; a material's annotations are the inverse of those edges.
// --------------------------------------------------------------------------- //

interface AnnotationInput {
  target: string; // the material's JSON path (e.g. "/60-simple-chapter.yamlover")
  selector: Record<string, unknown>; // { type: "text", exact, prefix, suffix } | { type:"rect", … }
  body?: string;
}

/** The annotations whose `target` resolves to this material — the incoming `ref` edges from
 *  `x-yamlover-annotation` nodes — each projected to its full object (selector, body, created). */
function annotationsFor(s: Store, segs: Seg[]): unknown[] {
  const p = storePath(segs);
  const out: unknown[] = [];
  for (const e of s.relationships(p).in) {
    if (e.kind !== "ref") continue;
    const src = s.node(e.from);
    if (src?.format !== "x-yamlover-annotation") continue;
    const aSegs = storePathToSegs(e.from);
    out.push({ path: segsToStr(aSegs), ...(projectValue(s, aSegs, 6, true) as Record<string, unknown>) });
  }
  return out;
}

/** Serialize a value as a yamlover scalar (double-quoted strings round-trip through the parser). */
function yScalar(v: unknown): string {
  return typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v ?? ""));
}

/** Persist a new annotation as a yamlover file under `<root>/annotations/`; returns its filename.
 *  The material is referenced with a project-scoped deref pointer so the engine reverse-links it
 *  on re-index (a leading star + a "//path" project path). */
function writeAnnotation(dataRoot: string, a: AnnotationInput): string {
  if (!a?.target || !a?.selector) throw new Error("annotation needs a target and a selector");
  const dir = path.join(dataRoot, "annotations");
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `${id}.yamlover`;
  const lines = [
    "!!<*yamlover/$defs/annotation>",
    `target: *//${a.target.replace(/^\//, "")}`,
    "selector:",
    ...Object.entries(a.selector).map(([k, v]) => `  ${k}: ${yScalar(v)}`),
  ];
  if (a.body) lines.push(`body: ${yScalar(a.body)}`);
  lines.push(`created: ${new Date().toISOString()}`, "");
  fs.writeFileSync(path.join(dir, file), lines.join("\n"));
  return `/annotations/${file}`;
}

/** Read a request body and parse it as JSON. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/** The nearest enclosing DOCUMENT root for `segs` — the closest ancestor (or self) whose node
 *  is flagged `documentRoot` (a parsed file / `.yamlover` dir / served root). It is the anchor a
 *  document-relative (`/…`) marklower link resolves against, mirroring the `/` pointer scope. */
function documentPath(s: Store, segs: Seg[]): string {
  for (let i = segs.length; i >= 0; i--) {
    const anc = segs.slice(0, i);
    if (s.node(storePath(anc))?.meta?.documentRoot) return segsToStr(anc);
  }
  return "/";
}

/** A node's `title` child value (a scalar), if any — used as a friendly label. */
function titleOf(s: Store, p: string): string | null {
  const titlePath = (p === "/" ? "" : p) + "/title";
  const t = s.node(titlePath);
  if (t && t.type === "scalar" && !s.hasChildren(titlePath) && t.value != null) return String(t.value);
  return null;
}

// --------------------------------------------------------------------------- //
// Path handling (JSON space; matches the client + the Store path scheme)
// --------------------------------------------------------------------------- //

const PATH_TOKEN = /\[\d+\]|[^/\[\]]+/g;

/** Render segments as a client-facing JSON path (`/key[0]/x`), percent-encoding keys. */
function segsToStr(segs: Seg[]): string {
  return segs.map((seg) => (typeof seg === "number" ? `[${seg}]` : `/${encodeURIComponent(seg)}`)).join("") || "/";
}

/** Parse a client JSON path into segments (`[n]` → number, else a decoded key). */
function strToSegs(str: string): Seg[] {
  const out: Seg[] = [];
  for (const tok of str.match(PATH_TOKEN) || []) out.push(/^\[\d+\]$/.test(tok) ? Number(tok.slice(1, -1)) : safeDecode(tok));
  return out;
}

/** Build the raw Store path (un-encoded keys) the index uses, from decoded segments. */
function storePath(segs: Seg[]): string {
  return segs.map((seg) => (typeof seg === "number" ? `[${seg}]` : `/${seg}`)).join("") || "/";
}

/** Parse a raw Store path back into segments (keys are raw — no decode). */
function storePathToSegs(p: string): Seg[] {
  const out: Seg[] = [];
  for (const tok of p.match(PATH_TOKEN) || []) out.push(/^\[\d+\]$/.test(tok) ? Number(tok.slice(1, -1)) : tok);
  return out;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// extension → Content-Type for the blob endpoint (mirrors the engine walker's table subset).
const EXT_CT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".tiff": "image/tiff", ".tif": "image/tiff", ".html": "text/html",
  ".md": "text/markdown", ".csv": "text/csv", ".epub": "application/epub+zip",
};
function formatFromExt(file: string): string | null {
  return EXT_CT[path.extname(file).toLowerCase()] ?? null;
}

function parseDepth(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}
function notFound(res: ServerResponse, url: URL): void {
  sendJson(res, 404, { error: `no such node/endpoint: ${url.pathname}?${url.searchParams}` });
}
