// Serializer round-trips (PLAN.md 2d/2e): parse → serialize → reparse must be IR-EQUAL.
// "IR-equal" compares the graph (values, entry order, keys, edge kinds, pointer base/steps/
// raw, anchors, !!set, !!<…> schema), NOT the typography — scalar `raw`, comments and
// layout are legitimately re-rendered (IR.md stores the graph, not the text).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Comment, Document, Node, Pointer, Value } from '../src/ir.ts';
import { isPointer } from '../src/ir.ts';
import { parseYamlover } from '../src/yamlover.ts';
import { parseJson5p } from '../src/json5p.ts';
import { serializeYamlover } from '../src/serialize-yamlover.ts';
import { serializeJson5p } from '../src/serialize-json5p.ts';
import { LossyError } from '../src/serialize-common.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const examples = join(root, 'examples');

// ---- IR equality (graph, not typography) --------------------------------------

function canonValue(v: Value): unknown {
  if (isPointer(v)) return canonPtr(v);
  return canonNode(v);
}

function canonPtr(p: Pointer): unknown {
  // the dual window re-renders raws in colon form — identity is base + steps, not text
  return { ptr: { base: p.base, steps: p.steps } };
}

/** A deprecated `~` back entry with an absolute-scoped pointer is EQUIVALENT to a `&`
 *  path anchor (`~k: *P` ≡ `&P/k`, `~- *P` ≡ `&P[]`) — and the serializers emit the
 *  anchor form. Canon folds both authorings into one anchor set (semantic identity =
 *  base+steps+ordinal; raw differs between the spellings by construction). */
function convBack(e: { key: string | null; edge: string; value: Value }): boolean {
  return e.edge === 'back' && isPointer(e.value) &&
    ((e.value as Pointer).base.scope === 'document' || (e.value as Pointer).base.scope === 'link');
}

function canonNode(n: Node): unknown {
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
  return {
    kind: n.kind,
    value: n.kind === 'scalar' ? n.value : undefined,
    blob: n.kind === 'blob' ? { format: n.format, hash: n.contentHash, size: n.size } : undefined,
    array: n.array === true,
    set: n.meta?.set === true,
    schema: n.meta?.schema !== undefined ? canonValue(n.meta.schema) : undefined,
    anchors,
    entries: ents.filter((e) => !convBack(e)).map((e) => ({ key: e.key, edge: e.edge, value: canonValue(e.value) })),
  };
}

function canonDoc(d: Document): unknown {
  return { root: canonNode(d.root) };
}

function rtYamlover(src: string, label = '<test>'): string {
  const doc = parseYamlover(src, label);
  const out = serializeYamlover(doc);
  const re = parseYamlover(out, `${label} (reserialized)`);
  assert.deepEqual(canonDoc(re), canonDoc(doc), `yamlover round-trip diverged for ${label}:\n${out}`);
  return out;
}

function rtJson5p(src: string, label = '<test>'): string {
  const doc = parseJson5p(src, label);
  const out = serializeJson5p(doc);
  const re = parseJson5p(out, `${label} (reserialized)`);
  assert.deepEqual(canonDoc(re), canonDoc(doc), `json5p round-trip diverged for ${label}:\n${out}`);
  return out;
}

// ---- yamlover: unit round-trips ------------------------------------------------

test('yamlover rt: block mapping with scalar zoo', () => {
  rtYamlover('name: Alice\nage: 30\nhex: 0x1F\nfloaty: .5\nadmin: true\nnote: ~\nempty: ""\n');
});

test('yamlover rt: nested mappings and sequences', () => {
  rtYamlover('user:\n  name: Alice\n  pets:\n    - Rex\n    - name: Whiskers\n      species: cat\n');
});

test('yamlover rt: pointers re-render in canonical colon form', () => {
  const out = rtYamlover('pets:\n  - name: Rex\nfeline: *pets[0]\ntop: */pets[0]/name\nrx: *pets[0]\n');
  assert.match(out, /\*pets\[0\]/);
  assert.match(out, /\*: pets\[0\]: name/);
});

test('yamlover rt: anchors and anchor references', () => {
  const out = rtYamlover('boss: &chief\n  name: Rex\nteam:\n  lead: *chief\n');
  // canonical M3 placement: the anchor moves to its own line inside the block
  assert.match(out, /boss:\n {2}&chief\n {2}name: Rex/);
});

test('yamlover rt: keyed back-edges and ~- membership', () => {
  rtYamlover('eve:\n  cain: */adam/cain\nadam:\n  cain:\n    ~cain: */eve\nfavorites:\n  - */adam\nfan:\n  name: Bob\n  ~- */favorites\n');
});

test('yamlover rt: !!mix and nested omni (value + fields)', () => {
  rtYamlover('playlist: !!mix\n  - Intro\n  title: Greatest Hits\n  - Chorus\nrating: 5\n  - solid\n  scale: 10\n');
});

test('yamlover rt: !!set survives via meta', () => {
  const out = rtYamlover('crew: !!set\n  - */fan\nfan:\n  name: Bob\n');
  assert.match(out, /crew: !!set/);
});

test('yamlover rt: root omni needs the explicit tag (canonical !!var)', () => {
  const out = rtYamlover('!!var Built-in tags\ncolors: palette\n');
  assert.match(out, /^!!var Built-in tags$/m);
  // the deprecated `!!omni` alias parses to the same shape and also re-emits as `!!var`
  assert.match(rtYamlover('!!omni Built-in tags\ncolors: palette\n'), /^!!var Built-in tags$/m);
});

test('yamlover rt: escaped keys (pointer metachars) and quoted keys', () => {
  rtYamlover('weird:\n  cat\\/dog:\n    n: 1\n"key with spaces, commas":\n  x: 1\n');
});

test('yamlover rt: block scalars (clip / strip / keep)', () => {
  rtYamlover('clip: |\n  line one\n  line two\nstrip: |-\n  no trailing\nkeep: |+\n  kept\n\nafter: 1\n');
});

test('yamlover rt: folded block reparses by VALUE', () => {
  // `>` folds to a value; the serializer re-emits it as a literal block — value-equal
  rtYamlover('folded: >\n  one\n  two\n\n  para\nafter: 1\n');
});

test('yamlover rt: multiline strings that cannot be blocks fall back to double quotes', () => {
  const out = rtYamlover('tricky: "  leading spaces\\nsecond"\ncrlf: "a\\r\\nb"\n');
  assert.match(out, /tricky: " /);
});

test('yamlover rt: strings that look like other types get quoted', () => {
  rtYamlover("a: 'true'\nb: '123'\nc: 'null'\nd: '- not a seq'\ne: 'key: value'\nf: '# not a comment'\ng: '*not a pointer'\n");
});

test('yamlover rt: schema tags — pointer, inline node, root', () => {
  const out = rtYamlover('!!<*yamlover/$defs/tag>\ntags: !!<*yamlover/$defs/tag> A taxonomy\n  field: About\nchunk: !!<format: text/x-plantuml> diagram\n');
  assert.match(out, /^!!<\*yamlover: \$defs: tag>$/m);
});

test('yamlover rt: duplicate back keys re-emit as distinct anchors', () => {
  // two same-named `~slug` memberships (the 67-pdf-tags shape) → two `&` anchor tokens
  const out = rtYamlover('"a.pdf":\n  ~slug: */tags/x\n  ~slug: */tags/y\ntags:\n  x: one\n  y: two\n');
  assert.match(out, /^ {2}&: tags: x: slug$/m);
  assert.match(out, /^ {2}&: tags: y: slug$/m);
  assert.doesNotMatch(out, /~slug/);
});

test('yamlover rt: empty containers, flow source', () => {
  rtYamlover('emptyMap: {}\nemptyArr: []\nflowMap: {a: 1, b: two}\nflowArr: [1, 2, three]\n');
});

test('yamlover rt: spacey keys re-render as quoted portions', () => {
  const out = rtYamlover('ref: */some file with spaces.pdf\nodd: *\'has #comment\'\n');
  assert.match(out, /\*: 'some file with spaces\.pdf'/);
  assert.match(out, /\*'has #comment'/);
});

test('yamlover rt: non-finite numbers use YAML float specials (.inf / -.inf / .nan)', () => {
  const out = rtYamlover('pos: .inf\nneg: -.inf\nundef: .nan\n');
  assert.match(out, /pos: \.inf$/m);
  assert.match(out, /neg: -\.inf$/m);
  assert.match(out, /undef: \.nan$/m);
});

test('yamlover parse: YAML float-special spellings → Infinity / -Infinity / NaN', () => {
  const root = parseYamlover('a: .inf\nb: -.inf\nc: .nan\nd: .Inf\ne: .NaN\n').root;
  const val = (k: string) => (root.entries!.find((e) => e.key === k)!.value as { value: number }).value;
  assert.equal(val('a'), Infinity);
  assert.equal(val('b'), -Infinity);
  assert.ok(Number.isNaN(val('c')));
  assert.equal(val('d'), Infinity);
  assert.ok(Number.isNaN(val('e')));
});

test('cross-concrete: a json5 Infinity/NaN serializes to yamlover .inf/.nan (no LossyError)', () => {
  const doc = parseJson5p('{x: Infinity, y: -Infinity, z: NaN}');
  const out = serializeYamlover(doc);
  assert.match(out, /x: \.inf$/m);
  assert.match(out, /y: -\.inf$/m);
  assert.match(out, /z: \.nan$/m);
  // and the yamlover output reparses to the SAME graph
  assert.deepEqual(canonDoc(parseYamlover(out)), canonDoc(doc));
});

// ---- yamlover: file round-trips -------------------------------------------------

const yamloverFiles: string[] = [
  join(examples, '05-tour.yaml'),
  join(examples, '06-tour.yamlover'),
  join(root, 'tags', '.yamlover', 'body.yamlover'),
];
for (const dir of readdirSync(examples, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const body = join(examples, dir.name, '.yamlover', 'body.yamlover');
  if (existsSync(body)) yamloverFiles.push(body);
}

for (const file of yamloverFiles) {
  test(`yamlover rt file: ${file.slice(root.length + 1)}`, () => {
    rtYamlover(readFileSync(file, 'utf8'), file);
  });
}

// ---- json5p: unit round-trips ----------------------------------------------------

test('json5p rt: object/array nesting, odd keys, escapes', () => {
  rtJson5p('{ pets: [{name: "Rex"}, {name: "Wh\'iskers"}], "odd/key": {n: 1}, "key with spaces": 2 }');
});

test('json5p rt: pointers, anchors, back-edges (keyed and keyless)', () => {
  const out = rtJson5p("{ boss: &'/chief' {name: 'Rex'}, team: {lead: *'/chief'}, eve: {cain: *'/adam/cain'}, adam: {cain: {~cain: *'/eve'}}, favorites: [*'/adam'], fan: {name: 'Bob', ~*'/favorites'}, thirty: &'/tags/whole[]' 30 }");
  assert.match(out, /&": chief" \{/);
  assert.match(out, /&": tags: whole\[\]" 30/);
  // deprecated `~` forms re-emit as anchors (absolute scopes), colon-rendered
  assert.match(out, /&": eve: cain"/);
  assert.match(out, /&": favorites\[\]"/);
  assert.doesNotMatch(out, /~/);
});

test('json5p rt: numbers keep their spelling (hex, Infinity, NaN)', () => {
  const out = rtJson5p('{ hex: 0x1F, inf: Infinity, neg: -Infinity, nan: NaN, exp: 1e3 }');
  assert.match(out, /0x1F/);
  assert.match(out, /Infinity/);
});

test('json5p rt: pointer raw with backslash escapes', () => {
  const out = rtJson5p("{ oddRef: *'odd\\\\/key/n' }");
  assert.match(out, /\*"odd\/key: n"/); // `/` is literal in colon portions
});

test('json5p lossy: yamlover tags are refused with a pointer to the meta layer', () => {
  assert.throws(() => serializeJson5p(parseYamlover('crew: !!set\n  - */fan\nfan: x\n')), LossyError);
  assert.throws(() => serializeJson5p(parseYamlover('p: !!mix\n  - a\n  k: v\n')), LossyError);
  assert.throws(() => serializeJson5p(parseYamlover('r: 5\n  - solid\n')), LossyError); // omni
  assert.throws(() => serializeJson5p(parseYamlover('t: !!<*yamlover/$defs/tag> body\n')), LossyError);
});

// ---- json5p: file round-trips ------------------------------------------------------

for (const name of ['01-tour.json', '02-tour.json5', '03-tour.json5p']) {
  test(`json5p rt file: examples/${name}`, () => {
    rtJson5p(readFileSync(join(examples, name), 'utf8'), name);
  });
}

// ---- comments: canonical equality ignores them, opt-in emission round-trips ----------
// Comments are typography (like scalar `raw`): canonDoc never reads them, so the standard
// round-trips above hold whether or not a file has comments. With { comments: true } the
// serializers re-emit them, and a reparse recovers the same set of comment texts.

/** Every retained comment text in the document (head + per-entry + node leftovers), sorted. */
function commentTexts(d: Document): string[] {
  const out: string[] = [];
  const take = (cs: Comment[] | undefined): void => { for (const c of cs ?? []) out.push(c.text.trim()); };
  take(d.head);
  const walk = (n: Node): void => {
    take(n.meta?.comments);
    for (const e of n.entries ?? []) {
      take(e.meta?.comments);
      if (!isPointer(e.value)) walk(e.value);
    }
  };
  walk(d.root);
  return out.sort();
}

test('comments: canonDoc ignores them (round-trip holds with comments present)', () => {
  // a commented source still round-trips under the default (comment-free) serialization
  rtYamlover('# header\n\nname: Alice # who\nage: 30\n');
  rtJson5p('{ // header\n  name: "Alice", // who\n  age: 30,\n}');
});

test('comments: yamlover { comments: true } re-emits and reparses to the same texts', () => {
  const src = '# license\n# v2\n\n# the name\nname: Alice # who\nuser:\n  # nested\n  age: 30\n# bye\n';
  const doc = parseYamlover(src, '<t>');
  const out = serializeYamlover(doc, { comments: true });
  const re = parseYamlover(out, '<t re>');
  assert.deepEqual(commentTexts(re), commentTexts(doc), `comments lost:\n${out}`);
  assert.deepEqual(canonDoc(re), canonDoc(doc)); // graph still intact
  // and the default emission drops them (byte-identical to comment-free)
  assert.equal(serializeYamlover(doc), serializeYamlover(parseYamlover(serializeYamlover(doc), '<t2>')));
});

test('comments: json5p { comments: true } re-emits and reparses to the same texts', () => {
  const src = '// header\n\n{\n  // the name\n  name: "Alice", // who\n  age: 30,\n}';
  const doc = parseJson5p(src, '<t>');
  const out = serializeJson5p(doc, { comments: true });
  const re = parseJson5p(out, '<t re>');
  assert.deepEqual(commentTexts(re), commentTexts(doc), `comments lost:\n${out}`);
  assert.deepEqual(canonDoc(re), canonDoc(doc));
});

// ---- cross-concrete -----------------------------------------------------------------

test('cross rt: 03-tour.json5p → yamlover → IR-equal', () => {
  const doc = parseJson5p(readFileSync(join(examples, '03-tour.json5p'), 'utf8'), '03-tour');
  const out = serializeYamlover(doc);
  assert.deepEqual(canonDoc(parseYamlover(out, '03-as-yamlover')), canonDoc(doc), out);
});

test('cross rt: genealogy body.yamlover → json5p → IR-equal', () => {
  const src = readFileSync(join(examples, '58-genealogy-dag', '.yamlover', 'body.yamlover'), 'utf8');
  const doc = parseYamlover(src, '58-genealogy');
  const out = serializeJson5p(doc);
  assert.deepEqual(canonDoc(parseJson5p(out, '58-as-json5p')), canonDoc(doc), out);
});

test('cross lossy: 06-tour.yamlover does not fit json5p (mix/omni/set)', () => {
  const doc = parseYamlover(readFileSync(join(examples, '06-tour.yamlover'), 'utf8'), '06-tour');
  assert.throws(() => serializeJson5p(doc), LossyError);
});
