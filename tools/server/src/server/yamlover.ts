/**
 * yamlover.ts — a TypeScript port of the read side of `tools/walker`.
 *
 * It materializes the single *logical* node of a yamlover entity from any of its
 * concrete representations (a plain file, a plain directory, or a directory
 * carrying `.yamlover/schema.yaml`), resolving where every value actually lives —
 * inline `const`, a `file/yaml` / `file/json` / `file/binary` child, a collapsed
 * file, an expanded subdirectory, a `$ref` into `$defs`. The result is one tree
 * of {@link YNode}s the web server serves as JSON, JSON Schema, and a TOC.
 *
 * It mirrors `walker.py` closely; see that file for the prose explanation of each
 * step. What this port adds is capturing each node's schema `title`/`description`
 * annotations (used for tree labels), which the walker — being a shell — ignores.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const YAMLOVER_DIR = ".yamlover";
const SCHEMA_FILE = "schema.yaml";

// A value pinned in the schema (via `const`, or built from `const` leaves) is
// instantiated from the schema; `.yamlover/schema.yaml` is YAML, hence this tag.
const SCHEMA_INSTANTIATE = "yaml-schema/instantiate";

/** A binary leaf value (a `file/binary` child) we do not expand inline. We keep
 *  only its `size` (cheap, via `stat`); the bytes are read lazily and only when a
 *  format is actually decodable, so a large blob never has to be slurped just to
 *  be listed. */
export class Binary {
  constructor(
    public size: number,
    public fmt: string | null = null,
    public decoded: unknown = null,
    public data: Buffer | null = null,
  ) {}

  repr(): string {
    let info = `<binary ${this.fmt || "bytes"}, ${this.size} bytes`;
    if (this.decoded !== null && this.decoded !== undefined)
      info += `, = ${JSON.stringify(this.decoded)}`;
    return info + ">";
  }
}

export type NodeValue =
  | Record<string, YNode>
  | YNode[]
  | string
  | number
  | boolean
  | null
  | Binary;

export type Kind = "object" | "array" | "scalar" | "binary";

/**
 * A logical node: a value plus the concrete representation it came from.
 *
 * `value` is an object (`Record<string, YNode>`), an array (`YNode[]`), or a
 * scalar / {@link Binary} leaf. `concrete` records how it is stored; `path` is
 * the on-disk path for filesystem-backed nodes (else null). `title`/`description`
 * carry the schema annotations used for tree labels.
 *
 * The value can be **lazy**: a file-backed node is created with a loader and its
 * `kind` (known from the schema), and the file is only read when `.value` is
 * actually accessed. So listing or eliding a node — which needs its kind, not its
 * bytes — never reads the file; the bytes of `value: 30` (or a binary blob) load
 * only when that node is itself serialized. Use {@link nodeKind} for the type
 * when you want to avoid forcing a load.
 */
export class YNode {
  title?: string;
  description?: string;
  rel?: Record<string, unknown> | null;
  kind?: Kind; // known up front for lazy nodes; lets us elide/list without loading
  schemaType?: string; // the schema's `type` (no file read needed to know it)
  format?: string; // the schema's `format` — half of the (type, format) renderer key

  private _value: NodeValue | undefined;
  private _loader?: () => NodeValue;

  constructor(value: NodeValue, public concrete: string | null = null, public path: string | null = null) {
    this._value = value;
  }

  /** A node whose value is read on first access (see the class note). `kind` may
   *  be omitted when the schema doesn't pin it (an untyped `file/yaml`): then
   *  {@link nodeKind} reads the file to find out. */
  static lazy(loader: () => NodeValue, concrete: string | null, path: string | null, kind?: Kind): YNode {
    const node = new YNode(null, concrete, path);
    node._value = undefined;
    node._loader = loader;
    node.kind = kind;
    return node;
  }

  /** Whether the value is already in memory (true for eager nodes and once a
   *  lazy node has been read) — lets callers avoid forcing a file read. */
  get loaded(): boolean {
    return this._loader === undefined;
  }

  get value(): NodeValue {
    if (this._loader) {
      this._value = this._loader();
      this._loader = undefined;
    }
    return this._value as NodeValue;
  }

  set value(v: NodeValue) {
    this._value = v;
    this._loader = undefined;
  }
}

// --------------------------------------------------------------------------- //
// Loading / materialization
// --------------------------------------------------------------------------- //

/** Materialize the logical node of the yamlover entity at `entityPath`. */
export function loadEntity(entityPath: string): YNode {
  if (isDir(entityPath)) {
    const schemaPath = path.join(entityPath, YAMLOVER_DIR, SCHEMA_FILE);
    if (isFile(schemaPath)) {
      const schema = yaml.load(fs.readFileSync(schemaPath, "utf-8")) as Schema;
      const node = resolve(schema, entityPath, null, true, schema);
      node.concrete = "yamlover"; // this directory is itself a yamlover node
      node.path = entityPath;
      annotate(node, schema);
      return node;
    }
    // plain directory (no .yamlover/): an object of its visible entries
    return new YNode(extraEntries(entityPath, new Set(), {}), "dir", entityPath);
  }
  // A plain file with no schema: read it now (we cannot know its kind otherwise),
  // but stray plain files are small text; described leaves stay lazy via fromFile.
  const value = decodeFile(entityPath, "file/yaml", null) as NodeValue;
  const node = wrap(value, "yaml");
  node.concrete = "file";
  node.path = entityPath;
  node.kind = valueKind(node.value);
  return node;
}

type Schema = Record<string, any>;

/** Resolve a `$ref` JSON Pointer (`#/...`) within the schema document. */
function resolveRef(ref: string, root: Schema): Schema {
  if (!ref.startsWith("#"))
    throw new Error(`only same-document $ref is supported, got ${ref}`);
  let target: any = root;
  for (let part of ref.slice(1).split("/")) {
    if (part === "") continue;
    part = part.replace(/~1/g, "/").replace(/~0/g, "~"); // JSON Pointer unescape
    target = Array.isArray(target) ? target[Number(part)] : target?.[part];
    if (target === undefined) throw new Error(`$ref target not found: ${ref}`);
  }
  return target;
}

/** Deep-merge a `$ref` target with the keywords beside it (overlay wins). */
function mergeSchema(base: Schema, overlay: Schema): Schema {
  const out: Schema = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) out[k] = mergeSchema(out[k], v);
    else out[k] = v;
  }
  return out;
}

/**
 * Resolve a JSON-Schema fragment to a logical {@link YNode}.
 *
 * @param schema       the fragment to resolve
 * @param container    directory holding this node's file(s)
 * @param defaultName  file/subdir name when `x-yamlover.os.path` is absent
 * @param backed       true only when this node *is* `container` (surfaces stray files)
 * @param root         the schema document, against which `$ref` pointers resolve
 */
function resolve(
  schema: Schema | null,
  container: string,
  defaultName: string | null,
  backed = false,
  root: Schema | null = null,
): YNode {
  if (schema == null) return new YNode(null, null);
  if (root == null) root = schema;

  // $ref lives in schema coordinates: pull in the referenced fragment and merge
  // any sibling keywords over it (JSON Schema 2020-12 allows $ref + siblings).
  if (isPlainObject(schema) && "$ref" in schema) {
    const target = resolveRef(schema["$ref"], root);
    const siblings = { ...schema };
    delete siblings["$ref"];
    schema = mergeSchema(target, siblings);
  }
  if ("const" in schema!) return wrap(schema!["const"], SCHEMA_INSTANTIATE);

  const xy = schema!["x-yamlover"] || {};
  const concrete: string | null = xy.concrete ?? null;
  const name = xyPath(xy) ?? defaultName;
  const isFileConcrete = !!concrete && concrete.startsWith("file/");
  const rel = xy.rel ?? null;

  const stype = schema!["type"];
  const isObject = stype === "object" || "properties" in schema!;
  const isArray = stype === "array" || "prefixItems" in schema!;

  // A structured node collapsed into a single file (e.g. 02-object-in-yaml).
  if ((isObject || isArray) && isFileConcrete && name) {
    const node = fromFile(path.join(container, name), concrete!, schema!, isObject ? "object" : "array");
    if (rel) node.rel = rel;
    return node;
  }

  // A child expanded as its own subdirectory (e.g. the spec's address/).
  if (name && isDir(path.join(container, name))) {
    const node = loadEntity(path.join(container, name));
    if (rel) node.rel = rel;
    return node;
  }

  if (isObject) {
    const children: Record<string, YNode> = {};
    const consumed = new Set<string>([YAMLOVER_DIR]);
    for (const [key, child] of Object.entries(schema!["properties"] || {})) {
      const cnode = resolve(child as Schema, container, key, false, root);
      annotate(cnode, child as Schema);
      children[key] = cnode;
      const cxy = (isPlainObject(child) ? (child as Schema)["x-yamlover"] : null) || {};
      consumed.add(xyPath(cxy) ?? key);
    }
    if (backed) {
      for (const child of Object.values(children))
        claimPaths(child, container, consumed);
      Object.assign(children, extraEntries(container, consumed, children));
    }
    const node = new YNode(children, concrete ?? SCHEMA_INSTANTIATE);
    if (rel) node.rel = rel;
    return node;
  }

  if (isArray) {
    const items = (schema!["prefixItems"] || []).map((child: Schema, idx: number) => {
      const cnode = resolve(child, container, String(idx), false, root);
      annotate(cnode, child);
      return cnode;
    });
    const node = new YNode(items, concrete ?? SCHEMA_INSTANTIATE);
    if (rel) node.rel = rel;
    return node;
  }

  // A value stored in its own file. Its kind is known from the schema `type`
  // (e.g. 04-object-in-dir's typed scalars) or, for an untyped `file/yaml`
  // (e.g. 11-switch's `contact`), determined by reading the file on demand.
  if (isFileConcrete && name) {
    const kind = concrete === "file/binary" ? "binary" : kindFromType(stype);
    const node = fromFile(path.join(container, name), concrete!, schema!, kind);
    if (rel) node.rel = rel;
    return node;
  }

  // No value, but still defined inline in the schema → instantiated from it.
  const node = new YNode(null, concrete ?? SCHEMA_INSTANTIATE);
  if (rel) node.rel = rel;
  return node;
}

/** A lazy node *is* a file: its interior (yaml/json/binary) is decoded only when
 *  the value is first accessed. `kind` (from the schema) lets callers list or
 *  elide it without reading the bytes. */
function fromFile(filePath: string, concrete: string, schema: Schema | null, kind?: Kind): YNode {
  return YNode.lazy(
    () => wrap(decodeFile(filePath, concrete, schema), interior(concrete)).value,
    concrete,
    filePath, // the node is this file; its interior children stay path-less
    kind,
  );
}

/** Wrap a plain JS value into YNodes, tagging every level with `concrete`. */
function wrap(value: unknown, concrete: string): YNode {
  if (isPlainObject(value)) {
    const out: Record<string, YNode> = {};
    for (const [k, v] of Object.entries(value)) out[k] = wrap(v, concrete);
    return new YNode(out, concrete);
  }
  if (Array.isArray(value))
    return new YNode(value.map((v) => wrap(v, concrete)), concrete);
  return new YNode(value as NodeValue, concrete);
}

/** Add to `consumed` every filename in `container` that `node`'s subtree binds.
 *  A file-backed node's interior lives *inside* that one file, so we never recurse
 *  into it — which also keeps lazy file nodes from being read here. */
function claimPaths(node: YNode, container: string, consumed: Set<string>): void {
  if (node.path && path.dirname(node.path) === container)
    consumed.add(path.basename(node.path));
  if (node.concrete && (node.concrete === "file" || node.concrete.startsWith("file/"))) return;
  if (isPlainObject(node.value))
    for (const child of Object.values(node.value)) claimPaths(child, container, consumed);
  else if (Array.isArray(node.value))
    for (const child of node.value) claimPaths(child, container, consumed);
}

// Predicate deciding whether an undescribed entry is hidden by .gitignore.
// Configured per server (see setIgnoreFilter); the default lets everything through.
let isIgnored: (absPath: string) => boolean = () => false;

/** Install the .gitignore predicate used to hide undescribed (stray) entries. */
export function setIgnoreFilter(fn: (absPath: string) => boolean): void {
  isIgnored = fn;
}

/** Undescribed, non-hidden files/dirs physically present in `container`.
 *  Entries matched by .gitignore are skipped (schema-described children are
 *  always kept — only these surfaced strays are filtered). */
function extraEntries(
  container: string,
  consumed: Set<string>,
  existing: Record<string, YNode>,
): Record<string, YNode> {
  const out: Record<string, YNode> = {};
  if (isDir(container)) {
    for (const name of fs.readdirSync(container).sort()) {
      if (name.startsWith(".") || consumed.has(name) || name in existing) continue;
      const full = path.join(container, name);
      if (isIgnored(full)) continue;
      out[name] = loadEntity(full);
    }
  }
  return out;
}

/** Read `filePath` and decode it according to its `concrete` encoding. A text
 *  file that does not parse as YAML/JSON (a README, a source file, …) falls back
 *  to its raw text — a yamlover string — rather than erroring. */
function decodeFile(filePath: string, concrete: string, schema: Schema | null): unknown {
  if (!fs.existsSync(filePath)) return `<missing: ${path.basename(filePath)}>`;

  if (concrete === "file/binary") {
    try {
      const size = fs.statSync(filePath).size; // cheap; avoids reading the blob
      const fmt = (schema || {})["format"] ?? null;
      let decoded: unknown = null;
      let data: Buffer | null = null;
      if (fmt === "int32/le" && size === 4) {
        data = fs.readFileSync(filePath);
        decoded = data.readInt32LE(0);
      }
      return new Binary(size, fmt, decoded, data);
    } catch (exc) {
      return `<unreadable ${path.basename(filePath)}: ${(exc as Error).name}>`;
    }
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (exc) {
    return `<unreadable ${path.basename(filePath)}: ${(exc as Error).name}>`;
  }
  try {
    return concrete === "file/json" ? JSON.parse(text) : yaml.load(text);
  } catch {
    return text; // not YAML/JSON — show the file's raw content as a string
  }
}

// --------------------------------------------------------------------------- //
// Small helpers
// --------------------------------------------------------------------------- //

function xyPath(xy: any): string | null {
  return xy?.os?.path ?? null;
}

/** The interior representation of a collapsed document file. */
function interior(concrete: string | null): string {
  return concrete === "file/json" ? "json" : "yaml";
}

/** Capture a fragment's annotations onto a node: `title`/`description` (tree
 *  labels) and `type`/`format` (the (type, format) renderer key — read without
 *  ever touching the file). */
function annotate(node: YNode, schema: Schema | null): void {
  if (!isPlainObject(schema)) return;
  if (typeof schema["title"] === "string") node.title = schema["title"];
  if (typeof schema["description"] === "string") node.description = schema["description"];
  if (typeof schema["type"] === "string") node.schemaType = schema["type"];
  if (typeof schema["format"] === "string") node.format = schema["format"];
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Binary);
}

function isBinary(v: unknown): v is Binary {
  return v instanceof Binary;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function valueKind(v: NodeValue): Kind {
  if (isPlainObject(v)) return "object";
  if (Array.isArray(v)) return "array";
  if (isBinary(v)) return "binary";
  return "scalar";
}

/** The node kind implied by a schema `type`, or undefined when `type` is absent
 *  (then the kind is only knowable by reading the file). */
function kindFromType(stype: unknown): Kind | undefined {
  if (stype === "object") return "object";
  if (stype === "array") return "array";
  if (stype === "string" || stype === "integer" || stype === "number" || stype === "boolean" || stype === "null")
    return "scalar";
  return undefined;
}

/** A node's coarse kind *without forcing a lazy load* when it is already known
 *  (set from the schema). Only eager nodes fall through to inspecting the value. */
export function nodeKind(node: YNode): Kind {
  return node.kind ?? valueKind(node.value);
}

export function isContainer(node: YNode): boolean {
  const k = nodeKind(node);
  return k === "object" || k === "array";
}

export function typeLabel(node: YNode): string {
  const v = node.value;
  if (isPlainObject(v)) return "object";
  if (Array.isArray(v)) return "array";
  if (isBinary(v)) return "binary";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") return "string";
  if (v === null) return "null";
  return typeof v;
}

// --------------------------------------------------------------------------- //
// Path handling (JSON space — no "properties")
// --------------------------------------------------------------------------- //

export type Seg = string | number;

/** Render path segments JSON-path style: `/key[0]/other` (root → `/`). Each key
 *  is percent-encoded so a `/`, `[`, or `]` *inside* a key (e.g.
 *  `@vitejs/plugin-react`) does not read as a separator. */
export function segsToStr(segs: Seg[]): string {
  return (
    segs
      .map((s) => (typeof s === "number" ? `[${s}]` : `/${encodeURIComponent(s)}`))
      .join("") || "/"
  );
}

const PATH_TOKEN = /\[\d+\]|[^/\[\]]+/g;

/** Parse a JSON-path string into segments (`[n]` → number, else decoded key). */
export function strToSegs(str: string): Seg[] {
  const out: Seg[] = [];
  for (const tok of str.match(PATH_TOKEN) || []) {
    out.push(/^\[\d+\]$/.test(tok) ? Number(tok.slice(1, -1)) : safeDecode(tok));
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Walk to the node addressed by `segs`, throwing on a bad segment. */
export function getNode(root: YNode, segs: Seg[]): YNode {
  let node = root;
  for (const seg of segs) {
    const v = node.value;
    if (typeof seg === "number") {
      if (!Array.isArray(v) || seg < 0 || seg >= v.length)
        throw new Error(`index out of range: [${seg}]`);
      node = v[seg];
    } else {
      if (!isPlainObject(v) || !(seg in v)) throw new Error(`no such child: ${seg}`);
      node = (v as Record<string, YNode>)[seg];
    }
  }
  return node;
}

// --------------------------------------------------------------------------- //
// Serialization: JSON value and instance JSON Schema
// --------------------------------------------------------------------------- //

function descend(depth: number | null): number | null {
  return depth == null ? null : depth - 1;
}

// A node shown only as a *link* (a container past the depth budget, or any binary
// leaf) becomes a link marker rather than being inlined: the client renders it as
// `{ object with N properties }` / `[ array with M items ]` / `< binary of N
// bytes >` and descends to `path` on click. The same marker is used in the value
// and the schema views, so every representation behaves identically.
export const LINK_KEY = "$yamloverLink";

interface LinkMarker {
  [LINK_KEY]: { kind: Kind; path: string; count?: number; size?: number; format?: string | null };
}

function linkMarker(node: YNode, segs: Seg[]): LinkMarker {
  const kind = nodeKind(node);
  const info: LinkMarker[typeof LINK_KEY] = { kind, path: segsToStr(segs) };
  if (kind === "binary") {
    const b = node.value as Binary; // stat-cheap; gives size + format
    info.size = b.size;
    info.format = b.fmt;
  } else {
    info.count = childCount(node);
  }
  return { [LINK_KEY]: info };
}

// The bytes of a binary leaf, shown only when the leaf itself is the selection.
// The client renders this as `!!binary` (YAML) or the metadata object (JSON).
export const BINARY_KEY = "$yamloverBinary";

export function binaryContent(node: YNode): Record<string, unknown> {
  return { [BINARY_KEY]: binaryBase64(node) };
}

/**
 * Materialize a node's subtree as plain JSON-able values. `depth` limits
 * container nesting (null = unlimited); a container past the budget becomes a
 * {@link linkMarker} (so the client links to it rather than inlining it).
 * `segs` is the node's own JSON path, threaded so markers know where to point.
 */
export function toPlain(node: YNode, depth: number | null = null, segs: Seg[] = [], top = true): unknown {
  const k = nodeKind(node);
  if ((k === "object" || k === "array") && depth != null && depth <= 0) return linkMarker(node, segs);
  if (k === "binary" && !top) return linkMarker(node, segs); // a binary child links to its page
  if (k === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, c] of Object.entries(node.value as Record<string, YNode>))
      out[key] = toPlain(c, descend(depth), [...segs, key], false);
    return out;
  }
  if (k === "array") {
    return (node.value as YNode[]).map((c, i) => toPlain(c, descend(depth), [...segs, i], false));
  }
  if (k === "binary") return (node.value as Binary).repr(); // top-level binary (header only)
  return node.value; // scalar — read on demand
}

/**
 * Build the JSON Schema whose sole instance is the node's subtree — the
 * instance → schema direction of the Schema ↔ instance correspondence (every
 * value `v` becomes `{const: v}`). Filesystem-backed nodes also carry their
 * `x-yamlover` provenance. A container past the `depth` budget becomes a
 * {@link linkMarker}, exactly as in {@link toPlain}.
 */
export function toSchema(node: YNode, depth: number | null = null, segs: Seg[] = [], top = true): unknown {
  const k = nodeKind(node);
  if ((k === "object" || k === "array") && depth != null && depth <= 0) return linkMarker(node, segs);
  if (k === "binary" && !top) return linkMarker(node, segs); // a binary child links to its page

  let schema: Schema;
  if (k === "object") {
    const properties: Schema = {};
    for (const [key, c] of Object.entries(node.value as Record<string, YNode>))
      properties[key] = toSchema(c, descend(depth), [...segs, key], false);
    schema = { type: "object", properties };
  } else if (k === "array") {
    schema = {
      type: "array",
      prefixItems: (node.value as YNode[]).map((c, i) => toSchema(c, descend(depth), [...segs, i], false)),
      items: false,
    };
  } else if (k === "binary") {
    schema = { const: (node.value as Binary).repr() };
  } else {
    schema = { const: node.value };
  }
  if (node.title) schema.title = node.title;
  if (node.description) schema.description = node.description;
  if (node.path != null) schema["x-yamlover"] = { concrete: node.concrete, os: osInfo(node.path) };
  return schema;
}

function osInfo(p: string): Schema {
  const st = fs.statSync(p);
  const info: Schema = { path: path.basename(p) };
  if (!st.isDirectory()) info.size = st.size;
  info.mtime = new Date(st.mtimeMs).toISOString().replace(/\.\d+Z$/, "Z");
  return info;
}

// --------------------------------------------------------------------------- //
// Table of contents (LHS tree)
// --------------------------------------------------------------------------- //

export interface TreeNode {
  path: string; // JSON-space path
  label: string;
  type: string; // JSON-Schema type (object | array | string | integer | …)
  format: string | null; // schema `format`; with `type` it keys the renderer/icon
  hasChildren: boolean; // container with children (whether or not loaded here)
  children: TreeNode[]; // loaded up to the requested depth ([] past the boundary)
}

/**
 * A node's tree label: its schema `title`, else an instance `title` child, else
 * the key (objects) or `[index]` (arrays).
 */
export function labelForSeg(node: YNode, keyOrIdx: Seg): string {
  if (node.title) return node.title;
  const v = node.value;
  if (isPlainObject(v)) {
    const t = (v as Record<string, YNode>)["title"];
    if (t && !isContainer(t) && !isBinary(t.value)) return String(t.value);
  }
  return typeof keyOrIdx === "number" ? `[${keyOrIdx}]` : keyOrIdx;
}

/** The TOC type for a node, derived without forcing a file read: the schema
 *  `type` if known, else the coarse kind (and the precise scalar type only when
 *  the value already happens to be loaded, e.g. a `const`). */
function tocType(node: YNode): string {
  if (node.schemaType) return node.schemaType;
  const k = nodeKind(node);
  if (k === "scalar") return node.loaded ? typeLabel(node) : "string";
  return k;
}

/** Number of direct children, or 0 for a scalar (asks the kind, not the bytes). */
function childCount(node: YNode): number {
  const k = nodeKind(node);
  if (k === "object") return Object.keys(node.value as Record<string, YNode>).length;
  if (k === "array") return (node.value as YNode[]).length;
  return 0;
}

/**
 * Build the TOC subtree rooted at `node` (addressed by `segs`, shown as `label`)
 * down to `depth` levels of descendants. *Every* node is listed — scalar fields
 * and array elements included — so a leaf like `05-scalar-as-file` is clickable;
 * `hasChildren` says whether a node can be expanded further. Past `depth`,
 * `children` is left empty for the client to fetch lazily.
 */
export function buildTree(node: YNode, segs: Seg[], label: string, depth: number): TreeNode {
  const container = isContainer(node);
  const out: TreeNode = {
    path: segsToStr(segs),
    label,
    type: tocType(node),
    format: node.format ?? null,
    hasChildren: container && childCount(node) > 0,
    children: [],
  };
  if (container && depth > 0) {
    const k = nodeKind(node);
    if (k === "object") {
      for (const [key, c] of Object.entries(node.value as Record<string, YNode>))
        out.children.push(buildTree(c, [...segs, key], labelForSeg(c, key), depth - 1));
    } else {
      (node.value as YNode[]).forEach((c, i) => {
        out.children.push(buildTree(c, [...segs, i], labelForSeg(c, i), depth - 1));
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Extra serializations used by the API
// --------------------------------------------------------------------------- //

/** Read a binary leaf's bytes *on demand* and return a base64 payload. Used when
 *  the binary node itself is the selection (we never read bytes just to list it). */
export function binaryBase64(node: YNode): { format: string | null; size: number; base64: string } {
  const v = node.value;
  if (!isBinary(v)) throw new Error("not a binary node");
  const bytes = v.data ?? (node.path ? fs.readFileSync(node.path) : Buffer.alloc(0));
  return { format: v.fmt, size: v.size, base64: bytes.toString("base64") };
}
