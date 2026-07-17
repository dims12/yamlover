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

// ─────────────────────── relative indexes — [.±k] (URIs.md §Relative indexes) ───────────────────────

test('relindex colspan: *[.-1] in a row targets the cell to my LEFT', () => {
  const doc = parseYamlover('header: [Animal, Trait, *[.-1]]\n');
  const e = find(resolveDocument(doc), ':header[2]');
  assert.equal(e.target.kind, 'node');
  assert.equal((e.target as { path: string }).path, ':header[1]');
  assert.equal((e.target as any).node.value, 'Trait');
});

test('relindex rowspan: *..[.-1][.] targets the cell ABOVE (previous row, my column)', () => {
  // rows are keyless arrays; the pointer sits at [1][1] and must land on [0][1]
  const doc = parseYamlover('- [Mammals, warm]\n- [*..[.-1][.], barky]\n');
  const e = find(resolveDocument(doc), '[1][0]');
  assert.equal(e.target.kind, 'node');
  assert.equal((e.target as { path: string }).path, '[0][0]');
  assert.equal((e.target as any).node.value, 'Mammals');
});

test('relindex: keyed entries consume positions — header is a frame position too', () => {
  // title(0), header(1), row(2): a rowspan pointer in the first BODY row lands on the header cell
  const doc = parseYamlover('title: t\nheader: [a, b]\n- [*..[.-1][.], y]\n');
  const e = find(resolveDocument(doc), '[2][0]');
  assert.equal(e.target.kind, 'node');
  assert.equal((e.target as { path: string }).path, ':header[0]');
});

test('relindex chain resolves transitively to the ORIGIN cell', () => {
  const doc = parseYamlover('- [Origin, *[.-1], *[.-1]]\n');
  const edges = resolveDocument(doc);
  for (const from of ['[0][1]', '[0][2]']) {
    const e = find(edges, from);
    assert.equal(e.target.kind, 'node');
    assert.equal((e.target as { path: string }).path, '[0][0]');
  }
});

test('relindex out of range is the ordinary dangling diagnostic', () => {
  const doc = parseYamlover('- [*[.-1], x]\n'); // first column has no left neighbor
  const t = find(resolveDocument(doc), '[0][0]').target;
  assert.equal(t.kind, 'unresolved');
  assert.match((t as { reason: string }).reason, /out of range/);
});

test('relindex [.] names its own position — a self-pointer is a cycle, not infinite', () => {
  const t = find(resolveDocument(parseYamlover('- [a, *[.]]\n')), '[0][1]').target;
  assert.equal(t.kind, 'unresolved');
  assert.equal((t as { reason: string }).reason, 'pointer cycle');
});

test('relindex deeper than the host path has no frame → unresolved', () => {
  // the pointer's host sits at depth 1; a second [.±k] step would select at depth 2
  const doc = parseYamlover('- a\n- *[.-1][.]\n');
  const t = find(resolveDocument(doc), '[1]').target;
  assert.equal(t.kind, 'unresolved');
  assert.match((t as { reason: string }).reason, /no host frame/);
});

test('relindex: the examples/61 table resolves with no relindex-unresolved edges', () => {
  const doc = parseYamlover(readFileSync(join(examples, '61-table.yamlover'), 'utf8'), '61-table.yamlover');
  const rel = resolveDocument(doc).filter((e) => e.ptr.steps.some((s) => s.sel === 'relindex'));
  assert.ok(rel.length >= 2); // the colspan + rowspan merges
  for (const e of rel) assert.equal(e.target.kind, 'node', (e.target as any).reason);
});
