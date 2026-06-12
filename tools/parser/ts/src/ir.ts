// The yamlover instance-graph IR. Normative spec: IR.md
//
// Parsers (json5p, yamlover) emit a Document; the engine consumes it. Pointers are
// stored UNRESOLVED (the engine resolves lazily). Positions are the array index of an
// entry — derived, not double-stored.

export interface Document {
  root: Node;
  source: SourceInfo;
}

export interface SourceInfo {
  concrete: 'json5p' | 'yamlover' | 'yaml' | 'json' | 'directory';
  uri: string;
}

export type Node = Mapping | Scalar | Blob;

export interface NodeMeta {
  span?: Span;
  /** Path anchors (`&P/k` / `&P[]`, URIs.md §`&`): this node ALSO lives at that path —
   *  the container at the path's parent gains an entry (the last segment as key; a
   *  positional member for `[]`) that is a ref edge to this node. Anchors are NOT
   *  entries: they never count toward the node's kind. Realized by the resolver. */
  anchors?: Anchor[];
  /** A schema/meta attached via the `!!<…>` tag (yamlover). Its contents are themselves
   *  yamlover, so the schema is any Value: a Pointer to a hosted schema
   *  (`!!<*yamlover/$defs/chapter>`) OR an inline schema Node (`!!<format: text/x-plantuml>`).
   *  Stored unresolved (see URIs.md / META.md). */
  schema?: Value;
  /** This node is a DOCUMENT root — a self-contained instance: a parsed file, a directory with
   *  a `.yamlover/` overlay, or the served root. The `/` pointer scope resolves to the nearest
   *  enclosing such node (URIs.md: `/` = document root), so a reference is depth-independent. */
  documentRoot?: boolean;
  /** SET semantics (`!!set` tag / `uniqueItems: true` in meta): an element appears at most
   *  once, so duplicate memberships — forward+forward, forward+`~-` reverse, reverse+reverse —
   *  collapse to one (URIs.md §`~-`). Unlike `!!mix`/`!!omni` (parse permissions visible in the
   *  node's shape), this must survive into the graph. */
  set?: boolean;
}
export interface Span { uri: string; start: number; end: number; }

/** One `&` path-anchor declaration (URIs.md §`&`). For a keyed anchor the path's LAST
 *  step is the key the target container gains; an ordinal anchor (`&path[]`) points at
 *  the container itself and appends a keyless member. `path.span` covers the whole
 *  `&…` token; `path.raw` is the authored path text (without the trailing `[]`). */
export interface Anchor {
  path: Pointer;
  /** True for `&path[]` — keyless appended membership. */
  ordinal?: boolean;
}

/**
 * Every node may carry, INDEPENDENTLY of its `kind`:
 *  - `entries`: ordered fields — keyless (positional) and/or keyed — the "one ordered
 *    container". So a Scalar or Blob can ALSO have fields: a node is *value + fields*, and a
 *    single node can be at once a scalar, partially positioned, and partially keyed.
 *  - `array`: projection hint (true ⇒ all-keyless, a pure sequence).
 * A pure scalar/mapping/blob is the degenerate case (only a value, or only entries).
 */
export interface NodeBase {
  entries?: Entry[];
  array?: boolean;
  meta?: NodeMeta;
}

export interface Mapping extends NodeBase {
  kind: 'mapping';
  entries: Entry[]; // a mapping's defining trait: it always has the ordered container
}

export interface Scalar extends NodeBase {
  kind: 'scalar';
  value: string | number | boolean | null;
  raw: string; // verbatim source token (lossless round-trip)
}

export interface Blob extends NodeBase {
  kind: 'blob';
  format: string;
  /** Content hash (`xxh64:…`), or null when the bytes have not been hashed yet — a large
   *  blob's identity is (path, size, mtime); the engine's background hasher fills this in. */
  contentHash: string | null;
  size: number;
}

export type EdgeKind = 'contain' | 'ref' | 'back';

export interface Entry {
  key: string | null; // string key, or null for a keyless ( ":" / "- " ) entry
  edge: EdgeKind;
  value: Value;
  meta?: EntryMeta;
}
export interface EntryMeta { span?: Span; } // span: not yet populated (pointer spans first)

export type Value = Node | Pointer; // Node iff edge==='contain'; Pointer iff ref/back

export interface Pointer {
  kind: 'pointer';
  base: PointerBase;
  steps: Step[];
  raw: string; // verbatim pointer text after `*` (round-trip + diagnostics)
  /** Source extent of the WHOLE deref token — from the `*` sigil through the end of the
   *  (possibly quoted) pointer text — as absolute offsets into `span.uri`. Filled by the
   *  parsers; the engine's `mv` rewrites exactly this range (surgical, format-preserving). */
  span?: Span;
}

export type PointerBase =
  | { scope: 'current' }                       // bare name/index: current mapping
  | { scope: 'document' }                       // ":" (legacy "/") — current document root
  | { scope: 'parent' }                         // ".." — parent node (then steps)
  /** "::" (legacy "//") — project scope: authority = the first portion, resolved as a
   *  root key (an import or a mounted authority), else external. `world: true` marks
   *  the ":::"-spelled WORLD scope (an AWS-like project URI, SEPARATOR.md §2) — same
   *  resolution semantics in v1, kept so re-emission preserves the ladder rung. */
  | { scope: 'link'; authority: string; world?: boolean };

export type Step =
  | { sel: 'key'; name: string }                // /x  — string key
  | { sel: 'index'; n: number }                 // [n] — integer key (position)
  | { sel: 'parent' };                          // ..  — up one node

export function isPointer(v: Value): v is Pointer {
  return (v as Pointer).kind === 'pointer';
}

/** Project a pointer-free Node to a plain JS value (for JSON comparison / debugging).
 *  A node with both a scalar value and fields projects to an object with the self-value under
 *  the reserved `$value` key; keyless entries project under their integer position. */
export function toPlain(node: Node): unknown {
  const ents = node.entries ?? [];
  if (ents.length === 0) {
    if (node.kind === 'scalar') return node.value;
    if (node.kind === 'blob') throw new Error('toPlain: a blob has no plain JSON form');
    return node.array ? [] : {}; // empty array vs empty mapping (keep the projection hint)
  }
  // pure sequence (a mapping projected as an array): all-keyless and no scalar self-value
  if (node.kind === 'mapping' && (node.array ?? ents.every((e) => e.key === null))) {
    return ents.map(entryPlain);
  }
  // object: keyed entries by key, keyless by position; a scalar self-value under $value
  const o: Record<string, unknown> = {};
  if (node.kind === 'scalar') o.$value = node.value;
  ents.forEach((e, i) => { o[e.key ?? String(i)] = entryPlain(e); });
  return o;
}

function entryPlain(e: Entry): unknown {
  if (isPointer(e.value)) throw new Error('toPlain: unresolved pointer has no plain form');
  return toPlain(e.value);
}
