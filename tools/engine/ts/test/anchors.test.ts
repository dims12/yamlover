// Path anchors (URIs.md §`&`, ANCHOR_REFACTOR.md) — the Phase A acceptance checks:
// the deprecated `~` forms and their `&` replacements produce IDENTICAL normalized
// edges (`~key: *P` ≡ `&P/key`, `~- *P` ≡ `&P[]`), an anchored scalar stays a scalar
// (anchors are not entries), and a dangling anchor is reported, never dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { buildGraph, normalize } from '../src/graph.ts';
import { resolveDocument } from '../src/resolve.ts';
import { Store } from '../src/store.ts';

function edges(src: string): string[] {
  return normalize(buildGraph(parseYamlover(src, 'x.yamlover')))
    .filter((e) => e.kind !== 'contain')
    .map((e) => `${e.from} --${e.label ?? '[]'}--> ${e.to}`)
    .sort();
}

test('equivalence: ~key/~- and &P/key/&P[] normalize to the same edges (Chemical-Free shape)', () => {
  const tags = 'tags:\n  field:\n    chemistry: Chemistry\n  genre:\n    satire: Satire\n';
  const viaBack =
    tags +
    'paper:\n' +
    '  ~chemical-free: */tags/field/chemistry\n' +
    '  ~chemical-free: */tags/genre/satire\n' +
    '  ~- */tags/field/chemistry\n';
  const viaAnchor =
    tags +
    'paper:\n' +
    '  &/tags/field/chemistry/chemical-free\n' +
    '  &/tags/genre/satire/chemical-free\n' +
    '  &/tags/field/chemistry[]\n';
  assert.deepEqual(edges(viaAnchor), edges(viaBack));
  assert.ok(edges(viaAnchor).includes(':tags:field:chemistry --chemical-free--> :paper'));
  assert.ok(edges(viaAnchor).includes(':tags:field:chemistry --[]--> :paper'));
});

test('the two-line tagged-scalar file: stays an integer in the store, back edge indexed', () => {
  // the root is one omni node: the `tags` field, the scalar value 30, and the membership
  const doc = parseYamlover('tags:\n  whole: Whole numbers\n30\n&/tags/whole[]\n', 'thirty.yamlover');
  const s = new Store(':memory:');
  s.indexDocument(doc);
  const root = s.node(':');
  assert.equal(root!.type, 'scalar');
  assert.equal(root!.value, 30);
  const ents = s.entries(':');
  assert.ok(ents.some((e) => e.kind === 'back' && e.to === ':tags:whole' && e.label === null));
});

test('a dangling anchor is reported, never dropped', () => {
  const doc = parseYamlover('x: 1\n  &/nowhere/key\n', 'd.yamlover');
  const dangling = resolveDocument(doc).filter((r) => r.target.kind === 'unresolved');
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].raw, '&/nowhere/key');
  assert.equal(dangling[0].anchor, true);
});
