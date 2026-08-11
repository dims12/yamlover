import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJson5p } from '../../../parser/ts/src/json5p.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import type { Mapping, Node } from '../../../parser/ts/src/ir.ts';
import { resolveDocument, resolvePointer, scanTextLinks } from '../src/resolve.ts';
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

  // feline = *'pets[1]' (legacy-alias spelling in the example) -> the Whiskers node, at :pets:1
  const feline = find(edges, ':feline').target;
  assert.equal(feline.kind, 'node');
  assert.equal((feline as any).path, ':pets:1');
  assert.equal(scalarAt(feline, 'name'), 'Whiskers');

  // topDog = *':pets[0]' -> Rex
  assert.equal(scalarAt(find(edges, ':topDog').target, 'name'), 'Rex');

  // humans[0].manager = *':pets[1]' -> Whiskers
  assert.equal(scalarAt(find(edges, ':humans:0:manager').target, 'name'), 'Whiskers');

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
  const doc = parseYamlover(readFileSync(join(examples, '06-tour.yo'), 'utf8'), '06-tour.yo');
  const edges = resolveDocument(doc);
  assert.equal(scalarAt(find(edges, ':feline').target, 'name'), 'Whiskers');
  assert.equal(scalarAt(find(edges, ':topDog').target, 'name'), 'Rex');
  assert.equal(scalarAt(find(edges, ':team:lead').target, 'name'), 'Rex'); // *chief anchor
  assert.equal((find(edges, ':secondName').target as any).node.value, 'Whiskers');
  // ref: *weird/cat\/dog/n -> 1  (literal key "cat/dog")
  assert.equal((find(edges, ':ref').target as any).node.value, 1);
});

test('parent scope (..) walks up the containment chain', () => {
  const doc = parseJson5p(`{ a: { b: { up: *'..: ..: x' }, }, x: 42 }`);
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

// ─────────────────────── the DOCUMENT BOUNDARY — a tag opens a document (src/boundary.ts) ───────────────────────

test('boundary: `:` inside a `!!yo` island resolves from the ISLAND, not the file', () => {
  // both `whiskers` keys are in scope by path; the island's own must win, or the content could not
  // be pasted anywhere else without rewriting every pointer
  const doc = parseYamlover('whiskers: the outer one\nisland: !!yo\n  whiskers: the inner one\n  pet: *: whiskers\n');
  const e = find(resolveDocument(doc), ':island:pet');
  assert.equal((e.target as { path: string }).path, ':island:whiskers');
  assert.equal((e.target as any).node.value, 'the inner one');
  assert.equal(e.docRoot, ':island'); // what a rewrite re-spells against
});

test('boundary: `..` still steps OUT of an island — the boundary is for `:` alone', () => {
  const doc = parseYamlover('outer: 42\nisland: !!yo\n  up: *..: outer\n');
  assert.equal((find(resolveDocument(doc), ':island:up').target as any).node.value, 42);
});

test('boundary: a tagged GRAPH is a document too, so a `&` anchor inside it lands inside it', () => {
  const doc = parseYamlover(
    'exports: outer\ngraph: !!<*yamlover: $defs: xyflow>\n  exports:\n    latest: the shelf\n  publish: to the shelf\n    &: exports: shipped\n',
  );
  const anchor = resolveDocument(doc).find((e) => e.anchor)!;
  assert.equal((anchor.target as { path: string }).path, ':graph:exports');
});

test('boundary: an ORDINARY tag opens no document — `:` still means the file', () => {
  const doc = parseYamlover('whiskers: the outer one\nt: !!<*yamlover: $defs: table>\n  pet: *: whiskers\n');
  assert.equal((find(resolveDocument(doc), ':t:pet').target as { path: string }).path, ':whiskers');
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

// ─────────────────────── relative indexes — [.±k] (docs/language/pointers/relative-indexes) ───────────────────────

test('relindex colspan: *[.-1] in a row targets the cell to my LEFT', () => {
  const doc = parseYamlover('header: [Animal, Trait, *[.-1]]\n');
  const e = find(resolveDocument(doc), ':header:2');
  assert.equal(e.target.kind, 'node');
  assert.equal((e.target as { path: string }).path, ':header:1');
  assert.equal((e.target as any).node.value, 'Trait');
});

test('relindex rowspan: *..[.-1][.] targets the cell ABOVE (previous row, my column)', () => {
  // rows are keyless arrays; the pointer sits at :1:0 and must land on :0:0
  const doc = parseYamlover('- [Mammals, warm]\n- [*..[.-1][.], barky]\n');
  const e = find(resolveDocument(doc), ':1:0');
  assert.equal(e.target.kind, 'node');
  assert.equal((e.target as { path: string }).path, ':0:0');
  assert.equal((e.target as any).node.value, 'Mammals');
});

test('relindex: keyed entries consume positions — header is a frame position too', () => {
  // title(0), header(1), row(2): a rowspan pointer in the first BODY row lands on the header cell
  const doc = parseYamlover('title: t\nheader: [a, b]\n- [*..[.-1][.], y]\n');
  const e = find(resolveDocument(doc), ':2:0');
  assert.equal(e.target.kind, 'node');
  assert.equal((e.target as { path: string }).path, ':header:0');
});

test('relindex chain resolves transitively to the ORIGIN cell', () => {
  const doc = parseYamlover('- [Origin, *[.-1], *[.-1]]\n');
  const edges = resolveDocument(doc);
  for (const from of [':0:1', ':0:2']) {
    const e = find(edges, from);
    assert.equal(e.target.kind, 'node');
    assert.equal((e.target as { path: string }).path, ':0:0');
  }
});

test('relindex out of range is the ordinary dangling diagnostic', () => {
  const doc = parseYamlover('- [*[.-1], x]\n'); // first column has no left neighbor
  const t = find(resolveDocument(doc), ':0:0').target;
  assert.equal(t.kind, 'unresolved');
  assert.match((t as { reason: string }).reason, /out of range/);
});

test('relindex [.] names its own position — a self-pointer is a cycle, not infinite', () => {
  const t = find(resolveDocument(parseYamlover('- [a, *[.]]\n')), ':0:1').target;
  assert.equal(t.kind, 'unresolved');
  assert.equal((t as { reason: string }).reason, 'pointer cycle');
});

test('relindex deeper than the host path has no frame → unresolved', () => {
  // the pointer's host sits at depth 1; a second [.±k] step would select at depth 2
  const doc = parseYamlover('- a\n- *[.-1][.]\n');
  const t = find(resolveDocument(doc), ':1').target;
  assert.equal(t.kind, 'unresolved');
  assert.match((t as { reason: string }).reason, /no host frame/);
});

test('relindex: the examples/61 table resolves with no relindex-unresolved edges', () => {
  const doc = parseYamlover(readFileSync(join(examples, '61-table.yo'), 'utf8'), '61-table.yo');
  const rel = resolveDocument(doc).filter((e) => e.ptr.steps.some((s) => s.sel === 'relindex'));
  assert.ok(rel.length >= 2); // the colspan + rowspan merges
  for (const e of rel) assert.equal(e.target.kind, 'node', (e.target as any).reason);
});

test('scanTextLinks: pointer-expression targets across every spelling and scope', () => {
  const doc = parseYamlover(
    'a: "see [x](*:: kb: tax) and [b](::kb:bare) and [y](*: local) and [r](:relbare) and [c](*name) and [p](*..: sib) and [w](https://x.example) and [k](&marks: spot)"\n',
    'links.yo',
  );
  const links = scanTextLinks(doc);
  assert.deepEqual(
    links.map((l) => ({ from: l.from, holder: l.holder, scope: l.ptr.base.scope, sigiled: l.sigiled, anchor: l.anchor, target: l.target, raw: l.raw })),
    [
      { from: ':a', holder: ':', scope: 'link', sigiled: true, anchor: false, target: ':kb:tax', raw: '[x](*:: kb: tax)' },
      { from: ':a', holder: ':', scope: 'link', sigiled: false, anchor: false, target: ':kb:bare', raw: '[b](::kb:bare)' }, // the bare alias, read forever
      { from: ':a', holder: ':', scope: 'document', sigiled: true, anchor: false, target: ':local', raw: '[y](*: local)' },
      { from: ':a', holder: ':', scope: 'document', sigiled: false, anchor: false, target: ':relbare', raw: '[r](:relbare)' },
      { from: ':a', holder: ':', scope: 'current', sigiled: true, anchor: false, target: ':name', raw: '[c](*name)' }, // the leaf scalar's PARENT is the frame
      { from: ':a', holder: ':', scope: 'parent', sigiled: true, anchor: false, target: null, raw: '[p](*..: sib)' }, // above the root — no nominal path
      { from: ':a', holder: ':', scope: 'current', sigiled: true, anchor: true, target: ':marks:spot', raw: '[k](&marks: spot)' }, // reserved `&`
    ],
  );
});

test('scanTextLinks: an OMNI scans its title AND descends into its members', () => {
  // NOTE the compact target: a SPACED one inside a bare title line would re-split the
  // line as key/value — the reason prose emission is compact
  const doc = parseYamlover('Chapter [t](*::top)\n- see [c](::kb:chunk)\n', 'omni.yo');
  const links = scanTextLinks(doc);
  assert.deepEqual(
    links.map((l) => ({ from: l.from, holder: l.holder, target: l.target })),
    [
      { from: ':', holder: ':', target: ':top' },       // the omni title itself — its own frame
      { from: ':0', holder: ':', target: ':kb:chunk' }, // the chunk below it — the omni is its frame
    ],
  );
});

test('scanTextLinks: a ``` fence never desyncs the code arm (the fence-desync report)', () => {
  const fence = '```\ncode\n```';
  const inline = 'x `[t](::dead)` y'; // a backticked example — atomic, never a link
  const cases = [
    ['A inline only', inline],
    ['B one fence then inline', fence + '\n' + inline],
    ['C fence w/ info string', '```bash\necho hi\n```\n' + inline],
    ['D two fences then inline', fence + '\n' + fence + '\n' + inline],
    ['E fence containing backtick', '```\na ` b\n```\n' + inline],
  ] as const;
  for (const [name, text] of cases) {
    const doc = parseYamlover(`md: ${JSON.stringify(text)}\n`, 'fence.yo');
    assert.deepEqual(scanTextLinks(doc), [], name);
  }
  // and a REAL link after a fence still scans
  const doc = parseYamlover(`md: ${JSON.stringify(fence + '\nsee [a](*::live)')}\n`, 'fence.yo');
  assert.equal(scanTextLinks(doc).length, 1);
});
