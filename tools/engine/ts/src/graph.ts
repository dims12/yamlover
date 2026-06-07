// Graph view over a resolved document: a flat edge list (containment + resolved `*`/`~`),
// plus on-demand inverse derivation and `normalize` (→ forwards-only). See ../../../URIs.md
// ("~ — reverse edges": graph kept as written; normalize reduces to forwards-only) and
// ../../../ENGINE.md (the node/edge model this mirrors).

import type { Document } from '../../../parser/ts/src/ir.ts';
import type { Node } from '../../../parser/ts/src/ir.ts';
import { isPointer } from '../../../parser/ts/src/ir.ts';
import { resolveDocument } from './resolve.ts';

export type EdgeKind = 'contain' | 'ref' | 'back' | 'derived';

export interface Edge {
  from: string;          // source node path
  to: string;            // target node path
  label: string | null;  // relation name (the entry key); null for keyless/positional
  kind: EdgeKind;
}

export interface Graph {
  edges: Edge[];                                              // contain + resolved ref/back
  external: { from: string; raw: string; authority: string }[]; // links (not resolved locally)
  unresolved: { from: string; raw: string; reason: string }[];  // dangling pointers
}

/** Build the edge list for a document: containment spine + every resolved `*`/`~` edge. */
export function buildGraph(doc: Document): Graph {
  const edges: Edge[] = [];
  const external: Graph['external'] = [];
  const unresolved: Graph['unresolved'] = [];

  const walk = (node: Node, path: string): void => {
    if (node.kind !== 'mapping') return;
    node.entries.forEach((e, i) => {
      if (isPointer(e.value)) return; // pointers handled below, via the resolver
      const childPath = (path === '/' ? '' : path) + (e.key != null ? '/' + e.key : '[' + i + ']');
      edges.push({ from: path, to: childPath, label: e.key, kind: 'contain' });
      walk(e.value, childPath);
    });
  };
  walk(doc.root, '/');

  for (const r of resolveDocument(doc)) {
    if (r.target.kind === 'node') edges.push({ from: r.holder, to: r.target.path, label: r.label, kind: r.edge });
    else if (r.target.kind === 'external') external.push({ from: r.from, raw: r.raw, authority: r.target.authority });
    else unresolved.push({ from: r.from, raw: r.raw, reason: r.target.reason });
  }
  return { edges, external, unresolved };
}

/**
 * Derive inverse edges on demand (kind `derived`): for every forward `ref`/`back` edge,
 * the reverse direction — so you can ask "what points at this node?". Returned as a new
 * list (originals + derived); never mutates.
 */
export function deriveInverses(g: Graph): Edge[] {
  const derived: Edge[] = [];
  for (const e of g.edges) {
    if (e.kind === 'ref' || e.kind === 'back') {
      derived.push({ from: e.to, to: e.from, label: e.label, kind: 'derived' });
    }
  }
  return [...g.edges, ...derived];
}

/**
 * Normalize to a **forwards-only** edge set (the `normalize` command): keep containment
 * and forward `ref` edges; fold every `~` back-edge into the forward `ref` it is the
 * reverse of (`B --~L--> A`  means  `A --L--> B`), de-duplicating against existing refs.
 * The result has no `back` (or `derived`) edges.
 */
export function normalize(g: Graph): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  const key = (e: Edge): string => `${e.from}\t${e.label}\t${e.to}`;

  for (const e of g.edges) if (e.kind === 'contain') out.push(e);
  for (const e of g.edges) {
    if (e.kind !== 'ref') continue;
    if (!seen.has(key(e))) { seen.add(key(e)); out.push(e); }
  }
  for (const e of g.edges) {
    if (e.kind !== 'back') continue;
    const fwd: Edge = { from: e.to, to: e.from, label: e.label, kind: 'ref' };
    if (!seen.has(key(fwd))) { seen.add(key(fwd)); out.push(fwd); }
  }
  return out;
}

/** Edges arriving at a node path (use over `deriveInverses(g)` or any edge list). */
export function edgesInto(edges: Edge[], path: string): Edge[] {
  return edges.filter((e) => e.to === path);
}

/** Edges leaving a node path. */
export function edgesFrom(edges: Edge[], path: string): Edge[] {
  return edges.filter((e) => e.from === path);
}
