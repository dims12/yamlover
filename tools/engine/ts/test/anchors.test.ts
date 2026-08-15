// Path anchors (docs/language/pointers/bookmarks) — the Phase A acceptance checks:
// the deprecated `~` forms and their `&` replacements produce IDENTICAL normalized
// edges (`~key: *P` ≡ `&P: key`, `~- *P` ≡ `&P: -`), an anchored scalar stays a scalar
// (anchors are not entries), and a dangling anchor is reported, never dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { buildGraph, normalize } from '../src/graph.ts';
import { resolveDocument } from '../src/resolve.ts';
import { Store } from '../src/store.ts';

function edges(src: string): string[] {
  return normalize(buildGraph(parseYamlover(src, 'x.yo')))
    .filter((e) => e.kind !== 'contain')
    .map((e) => `${e.from} --${e.label ?? '(keyless)'}--> ${e.to}`)
    .sort();
}

test('equivalence: ~key/~- and &P:key/&P: - normalize to the same edges (Chemical-Free shape)', () => {
  const tags = 'ontos:\n  field:\n    chemistry: Chemistry\n  genre:\n    satire: Satire\n';
  const viaBack =
    tags +
    'paper:\n' +
    '  ~chemical-free: *: ontos: field: chemistry\n' +
    '  ~chemical-free: *: ontos: genre: satire\n' +
    '  ~- *: ontos: field: chemistry\n';
  const viaAnchor =
    tags +
    'paper:\n' +
    '  &: ontos: field: chemistry: chemical-free\n' +
    '  &: ontos: genre: satire: chemical-free\n' +
    '  &: ontos: field: chemistry: -\n';
  assert.deepEqual(edges(viaAnchor), edges(viaBack));
  assert.ok(edges(viaAnchor).includes(':ontos:field:chemistry --chemical-free--> :paper'));
  assert.ok(edges(viaAnchor).includes(':ontos:field:chemistry --(keyless)--> :paper'));
});

test('the two-line tagged-scalar file: stays an integer in the store, back edge indexed', () => {
  // the root is one omni node: the `tags` field, the scalar value 30, and the membership
  const doc = parseYamlover('ontos:\n  whole: Whole numbers\n30\n&: ontos: whole: -\n', 'thirty.yo');
  const s = new Store(':memory:');
  s.indexDocument(doc);
  const root = s.node(':');
  assert.equal(root!.type, 'scalar');
  assert.equal(root!.value, 30);
  const ents = s.entries(':');
  assert.ok(ents.some((e) => e.kind === 'back' && e.to === ':ontos:whole' && e.label === null));
});

test('a dangling anchor is reported, never dropped', () => {
  const doc = parseYamlover('x: 1\n  &: nowhere: key\n', 'd.yo');
  const dangling = resolveDocument(doc).filter((r) => r.target.kind === 'unresolved');
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].raw, '&: nowhere: key');
  assert.equal(dangling[0].anchor, true);
});
