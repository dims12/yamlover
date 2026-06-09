// Directory walker — the directory concrete (YAMLOVER.md §5) → IR Document. Replaces the
// Python walker / the server's legacy `loadEntity`, mirroring its file→value semantics so the
// web UI works "as it was", but emitting the new IR (parser/ts/src/ir.ts) the engine consumes.
//
// A directory IS a mapping: each file/subdir is an entry keyed by its filename. The `.yamlover/`
// overlay dir is not itself an entry; it carries:
//   - body.yamlover — the INSTANCE overlay: a mapping merges over the dir (override/add); a
//     pointer-array (`- *file …`) imposes child ORDER (a bare dir takes filesystem order).
//   - meta.yamlover — the metadata SCHEMA: `properties.<name>.{type,format}` types a child
//     (e.g. type: binary makes a textual-looking file a Blob; format names its decoding).
//
// File → value (legacy rule): a TEXT-format extension → a string scalar (raw content); a known
// binary/opaque extension → a Blob; unknown/no extension → sniff (NUL byte or >1 MiB ⇒ Blob,
// else parse the content as yamlover → scalar/structure). A `meta` type:binary overrides to Blob.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Document, Node, Mapping, Blob, Entry, Value } from '../../../parser/ts/src/ir.ts';
import { isPointer, toPlain } from '../../../parser/ts/src/ir.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { parseJson5p } from '../../../parser/ts/src/json5p.ts';
import { Store } from './store.ts';

const YAMLOVER_DIR = '.yamlover';
const MAX_TEXT_BYTES = 1 << 20; // 1 MiB: above this we never slurp a file to sniff/parse it

export interface WalkOptions {
  /** Skip a filesystem child when this returns true for its absolute path (e.g. a `.gitignore`
   *  matcher, so a project-root walk does not descend into `node_modules`). Hidden dotfiles and
   *  the `.yamlover/` overlay dir are always skipped regardless. */
  ignore?: (absPath: string) => boolean;
}

/** Walk a directory (absolute path) into an IR Document (concrete: "directory"). */
export function walkDir(absDir: string, opts: WalkOptions = {}): Document {
  // Anchors live per parsed file (YAML `&name`), but resolution runs over the whole assembled
  // tree — so collect every file's anchors here, keyed by name → the anchored Node (the same
  // object that ends up in the tree). Names are treated as tree-global (a YAML anchor is really
  // intra-document; collisions across files would shadow — unique in practice).
  const anchors = new Map<string, Node>();
  const root = dirNode(absDir, opts, anchors);
  root.meta = { ...root.meta, documentRoot: true }; // the served root is always a document root
  applySchemas(root, findDefsRoot(absDir)); // propagate attached !!<…> schemas down the instance
  return { root, anchors, source: { concrete: 'directory', uri: absDir } };
}

/** Build the index DB for a directory tree: walk → IR → SQLite at <root>/.yamlover/index.db.
 *  Creates the .yamlover/ dir if absent. The DB is a derived cache (ENGINE.md) — re-runnable. */
export function buildIndex(absDir: string, opts: WalkOptions = {}): string {
  const overlay = path.join(absDir, YAMLOVER_DIR);
  fs.mkdirSync(overlay, { recursive: true });
  const dbPath = path.join(overlay, 'index.db');
  const store = new Store(dbPath);
  store.indexDocument(walkDir(absDir, opts));
  store.close();
  return dbPath;
}

/** Per-child metadata from `.yamlover/meta.yamlover` `properties`: { name → {type, format} }. */
type Meta = Record<string, { type?: string; format?: string }>;

function loadMeta(dir: string): Meta {
  const file = path.join(dir, YAMLOVER_DIR, 'meta.yamlover');
  if (!fs.existsSync(file)) return {};
  try {
    const plain = toPlain(parseYamlover(fs.readFileSync(file, 'utf8'), file).root) as Record<string, unknown>;
    const props = (plain?.properties ?? {}) as Record<string, { type?: string; format?: string }>;
    return props && typeof props === 'object' ? props : {};
  } catch {
    return {};
  }
}

/** A directory → a Mapping node: one entry per file/subdir, then the body.yamlover overlay.
 *  Collected anchors from any parsed children/overlay are merged into `anchors`. */
function dirNode(dir: string, opts: WalkOptions, anchors: Map<string, Node>): Node {
  const meta = loadMeta(dir);
  const names = fs
    .readdirSync(dir)
    .filter((n) => n !== YAMLOVER_DIR && !n.startsWith('.')) // skip the overlay dir + hidden
    .filter((n) => !opts.ignore?.(path.join(dir, n))) // skip git-ignored (e.g. node_modules)
    .sort(); // filesystem order = sorted names (stable; body.yamlover can re-impose order)

  const entries: Entry[] = [];
  for (const name of names) {
    const child = childNode(path.join(dir, name), meta[name], opts, anchors);
    entries.push({ key: name, edge: 'contain', value: child });
  }

  let node: Mapping = { kind: 'mapping', entries, array: false };
  node = applyBody(dir, node, anchors);
  return applyMeta(node, meta); // attach meta `format` to entries (incl. body-overlay ones)
}

/** A single filesystem child (file or subdir) → a Node, honoring meta type/format overrides. */
function childNode(abs: string, m: { type?: string; format?: string } | undefined, opts: WalkOptions, anchors: Map<string, Node>): Node {
  if (fs.statSync(abs).isDirectory()) return dirNode(abs, opts, anchors);

  const ext = path.extname(abs).toLowerCase();
  // format resolution order: meta `format:` → a recognized extension → (none → sniff/parse).
  const fmt = m?.format ?? EXT_FORMAT[ext] ?? null;
  if (m?.type === 'binary') return blob(abs, fmt ?? 'application/octet-stream');
  if (fmt && TEXT_FORMATS.has(fmt)) return textScalar(abs, fmt); // markdown/adoc/plantuml/csv → string + format
  if (fmt) return blob(abs, fmt); // a known but non-text format = opaque bytes
  if (looksBinary(abs)) return blob(abs, 'application/octet-stream');
  return parsedScalar(abs, ext, anchors); // text, no format → parse by extension (json5p for .json*, else yamlover)
}

/** Apply `meta.yamlover` `properties.<key>.format` to the matching entries, so a body-overlay
 *  text entry (e.g. 59's `markdown:`) gets its (type, format) just like a file child does. A
 *  Blob already carries its format; a node with a format already wins; binary stays a Blob. */
function applyMeta(node: Mapping, meta: Meta): Mapping {
  for (const e of node.entries) {
    if (e.key == null || isPointer(e.value) || e.value.kind === 'blob') continue;
    const fmt = meta[e.key]?.format;
    if (fmt && !e.value.meta?.schema) e.value = { ...e.value, meta: { ...e.value.meta, schema: inlineFormat(fmt) } };
  }
  return node;
}

/** A Blob node: format + content hash + size; bytes live in the store, not the IR (IR.md). */
function blob(abs: string, format: string): Blob {
  const bytes = fs.readFileSync(abs);
  const contentHash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  return { kind: 'blob', format, contentHash, size: bytes.length };
}

/** A textual file kept as a raw string scalar (markdown/asciidoc/plantuml/csv …). */
function textScalar(abs: string, format: string): Node {
  const text = fs.readFileSync(abs, 'utf8');
  return { kind: 'scalar', value: text, raw: text, meta: { schema: inlineFormat(format) } };
}

/** A structured/text file with no binary format: parse it into a node. The parser is chosen by
 *  extension — `.json`/`.json5`/`.json5p` → json5p (handles JSON/JSON5 incl. multi-line + comments,
 *  which the YAML parser does not), everything else (`.yaml`/`.yamlover`/no extension) → yamlover,
 *  the DEFAULT. So `30`→number, `"Alice"`→string, a JSON doc → a structure. Falls back to a raw
 *  string if parsing fails. */
function parsedScalar(abs: string, ext: string, anchors: Map<string, Node>): Node {
  const text = fs.readFileSync(abs, 'utf8');
  try {
    const doc = ext === '.json' || ext === '.json5' || ext === '.json5p' ? parseJson5p(text, abs) : parseYamlover(text, abs);
    for (const [name, node] of doc.anchors) anchors.set(name, node); // the file's `&` anchors, tree-global
    const root = doc.root;
    root.meta = { ...root.meta, documentRoot: true }; // a parsed file is its own document
    return root;
  } catch {
    return { kind: 'scalar', value: text, raw: text };
  }
}

// --------------------------------------------------------------------------- //
// Schema application (the metadata layer): resolve a node's attached `!!<…>` schema and
// propagate (type, format) DOWN the instance via the schema's `properties`/`items`. So a
// chapter tagged only at its root makes its `children[*]` chapters and its `chunks[*]`
// text/marklower — even though the subnodes carry no tag of their own. (METADATA-only; no
// validation. Schema resolution was deferred — this is the first, targeted slice of it.)
// --------------------------------------------------------------------------- //

/** The nearest ancestor of `dir` (incl. itself) that holds a `$defs/` dir — the yamlover
 *  project root that hosts schemas; falls back to `dir`. */
function findDefsRoot(dir: string): string {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '$defs'))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(dir);
    d = up;
  }
}

function applySchemas(root: Node, defsRoot: string): void {
  const cache = new Map<string, Node | null>();
  const loadDef = (name: string): Node | null => {
    if (!cache.has(name)) {
      const defFile = path.join(defsRoot, '$defs', name);
      try {
        cache.set(name, parseYamlover(fs.readFileSync(defFile, 'utf8'), defFile).root);
      } catch {
        cache.set(name, null);
      }
    }
    return cache.get(name)!;
  };

  // the schema field at `key`: a Value (a sub-schema Node, or a `*…/$defs/…` Pointer)
  const field = (n: Node, key: string): Value | null => n.entries?.find((e) => e.key === key)?.value ?? null;
  const str = (n: Node, key: string): string | null => {
    const v = field(n, key);
    return v && !isPointer(v) && v.kind === 'scalar' && v.value != null ? String(v.value) : null;
  };
  const hasFormat = (inst: Node): boolean => {
    if (inst.kind === 'blob') return true;
    const s = inst.meta?.schema;
    return !!s && !isPointer(s) && s.kind === 'mapping' && !!field(s, 'format');
  };

  const apply = (inst: Node, schema: Value, depth: number): void => {
    if (depth > 64 || isPointer(inst)) return;
    // resolve a pointer schema (`*…/$defs/<name>`) to the hosted schema node
    let name: string | null = null;
    let s: Node | null;
    if (isPointer(schema)) {
      const last = schema.steps[schema.steps.length - 1];
      name = last?.sel === 'key' ? last.name : null;
      s = name ? loadDef(name) : null;
    } else s = schema;
    if (!s || isPointer(s)) return;
    // attach this node's derived (type, format): an explicit schema `format`, else an
    // object schema hosted as `$defs/<name>` → `x-yamlover-<name>` (chapter, tag, …).
    const fmt = str(s, 'format') ?? (name && str(s, 'type') === 'object' ? `x-yamlover-${name}` : null);
    if (fmt && !hasFormat(inst)) inst.meta = { ...inst.meta, schema: inlineFormat(fmt) };
    // recurse structurally
    const stype = str(s, 'type');
    if (stype === 'object') {
      const props = field(s, 'properties');
      const addl = field(s, 'additionalProperties'); // a schema for keys not in `properties`
      for (const e of inst.entries ?? []) {
        if (e.key == null || isPointer(e.value)) continue;
        const declared = props && !isPointer(props) ? field(props, e.key) : null;
        const sub = declared ?? addl; // a declared property wins, else additionalProperties
        if (sub) apply(e.value, sub, depth + 1);
      }
    } else if (stype === 'array') {
      const items = field(s, 'items');
      if (items) for (const e of inst.entries ?? []) if (!isPointer(e.value)) apply(e.value, items, depth + 1);
    }
  };

  const walk = (node: Node): void => {
    if (node.meta?.schema) apply(node, node.meta.schema, 0);
    for (const e of node.entries ?? []) if (!isPointer(e.value)) walk(e.value);
  };
  walk(root);
}

/** Wrap a `format` string as an inline schema Node (a one-line yamlover/meta `{format: …}`),
 *  matching the `!!<format: …>` tag form so the renderer keys off (type, format) uniformly. */
function inlineFormat(format: string): Value {
  return { kind: 'mapping', entries: [{ key: 'format', edge: 'contain', value: { kind: 'scalar', value: format, raw: format } }], array: false };
}

/** Merge `.yamlover/body.yamlover` over the directory mapping (YAMLOVER.md §5):
 *  - a mapping body OVERRIDES same-key children and ADDS overlay-only keys (scalars/pointers);
 *  - a pointer-array body (`- *file …`) imposes ORDER over the existing children.
 *  The body root's `meta` (e.g. a `!!<*yamlover/$defs/chapter>` tag attaching a schema to the
 *  whole directory) is carried onto the merged node, so a directory CHAPTER is recognized. */
function applyBody(dir: string, node: Mapping, anchors: Map<string, Node>): Mapping {
  const file = path.join(dir, YAMLOVER_DIR, 'body.yamlover');
  if (!fs.existsSync(file)) return node;
  const bodyDoc = parseYamlover(fs.readFileSync(file, 'utf8'), file);
  for (const [name, n] of bodyDoc.anchors) anchors.set(name, n); // overlay `&` anchors, tree-global
  const body = bodyDoc.root;
  if (body.kind !== 'mapping' || !body.entries) return node;
  // a directory with a body.yamlover overlay is a self-contained instance = a DOCUMENT root
  // (so `*/file` inside it resolves to this directory, at any nesting depth).
  const meta = { ...node.meta, ...body.meta, documentRoot: true };

  // a pure pointer/positional array → reorder existing children to match
  if (body.array || (body.entries.length > 0 && body.entries.every((e) => e.key === null))) {
    const byKey = new Map(node.entries.map((e) => [e.key, e] as const));
    const ordered: Entry[] = [];
    for (const e of body.entries) {
      const targetKey = isPointer(e.value) ? pointerLeafKey(e.value) : null;
      const hit = targetKey != null ? byKey.get(targetKey) : null;
      if (hit) { ordered.push(hit); byKey.delete(targetKey); }
      else ordered.push(e); // an inline element (not a pointer to a child)
    }
    for (const e of node.entries) if (e.key != null && byKey.has(e.key)) ordered.push(e); // unlisted, trailing
    return { kind: 'mapping', entries: ordered, array: true, meta };
  }

  // a mapping body: ADD overlay-only keys; for a key that matches a dir child, the overlay
  // AUGMENTS it (YAMLOVER.md §5) — e.g. a file blob + body title/tags ⇒ an omni-blob (a blob
  // that carries members), not a replacement.
  const merged = new Map(node.entries.map((e) => [e.key, e] as const));
  const order: (string | null)[] = node.entries.map((e) => e.key);
  for (const e of body.entries) {
    const existing = merged.get(e.key);
    if (!existing) { order.push(e.key); merged.set(e.key, e); }
    else merged.set(e.key, augmentEntry(existing, e));
  }
  return { kind: 'mapping', entries: order.map((k) => merged.get(k)!), array: false, meta };
}

/** Overlay `body`'s entry onto the directory's: keep the dir node's value/kind/format (the file
 *  bytes) and attach the overlay's fields + meta. A pointer on either side just replaces. */
function augmentEntry(base: Entry, overlay: Entry): Entry {
  if (isPointer(base.value) || isPointer(overlay.value)) return overlay;
  const b = base.value, o = overlay.value;
  // keep b's discriminated kind (mapping/scalar/blob) + value/format; attach the overlay's fields
  const value = {
    ...b,
    entries: o.entries ?? b.entries,
    array: o.entries ? o.array : b.array,
    meta: b.meta || o.meta ? { ...b.meta, ...o.meta } : undefined,
  } as Node;
  return { key: base.key, edge: 'contain', value };
}

/** The final string key a sibling pointer addresses (`*anyfile01` → "anyfile01"); null if not
 *  a simple current-scope key reference. Used to match a body pointer-array element to a child. */
function pointerLeafKey(v: Value): string | null {
  if (!isPointer(v)) return null;
  const last = v.steps[v.steps.length - 1];
  if (last?.sel === 'key') return last.name;
  if (v.steps.length === 0 && v.base.scope === 'current') return v.raw; // bare `*name`
  return null;
}

/** Heuristic: a file is binary if it is large, or a NUL byte appears in its head. */
function looksBinary(abs: string): boolean {
  try {
    if (fs.statSync(abs).size > MAX_TEXT_BYTES) return true;
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).includes(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true; // unreadable → treat as opaque
  }
}

// Extension → format (subset of the server's table; the renderer keys off it). TEXT_FORMATS are
// the formats kept inline as string scalars; every other known format is opaque (a Blob).
const EXT_FORMAT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.djvu': 'image/vnd.djvu', '.djv': 'image/vnd.djvu',
  '.psd': 'image/vnd.adobe.photoshop', '.psb': 'image/vnd.adobe.photoshop', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heic',
  '.fb2': 'application/x-fictionbook+xml', '.epub': 'application/epub+zip',
  '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.adoc': 'text/asciidoc', '.asciidoc': 'text/asciidoc', '.asc': 'text/asciidoc',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.kml': 'application/vnd.google-earth.kml+xml', '.kmz': 'application/vnd.google-earth.kmz',
  '.puml': 'text/x-plantuml', '.plantuml': 'text/x-plantuml', '.iuml': 'text/x-plantuml', '.pu': 'text/x-plantuml',
};

const TEXT_FORMATS = new Set(['text/markdown', 'text/asciidoc', 'text/x-plantuml', 'text/csv', 'text/tab-separated-values']);
