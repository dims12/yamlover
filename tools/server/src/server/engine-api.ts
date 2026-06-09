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
import type { NodeRow, EdgeRow } from "../../../engine/ts/src/index.ts";
import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { buildGitIgnore } from "./gitignore.js";
import { displayKind, ownedEntries, typeName } from "./node-kind.js";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;
interface Options { gitignore?: boolean } // honor .gitignore for stray files (default: true)

// Marker keys + types the client recognizes (must match src/client expectations).
const LINK_KEY = "$yamloverLink";
const BINARY_KEY = "$yamloverBinary";
const MIXED_KEY = "$yamloverMixed"; // an omni/mix node: a self-value and/or interleaved items+fields
type Seg = string | number;
// Node-KIND classification (object|array|scalar|binary|omni|mix → the client `type:`) lives in
// ./node-kind.ts so it can be unit-tested against a Store without the HTTP layer.

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
            const a = data as AnnotationInput;
            const annPath = writeAnnotation(dataRoot, a);
            // Update the index INCREMENTALLY (not a full rebuild — that re-hashes every blob and
            // blocks the next click). Add just this annotation's nodes + its `target` edge.
            const doc = parseYamlover(fs.readFileSync(path.join(dataRoot, ...strToSegs(annPath).map(String)), "utf8"), annPath);
            s.addAnnotation(storePath(strToSegs(annPath)), storePath(strToSegs(a.target)), doc);
            sendJson(res, 201, { path: annPath });
          })
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Delete an annotation by its node path (recolor = delete + create, client-side). Removes the
      // file under `annotations/` and its index rows — incrementally. `?path=/annotations/<id>.yamlover`.
      if (req.method === "DELETE" && url.pathname === "/api/annotate") {
        try {
          const annPath = url.searchParams.get("path") || "";
          deleteAnnotation(dataRoot, annPath);
          s.removeAnnotation(storePath(strToSegs(annPath)));
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { error: String((e as Error).message || e) });
        }
        return;
      }

      // Upload a pasted file (a WRITE path). Onto a DIRECTORY page → the file lands in that
      // directory. Onto a CHAPTER page → the file lands in the chapter's owning directory AND a
      // `*…` pointer to it is appended as the chapter's last chunk. Body: { path, filename,
      // contentBase64 }. A new file / edited chapter source needs the full graph re-walked, so we
      // rebuild the index (paste is a rare, deliberate action — unlike a click).
      if (req.method === "POST" && url.pathname === "/api/paste") {
        readBody(req)
          .then((data) => {
            const result = handlePaste(dataRoot, s, data as PasteInput);
            rebuild();
            sendJson(res, 201, result);
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

/** The (type) label shown in the TOC/header — the schema-style {@link typeName}. */
function tocType(s: Store, p: string, row: NodeRow): string {
  return typeName(s, p, row);
}

// --------------------------------------------------------------------------- //
// Relation direction. A relation has ONE natural direction (upstream → downstream), regardless of
// which side authored it: a forward `*` ref / containment runs from→to; a `~` back-edge is stored
// reversed (it is authored on the downstream side, pointing back up), so its nature is to→from.
// A node's DOWNSTREAM relations (it is the natural source) are its children/value, shown below the
// <hr>; its UPSTREAM relations (it is the natural target) are shown above it. Authoring a relation
// both ways (forward at the parent AND `~` at the child) yields two stored edges for ONE relation,
// so each direction is de-duplicated by (label, other end). This split is used everywhere — the
// value/schema projections and the relations panel — so nothing has to special-case `~`.
// --------------------------------------------------------------------------- //

const relKey = (label: string | null, other: string): string => `${label ?? ""} ${other}`;

/** A node's DOWNSTREAM entries (it is the natural source), in source order: its containment
 *  children and forward `*` refs (authored here, positioned), then any `~` back-edges that target
 *  it from elsewhere (authored on the downstream node, so unpositioned → appended). A relation
 *  authored both ways collapses to one entry (deduped by label + target). */
function downstreamEntries(s: Store, p: string): { to: string; label: string | null; pos: number | null; kind: EdgeRow["kind"] }[] {
  const out = s.entries(p).filter((e) => e.kind !== "back"); // contain + forward ref, ordered by pos
  const seen = new Set(out.map((e) => relKey(e.label, e.to)));
  for (const e of s.relationships(p).in) {
    if (e.kind !== "back" || !e.from) continue; // back-edge INTO p: its natural source is p (downstream)
    const k = relKey(e.label, e.from); // natural target of a back-edge is its `from`
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ to: e.from, label: e.label, pos: null, kind: "ref" });
  }
  return out;
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
  // DOWNSTREAM entries in order — containment recursed, a forward `*` ref or an incoming `~`
  // back-edge shown as a link marker to the downstream node (so a `chunks` array mixing inline
  // blocks and `*sample.png` pointers is whole, and a child reached only by `~` still appears).
  const kids = downstreamEntries(s, p);
  const project = (c: { to: string; label: string | null; pos: number | null; kind: string }) =>
    c.kind === "contain"
      ? projectValue(s, [...segs, c.label ?? c.pos ?? 0], depth - 1, false)
      : linkMarker(s, storePathToSegs(c.to)); // pointer → a marker to where it resolves
  if (k === "array") return kids.map(project);
  if (k === "omni" || k === "mix") {
    // A `$yamloverMixed` marker preserving source order: each entry is positional (`key: null` →
    // a `- item`) or keyed (`key: "scale"` → `scale: …`); an omni also carries its self-value.
    const entries = kids.map((c) => ({ key: c.label, value: project(c) }));
    const marker: Record<string, unknown> = { kind: k, entries };
    if (k === "omni") marker.value = row.value; // the node's own scalar self-value (the `!!omni 5`)
    return { [MIXED_KEY]: marker };
  }
  if (k === "object") {
    const out: Record<string, unknown> = {};
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
  if ((k === "object" || k === "array" || k === "mix" || k === "omni") && depth <= 0) return linkMarker(s, segs);
  if (k === "binary" && !top) return linkMarker(s, segs);
  const schema: Record<string, unknown> = { type: typeName(s, p, row) }; // object|array|binary|mixed|variant|<scalar>
  if (row.format) schema.format = row.format;
  const kids = downstreamEntries(s, p);
  const sub = (c: { to: string; label: string | null; pos: number | null; kind: string }) =>
    c.kind === "contain" ? projectSchema(s, [...segs, c.label ?? c.pos ?? 0], depth - 1, false) : linkMarker(s, storePathToSegs(c.to));
  if (k === "object" || k === "mix" || k === "omni") {
    // mixed/variant fields: keyless entries keep their `[pos]` key, keyed ones their name; a
    // variant (omni) also pins its self-value. (Order is the property insertion order.)
    const props: Record<string, unknown> = {};
    for (const c of kids) props[c.label ?? `[${c.pos}]`] = sub(c);
    schema.properties = props;
    if (k === "omni") schema.value = row.value;
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
  else if (k === "omni" || k === "mix") {
    info.count = ownedEntries(s, p).length; // owned items + fields (reverse members excluded)
    if (k === "omni") info.value = row.value; // the self-scalar, for the link label
  } else info.count = s.children(p).length;
  return { [LINK_KEY]: info };
}

const segsEqual = (a: Seg[], b: Seg[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** An upstream node's path written in the scope it has FROM the current node's document frame:
 *  document-relative (`/eve`) when it lives in the same document, else a link from the project/
 *  tree root (`//examples/…`) — mirroring the pointer scopes in URIs.md (`/` = document root,
 *  `//` = link). */
function scopedPath(s: Store, src: Seg[], currentDoc: Seg[]): string {
  if (segsEqual(documentRootSegs(s, src), currentDoc)) return segsToStr(src.slice(currentDoc.length)); // `/…`
  return "/" + segsToStr(src); // `//…` — a link from the project/tree root
}

/** The relations panel: this node's UPSTREAM relations — those for which it is the natural target.
 *  Led by the containment parent as `..`, then each `*`/`~` upstream source: a forward ref authored
 *  AT the source (stored into this node) or a `~` back-edge authored here pointing at the source
 *  (stored out of it) — the same relation either way, so deduped by source + label. Each is keyed
 *  by the path it has from this node's document frame, with a link to its summary; a source that is
 *  a tag node is peeled into a header badge by splitTagRefs. (A tag is upstream of what it files —
 *  the membership `~tag` back-edge lands here naturally, no special-casing.) */
function buildRelations(s: Store, segs: Seg[]): Record<string, unknown> {
  const p = storePath(segs);
  const out: Record<string, unknown> = {};
  const put = (label: string, marker: unknown) => {
    let k = label;
    for (let i = 2; k in out; i++) k = `${label} (${i})`;
    out[k] = marker;
  };

  // The containment parent — the upstream containment relation, always the primary way up.
  if (segs.length > 0) put("..", linkMarker(s, segs.slice(0, -1)));

  // Upstream `*`/`~` sources (this node is the natural target), deduped across forward+reverse
  // authoring. A forward ref INTO p has its source at `from`; a `~` back-edge OUT of p (stored
  // reversed) has its source at `to`.
  const currentDoc = documentRootSegs(s, segs);
  const { out: outEdges, in: inEdges } = s.relationships(p);
  const upstream = new Map<string, string>(); // relKey → source store-path
  const addUp = (src: string | null, label: string | null) => {
    if (src) upstream.set(relKey(label, src), src);
  };
  for (const e of inEdges) if (e.kind === "ref") addUp(e.from, e.label); // forward ref INTO p
  for (const e of outEdges) if (e.kind === "back") addUp(e.to, e.label); // `~` back-edge OUT of p
  for (const src of upstream.values()) {
    const segs2 = storePathToSegs(src);
    put(scopedPath(s, segs2, currentDoc), linkMarker(s, segs2));
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

/** Delete an annotation file given its node path (`/annotations/<id>.yamlover`). Guarded to the
 *  `annotations/` folder under the served root so it can only remove annotation files. */
function deleteAnnotation(dataRoot: string, annPath: string): void {
  const segs = strToSegs(annPath);
  if (segs[0] !== "annotations" || !String(segs[segs.length - 1]).endsWith(".yamlover")) {
    throw new Error("not an annotation path");
  }
  const annDir = path.resolve(dataRoot, "annotations");
  const file = path.resolve(dataRoot, ...segs.map(String));
  if (file !== annDir && !file.startsWith(annDir + path.sep)) throw new Error("outside the annotations dir");
  fs.rmSync(file, { force: true });
}

// --------------------------------------------------------------------------- //
// Paste / upload — drop a clipboard file into the tree. A directory target takes the file as a
// new child; a chapter target takes it into its owning directory and gains a `*…` pointer chunk.
// --------------------------------------------------------------------------- //

interface PasteInput {
  path: string; // the page's node path (a directory or a chapter)
  filename: string; // the source filename (sanitized + de-duplicated server-side)
  contentBase64: string; // the file bytes, base64
}

/** Handle a paste/upload onto the node at `input.path`. Returns the new file's node path and,
 *  for a chapter, the chapter path + the chunk pointer appended to it. */
function handlePaste(dataRoot: string, s: Store, input: PasteInput): Record<string, unknown> {
  const segs = strToSegs(input.path || "/");
  const row = s.node(storePath(segs));
  if (!row) throw new Error(`no such node: ${input.path}`);
  const bytes = Buffer.from(input.contentBase64 || "", "base64");
  if (bytes.length === 0) throw new Error("empty paste (no file bytes)");
  const name = sanitizeName(input.filename);

  if (row.format === "x-yamlover-chapter") return pasteIntoChapter(dataRoot, s, segs, name, bytes);

  // a directory page, or a MEMBER of one (any non-chapter node): the file lands in the nearest
  // enclosing directory. `open` marks the member case — the page is not the directory, so the
  // client opens the new file (on a directory page it just refreshes in place).
  const dirSegs = nearestDirSegs(dataRoot, segs);
  if (!dirSegs) throw new Error("no enclosing directory to paste into");
  const dir = path.resolve(dataRoot, ...dirSegs.map(String));
  const final = uniqueName(dir, name);
  writeInside(dataRoot, dir, final, bytes);
  return { path: segsToStr([...dirSegs, final]), dir: segsToStr(dirSegs), open: dirSegs.length !== segs.length };
}

/** The nearest enclosing filesystem directory at or above `segs` (the node itself when it is a
 *  directory, else its closest ancestor that is one), as segments; null if none under the root. */
function nearestDirSegs(dataRoot: string, segs: Seg[]): Seg[] | null {
  for (let i = segs.length; i >= 0; i--) {
    const sub = segs.slice(0, i);
    const abs = path.resolve(dataRoot, ...sub.map(String));
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return sub;
  }
  return null;
}

/** A chapter paste: write the file into the chapter's owning directory, then append a pointer to
 *  it as the chapter's last chunk (editing the .yamlover source). The chapter is either directory-
 *  backed (`.yamlover/body.yamlover`) or a standalone `*.yamlover` file. */
function pasteIntoChapter(dataRoot: string, s: Store, segs: Seg[], name: string, bytes: Buffer): Record<string, unknown> {
  const docSegs = documentRootSegs(s, segs);
  const docFs = path.resolve(dataRoot, ...docSegs.map(String));
  const dirBacked = fs.existsSync(docFs) && fs.statSync(docFs).isDirectory();

  const bodyFile = dirBacked ? path.join(docFs, ".yamlover", "body.yamlover") : docFs;
  if (!bodyFile.endsWith(".yamlover") || !fs.existsSync(bodyFile)) {
    throw new Error("unsupported chapter source (need a .yamlover body)");
  }
  // the file lands in the doc-root dir (directory-backed) or beside the standalone chapter file.
  const writeDirSegs = dirBacked ? docSegs : docSegs.slice(0, -1);
  const writeDir = path.resolve(dataRoot, ...writeDirSegs.map(String));
  const final = uniqueName(writeDir, name);
  writeInside(dataRoot, writeDir, final, bytes);

  // The chunk pointer: document-scoped (`*/file`) when the file sits inside the chapter's own
  // document (directory-backed); else a project-root link (`*//dir/file`) reaching the sibling.
  const fileSegs = [...writeDirSegs, final];
  const pointer = dirBacked ? `*/${final}` : `*/${segsToStr(fileSegs)}`;
  // The chapter's location WITHIN its document — alternating `children`,N pairs (empty = top-level).
  const within = segs.slice(docSegs.length);
  const src = fs.readFileSync(bodyFile, "utf8");
  fs.writeFileSync(bodyFile, appendChunkPointer(src, within, pointer));
  return { path: segsToStr(fileSegs), chapter: segsToStr(segs), pointer };
}

/** A safe filename: basename only, restricted charset, never hidden; defaults when empty. */
function sanitizeName(raw: string): string {
  const base = path.basename(String(raw || "")).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return base || "pasted";
}

/** `name`, or `name-1`/`name-2`/… if it already exists in `dir` (extension kept). */
function uniqueName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, cand))) return cand;
  }
}

/** Write `bytes` to `dir/name`, refusing any path that escapes the served root. */
function writeInside(dataRoot: string, dir: string, name: string, bytes: Buffer): void {
  const root = path.resolve(dataRoot);
  const target = path.resolve(dir, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("target escapes the data root");
  fs.writeFileSync(target, bytes);
}

// --- chapter chunk insertion (indentation-aware; the parser does not track spans) ------------ //
// A directory body / standalone chapter is YAML-shaped: a mapping's keys at one indent, a
// sequence's `- ` items at the SAME indent as their key, an item's mapping body at key-indent+2.
// To reach a subchapter we descend `children:` sequences by index; then we append to `chunks:`.

const indentOf = (line: string): number => { let i = 0; while (line[i] === " ") i++; return i; };
const isContentLine = (line: string): boolean => { const t = line.trim(); return t.length > 0 && !t.startsWith("#"); };

/** Append `- <pointer>` to the `chunks` list of the chapter at `chapterPath` (alternating
 *  ["children", N, …] pairs; empty = the top-level chapter) within a .yamlover source. */
function appendChunkPointer(text: string, chapterPath: Seg[], pointer: string): string {
  const lines = text.split("\n");
  let lo = 0;
  let hi = lines.length;
  let indent = firstContentIndent(lines); // the chapter mapping's key indent

  for (let i = 0; i < chapterPath.length; i += 2) {
    const idx = Number(chapterPath[i + 1]);
    const key = findKeyLine(lines, lo, hi, indent, "children");
    if (key < 0) throw new Error(`no 'children:' at indent ${indent}`);
    const items = seqItems(lines, key + 1, hi, indent);
    if (!(idx >= 0 && idx < items.length)) throw new Error(`children[${idx}] out of range (${items.length})`);
    hi = idx + 1 < items.length ? items[idx + 1] : seqEnd(lines, key + 1, hi, indent);
    lo = items[idx] + 1; // body starts past the `- ` marker (its inline key sits at the parent indent)
    indent += 2;
  }

  const chunksKey = findKeyLine(lines, lo, hi, indent, "chunks");
  if (chunksKey < 0) throw new Error(`no 'chunks:' at indent ${indent}`);
  const end = seqEnd(lines, chunksKey + 1, hi, indent);
  lines.splice(end, 0, `${" ".repeat(indent)}- ${pointer}`);
  return lines.join("\n");
}

/** The indent of the first content line — the chapter mapping's key column. */
function firstContentIndent(lines: string[]): number {
  for (const l of lines) if (isContentLine(l)) return indentOf(l);
  return 0;
}

/** Line index of `key:` at exactly `indent` within [lo,hi); -1 once the mapping ends (a dedent). */
function findKeyLine(lines: string[], lo: number, hi: number, indent: number, key: string): number {
  for (let i = lo; i < hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < indent) return -1; // left the mapping
    if (ind !== indent) continue; // deeper (a nested value / block scalar)
    const t = lines[i].trim();
    if (t === `${key}:` || t.startsWith(`${key}:`)) return i;
  }
  return -1;
}

/** Start lines of the `- ` items of a sequence whose items sit at `indent`, from `from`. */
function seqItems(lines: string[], from: number, hi: number, indent: number): number[] {
  const out: number[] = [];
  for (let i = from; i < hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < indent) break; // dedent → sequence ended
    if (ind !== indent) continue; // deeper → the current item's body
    const t = lines[i].trim();
    if (t === "-" || t.startsWith("- ")) out.push(i);
    else break; // a sibling key at the same indent → sequence ended
  }
  return out;
}

/** The line index that ends the sequence starting at `from` (a dedent below `indent`, or a
 *  non-item sibling key at `indent`), skipping back over trailing blank lines. */
function seqEnd(lines: string[], from: number, hi: number, indent: number): number {
  let last = from;
  for (let i = from; i < hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < indent) return trimBack(lines, last, i);
    if (ind === indent) {
      const t = lines[i].trim();
      if (t === "-" || t.startsWith("- ")) { last = i; continue; }
      return trimBack(lines, last, i); // sibling key
    }
    last = i; // deeper: part of the current item
  }
  return trimBack(lines, last, hi);
}

/** Walk an end index back over trailing blank lines, so we insert right after the last item. */
function trimBack(lines: string[], lastItemLine: number, end: number): number {
  let e = end;
  while (e > lastItemLine + 1 && !isContentLine(lines[e - 1])) e--;
  return e;
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
 *  is flagged `documentRoot` (a parsed file / `.yamlover` dir / served root), as segments. It is
 *  the anchor a document-relative (`/…`) pointer resolves against, mirroring the `/` pointer scope. */
function documentRootSegs(s: Store, segs: Seg[]): Seg[] {
  for (let i = segs.length; i >= 0; i--) {
    const anc = segs.slice(0, i);
    if (s.node(storePath(anc))?.meta?.documentRoot) return anc;
  }
  return [];
}

/** The nearest enclosing document root as a client JSON path (`/…`). */
function documentPath(s: Store, segs: Seg[]): string {
  return segsToStr(documentRootSegs(s, segs));
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
