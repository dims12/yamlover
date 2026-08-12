// FLATTEN / DEFLATTEN — the doc→doc transforms of docs/language/flattening. Both are pure
// and META-ONLY: they stamp or strip the `yamlover/key/flat` entry concrete and never touch
// key/edge/value, so `canonDoc` equality across either is structural. `serializeYamlover`
// then does the actual spelling: a stamped chain emits as flat rows, a stripped one as the
// normalized nested form. What a flat row cannot spell — a decorated intermediate, a scalar
// self-value among fields, comments between segments, duplicate keys (whose second fold
// would PAVE into the first on reparse) — is left unstamped and stays nested, silently and
// losslessly (the serializer's canFold guard enforces the same list on emission).

import type { Document, Entry, Node, Value } from './ir.ts';
import { isPointer } from './ir.ts';

const FLAT = 'yamlover/key/flat';

/** May the entries of `v` be spelled as flat-row segments under their parent's prefix?
 *  (The serializer's canFold, minus the flat-mark requirement — flatten is what ADDS it.) */
function foldable(v: Value): v is Node & { kind: 'mapping' } {
  if (isPointer(v) || v.kind !== 'mapping') return false;
  const m = v.meta ?? {};
  if (m.schema !== undefined || m.set === true || m.yo === true || m.style !== undefined) return false;
  if ((m as { concrete?: string }).concrete !== undefined) return false;
  if ((m.anchors ?? []).length > 0 || (m.comments ?? []).length > 0) return false;
  const ents = v.entries ?? [];
  if (ents.length === 0) return false;
  const seen = new Set<string>();
  for (const e of ents) {
    if (e.nullKey === true || (e.edge !== 'contain' && e.edge !== 'ref')) return false;
    if ((e.meta?.comments ?? []).length > 0 || e.meta?.blankBefore === true) return false;
    if (e.key !== null) {
      if (seen.has(e.key)) return false;
      seen.add(e.key);
    }
  }
  return true;
}

/** Stamp the flat concrete through one container's children (they become segments of flat
 *  rows under the caller's prefix), recursing while the fold stays legal. */
function stamp(v: Node & { kind: 'mapping' }): void {
  for (const e of v.entries!) {
    e.meta = { ...e.meta, keyConcrete: FLAT };
    // the fold continues through foldable keyed children; everything else (a keyless
    // element's `-:` block, an unfoldable subtree) gets its own folds deeper down
    if (e.key !== null && foldable(e.value)) stamp(e.value);
    else descend(e.value);
  }
}

/** Walk PAST an unfoldable boundary: deeper containers get their own folds. */
function descend(v: Value): void {
  if (isPointer(v) || v.kind === 'blob') return;
  for (const e of v.entries ?? []) {
    if (e.key !== null && foldable(e.value)) stamp(e.value);
    else descend(e.value);
  }
}

/** FLATTEN: return the same document with every legally foldable chain stamped for flat
 *  emission — `serializeYamlover(flattenYamlover(doc))` is the fully flattened text. The
 *  input is not mutated. */
export function flattenYamlover(doc: Document): Document {
  const out = structuredClone(doc);
  descend(out.root);
  return out;
}

/** DEFLATTEN: strip every flat concrete — serialization yields the normalized nested form.
 *  The input is not mutated. */
export function deflattenYamlover(doc: Document): Document {
  const out = structuredClone(doc);
  const strip = (v: Value): void => {
    if (isPointer(v) || v.kind === 'blob') return;
    for (const e of v.entries ?? []) {
      if (e.meta?.keyConcrete !== undefined) {
        const { keyConcrete: _k, ...rest } = e.meta;
        e.meta = Object.keys(rest).length > 0 ? rest : undefined;
      }
      strip(e.value);
    }
  };
  strip(out.root);
  return out;
}
