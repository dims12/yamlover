// Shared bits for the IR → concrete serializers (PLAN.md 2d).

import type { Anchor, Entry, Pointer } from './ir.ts';
import { isPointer } from './ir.ts';
import { renderPointer } from './pointer.ts';

/** The target concrete cannot express this construct. The lossy policy (PLAN.md 2d) is
 *  REFUSE: a serializer never drops or silently rewrites graph data — route inexpressible
 *  metadata through the meta layer (META.md) or pick a fuller concrete instead. */
export class LossyError extends Error {}

/** The CANONICAL (colon-form, spaced) path text of an anchor token (after `&`):
 *  re-rendered from base+steps — the dual window emits `:` regardless of how the
 *  anchor was authored — plus the ordinal `[]`. */
export function anchorBody(a: Anchor): string {
  return renderPointer(a.path) + (a.ordinal ? '[]' : '');
}

/** Deprecated `~` back entries re-emit as `&` anchors (ANCHOR_REFACTOR; serializers emit
 *  anchors only) — but ONLY the absolute-scoped ones: an anchor path resolves from the
 *  node's CONTAINER while a back entry's pointer resolves from the node itself, so a
 *  current-/parent-scoped raw cannot be transplanted verbatim. Those (none in the corpus)
 *  keep the `~` spelling through the migration window. */
export function isAnchorizableBack(e: Entry): boolean {
  return e.edge === 'back' && isPointer(e.value) &&
    (e.value.base.scope === 'document' || e.value.base.scope === 'link');
}

/** The anchor-token body equivalent of a back entry, in canonical colon form:
 *  `~k: *P` → `P: k`, `~- *P` → `P[]`. */
export function backAnchorBody(e: Entry): string {
  if (!isPointer(e.value)) throw new LossyError('a back entry must hold a pointer');
  if (e.key === null) return renderPointer(e.value) + '[]';
  const withKey: Pointer = { ...e.value, steps: [...e.value.steps, { sel: 'key', name: e.key }] };
  return renderPointer(withKey);
}
