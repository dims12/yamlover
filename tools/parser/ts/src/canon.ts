// Canonical IR — graph identity, not typography (IR.md, PLAN.md 2e).
//
// "IR-equal" compares the graph: values, entry order, keys, edge kinds, pointer
// base/steps, anchors, !!set, !!<…> schema — NOT scalar `raw`, comments, spans or
// layout, which serializers legitimately re-render. This is the single equality the
// round-trip tests and the test-examples fixture corpus assert against; `canonJson`
// is the only writer of a fixture's `ir.json` text, so goldens are format-stable
// by construction.

import type { Document, Entry, Node, Pointer, Value } from './ir.ts';
import { isPointer } from './ir.ts';

export function canonValue(v: Value): unknown {
  if (isPointer(v)) return canonPtr(v);
  return canonNode(v);
}

export function canonPtr(p: Pointer): unknown {
  // the dual window re-renders raws in colon form — identity is base + steps, not text
  return { ptr: { base: p.base, steps: p.steps } };
}

/** A deprecated `~` back entry with an absolute-scoped pointer is EQUIVALENT to a `&`
 *  path anchor (`~k: *P` ≡ `&P/k`, `~- *P` ≡ `&P[]`) — and the serializers emit the
 *  anchor form. Canon folds both authorings into one anchor set (semantic identity =
 *  base+steps+ordinal; raw differs between the spellings by construction). */
function convBack(e: Entry): boolean {
  return e.edge === 'back' && isPointer(e.value) &&
    ((e.value as Pointer).base.scope === 'document' || (e.value as Pointer).base.scope === 'link');
}

/** JSON cannot hold Infinity/NaN (stringify silently nulls them) or -0 (parses back as 0,
 *  which strict deepEqual distinguishes). Encode them as sentinel objects so `ir.json` is
 *  faithful; primitives pass through, and the sentinel cannot collide with a string value. */
function canonScalarValue(v: string | number | boolean | null): unknown {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $num: 'nan' };
    if (v === Infinity) return { $num: 'inf' };
    if (v === -Infinity) return { $num: '-inf' };
    if (Object.is(v, -0)) return { $num: '-0' };
  }
  return v;
}

export function canonNode(n: Node): unknown {
  const ents = n.entries ?? [];
  const anchors = [
    ...(n.meta?.anchors ?? []).map((a) => ({ base: a.path.base, steps: a.path.steps, ordinal: a.ordinal === true })),
    ...ents.filter(convBack).map((e) => {
      const p = e.value as Pointer;
      return e.key === null
        ? { base: p.base, steps: p.steps, ordinal: true }
        : { base: p.base, steps: [...p.steps, { sel: 'key' as const, name: e.key }], ordinal: false };
    }),
  ].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  // Build conditionally — no undefined-valued keys, so the result survives a JSON
  // round-trip unchanged (deepEqual(canonNode(x), JSON.parse(JSON.stringify(canonNode(x))))).
  const out: Record<string, unknown> = { kind: n.kind };
  if (n.kind === 'scalar') out.value = canonScalarValue(n.value);
  if (n.kind === 'blob') out.blob = { format: n.format, hash: n.contentHash, size: n.size };
  out.array = n.array === true;
  out.set = n.meta?.set === true;
  if (n.meta?.schema !== undefined) out.schema = canonValue(n.meta.schema);
  out.anchors = anchors;
  out.entries = ents.filter((e) => !convBack(e)).map((e) => ({ key: e.key, edge: e.edge, value: canonValue(e.value) }));
  return out;
}

export function canonDoc(d: Document): unknown {
  return { root: canonNode(d.root) };
}

/** The one writer of a fixture's `ir.json`: 2-space indent, LF, trailing newline. */
export function canonJson(d: Document): string {
  return JSON.stringify(canonDoc(d), null, 2) + '\n';
}
