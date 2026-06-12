import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJson5p } from '../../../parser/ts/src/json5p.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { buildGraph, deriveInverses, normalize, edgesInto, edgesFrom } from '../src/graph.ts';
import type { Edge } from '../src/graph.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', '..', 'examples');

const has = (edges: Edge[], e: Partial<Edge>) =>
  edges.some((x) => (e.from === undefined || x.from === e.from) && (e.to === undefined || x.to === e.to) &&
    (e.label === undefined || x.label === e.label) && (e.kind === undefined || x.kind === e.kind));

test('buildGraph: containment + resolved ref/back edges', () => {
  const g = buildGraph(parseJson5p(readFileSync(join(examples, '03-tour.json5p'), 'utf8')));
  // containment
  assert.ok(has(g.edges, { from: ':', to: ':pets', label: 'pets', kind: 'contain' }));
  assert.ok(has(g.edges, { from: ':pets', to: ':pets[1]', kind: 'contain' }));
  // a forward ref: feline -> /pets[1]
  assert.ok(has(g.edges, { from: ':', to: ':pets[1]', label: 'feline', kind: 'ref' }));
  // the back-edge sits on /adam/cain, pointing to /eve, label cain
  assert.ok(has(g.edges, { from: ':adam:cain', to: ':eve', label: 'cain', kind: 'back' }));
});

test('external links and unresolved are separated out', () => {
  const g = buildGraph(parseJson5p(`{ wild: *'//pet.store.com/pets', bad: *'nope' }`));
  assert.equal(g.external.length, 1);
  assert.equal(g.external[0].authority, 'pet.store.com');
  assert.equal(g.unresolved.length, 1);
});

test('incoming refs are queryable; deriveInverses exposes them from the target', () => {
  const g = buildGraph(parseJson5p(readFileSync(join(examples, '03-tour.json5p'), 'utf8')));
  // forward refs already arrive at the node:
  const incoming = edgesInto(g.edges, ':pets[1]').filter((e) => e.kind === 'ref').map((e) => e.label).sort();
  assert.deepEqual(incoming, ['feline', 'manager', 'secondPet']);
  // ...and deriveInverses re-expresses them as edges FROM the node (kind 'derived'):
  const derived = edgesFrom(deriveInverses(g), ':pets[1]').filter((e) => e.kind === 'derived').map((e) => e.label).sort();
  assert.deepEqual(derived, ['feline', 'manager', 'secondPet']);
});

test('normalize: ~ back-edge folds into the forward ref, deduped, no back/derived left', () => {
  const g = buildGraph(parseJson5p(readFileSync(join(examples, '03-tour.json5p'), 'utf8')));
  const n = normalize(g);
  assert.equal(n.filter((e) => e.kind === 'back' || e.kind === 'derived').length, 0);
  // eve --cain--> /adam/cain appears exactly once (explicit forward + folded back-edge deduped)
  const cain = n.filter((e) => e.label === 'cain' && e.from === ':eve' && e.to === ':adam:cain');
  assert.equal(cain.length, 1);
  assert.equal(cain[0].kind, 'ref');
});

test('normalize folds a lone back-edge into a new forward ref', () => {
  // only the back-edge present (no explicit forward eve.cain)
  const g = buildGraph(parseJson5p(`{ eve: {}, adam: { cain: { ~cain: *':eve' } } }`));
  const n = normalize(g);
  assert.ok(n.some((e) => e.from === ':eve' && e.to === ':adam:cain' && e.label === 'cain' && e.kind === 'ref'));
  assert.equal(n.filter((e) => e.kind === 'back').length, 0);
});

test('yamlover and json5p agree on the shared normalized edges (06 vs 03)', () => {
  // The two tour files share the same data except their escaping demos, so compare a
  // shared subset of normalized forward edges.
  const fmt = (src: string, p: (s: string) => any) =>
    new Set(normalize(buildGraph(p(src))).map((e) => `${e.from} -${e.label}-> ${e.to}`));
  const j = fmt(readFileSync(join(examples, '03-tour.json5p'), 'utf8'), parseJson5p);
  const y = fmt(readFileSync(join(examples, '06-tour.yamlover'), 'utf8'), parseYamlover);
  const shared = [
    ': -feline-> :pets[1]',
    ': -topDog-> :pets[0]',
    ':humans[0] -manager-> :pets[1]',
    ':team -lead-> :boss',
    ':eve -cain-> :adam:cain',
    ':favorites -null-> :pets[0]', // forward keyless element
    ':favorites -null-> :fan',     // fan's ~- membership, folded forward
    ':crew -null-> :fan',          // both-ways keyless membership
  ];
  for (const s of shared) {
    assert.ok(j.has(s), `json5p missing: ${s}`);
    assert.ok(y.has(s), `yamlover missing: ${s}`);
  }
});

test('normalize: a keyless ~- membership is ADDITIVE — folds beside the forward, never deduped', () => {
  // forward `- *member` AND reverse `~- */items`: with no label there is no identity to
  // dedup on, so normalize keeps BOTH forward keyless refs (URIs.md §~- — lists repeat).
  const d = parseYamlover('items:\n- */member\nmember:\n  name: m\n  ~- */items\n');
  const n = normalize(buildGraph(d));
  const memberships = n.filter((e) => e.from === ':items' && e.to === ':member' && e.label === null && e.kind === 'ref');
  assert.equal(memberships.length, 2);
  assert.ok(!n.some((e) => e.kind === 'back'));
});

test('normalize: keyless forward repetitions survive; labeled pairs still dedup', () => {
  const d = parseYamlover('items:\n- */m\n- */m\nm: x\nowner:\n  pet: */m\npet2: &z 1\n');
  const n = normalize(buildGraph(d));
  assert.equal(n.filter((e) => e.from === ':items' && e.to === ':m' && e.label === null && e.kind === 'ref').length, 2);
  // labeled both-ways still reconciles to ONE (existing behavior, unchanged)
  const d2 = parseYamlover('eve:\n  cain: */adam\nadam:\n  ~cain: */eve\n');
  const n2 = normalize(buildGraph(d2));
  assert.equal(n2.filter((e) => e.label === 'cain' && e.kind === 'ref').length, 1);
});
