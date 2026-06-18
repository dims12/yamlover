import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJson5p } from '../../../parser/ts/src/json5p.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import type { Mapping, Node } from '../../../parser/ts/src/ir.ts';
import { resolveDocument, resolvePointer } from '../src/resolve.ts';
import type { Located } from '../src/resolve.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', '..', 'examples');

// scalar value at a string key of a resolved mapping node
function scalarAt(loc: Located, key: string): unknown {
  assert.equal(loc.kind, 'node');
  const n = (loc as { node: Node }).node as Mapping;
  const e = n.entries.find((x) => x.key === key);
  return (e!.value as any).value;
}
function find(edges: ReturnType<typeof resolveDocument>, from: string) {
  return edges.find((e) => e.from === from)!;
}

test('json5p 03-tour: pointers resolve to the right nodes', () => {
  const doc = parseJson5p(readFileSync(join(examples, '03-tour.json5p'), 'utf8'), '03-tour.json5p');
  const edges = resolveDocument(doc);

  // feline = *'pets[1]'  -> the Whiskers node, at /pets[1]
  const feline = find(edges, ':feline').target;
  assert.equal(feline.kind, 'node');
  assert.equal((feline as any).path, ':pets[1]');
  assert.equal(scalarAt(feline, 'name'), 'Whiskers');

  // topDog = *':pets[0]' -> Rex
  assert.equal(scalarAt(find(edges, ':topDog').target, 'name'), 'Rex');

  // humans[0].manager = *':pets[1]' -> Whiskers
  assert.equal(scalarAt(find(edges, ':humans[0]:manager').target, 'name'), 'Whiskers');

  // team.lead = *'chief' -> the &chief anchor (boss = Rex), by anchor precedence
  assert.equal(scalarAt(find(edges, ':team:lead').target, 'name'), 'Rex');

  // secondName = *'pets[1]/name' -> the scalar "Whiskers"
  const sn = find(edges, ':secondName').target;
  assert.equal((sn as any).node.value, 'Whiskers');

  // the reverse edge is anchor-spelled (&':eve:cain' on cain) — realized as a back edge
  const back = find(edges, ':adam:cain');
  assert.equal(back.edge, 'back');
  assert.equal(back.anchor, true);
  assert.equal(back.label, 'cain');
  assert.equal((back.target as any).path, ':eve');

  // escaping: ref = *'odd\\/key/n' -> literal key "odd/key", then /n -> scalar 1
  assert.equal((find(edges, ':oddRef').target as any).node.value, 1);
});

test('yamlover 06-tour: same pointers resolve', () => {
  const doc = parseYamlover(readFileSync(join(examples, '06-tour.yamlover'), 'utf8'), '06-tour.yamlover');
  const edges = resolveDocument(doc);
  assert.equal(scalarAt(find(edges, ':feline').target, 'name'), 'Whiskers');
  assert.equal(scalarAt(find(edges, ':topDog').target, 'name'), 'Rex');
  assert.equal(scalarAt(find(edges, ':team:lead').target, 'name'), 'Rex'); // *chief anchor
  assert.equal((find(edges, ':secondName').target as any).node.value, 'Whiskers');
  // ref: *weird/cat\/dog/n -> 1  (literal key "cat/dog")
  assert.equal((find(edges, ':ref').target as any).node.value, 1);
});

test('parent scope (..) walks up the containment chain', () => {
  const doc = parseJson5p(`{ a: { b: { up: *'../../x' }, }, x: 42 }`);
  const edges = resolveDocument(doc);
  assert.equal((find(edges, ':a:b:up').target as any).node.value, 42);
});

test('world scope (:::) is external when the authority is not a local root key', () => {
  // ::: names the WORLD (a cross-authority URI) — the only form that may reference content outside
  // the loaded tree, so an unresolved one stays external rather than dangling.
  const doc = parseJson5p(`{ wild: *':::pet.store.com:pets' }`);
  const t = resolveDocument(doc)[0].target;
  assert.equal(t.kind, 'external');
  assert.equal((t as any).authority, 'pet.store.com');
});

test('project scope (::) is INTERNAL — an unresolved authority is dangling, not external', () => {
  // `::tags:…` means a `tags` key at the served root; absent, it is a typo, not a host. (This is the
  // class of bug that used to vanish into the external bucket.)
  const t = resolveDocument(parseJson5p(`{ bad: *'::tags:workflow' }`))[0].target;
  assert.equal(t.kind, 'unresolved');
});

test('missing target → unresolved', () => {
  const t = resolveDocument(parseJson5p(`{ a: *'nope/missing' }`))[0].target;
  assert.equal(t.kind, 'unresolved');
});

test('pointer cycle is detected, not infinite', () => {
  // a -> b -> a
  const doc = parseJson5p(`{ a: *'b', b: *'a' }`);
  const t = resolveDocument(doc).map((e) => e.target.kind);
  assert.ok(t.every((k) => k === 'node' || k === 'unresolved')); // terminates
});

// ─────────────────────── self-import absorption (graft-virtualize) ───────────────────────

test('self-import: `::yamlover:tags:x` is ABSORBED to the real `:tags:x` when no yamlover node', () => {
  // a project root (its taxonomy at :tags, no materialized :yamlover): the `yamlover` authority
  // loops back to the project root, so the pointer lands on the REAL node — not a graft duplicate.
  const doc = parseYamlover('tags:\n  x: 1\nref: *::yamlover:tags:x\n');
  const e = resolveDocument(doc).find((r) => r.label === 'ref')!;
  assert.equal(e.target.kind, 'node');
  assert.equal((e.target as { path: string }).path, ':tags:x');
});

test('self-import: `::yamlover:tags:x` steps INTO a materialized yamlover node when one exists', () => {
  // a foreign/subdir root whose taxonomy lives under a real `yamlover` graft key: step in as before.
  const doc = parseYamlover('yamlover:\n  tags:\n    x: 1\nref: *::yamlover:tags:x\n');
  const e = resolveDocument(doc).find((r) => r.label === 'ref')!;
  assert.equal(e.target.kind, 'node');
  assert.equal((e.target as { path: string }).path, ':yamlover:tags:x');
});

test('self-import: `::tags:x` and `::yamlover:tags:x` reach the SAME node in a project', () => {
  const doc = parseYamlover('tags:\n  x: 1\nplain: *::tags:x\nviaImport: *::yamlover:tags:x\n');
  const edges = resolveDocument(doc);
  const plain = edges.find((r) => r.label === 'plain')!;
  const via = edges.find((r) => r.label === 'viaImport')!;
  assert.equal((plain.target as { path: string }).path, ':tags:x');
  assert.equal((via.target as { path: string }).path, ':tags:x');
});
