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
import { fileConcreteForExt, interiorOf } from "../concrete";

const YAMLOVER_DIR = ".yamlover";
const SCHEMA_FILE = "schema.yaml";

// A value pinned in the schema (via `const`, or built from `const` leaves) lives
// in `.yamlover/schema.yaml`, which is YAML — so its concrete is the inlined
// `yaml` language of that file. (See CONCRETES.md.)
const SCHEMA_INLINED = "yaml";

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

/** Materialize the logical node of the yamlover entity at `entityPath`.
 *  `knownDir` lets a caller that already learned the type (e.g. from a
 *  `readdir({withFileTypes})` Dirent) skip a redundant `stat`. */
export function loadEntity(entityPath: string, knownDir?: boolean): YNode {
  if (knownDir ?? isDir(entityPath)) {
    const schemaPath = path.join(entityPath, YAMLOVER_DIR, SCHEMA_FILE);
    if (isFile(schemaPath)) {
      const schema = yaml.load(fs.readFileSync(schemaPath, "utf-8")) as Schema;
      const node = resolve(schema, entityPath, null, true, schema);
      node.concrete = "dir/yamlover"; // a directory carrying a `.yamlover/` marker
      node.path = entityPath;
      annotate(node, schema);
      return node;
    }
    // plain directory (no .yamlover/): a *lazy* object of its visible entries.
    // The entries (and any files among them) are read only when this directory
    // is actually descended into — its subdirectories are themselves lazy — so a
    // huge tree is never walked whole; only the levels the TOC shows are read.
    return YNode.lazy(() => extraEntries(entityPath, new Set(), {}), "dir", entityPath, "object");
  }
  // A plain file with no schema, but whose extension names a renderable format.
  // Binary-rendered formats (image, pdf, djvu, html) stay raw bytes, served as
  // such and routed to their renderer by `(binary, format)`. Text formats
  // (markdown, asciidoc) read as a string — their renderer takes the text value.
  const fmt = formatFromExt(entityPath);
  if (fmt && !TEXT_FORMATS.has(fmt)) {
    const node = fromFile(entityPath, "file/binary", null, "binary");
    node.format = fmt;
    return node;
  }
  if (fmt) {
    // A text material (markdown / asciidoc / csv / …): its single value is the raw
    // text, kept verbatim and rendered by `fmt`. Modeled as a `file/<lang>` scalar
    // string (file/yaml for non-data text) — see CONCRETES.md.
    const node = new YNode(fs.readFileSync(entityPath, "utf-8"), fileConcreteForExt(entityPath), entityPath);
    node.format = fmt;
    node.kind = "scalar";
    return node;
  }
  // Unknown extension: an opaque file (binary, or simply large) is surfaced as a
  // *binary link* — stat-only, never read during materialization, fetched on
  // demand (a directory full of archives/scans must not be slurped into memory).
  // Only a small, text-looking file is read so its YAML/JSON/raw value can show.
  if (looksBinary(entityPath)) {
    const node = fromFile(entityPath, "file/binary", null, "binary");
    node.path = entityPath;
    return node;
  }
  // A small text file: read it now (we cannot know its kind otherwise). Its
  // concrete (and the inlined language its interior is tagged with) follows the
  // extension — file/yaml by default, file/json for `.json`, etc.
  const concrete = fileConcreteForExt(entityPath);
  const value = decodeFile(entityPath, concrete, null) as NodeValue;
  const node = wrap(value, interiorOf(concrete));
  node.concrete = concrete;
  node.path = entityPath;
  node.kind = valueKind(node.value);
  return node;
}

// The largest stray file read as text during materialization; above this it is
// treated as opaque bytes (a binary link) regardless of content.
const MAX_TEXT_BYTES = 1 << 20; // 1 MiB

/** Whether a stray file should be treated as opaque bytes rather than read as
 *  text: true when it is large, or when a NUL byte in its head marks it binary.
 *  Cheap — it stats and reads at most an 8 KiB prefix, never the whole file. */
function looksBinary(filePath: string): boolean {
  let fd: number | undefined;
  try {
    if (fs.statSync(filePath).size > MAX_TEXT_BYTES) return true;
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0); // a NUL byte ⇒ binary
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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
  if (schema == null) return new YNode(null, SCHEMA_INLINED);
  if (root == null) root = schema;

  // $ref lives in schema coordinates: pull in the referenced fragment and merge
  // any sibling keywords over it (JSON Schema 2020-12 allows $ref + siblings).
  if (isPlainObject(schema) && "$ref" in schema) {
    const target = resolveRef(schema["$ref"], root);
    const siblings = { ...schema };
    delete siblings["$ref"];
    schema = mergeSchema(target, siblings);
  }
  if ("const" in schema!) return wrap(schema!["const"], SCHEMA_INLINED);

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
    annotate(node, schema!); // title/description/type/format (post-$ref-merge)
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
    const node = new YNode(children, concrete ?? SCHEMA_INLINED);
    annotate(node, schema!); // title/description/type/format (post-$ref-merge)
    if (rel) node.rel = rel;
    return node;
  }

  if (isArray) {
    // When the array's `items` is an element schema (not `false`), it is the base
    // each `prefixItems` entry overlays — so a uniform element type/format (e.g. a
    // chapter's chunks all `string`/`text/markdown`) is declared once, not repeated.
    const itemBase = isPlainObject(schema!["items"]) ? (schema!["items"] as Schema) : null;
    const items = (schema!["prefixItems"] || []).map((child: Schema, idx: number) => {
      const eff = itemBase ? mergeSchema(itemBase, child) : child;
      const cnode = resolve(eff, container, String(idx), false, root);
      annotate(cnode, eff);
      return cnode;
    });
    const node = new YNode(items, concrete ?? SCHEMA_INLINED);
    annotate(node, schema!); // title/description/type/format (post-$ref-merge)
    if (rel) node.rel = rel;
    return node;
  }

  // A value stored in its own file. Its kind is known from the schema `type`
  // (e.g. 04-object-in-dir's typed scalars) or, for an untyped `file/yaml`
  // (e.g. 11-switch's `contact`), determined by reading the file on demand.
  if (isFileConcrete && name) {
    const kind = concrete === "file/binary" ? "binary" : kindFromType(stype);
    const node = fromFile(path.join(container, name), concrete!, schema!, kind);
    annotate(node, schema!); // title/description/type/format (post-$ref-merge)
    if (rel) node.rel = rel;
    return node;
  }

  // No value, but still defined inline in the schema → instantiated from it.
  const node = new YNode(null, concrete ?? SCHEMA_INLINED);
  annotate(node, schema!); // title/description/type/format (post-$ref-merge)
  if (rel) node.rel = rel;
  return node;
}

/** A lazy node *is* a file: its interior (yaml/json/binary) is decoded only when
 *  the value is first accessed. `kind` (from the schema) lets callers list or
 *  elide it without reading the bytes. */
function fromFile(filePath: string, concrete: string, schema: Schema | null, kind?: Kind): YNode {
  const node = YNode.lazy(
    () => wrap(decodeFile(filePath, concrete, schema), interior(concrete)).value,
    concrete,
    filePath, // the node is this file; its interior children stay path-less
    kind,
  );
  // Fall back to the extension-implied format when the schema pins none, so a
  // file routes to its renderer with no `format:` declaration. A schema `format`
  // (applied by `annotate` after this) still wins.
  const schemaFmt = isPlainObject(schema) ? schema["format"] : null;
  const fmt = (typeof schemaFmt === "string" ? schemaFmt : null) ?? formatFromExt(filePath);
  if (fmt) node.format = fmt;
  return node;
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
  if (node.concrete && node.concrete.startsWith("file/")) return;
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
    // `withFileTypes` returns each entry's kind in the one `readdir`, so the
    // common dir/file case needs no extra `stat` per entry (a symlink still
    // falls back to one, via `knownDir: undefined`).
    const ents = fs.readdirSync(container, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
      const name = ent.name;
      if (name.startsWith(".") || consumed.has(name) || name in existing) continue;
      const full = path.join(container, name);
      if (isIgnored(full)) continue;
      const knownDir = ent.isDirectory() ? true : ent.isFile() ? false : undefined;
      out[name] = loadEntity(full, knownDir);
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
      const fmt = (isPlainObject(schema) ? schema["format"] : null) ?? formatFromExt(filePath);
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

/** The inlined language a collapsed document file's interior is tagged with
 *  (`file/yaml` → `yaml`, `file/json` → `json`). */
const interior = interiorOf;

// File extension → format (MIME-ish), the second half of the (type, format)
// renderer key. A file-backed node that carries no explicit schema `format`
// falls back to this, so a stray `.pdf`/`.png`/`.md` renders without being
// declared. The formats here are exactly the ones a client renderer claims.
const EXT_FORMAT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".djvu": "image/vnd.djvu",
  ".djv": "image/vnd.djvu",
  ".psd": "image/vnd.adobe.photoshop",
  ".psb": "image/vnd.adobe.photoshop",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heic",
  ".fb2": "application/x-fictionbook+xml",
  ".epub": "application/epub+zip",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".adoc": "text/asciidoc",
  ".asciidoc": "text/asciidoc",
  ".asc": "text/asciidoc",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".rtf": "application/rtf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".kml": "application/vnd.google-earth.kml+xml",
  ".kmz": "application/vnd.google-earth.kmz",
  ".puml": "text/x-plantuml",
  ".plantuml": "text/x-plantuml",
  ".iuml": "text/x-plantuml",
  ".pu": "text/x-plantuml",
};

/** The renderable format implied by a file's extension, or null when unknown. */
export function formatFromExt(filePath: string | null): string | null {
  if (!filePath) return null;
  return EXT_FORMAT[path.extname(filePath).toLowerCase()] ?? null;
}

// Formats whose nodes carry their content as a *string* value (rendered from the
// text). Everything else inferable (images, pdf, djvu, html) is served as bytes.
const TEXT_FORMATS = new Set([
  "text/markdown",
  "text/asciidoc",
  "text/x-plantuml",
  "text/csv",
  "text/tab-separated-values",
]);

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

/** Whether a node *displays* as a container: a real object/array, or a `null`
 *  leaf *overlaid* with virtual children (dot-prefixed `rel` down-edges) — those
 *  keys make the null read as an object (e.g. a childless person who is recorded
 *  as a parent elsewhere). Plain up-edge relations (`father`/`mother`) do *not*
 *  promote a null: it stays a scalar. The virtual-children check (which reads only
 *  `rel`) comes before touching `value`, so leaves are judged without a file read. */
export function isDisplayContainer(node: YNode): boolean {
  const k = nodeKind(node);
  if (k === "object" || k === "array") return true;
  if (k === "binary") return false;
  if (Object.keys(virtualChildren(node)).length === 0) return false;
  return node.value == null;
}

/** A node's display kind: an entity node (see {@link isDisplayContainer}) shows as
 *  `object`; otherwise its ordinary {@link nodeKind}. */
export function displayKind(node: YNode): Kind {
  const k = nodeKind(node);
  return k === "scalar" && isDisplayContainer(node) ? "object" : k;
}

/** Direct child count for display: real children plus non-colliding virtual ones
 *  (dot-prefixed `rel` down-edges read like real children). */
function displayChildCount(node: YNode): number {
  const k = nodeKind(node);
  const real =
    k === "object" ? Object.keys(node.value as Record<string, YNode>)
    : k === "array" ? (node.value as YNode[]).map((_, i) => String(i))
    : [];
  let n = real.length;
  for (const name of Object.keys(virtualChildren(node))) if (!real.includes(name)) n++;
  return n;
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

/** The type shown in the TOC and the content header. Same as {@link typeLabel},
 *  except a `null` leaf overlaid with virtual children reads as `object` (see
 *  {@link isDisplayContainer}); a node with only up-edge relations stays `null`. */
export function displayTypeLabel(node: YNode): string {
  return nodeKind(node) === "scalar" && isDisplayContainer(node) ? "object" : typeLabel(node);
}

// --------------------------------------------------------------------------- //
// Path handling (JSON space — no "properties")
// --------------------------------------------------------------------------- //

export type Seg = string | number;

/** Render path segments JSON-path style: `:key[0]:other` (root → `:`, colon-form —
 *  SEPARATOR.md M4). Each key is percent-encoded so a `:`, `[`, or `]` *inside* a
 *  key (e.g. `@vitejs/plugin-react`) does not read as a separator. */
export function segsToStr(segs: Seg[]): string {
  return (
    segs
      .map((s) => (typeof s === "number" ? `[${s}]` : `:${encodeURIComponent(s)}`))
      .join("") || ":"
  );
}

const PATH_TOKEN = /\[\d+\]|[^:\[\]]+/g;

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
// rel pointer resolution (a port of walker.py's follow_pointer / walk_segments)
// --------------------------------------------------------------------------- //

// A rel-pointer token: a bracketed array index (`[0]`), a `^name` ascent, or a
// key name. `^` is a boundary (`a^b` → `a` then `^b`); keys may not contain `^`.
const REL_TOKEN = /\[\d+\]|\^[^/\[\]^]+|[^/\[\]^]+/g;

/** Translate a single path token into a real key/index for `node`'s value. */
function childKey(node: YNode, part: string): Seg {
  const v = node.value;
  if (isPlainObject(v)) {
    if (part in v) return part;
    throw new Error(`no such child: ${part}`);
  }
  if (Array.isArray(v)) {
    const tok = part.startsWith("[") && part.endsWith("]") ? part.slice(1, -1) : part;
    const idx = Number(tok);
    if (Number.isInteger(idx) && idx >= 0 && idx < v.length) return idx;
    throw new Error(`bad index: ${part}`);
  }
  throw new Error(`${typeLabel(node)} has no children`);
}

function hasChild(node: YNode, token: string): boolean {
  try {
    childKey(node, token);
    return true;
  } catch {
    return false;
  }
}

/** A node's virtual children — `rel` keys prefixed with `.` (down-edges), the
 *  `.` stripped — mapping name → pointer (string pointers only). */
function virtualChildren(node: YNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.rel || {}))
    if (k.startsWith(".") && typeof v === "string") out[k.slice(1)] = v;
  return out;
}

/** Segments of the nearest ancestor-or-self that is a yamlover entity — the
 *  anchor an absolute (`/…`) pointer is written relative to. Falls back to root. */
function entityRootSegs(root: YNode, segs: Seg[]): Seg[] {
  for (let i = segs.length; i >= 0; i--)
    if (getNode(root, segs.slice(0, i)).concrete === "dir/yamlover") return segs.slice(0, i);
  return [];
}

/** The JSON-space path of the *document* the node at `segs` belongs to: the nearest
 *  yamlover entity (or the served root). This is the anchor a document-relative
 *  (`/…`) link or `rel` pointer resolves against — see {@link entityRootSegs}. */
export function documentPath(root: YNode, segs: Seg[]): string {
  return segsToStr(entityRootSegs(root, segs));
}

/** Walk *up* a named parent edge (`^name`) from the node at `segs`. */
function ascend(root: YNode, segs: Seg[], name: string): Seg[] {
  const rel = getNode(root, segs).rel || {};
  if (name in rel && typeof rel[name] === "string") return followPointer(root, segs, rel[name] as string);
  if (segs.length && String(segs[segs.length - 1]) === name) return segs.slice(0, -1); // ^<own-key> undoes the descent
  throw new Error(`no parent relation: ^${name}`);
}

/** Apply path `tokens` from `segs`: `..` ascends, `^name` ascends a named parent,
 *  `[n]`/names descend (falling back to a virtual child). Throws on a bad step. */
function walkSegments(root: YNode, segs: Seg[], tokens: string[]): Seg[] {
  let cur = [...segs];
  for (const token of tokens) {
    if (token === ".") continue;
    if (token === "..") {
      if (cur.length) cur.pop();
    } else if (token.startsWith("^")) {
      cur = ascend(root, cur, token.slice(1));
    } else {
      const node = getNode(root, cur);
      const vkids = virtualChildren(node);
      // a real containment child wins; otherwise follow a virtual down-edge
      if (token in vkids && !hasChild(node, token)) cur = followPointer(root, cur, vkids[token]);
      else cur.push(childKey(node, token));
    }
  }
  getNode(root, cur); // validate
  return cur;
}

/** Resolve a `rel` pointer to target segments: `..`-relative walks from `segs`,
 *  an absolute `/…` from the enclosing yamlover entity (cf. walker.py). */
function followPointer(root: YNode, segs: Seg[], ptr: string): Seg[] {
  if (ptr.startsWith("*")) throw new Error(`anchor refs not yet supported: ${ptr}`);
  const base = ptr.startsWith("/") ? entityRootSegs(root, segs) : segs;
  return walkSegments(root, base, ptr.match(REL_TOKEN) || []);
}

/** The target segments a `rel` pointer resolves to, or null when it is not a
 *  string pointer or does not resolve to a real node. */
export function resolveRel(root: YNode, segs: Seg[], ptr: unknown): Seg[] | null {
  if (typeof ptr !== "string") return null;
  try {
    return followPointer(root, segs, ptr);
  } catch {
    return null;
  }
}

/** The JSON-space path a `rel` pointer resolves to (for hyperlinking), or null. */
export function relTargetPath(root: YNode, segs: Seg[], ptr: unknown): string | null {
  const target = resolveRel(root, segs, ptr);
  return target ? segsToStr(target) : null;
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
  [LINK_KEY]: { kind: Kind; type: string; path: string; title?: string; count?: number; size?: number; format?: string | null; value?: unknown };
}

function linkMarker(node: YNode, segs: Seg[]): LinkMarker {
  const kind = displayKind(node); // entity nodes link as `object`, like their siblings
  // the (type, format) tuple rides along — the same key the TOC and RHS use — so a
  // renderer can route a child to its own renderer (e.g. a chapter to its chunks)
  const info: LinkMarker[typeof LINK_KEY] = { kind, type: tocType(node), path: segsToStr(segs) };
  if (node.format) info.format = node.format; // half of the routing key (see above)
  // a node's schema title rides along so a renderer can label the link with the
  // target's heading (e.g. a chapter linking its subchapters by their titles)
  if (node.title) info.title = node.title;
  if (kind === "binary") {
    const b = node.value as Binary; // stat-cheap; gives size + format
    info.size = b.size;
    if (info.format == null) info.format = b.fmt; // fall back to the file's encoded format
  } else if (kind === "scalar") {
    info.value = node.value; // a link to a genuine scalar shows its value as the label
  } else {
    info.count = displayChildCount(node);
  }
  return { [LINK_KEY]: info };
}

// An `x-yamlover.rel` pointer, emitted in the schema view as `{ [REF_KEY]: {text,
// path} }`: the client renders `text` (the original pointer) as a hyperlink that
// navigates to `path` (the resolved JSON-space location), or as plain text when
// `path` is null (the pointer does not resolve to a real node).
export const REF_KEY = "$yamloverRef";

interface RefMarker {
  [REF_KEY]: { text: string; path: string | null };
}

/** Turn a node's `rel` table into ref markers, resolving each pointer (relative
 *  to `segs`, the node's own path) so the client can hyperlink it. */
function relMarkers(rel: Record<string, unknown>, segs: Seg[], root: YNode): Record<string, RefMarker> {
  const out: Record<string, RefMarker> = {};
  for (const [name, ptr] of Object.entries(rel))
    out[name] = { [REF_KEY]: { text: String(ptr), path: relTargetPath(root, segs, ptr) } };
  return out;
}

function refTo(path: string | null, fallbackText: string): RefMarker {
  return { [REF_KEY]: { text: path ?? fallbackText, path } };
}

/** A hyperlink to where a `rel` pointer resolves, shown with the *target's*
 *  standard title (`{ object … }` / `[ array … ]` / scalar value) via a
 *  {@link linkMarker}; falls back to a plain-text {@link refTo} when the pointer
 *  does not resolve to a real node. */
function relLink(root: YNode, segs: Seg[], ptr: unknown): LinkMarker | RefMarker {
  const target = resolveRel(root, segs, ptr);
  return target ? linkMarker(getNode(root, target), target) : refTo(null, String(ptr));
}

/**
 * The relations panel shown above the value in the data (yaml/json) views: the
 * node's *named up-edges* (its non-dot `rel` keys, e.g. `father`/`mother`), each
 * a hyperlink to where it resolves — shown with the target's standard title, like
 * any other container link — led by the structural parent `..`. The `..` is
 * omitted when a named edge already points to the parent (e.g. `father: ".."`),
 * so the parent is not listed twice, and at the root (which has no parent); a node
 * with no named up-edges shows only `..`. (Dot-prefixed `rel` keys are *virtual
 * children* — see {@link toPlain} — surfaced in the value, not here.)
 */
export function buildRelations(node: YNode, segs: Seg[], root: YNode): Record<string, unknown> {
  const parentSegs = segs.slice(0, -1); // structural parent (root → itself)
  const parentPath = segsToStr(parentSegs);
  const named: Record<string, unknown> = {};
  let parentCovered = false;
  for (const [name, ptr] of Object.entries(node.rel || {})) {
    if (name.startsWith(".")) continue;
    named[name] = relLink(root, segs, ptr);
    if (relTargetPath(root, segs, ptr) === parentPath) parentCovered = true;
  }
  const out: Record<string, unknown> = {};
  if (segs.length > 0 && !parentCovered) out[".."] = linkMarker(getNode(root, parentSegs), parentSegs);
  return Object.assign(out, named);
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
 *
 * Entity nodes — including childless ones that materialize as null-valued leaves
 * carrying only a `rel` table — display as objects (see {@link isDisplayContainer})
 * so siblings render uniformly. A node's *virtual children* (its dot-prefixed
 * `rel` down-edges, e.g. a mother's `.cain`) are surfaced alongside any real
 * children as links to where they resolve — with the target's standard title, like
 * any container link — so they read like ordinary children. A real child of the
 * same name always wins. `root` (default `node`) anchors the pointer resolution;
 * the API passes the real entity root.
 */
export function toPlain(
  node: YNode,
  depth: number | null = null,
  segs: Seg[] = [],
  top = true,
  root: YNode = node,
): unknown {
  const k = nodeKind(node);
  // Every child (non-top) is a hyperlink to its own page: at the one-level depth
  // boundary a container links by its `{ … }`/`[ … ]` summary and a scalar by its
  // rendered value, so all children are navigable alike. (The top node is shown in
  // full, and a binary child always links — never inlined — regardless of depth.)
  if (!top && depth != null && depth <= 0) return linkMarker(node, segs);
  if (k === "binary" && !top) return linkMarker(node, segs);

  if (k === "array") {
    return (node.value as YNode[]).map((c, i) => toPlain(c, descend(depth), [...segs, i], false, root));
  }
  if (isDisplayContainer(node)) {
    // a real object, or a null leaf overlaid with virtual children, rendered as an
    // object: real children recursed, virtual ones (dot-rel) linked to where they
    // resolve (a real child of the same name wins)
    const out: Record<string, unknown> = {};
    if (k === "object")
      for (const [key, c] of Object.entries(node.value as Record<string, YNode>))
        out[key] = toPlain(c, descend(depth), [...segs, key], false, root);
    for (const [name, ptr] of Object.entries(virtualChildren(node)))
      if (!(name in out)) out[name] = relLink(root, segs, ptr);
    return out;
  }
  if (k === "binary") return (node.value as Binary).repr(); // top-level binary (header only)
  return node.value; // scalar — read on demand
}

/**
 * Build the JSON Schema whose sole instance is the node's subtree — the
 * instance → schema direction of the Schema ↔ instance correspondence (every
 * value `v` becomes `{const: v}`). Every node also carries its full
 * `x-yamlover` block (see {@link xyProvenance}) — uniformly, whatever its
 * concrete representation. A container past the `depth` budget becomes a
 * {@link linkMarker}, exactly as in {@link toPlain}.
 *
 * `root` is the full materialized tree (defaulting to `node` itself), needed to
 * resolve each node's `rel` pointers into hyperlinks; the API passes the real
 * entity root so absolute (`/…`) pointers anchor correctly.
 */
export function toSchema(
  node: YNode,
  depth: number | null = null,
  segs: Seg[] = [],
  top = true,
  root: YNode = node,
): unknown {
  const k = nodeKind(node);
  if ((k === "object" || k === "array") && depth != null && depth <= 0) return linkMarker(node, segs);
  if (k === "binary" && !top) return linkMarker(node, segs); // a binary child links to its page

  // Lead with the (type, format) tuple a node routes on — the same key the TOC,
  // icons, and renderers use — in the JSON Schema order (`type`, then `format`), so
  // the schema view mirrors the source. `type` is the declared schema `type` when
  // pinned, else the inferred kind; `format` is whatever the node carries (a
  // source-pinned `text/markdown` or an extension-inferred one). Without these the
  // representation silently dropped a leaf's `type:`/`format:`.
  const schema: Schema = { type: node.schemaType ?? typeLabel(node) };
  if (node.format) schema.format = node.format;
  if (k === "object") {
    const properties: Schema = {};
    for (const [key, c] of Object.entries(node.value as Record<string, YNode>))
      properties[key] = toSchema(c, descend(depth), [...segs, key], false, root);
    schema.properties = properties;
  } else if (k === "array") {
    schema.prefixItems = (node.value as YNode[]).map((c, i) => toSchema(c, descend(depth), [...segs, i], false, root));
    schema.items = false;
  } else if (k === "binary") {
    schema.const = (node.value as Binary).repr();
  } else {
    schema.const = node.value;
  }
  if (node.title) schema.title = node.title;
  if (node.description) schema.description = node.description;
  const xy = xyProvenance(node, segs, root);
  if (xy) schema["x-yamlover"] = xy;
  return schema;
}

/**
 * A node's full `x-yamlover` block for the schema view, built the same way for
 * every node regardless of how it is concretely stored: its `concrete` tag, any
 * `rel` links, and — only when the node is physically on disk — its `os` stat
 * provenance. There is no per-concrete special-casing: a schema-instantiated
 * node (no file, no directory) still surfaces its `concrete` and `rel`, and a
 * filesystem-backed one adds `os` on top. Returns null when nothing applies.
 * Each `rel` pointer is emitted as a {@link relMarkers} ref so the client can
 * hyperlink it to the location it resolves to.
 */
function xyProvenance(node: YNode, segs: Seg[], root: YNode): Schema | null {
  const xy: Schema = {};
  if (node.concrete != null) xy.concrete = node.concrete;
  if (node.rel != null) xy.rel = relMarkers(node.rel, segs, root);
  if (node.path != null) xy.os = osInfo(node.path);
  return Object.keys(xy).length > 0 ? xy : null;
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
  concrete: string | null; // how it is stored (e.g. `dir` → a plain folder icon)
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
 *  the value already happens to be loaded, e.g. a `const`). A `null` leaf overlaid
 *  with virtual children reads as `object`, matching the content header. */
function tocType(node: YNode): string {
  if (node.schemaType) return node.schemaType;
  const k = nodeKind(node);
  if (k === "scalar") {
    if (isDisplayContainer(node)) return "object"; // virtual-children overlay
    return node.loaded ? typeLabel(node) : "string";
  }
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
    concrete: node.concrete ?? null,
    // An unloaded lazy container (a directory not yet descended into) is assumed
    // expandable rather than read just to count — its children load on expand.
    hasChildren: container && (node.loaded ? childCount(node) > 0 : true),
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
