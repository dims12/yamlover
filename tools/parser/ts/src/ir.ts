// The yamlover instance-graph IR. Normative spec: IR.md
//
// Parsers (json5p, yamlover) emit a Document; the engine consumes it. Pointers are
// stored UNRESOLVED (the engine resolves lazily). Positions are the array index of an
// entry — derived, not double-stored.

export interface Document {
  root: Node;
  anchors: Map<string, Node>; // & declarations in this document (intra-doc)
  source: SourceInfo;
}

export interface SourceInfo {
  concrete: 'json5p' | 'yamlover' | 'yaml' | 'json' | 'directory';
  uri: string;
}

export type Node = Mapping | Scalar | Blob;

export interface NodeMeta {
  span?: Span;
  /** A schema/meta attached via the `!!<…>` tag (yamlover). Its contents are themselves
   *  yamlover, so the schema is any Value: a Pointer to a hosted schema
   *  (`!!<*yamlover/$defs/chapter>`) OR an inline schema Node (`!!<format: text/x-plantuml>`).
   *  Stored unresolved (see URIs.md / META.md). */
  schema?: Value;
  /** This node is a DOCUMENT root — a self-contained instance: a parsed file, a directory with
   *  a `.yamlover/` overlay, or the served root. The `/` pointer scope resolves to the nearest
   *  enclosing such node (URIs.md: `/` = document root), so a reference is depth-independent. */
  documentRoot?: boolean;
}
export interface Span { uri: string; start: number; end: number; }

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
  contentHash: string;
  size: number;
}

export type EdgeKind = 'contain' | 'ref' | 'back';

export interface Entry {
  key: string | null; // string key, or null for a keyless ( ":" / "- " ) entry
  edge: EdgeKind;
  value: Value;
  meta?: EntryMeta;
}
export interface EntryMeta { span?: Span; anchor?: string; }

export type Value = Node | Pointer; // Node iff edge==='contain'; Pointer iff ref/back

export interface Pointer {
  kind: 'pointer';
  base: PointerBase;
  steps: Step[];
  raw: string; // verbatim pointer text after `*` (round-trip + diagnostics)
}

export type PointerBase =
  | { scope: 'current' }                       // bare name/index: current mapping
  | { scope: 'document' }                       // "/"  — current document root
  | { scope: 'parent' }                         // ".." — parent node (then steps)
  | { scope: 'link'; authority: string };       // [scheme]"//"authority — any other start

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
