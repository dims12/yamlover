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
  /** A schema/meta attached inline via the `!!<…>` tag (yamlover) — a pointer to a schema
   *  def, e.g. `*yamlover/$defs/chapter`. Stored unresolved (see URIs.md / META.md). */
  schema?: Pointer;
}
export interface Span { uri: string; start: number; end: number; }

export interface Mapping {
  kind: 'mapping';
  entries: Entry[];
  // surface hint: written as a sequence ([..]) vs a mapping ({..}). The model is one
  // ordered container; this only aids round-trip and plain-JSON projection.
  array?: boolean;
  meta?: NodeMeta;
}

export interface Scalar {
  kind: 'scalar';
  value: string | number | boolean | null;
  raw: string; // verbatim source token (lossless round-trip)
  meta?: NodeMeta;
}

export interface Blob {
  kind: 'blob';
  format: string;
  contentHash: string;
  size: number;
  meta?: NodeMeta;
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

/** Project a pointer-free Node to a plain JS value (for JSON comparison / debugging). */
export function toPlain(node: Node): unknown {
  switch (node.kind) {
    case 'scalar':
      return node.value;
    case 'blob':
      throw new Error('toPlain: a blob has no plain JSON form');
    case 'mapping': {
      const isArr = node.array ?? (node.entries.length > 0 && node.entries.every((e) => e.key === null));
      if (isArr) return node.entries.map(entryPlain);
      const o: Record<string, unknown> = {};
      for (const e of node.entries) o[e.key ?? ''] = entryPlain(e);
      return o;
    }
  }
}

function entryPlain(e: Entry): unknown {
  if (isPointer(e.value)) throw new Error('toPlain: unresolved pointer has no plain form');
  return toPlain(e.value);
}
