// Pointer resolver — turns an unresolved IR `Pointer` into the node it points at.
// Model & scopes: ../../../../URIs.md.  IR: ../../../parser/ts/src/ir.ts.
//
// - Containment is the spine; resolution walks it. Intermediate `*` edges are followed
//   transitively (cycle-safe). `~` back-edges resolve like `*` (their value is a Pointer).
// - Scopes: current (the mapping holding the pointer) · parent (`..`) · document (`/`,
//   the root) · link (`//auth`, an external virtual id — NOT resolved locally).
// - PATH anchors (URIs.md §`&`): `&P/k` on a node X means the container at `P` gains the
//   key `k` → X (an ordinal `&P[]` appends X keyless). Anchors are REAL keys: the resolver
//   realizes them as back-style edges and lets a `*` step traverse an anchor-created key.
//   There is no anchor namespace and no precedence rule — `*name` is pure path lookup.
//   (Anchor paths themselves resolve without anchor keys: no anchor-through-anchor in v1.)

import type { Document, Node, Pointer, Step, Anchor } from '../../../parser/ts/src/ir.ts';
import { isPointer } from '../../../parser/ts/src/ir.ts';

export type Located =
  | { kind: 'node'; node: Node; path: string }
  | { kind: 'external'; authority: string; steps: Step[] }
  | { kind: 'unresolved'; reason: string };

export interface ResolvedEdge {
  from: string;            // path of the entry holding the pointer
  holder: string;          // path of the mapping that holds it
  label: string | null;    // the entry's key (the relation name); null if keyless
  pos: number;             // the entry's index in the holder (so positional pointers keep order)
  raw: string;             // the pointer text (for an anchor edge: the whole `&…` token text)
  edge: 'ref' | 'back';
  target: Located;
  ptr: Pointer;            // the unresolved pointer itself: base, steps, raw — and its source span
  docRoot: string;         // path of the holder's nearest enclosing DOCUMENT root (its `/` scope)
  /** True for an edge realized from a `&` path anchor (NodeMeta.anchors), not an entry.
   *  `mv` cannot rewrite these yet (PLAN.md A4) — planRewrites reports them instead. */
  anchor?: boolean;
}

/** Anchor-created keys per container node — `&P/k` declarations realized, so a `*` step
 *  can traverse a key that exists only as an anchor. */
type AnchorKeys = Map<Node, Map<string, Node>>;

interface AnchorEdge { node: Node; chain: Node[]; anchor: Anchor; idx: number; target: Located }

/** Resolve every `*`/`~` pointer in a document — and realize every `&` anchor; useful for
 *  tests, graph building, and indexing (the store ingests anchor edges like `~` ones). */
export function resolveDocument(doc: Document): ResolvedEdge[] {
  const chains = buildChains(doc.root);
  const { edges: anchorEdges, keys } = realizeAnchors(doc, chains);
  const out: ResolvedEdge[] = [];
  const walk = (node: Node, docRoot: string): void => {
    if (!node.entries && !node.meta?.anchors) return;
    const chain = chains.get(node)!;
    const base = pathOf(chain);
    const dr = node.meta?.documentRoot ? base : docRoot;
    const prefix = base === ':' ? '' : base; // root is ':', so a top-level entry is ":key" not "::key"
    node.entries?.forEach((e, i) => {
      const seg = e.key != null ? ':' + e.key : '[' + i + ']';
      if (isPointer(e.value)) {
        const target = resolve(doc, chains, chain, e.value, new Set([e.value]), keys);
        out.push({ from: prefix + seg, holder: base, label: e.key, pos: i, raw: e.value.raw, edge: e.edge as 'ref' | 'back', target, ptr: e.value, docRoot: dr });
      } else {
        walk(e.value, dr);
      }
    });
    // the node's anchors, realized as back-style edges (owner = the anchored node, target =
    // the container that gains the key/member) — the exact shape a `~` entry produces, so
    // the store/graph/node-kind machinery treats both alike
    for (const ae of anchorEdges) {
      if (ae.node !== node) continue;
      const raw = '&' + ae.anchor.path.raw + (ae.anchor.ordinal ? '[]' : '');
      out.push({
        from: base, holder: base, label: anchorKeyOf(ae.anchor), pos: (node.entries?.length ?? 0) + ae.idx,
        raw, edge: 'back', target: ae.target, ptr: ae.anchor.path, docRoot: dr, anchor: true,
      });
    }
  };
  walk(doc.root, ':');
  return out;
}

/** Resolve a single pointer, given the chain (root..node) of the mapping that holds it. */
export function resolvePointer(doc: Document, fromChain: Node[], ptr: Pointer): Located {
  const chains = buildChains(doc.root);
  const { keys } = realizeAnchors(doc, chains);
  return resolve(doc, chains, fromChain, ptr, new Set([ptr]), keys);
}

/** The key a keyed anchor's container gains (the path's last step); null for ordinal. */
function anchorKeyOf(a: Anchor): string | null {
  return a.ordinal ? null : lastKey(a.path);
}

function lastKey(p: Pointer): string | null {
  const last = p.steps[p.steps.length - 1];
  return last && last.sel === 'key' ? last.name : null;
}

/** Realize every anchor: resolve its CONTAINER (the path minus the last step for keyed;
 *  the whole path for ordinal) from the anchored node's parent chain, and index the keyed
 *  ones so step lookup can traverse anchor-created keys. */
function realizeAnchors(doc: Document, chains: Map<Node, Node[]>): { edges: AnchorEdge[]; keys: AnchorKeys } {
  const edges: AnchorEdge[] = [];
  const keys: AnchorKeys = new Map();
  for (const [node, chain] of chains) {
    const anchors = node.meta?.anchors;
    if (!anchors) continue;
    anchors.forEach((a, idx) => {
      const fromChain = chain.slice(0, -1); // anchor paths resolve from the node's CONTAINER
      const containerPtr: Pointer = a.ordinal ? a.path : { ...a.path, steps: a.path.steps.slice(0, -1) };
      let target: Located;
      if (fromChain.length === 0 && (containerPtr.base.scope === 'current' || containerPtr.base.scope === 'parent')) {
        target = { kind: 'unresolved', reason: 'a relative anchor on the document root has no container' };
      } else {
        target = resolve(doc, chains, fromChain.length > 0 ? fromChain : [doc.root], containerPtr, new Set([containerPtr]));
      }
      edges.push({ node, chain, anchor: a, idx, target });
      if (!a.ordinal && target.kind === 'node') {
        const k = lastKey(a.path);
        if (k !== null) {
          let m = keys.get(target.node);
          if (!m) { m = new Map(); keys.set(target.node, m); }
          if (!m.has(k)) m.set(k, node); // first declaration wins; conflicts surface via the store
        }
      }
    });
  }
  return { edges, keys };
}

function resolve(doc: Document, chains: Map<Node, Node[]>, fromChain: Node[], ptr: Pointer, visited: Set<Pointer>, anchorKeys?: AnchorKeys): Located {
  const root = doc.root;
  let steps: Step[] = ptr.steps;
  let chain: Node[];
  const linkAuthority = ptr.base.scope === 'link' ? ptr.base.authority : '';
  // Only the `:::` WORLD form (URIs.md: a cross-authority URI) may reference content outside the
  // loaded tree — a miss there is a legitimate external reference, not a bug. A plain `::` link is
  // project-internal, so a miss is a DANGLING typo and must be flagged, not silently dropped.
  const isWorld = ptr.base.scope === 'link' && ptr.base.world === true;
  const external = (): Located => ({ kind: 'external', authority: linkAuthority, steps: ptr.steps });

  switch (ptr.base.scope) {
    case 'link': {
      // `::authority:…` is PROJECT-root relative (URIs.md: `:`=document, `::`=project): resolve
      // `authority` + steps from the top-level (served) document root. A plain `::` link is always
      // intra-project (e.g. an annotation → its material), so a miss is DANGLING. Only the `:::`
      // world form (`isWorld`) may name a genuine external authority and stay external on a miss.
      chain = chains.get(root) ?? [root];
      // SELF-IMPORT (SEPARATOR.md §2): inside the yamlover project `::X` ≡ `::yamlover:X`. When the
      // served root IS the project, the `yamlover` self-import is DE-MATERIALIZED (walk.ts) — there
      // is no `yamlover` node — so absorb the authority: resolve the steps straight from the project
      // root, landing on the REAL `:tags:…` / `:$defs:…`, not a graft duplicate. When a `yamlover`
      // node DOES exist (a served subdir, or a foreign dir's built-in graft) it is stepped into.
      const selfImport = ptr.base.authority === 'yamlover' && !root.entries?.some((e) => e.key === 'yamlover');
      steps = selfImport ? ptr.steps : [{ sel: 'key', name: ptr.base.authority }, ...ptr.steps];
      break;
    }
    case 'document': {
      // the nearest enclosing DOCUMENT root (a parsed file / a `.yamlover` dir / the served
      // root), so `/file` is relative to the chapter (or other instance) it sits in — not the
      // whole served tree. Falls back to the overall root when nothing in the chain is marked.
      let docRoot = root;
      for (let k = fromChain.length - 1; k >= 0; k--) {
        if (fromChain[k].meta?.documentRoot) { docRoot = fromChain[k]; break; }
      }
      chain = chains.get(docRoot) ?? [docRoot];
      break;
    }
    case 'parent':
      chain = fromChain.slice(0, -1);
      break;
    case 'current':
      chain = fromChain; // pure path lookup — no anchor namespace, no precedence
      break;
  }

  for (const st of steps) {
    if (st.sel === 'parent') {
      if (chain.length <= 1) return isWorld ? external() : { kind: 'unresolved', reason: '".." above the document root' };
      chain = chain.slice(0, -1);
      continue;
    }
    const node = chain[chain.length - 1];
    if (node === undefined) return { kind: 'unresolved', reason: 'empty resolution scope' };
    const entry = st.sel === 'key'
      ? node.entries?.find((e) => e.key === st.name)
      : node.entries?.[st.n];
    if (!entry) {
      // a key that exists only as a `&` anchor-created entry (anchors are real keys)
      if (st.sel === 'key') {
        const via = anchorKeys?.get(node)?.get(st.name);
        if (via) { chain = chains.get(via) ?? [via]; continue; }
      }
      if (!node.entries) return isWorld ? external() : { kind: 'unresolved', reason: 'step into a node with no fields' };
      return isWorld ? external() : { kind: 'unresolved', reason: `no ${st.sel === 'key' ? `key "${st.name}"` : `index [${st.n}]`}` };
    }

    if (isPointer(entry.value)) {
      if (visited.has(entry.value)) return { kind: 'unresolved', reason: 'pointer cycle' };
      const next = new Set(visited);
      next.add(entry.value);
      const r = resolve(doc, chains, chain, entry.value, next, anchorKeys);
      if (r.kind !== 'node') return r; // external/unresolved propagates
      chain = chains.get(r.node) ?? [r.node];
    } else {
      chain = chains.get(entry.value) ?? [...chain, entry.value];
    }
  }

  const target = chain[chain.length - 1];
  return { kind: 'node', node: target, path: pathOf(chain) };
}

/** Map every owned (containment) node to its chain root..node. Pointers are skipped. */
function buildChains(root: Node): Map<Node, Node[]> {
  const m = new Map<Node, Node[]>();
  const walk = (node: Node, chain: Node[]): void => {
    const c = [...chain, node];
    m.set(node, c);
    if (node.entries) {
      for (const e of node.entries) if (!isPointer(e.value)) walk(e.value, c);
    }
  };
  walk(root, []);
  return m;
}

/** A readable path for a chain, e.g. ":pets[1]:name" ([n] for keyless/positional). */
export function pathOf(chain: Node[]): string {
  let s = '';
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i - 1];
    if (!parent.entries) { s += ':?'; continue; }
    const idx = parent.entries.findIndex((e) => e.value === chain[i]);
    const e = parent.entries[idx];
    s += e && e.key != null ? ':' + e.key : '[' + idx + ']';
  }
  return s === '' ? ':' : s;
}
