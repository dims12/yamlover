// Shared bits for the IR → concrete serializers (PLAN.md 2d).

import type { Document, Node } from './ir.ts';

/** The target concrete cannot express this construct. The lossy policy (PLAN.md 2d) is
 *  REFUSE: a serializer never drops or silently rewrites graph data — route inexpressible
 *  metadata through the meta layer (META.md) or pick a fuller concrete instead. */
export class LossyError extends Error {}

/** Anchor name by node identity, from `Document.anchors`. A node has ONE written location,
 *  so it can carry at most one `&` — two names on the same node cannot be serialized. */
export function anchorIndex(doc: Document): WeakMap<Node, string> {
  const byNode = new WeakMap<Node, string>();
  for (const [name, node] of doc.anchors) {
    const prev = byNode.get(node);
    if (prev !== undefined) {
      throw new LossyError(`anchors "&${prev}" and "&${name}" name the same node — a node's single written location fits one anchor`);
    }
    byNode.set(node, name);
  }
  return byNode;
}
