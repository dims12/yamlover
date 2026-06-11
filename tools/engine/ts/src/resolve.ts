// Pointer resolver — turns an unresolved IR `Pointer` into the node it points at.
// Model & scopes: ../../../../URIs.md.  IR: ../../../parser/ts/src/ir.ts.
//
// - Containment is the spine; resolution walks it. Intermediate `*` edges are followed
//   transitively (cycle-safe). `~` back-edges resolve like `*` (their value is a Pointer).
// - Scopes: current (the mapping holding the pointer) · parent (`..`) · document (`/`,
//   the root) · link (`//auth`, an external virtual id — NOT resolved locally).
// - Anchor precedence (URIs.md): a current-scope `*name` whose first step names a declared
//   `&` anchor resolves to that anchor, beating a sibling key.

import type { Document, Node, Mapping, Pointer, Step } from '../../../parser/ts/src/ir.ts';
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
  raw: string;             // the pointer text
  edge: 'ref' | 'back';
  target: Located;
  ptr: Pointer;            // the unresolved pointer itself: base, steps, raw — and its source span
  docRoot: string;         // path of the holder's nearest enclosing DOCUMENT root (its `/` scope)
}

/** Resolve every `*`/`~` pointer in a document; useful for tests and graph building. */
export function resolveDocument(doc: Document): ResolvedEdge[] {
  const chains = buildChains(doc.root);
  const out: ResolvedEdge[] = [];
  const walk = (node: Node, docRoot: string): void => {
    if (!node.entries) return; // any node may carry fields (scalar/blob too)
    const chain = chains.get(node)!;
    const base = pathOf(chain);
    const dr = node.meta?.documentRoot ? base : docRoot;
    const prefix = base === '/' ? '' : base; // root is '/', so a top-level entry is "/key" not "//key"
    node.entries.forEach((e, i) => {
      const seg = e.key != null ? '/' + e.key : '[' + i + ']';
      if (isPointer(e.value)) {
        const target = resolve(doc, chains, chain, e.value, new Set([e.value]));
        out.push({ from: prefix + seg, holder: base, label: e.key, pos: i, raw: e.value.raw, edge: e.edge as 'ref' | 'back', target, ptr: e.value, docRoot: dr });
      } else {
        walk(e.value, dr);
      }
    });
  };
  walk(doc.root, '/');
  return out;
}

/** Resolve a single pointer, given the chain (root..node) of the mapping that holds it. */
export function resolvePointer(doc: Document, fromChain: Node[], ptr: Pointer): Located {
  return resolve(doc, buildChains(doc.root), fromChain, ptr, new Set([ptr]));
}

function resolve(doc: Document, chains: Map<Node, Node[]>, fromChain: Node[], ptr: Pointer, visited: Set<Pointer>): Located {
  const root = doc.root;
  let steps: Step[] = ptr.steps;
  let chain: Node[];
  const linkAuthority = ptr.base.scope === 'link' ? ptr.base.authority : '';
  let isLink = false; // a `//…` whose first segment names a project node resolves; else external
  const external = (): Located => ({ kind: 'external', authority: linkAuthority, steps: ptr.steps });

  switch (ptr.base.scope) {
    case 'link': {
      // `//authority/…` is PROJECT-root relative (URIs.md: `/`=document, `//`=project): resolve
      // `authority` + steps from the top-level (served) document root. If it lands on a node it is
      // an intra-project link (e.g. an annotation → its material); otherwise it is a genuine
      // external reference (a real host/scheme) and stays external.
      isLink = true;
      chain = chains.get(root) ?? [root];
      steps = [{ sel: 'key', name: ptr.base.authority }, ...ptr.steps];
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
    case 'current': {
      const s0 = ptr.steps[0];
      if (s0 && s0.sel === 'key' && doc.anchors.has(s0.name)) {
        const anchored = doc.anchors.get(s0.name)!; // anchor wins over a sibling key
        chain = chains.get(anchored) ?? [anchored];
        steps = ptr.steps.slice(1);
      } else {
        chain = fromChain;
      }
      break;
    }
  }

  for (const st of steps) {
    if (st.sel === 'parent') {
      if (chain.length <= 1) return isLink ? external() : { kind: 'unresolved', reason: '".." above the document root' };
      chain = chain.slice(0, -1);
      continue;
    }
    const node = chain[chain.length - 1];
    if (!node.entries) return isLink ? external() : { kind: 'unresolved', reason: 'step into a node with no fields' };
    const entry = st.sel === 'key'
      ? node.entries.find((e) => e.key === st.name)
      : node.entries[st.n];
    if (!entry) return isLink ? external() : { kind: 'unresolved', reason: `no ${st.sel === 'key' ? `key "${st.name}"` : `index [${st.n}]`}` };

    if (isPointer(entry.value)) {
      if (visited.has(entry.value)) return { kind: 'unresolved', reason: 'pointer cycle' };
      const next = new Set(visited);
      next.add(entry.value);
      const r = resolve(doc, chains, chain, entry.value, next);
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

/** A readable path for a chain, e.g. "/pets[1]/name" ([n] for keyless/positional). */
export function pathOf(chain: Node[]): string {
  let s = '';
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i - 1];
    if (!parent.entries) { s += '/?'; continue; }
    const idx = parent.entries.findIndex((e) => e.value === chain[i]);
    const e = parent.entries[idx];
    s += e && e.key != null ? '/' + e.key : '[' + idx + ']';
  }
  return s === '' ? '/' : s;
}
