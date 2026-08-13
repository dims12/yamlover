// Serializer round-trips (PLAN.md 2d/2e): parse → serialize → reparse must be IR-EQUAL.
// "IR-equal" compares the graph (values, entry order, keys, edge kinds, pointer base/steps/
// raw, anchors, !!set, !!<…> schema), NOT the typography — scalar `raw`, comments and
// layout are legitimately re-rendered (IR.md stores the graph, not the text).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Comment, Document, Entry, Node } from '../src/ir.ts';
import { isPointer } from '../src/ir.ts';
import { canonDoc } from '../src/canon.ts';
import { parseYamlover } from '../src/yamlover.ts';
import { parseJson5p } from '../src/json5p.ts';
import { parsePointer, renderPointer } from '../src/pointer.ts';
import { serializeYamlover } from '../src/serialize-yamlover.ts';
import { serializeJson5p } from '../src/serialize-json5p.ts';
import { LossyError, flowKeyText } from '../src/serialize-common.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const examples = join(root, 'examples');

// ---- IR equality (graph, not typography) — canonDoc lives in src/canon.ts ------

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

test('yamlover rt: compact nested sequences fold onto the dash', () => {
  const out = rtYamlover('- - a\n  - b\n- - - deep\n');
  assert.match(out, /- - a/);
  assert.match(out, /- - - deep/);
});

test('yamlover rt: a leading ~- back-edge in a seq item stays block (no fold)', () => {
  rtYamlover('crew:\n  -\n    ~- *: teams\n    name: Al\nteams:\n  - x\n');
});

test('yamlover rt: pointers re-render in canonical colon form — bare integer positions', () => {
  // `[n]` is the read-forever ALIAS (the YAML-keys round); canonical emission is the bare
  // integer portion — a position IS the integer key
  const out = rtYamlover('pets:\n  - name: Rex\nfeline: *pets[0]\ntop: *:pets[0]:name\nrx: *pets: 0\n');
  assert.doesNotMatch(out, /\[0\]/); // the bracket spelling is never written
  assert.match(out, /\*pets: 0/);
  assert.match(out, /\*: pets: 0: name/); // compact input re-emits with the `: ` styling
});

test('yamlover rt: the NULL KEY — `: v` ≡ `~: v`, distinct from `"": v`, canonical `~:`', () => {
  // both spellings parse to the null-keyed entry and re-emit canonically as `~:`
  for (const src of [': late\n', '~: late\n', '~ : late\n'.replace(' :', ':')]) {
    const out = rtYamlover(src);
    assert.match(out, /^~: late$/m);
  }
  // the empty-STRING key stays its own thing
  const empty = rtYamlover('"": late\n');
  assert.match(empty, /^"": late$/m);
  assert.doesNotMatch(empty, /^~:/m);
  // flow spellings: `{~: v}` and `{: v}` — the null key rides flow as `~:`
  assert.match(rtYamlover('m: {~: 1}\n'), /m: \{~: 1\}/);
  assert.match(rtYamlover('m: {: 1}\n'), /m: \{~: 1\}/);
  // a literal tilde key is escaped/quoted, never the null key
  const lit = rtYamlover('\\~: x\n');
  assert.match(lit, /^\\~: x$/m);
});

test('yamlover: a null-keyed entry is KEYED — it breaks pure-sequence-ness', () => {
  const doc = parseYamlover('- a\n~: b\n', 't');
  assert.equal(doc.root.kind, 'mapping');
  assert.equal((doc.root as { array?: boolean }).array, false);
  const entries = (doc.root as { entries: { key: string | null; nullKey?: true }[] }).entries;
  assert.deepEqual(entries.map((e) => [e.key, e.nullKey === true]), [[null, false], [null, true]]);
});

test('yamlover rt: `-:` is the EXPLICIT KEYLESS CONVERSION — `-: v` ≡ `- v`, canonical `- v`', () => {
  // the sugar is INPUT ONLY: every spelling below re-emits with the canonical dash marker
  assert.equal(rtYamlover('a: 1\n-: 2\n'), 'a: 1\n- 2\n');
  assert.equal(rtYamlover('-:\n  name: Whiskers\n  species: cat\n'), '- name: Whiskers\n  species: cat\n');
  // `-: key: …` FLIPPED under flattening (docs/language/flattening): key segments after a `-`
  // make it a MIDDLE segment — it addresses the LAST keyless element and never adds one, so
  // with nothing to address it refuses. The appends spell `- name: Rex` or `-:` + a block.
  assert.throws(() => parseYamlover('-: name: Rex\n'), /middle "-" segment/);
  assert.equal(rtYamlover('- 1\n-: name: Rex\n'), '- 1\n  name: Rex\n'); // …and WITH one, it paves into it
  assert.equal(rtYamlover('-: - x\n'), '- - x\n'); // nests like the dash it is
  // the marker is the WHOLE token: the colon sits tight, and space-or-EOL must follow
  assert.equal(rtYamlover('-:x\n'), '-:x\n'); // a plain scalar, not a marker
  assert.equal(rtYamlover('- : x\n'), '- ~: x\n'); // still a keyless entry holding a NULL-KEYED one
  // the IR really is keyless — not the null key, not the string key `-`
  const doc = parseYamlover('-: 2\n', 't');
  const entries = (doc.root as { entries: { key: string | null; nullKey?: true }[] }).entries;
  assert.deepEqual(entries.map((e) => [e.key, e.nullKey === true]), [[null, false]]);
  assert.equal((doc.root as { array?: boolean }).array, true);
});

test('yamlover rt: a LITERAL `-` key is quoted — in block, in flow, and against a stale raw', () => {
  assert.equal(rtYamlover('"-": 12\n'), '"-": 12\n');
  assert.equal(rtYamlover("'-': 12\n"), "'-': 12\n");
  assert.equal(rtYamlover("m: {'-': 1}\n"), "m: {'-': 1}\n");
  // a MINTED `-` key (no authored raw) gets the canonical quoting on both surfaces
  const minted = parseYamlover('a: 12\n', 't');
  (minted.root as { entries: { key: string; meta?: object }[] }).entries[0].key = '-';
  delete (minted.root as { entries: { meta?: object }[] }).entries[0].meta;
  assert.match(serializeYamlover(minted), /^"-": 12$/m);
  assert.equal(flowKeyText('-'), "'-'");
  assert.equal(flowKeyText('-1'), '-1'); // word-like keys stay bare
  assert.equal(flowKeyText('a-b'), 'a-b');
});

test('yamlover: an UNQUOTED authored raw is refused wherever keyText quotes (the reparse guard)', () => {
  // keyText quotes exactly the keys whose BARE spelling the line grammar misreads — the keyless
  // marker and the plain numeric (a position claim). A `.yaml` file mints such raws for real, so
  // reading YAML and writing yamlover must not emit a document that cannot be reparsed.
  const cases: [string, string, RegExp][] = [
    ['-: 12\n', '-', /^"-": 12$/m], // there, the string key `-`
    ['1: 12\n', '1', /^"1": 12$/m], // there, the integer key 1
  ];
  for (const [src, key, want] of cases) {
    const y = parseYamlover(src, 't', { yaml: true });
    const e = (y.root as { entries: { key: string | null; meta?: { keyRaw?: string } }[] }).entries[0];
    assert.equal(e.key, key);
    assert.equal(e.meta?.keyRaw, key, 'the YAML read keeps the authored spelling');
    const out = serializeYamlover(y);
    assert.match(out, want, 'the yamlover emission quotes it anyway');
    assert.doesNotThrow(() => parseYamlover(out, 't'), 'and the result reparses');
  }
  // a hand-forged raw is refused the same way, whatever the key came from
  for (const [key, raw, want] of [['- x', '- x', /^"- x": 1$/m], ['12', '12', /^"12": 1$/m]] as const) {
    const stale = parseYamlover('a: 1\n', 't');
    const e = (stale.root as { entries: { key: string; meta?: object }[] }).entries[0];
    e.key = key;
    e.meta = { keyRaw: raw };
    assert.match(serializeYamlover(stale), want);
  }
  // a QUOTED raw still wins — that is the whole point of keeping the spelling
  assert.equal(rtYamlover("'-': 12\n"), "'-': 12\n");
  assert.equal(rtYamlover("'1': 12\n"), "'1': 12\n");
});

test('yamlover rt: the flow surface reads `-` the same way — `{-: 1}` is the seq `[1]`', () => {
  assert.equal(rtYamlover('{-: 1, -: 2}\n'), '[1, 2]\n');
  // a MIXTURE cannot stay flow (flowTextOrNull refuses it) — it demotes to block, keyless and all
  assert.equal(rtYamlover('{a: 1, -: 2}\n'), 'a: 1\n- 2\n');
  // YAML mode keeps the literal key on both surfaces
  const y = parseYamlover('m: {-: 1}\n', 't', { yaml: true });
  const m = (y.root as { entries: { value: { entries: { key: string | null }[] } }[] }).entries[0].value;
  assert.equal(m.entries[0].key, '-');
});

test('yamlover: a plain numeric key is a parse ERROR (a position claim); quoted is the string', () => {
  assert.throws(() => parseYamlover('1: x\n', 't'), /plain numeric key is a position/);
  assert.throws(() => parseYamlover('m: {1: x}\n', 't'), /plain numeric key is a position/);
  // quoted: the numeric STRING key — round-trips QUOTED, in the AUTHORED spelling
  // (EntryMeta.keyRaw, the raw-first law); a minted key (no raw) emits canonical dq
  const out = rtYamlover("'1': x\n");
  assert.match(out, /^'1': x$/m);
  assert.match(rtYamlover('"1": x\n'), /^"1": x$/m);
  // YAML mode reads a plain numeric key faithfully as the string key
  const y = parseYamlover('1: x\n', 't', { yaml: true });
  assert.equal((y.root as { entries: { key: string | null }[] }).entries[0].key, '1');
});

test('yamlover: authored key and null SPELLINGS survive (EntryMeta.keyRaw; raw-first null)', () => {
  // quoted-by-choice keys keep their quotes and their style
  assert.equal(rtYamlover('"a": 1\n'), '"a": 1\n');
  assert.equal(rtYamlover("'a b': 1\n"), "'a b': 1\n");
  // a flow-token key round-trips bare — `{}` never gains quotes (the 0012 shape)
  assert.equal(rtYamlover('{}: 12\n'), '{}: 12\n');
  // authored nulls re-emit verbatim; the bare `key:` spelling stays bare
  assert.equal(rtYamlover('a: ~\n'), 'a: ~\n');
  assert.equal(rtYamlover('a: null\n'), 'a: null\n');
  assert.equal(rtYamlover('a:\n'), 'a:\n');
  // flow map: the authored quoted key survives inside the token
  assert.equal(rtYamlover("m: {'a b': 1}\n"), "m: {'a b': 1}\n");
  // a STALE keyRaw never changes the key — the reparse guard falls back to canonical
  const doc = parseYamlover('a: 1\n', 't');
  (doc.root as { entries: { meta?: object }[] }).entries[0].meta = { keyRaw: 'b' };
  assert.match(serializeYamlover(doc), /^a: 1$/m);
  // a MINTED null (no raw at all — the yed loader's bare `key:` shape) spells the default and
  // never crashes (the reported UNSERIALIZABLE `.trim` banner)
  const minted = {
    root: { kind: 'mapping', entries: [{ key: 'a', edge: 'contain', value: { kind: 'scalar', value: null } }] },
    source: { concrete: 'yamlover', uri: 't' },
  };
  assert.equal(serializeYamlover(minted as never), 'a:\n');
});

test('pointer: the bare-token typing rule — integers, ~, quotes, aliases', () => {
  // bare integer portion = position; quoted = string key; ~ = null key; \~ = literal
  const steps = (raw: string) => parsePointer(raw).steps;
  assert.deepEqual(steps(': pets: 1'), [{ sel: 'key', name: 'pets' }, { sel: 'index', n: 1 }]);
  assert.deepEqual(steps("x: '1'"), [{ sel: 'key', name: 'x' }, { sel: 'key', name: '1' }]);
  assert.deepEqual(steps('x: ~'), [{ sel: 'key', name: 'x' }, { sel: 'nullkey' }]);
  assert.deepEqual(steps('x: \\~'), [{ sel: 'key', name: 'x' }, { sel: 'key', name: '~' }]);
  assert.deepEqual(steps('pets[1]'), [{ sel: 'key', name: 'pets' }, { sel: 'index', n: 1 }]); // read-forever alias
  // reserved / non-integers stay string keys
  assert.deepEqual(steps('x: -1'), [{ sel: 'key', name: 'x' }, { sel: 'key', name: '-1' }]);
  assert.deepEqual(steps('x: 1.5'), [{ sel: 'key', name: 'x' }, { sel: 'key', name: '1.5' }]);
  // canonical emission: bare position, quoted numeric string, ~ null key
  assert.equal(renderPointer(parsePointer(': pets[1]: name')), ': pets: 1: name');
  assert.equal(renderPointer(parsePointer("x: '1'")), "x: '1'");
  assert.equal(renderPointer(parsePointer('x: ~')), 'x: ~');
});

test('pointer: a null-keyed entry resolves via the bare ~ portion in a document', () => {
  const doc = parseYamlover('~: late\nafter: *~\n', 't');
  const ents = (doc.root as { entries: { key: string | null; nullKey?: true; value: unknown }[] }).entries;
  assert.equal(ents[0].nullKey, true);
  const ptr = ents[1].value as { kind: string; steps: { sel: string }[] };
  assert.equal(ptr.kind, 'pointer');
  assert.deepEqual(ptr.steps, [{ sel: 'nullkey' }]);
});

test('bookmark: no position claims in the new spelling; no null-key bookmarks', () => {
  // a bare-integer tail is a position claim, same rule as the dead `&path[3]`
  assert.throws(() => parseYamlover('x: 1\n  &: p: 3\n', 't'), /bookmark may not claim a position/);
  assert.throws(() => parseYamlover('x: 1\n  &: p: ~\n', 't'), /bookmark cannot create the null key/);
});

test('yamlover rt: anchors and anchor references', () => {
  const out = rtYamlover('boss: &chief\n  name: Rex\nteam:\n  lead: *chief\n');
  // canonical M3 placement: the anchor moves to its own line inside the block
  assert.match(out, /boss:\n {2}&chief\n {2}name: Rex/);
});

test('yamlover rt: keyed back-edges and ~- membership', () => {
  rtYamlover('eve:\n  cain: *: adam: cain\nadam:\n  cain:\n    ~cain: *: eve\nfavorites:\n  - *: adam\nfan:\n  name: Bob\n  ~- *: favorites\n');
});

test('yamlover rt: !!mix is dropped (omni default); !!var re-emits as its new name !!yo', () => {
  const out = rtYamlover('playlist: !!mix\n  - Intro\n  title: Greatest Hits\n  - Chorus\nrating: !!var 5\n  - solid\n  scale: 10\n');
  assert.doesNotMatch(out, /!!mix|!!var|!!omni/); // the no-op marker dropped; the aliases renamed
  assert.match(out, /^rating: !!yo 5$/m); // `!!var` is a read-forever ALIAS of the semantic `!!yo`
  // …and the mixture stays untagged (a mixed container is the default shape)
  assert.match(out, /^ {2}- Intro$/m);
  assert.match(out, /^ {2}title: Greatest Hits$/m);
});

test('yamlover rt: !!set survives via meta', () => {
  const out = rtYamlover('crew: !!set\n  - *: fan\nfan:\n  name: Bob\n');
  assert.match(out, /crew: !!set/);
});

test('yamlover rt: a root !!var re-emits as a lone !!yo line (the semantic rename)', () => {
  const out = rtYamlover('!!var Built-in tags\ncolors: palette\n');
  assert.doesNotMatch(out, /!!var|!!omni/); // the deprecated spellings are never written
  assert.match(out, /^!!yo$/m); // the semantic mark survives — the lone-tag document-root form
  assert.match(out, /^Built-in tags$/m); // the self-value line
  assert.match(out, /^colors: palette$/m); // its field
  // the deprecated `!!omni` alias parses to the same shape and also re-emits as !!yo
  assert.match(rtYamlover('!!omni Built-in tags\ncolors: palette\n'), /^!!yo$/m);
});

test('yamlover rt: !!yo is semantic — kept on keyed nodes, containers, and the root', () => {
  // keyed omni: the tag rides the value line, exactly where it was authored
  assert.match(rtYamlover('rating: !!yo 5\n  - solid\n  scale: 10\n'), /^rating: !!yo 5$/m);
  // a container (no self-value) — the escape-hatch shape a chapter body uses
  const c = rtYamlover('island: !!yo\n  species: cat\n  - keyless\n');
  assert.match(c, /^island: !!yo$/m);
  // an UNTAGGED omni stays untagged: !!yo is authored semantics, never re-derived from shape
  assert.doesNotMatch(rtYamlover('rating: 5\n  - solid\n  scale: 10\n'), /!!yo/);
});

test('yamlover rt: a MULTILINE root omni self-value re-emits as a tagless block scalar, fields follow', () => {
  // a bare block-scalar self-value mixed with entries — no `!!var` (docs/language/vs-yaml/differences/mixtures)
  const out = rtYamlover('- solid\n|\n   multi\n   line\n- recommended\nscale: 10\n');
  assert.doesNotMatch(out, /!!var|!!omni/);
  assert.match(out, /^\|$/m); // the block-scalar introducer on its own line
  assert.match(out, /^ {2}multi$/m); // content indented under it
  assert.match(out, /^scale: 10$/m); // a field at the root indent
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
  const out = rtYamlover('!!<*yamlover: $defs: tag>\ntags: !!<*yamlover: $defs: tag> A taxonomy\n  field: About\nchunk: !!<format: text/x-plantuml> diagram\n');
  assert.match(out, /^!!<\*yamlover: \$defs: tag>$/m);
});

test('yamlover rt: duplicate back keys re-emit as distinct anchors', () => {
  // two same-named `~slug` memberships (the 67-pdf-tags shape) → two `&` anchor tokens
  const out = rtYamlover('"a.pdf":\n  ~slug: *: tags: x\n  ~slug: *: tags: y\ntags:\n  x: one\n  y: two\n');
  assert.match(out, /^ {2}&: tags: x: slug$/m);
  assert.match(out, /^ {2}&: tags: y: slug$/m);
  assert.doesNotMatch(out, /~slug/);
});

test('yamlover rt: empty containers, flow source', () => {
  rtYamlover('emptyMap: {}\nemptyArr: []\nflowMap: {a: 1, b: two}\nflowArr: [1, 2, three]\n');
});

test('yamlover rt: spacey keys re-render as quoted portions', () => {
  const out = rtYamlover('ref: *: \'some file with spaces.pdf\'\nodd: *\'has #comment\'\n');
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
  join(examples, '06-tour.yo'),
  join(examples, '08-flat.yo'),
  join(root, 'tags', '.yo', 'body.yo'),
];
for (const dir of readdirSync(examples, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const body = join(examples, dir.name, '.yo', 'body.yo');
  if (existsSync(body)) yamloverFiles.push(body);
}

for (const file of yamloverFiles) {
  test(`yamlover rt file: ${file.slice(root.length + 1)}`, () => {
    rtYamlover(readFileSync(file, 'utf8'), file);
  });
}

test('examples/08-flat.yo is a BYTE fixed point - the authored fold survives end to end', () => {
  const src = readFileSync(join(examples, '08-flat.yo'), 'utf8');
  assert.equal(serializeYamlover(parseYamlover(src, '08-flat'), { comments: true }), src);
});

test('examples/08-flat.yo: each flattenN block parses GRAPH-IDENTICAL to its unflattenN twin', () => {
  const doc = parseYamlover(readFileSync(join(examples, '08-flat.yo'), 'utf8'), '08-flat');
  const byKey = new Map((doc.root as Node).entries!.map((e) => [e.key, e.value]));
  for (const n of [1, 2, 3, 4]) {
    assert.ok(byKey.has(`flatten${n}`) && byKey.has(`unflatten${n}`), `pair ${n} present`);
    assert.deepEqual(
      canonDoc({ root: byKey.get(`flatten${n}`) } as Document),
      canonDoc({ root: byKey.get(`unflatten${n}`) } as Document),
      `pair ${n}: the flat spelling and the nested spelling are the same model`,
    );
  }
});

// ---- json5p: unit round-trips ----------------------------------------------------

test('json5p rt: object/array nesting, odd keys, escapes', () => {
  rtJson5p('{ pets: [{name: "Rex"}, {name: "Wh\'iskers"}], "odd/key": {n: 1}, "key with spaces": 2 }');
});

test('json5p rt: pointers, bookmarks, back-edges (keyed and keyless)', () => {
  const out = rtJson5p("{ boss: &': chief' {name: 'Rex'}, team: {lead: *': chief'}, eve: {cain: *': adam: cain'}, adam: {cain: {~cain: *': eve'}}, favorites: [*': adam'], fan: {name: 'Bob', ~*': favorites'}, thirty: &': tags: whole: -' 30 }");
  assert.match(out, /&": chief" \{/);
  assert.match(out, /&": tags: whole: -" 30/);
  // deprecated `~` forms re-emit as bookmarks (absolute scopes), colon-rendered
  assert.match(out, /&": eve: cain"/);
  assert.match(out, /&": favorites: -"/);
  assert.doesNotMatch(out, /~/);
});

test('json5p rt: numbers keep their spelling (hex, Infinity, NaN)', () => {
  const out = rtJson5p('{ hex: 0x1F, inf: Infinity, neg: -Infinity, nan: NaN, exp: 1e3 }');
  assert.match(out, /0x1F/);
  assert.match(out, /Infinity/);
});

test('json5p rt: a slash key rides bare in colon portions', () => {
  const out = rtJson5p("{ oddRef: *'odd/key: n' }");
  assert.match(out, /\*"odd\/key: n"/); // `/` is literal in colon portions
});

test('json5p lossy: yamlover tags are refused with a pointer to the meta layer', () => {
  assert.throws(() => serializeJson5p(parseYamlover('crew: !!set\n  - *: fan\nfan: x\n')), LossyError);
  assert.throws(() => serializeJson5p(parseYamlover('p: !!mix\n  - a\n  k: v\n')), LossyError);
  assert.throws(() => serializeJson5p(parseYamlover('r: 5\n  - solid\n')), LossyError); // omni
  assert.throws(() => serializeJson5p(parseYamlover('t: !!<*yamlover: $defs: tag> body\n')), LossyError);
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

test('cross rt: genealogy body.yo → json5p → IR-equal', () => {
  const src = readFileSync(join(examples, '58-genealogy-dag', '.yo', 'body.yo'), 'utf8');
  const doc = parseYamlover(src, '58-genealogy');
  const out = serializeJson5p(doc);
  assert.deepEqual(canonDoc(parseJson5p(out, '58-as-json5p')), canonDoc(doc), out);
});

test('cross lossy: 06-tour.yo does not fit json5p (mix/omni/set)', () => {
  const doc = parseYamlover(readFileSync(join(examples, '06-tour.yo'), 'utf8'), '06-tour');
  assert.throws(() => serializeJson5p(doc), LossyError);
});

// ── flow style: the `yaml/flow` representation concrete (docs/language/concretes) ──────────────────────
// An AUTHORED flow container re-emits as flow; anything flow cannot hold LOSSLESSLY falls back to
// block form rather than throwing or dropping. The refusal list here is the contract the editor's
// `flowFits` mirrors — if the two disagree, the screen and the file disagree.

test('yamlover rt: authored flow re-emits as flow, canonically spaced', () => {
  const src = 'a: {x: 1, y: 2}\nb: [1, 2, 3]\nc: [[1, 2], [3]]\nd: {k: [1, {n: 2}]}\n';
  assert.equal(serializeYamlover(parseYamlover(src, 't')), src);
  // FORMATTING is normalized, the STYLE is kept: the concrete is a classification, not the bytes
  assert.equal(serializeYamlover(parseYamlover('a: [1,2,  3]\n', 't')), 'a: [1, 2, 3]\n');
});

test('yamlover rt: a flow DOCUMENT root, and a flow element of a block sequence', () => {
  for (const src of ['[12, 13, 14]\n', '{a: 1}\n', '- [one, two]\n- [three]\n']) {
    assert.equal(serializeYamlover(parseYamlover(src, 't')), src);
  }
});

test('yamlover rt: flow keeps quoting, pointers and number spellings', () => {
  const src = "c: [x, 'a b', \"q\"]\nh: [0xff, 1.0, -0]\np: [*a[0], plain]\n";
  const out = serializeYamlover(parseYamlover(src, 't'));
  assert.match(out, /c: \[x, 'a b', q\]/); // a double-quoted cell with no metachar reads plain
  assert.match(out, /h: \[0xff, 1\.0, -0\]/); // authored spellings survive (repr.ts yaml/hex …)
  assert.match(out, /p: \[\*a:0, plain\]/); // the `[0]` alias re-emits as the bare position (compact in flow)
});

test('yamlover: block form is untouched — only an AUTHORED flow bit turns flow on', () => {
  const block = 'a:\n  x: 1\nb:\n  - 1\n  - 2\n';
  assert.equal(serializeYamlover(parseYamlover(block, 't')), block);
});

test('yamlover: a json5p document still serializes to BLOCK yamlover', () => {
  // json5p is flow END TO END by language; setting the per-node bit there would turn every
  // json→yamlover conversion into one giant line
  const out = serializeYamlover(parseJson5p('{a: 1, b: [2, 3]}', 't'));
  assert.doesNotMatch(out, /^\{/);
  assert.match(out, /a: 1/);
});

// ── K&R: a MULTI-LINE flow token is an inline concrete switch to json5p ─────────────────────
// docs/language/concretes/00-storage/00-inlined. One line ⇒ yamlover with the `yaml/flow` representation; several
// lines ⇒ the LANGUAGE changes, so the subtree re-emits through the json5p serializer (whose layout
// is K&R) and everything json5p cannot hold falls back to block, like flow's own refusals.

test('yamlover rt: a K&R token round-trips, at the root, under a key and on a dash', () => {
  for (const src of [
    '{\n  a: 1,\n  b: 2\n}\n',
    'k: {\n  a: 1,\n  b: 2\n}\n',
    'k: [\n  1,\n  2\n]\nnext: 9\n',
    '- [\n  1,\n  2\n]\n',
    'a:\n  b:\n    c: [\n      1\n    ]\n', // the closer aligns under its own key, at any depth
  ]) {
    assert.equal(serializeYamlover(parseYamlover(src, 't')), src);
  }
});

test('yamlover: the multi-line bit rides meta.concrete, and one line does NOT set it', () => {
  const multi = parseYamlover('k: {\n  a: 1\n}\n', 't').root.entries![0].value as Node;
  assert.equal(multi.meta?.concrete, 'json5p');
  assert.equal(multi.meta?.style, undefined); // ONE signal: the concrete already says flow
  const one = parseYamlover('k: {a: 1}\n', 't').root.entries![0].value as Node;
  assert.equal(one.meta?.concrete, undefined);
  assert.equal(one.meta?.style, 'flow');
});

test('yamlover: the switch is authored provenance, NOT part of IR identity', () => {
  // the same graph written both ways canonicalizes identically — which is what lets every fixture
  // and the edit corpus keep asserting canonDoc equality across a reflow
  const a = canonDoc(parseYamlover('k: {a: 1, b: 2}\n', 't'));
  const b = canonDoc(parseYamlover('k: {\n  a: 1,\n  b: 2\n}\n', 't'));
  assert.deepEqual(a, b);
});

test('yamlover: a K&R subtree carrying a schema tag falls back to BLOCK', () => {
  // json5p has no `!!<…>`, so its emitter refuses — and refusing means block form, never a drop
  const out = serializeYamlover(parseYamlover('k: !!<*x> {\n  a: 1\n}\n', 't'));
  assert.doesNotMatch(out, /\{/);
  assert.match(out, /a: 1/);
});

test('yamlover: YAML mode reads multi-line flow with NO concrete switch', () => {
  // yaml-test-suite 652Z/ZF4X/ZK9H — a flow collection may span lines (Ch. 7). There is no json5p
  // to switch to in a `.yaml` file, so it stays plain flow and re-emits on one line.
  const doc = parseYamlover('Sammy Sosa: {\n    hr: 63,\n    avg: 0.288\n  }\n', 't', { yaml: true });
  const v = doc.root.entries![0].value as Node;
  assert.equal(v.meta?.concrete, undefined);
  assert.equal(v.meta?.style, 'flow');
  assert.equal(serializeYamlover(doc), 'Sammy Sosa: {hr: 63, avg: 0.288}\n');
});

test('yamlover: flow FALLS BACK to block when it cannot hold the node losslessly', () => {
  // Parse REAL yamlover, then stamp the flow bit on a node flow cannot hold. A parse can never
  // produce this (the flow reader only ever sees flow-expressible content), but an editor or a
  // programmatic IR can — and a silent drop, or a throw, would each be the wrong answer.
  const cases: [string, string][] = [
    ['an anchored member', 'k:\n  - &p 1\n'],
    ['a tagged member', 'k:\n  - !!<format: text/x-plantuml> 1\n'],
    ['a multiline member', 'k:\n  - |\n    one\n    two\n'],
    ['a mixed keyed+keyless container', 'k:\n  a: 1\n  - 2\n'],
  ];
  for (const [name, src] of cases) {
    const doc = parseYamlover(src, 't');
    const k = doc.root.entries![0].value as Node;
    k.meta = { ...k.meta, style: 'flow' };
    const out = serializeYamlover(doc);
    assert.doesNotMatch(out, /^k: [[{]/m, `${name} must fall back to BLOCK form`);
    assert.ok(out.includes('k:'), `${name} must still serialize`);
  }
});

test('yamlover: the same stamp DOES turn on flow when flow can hold it (the control)', () => {
  const doc = parseYamlover('k:\n  - 1\n  - 2\n', 't');
  const k = doc.root.entries![0].value as Node;
  k.meta = { ...k.meta, style: 'flow' };
  assert.equal(serializeYamlover(doc), 'k: [1, 2]\n');
});

// ---- block scalars: the raw-first law and the minted fold (the `>` round) ----------------

test('yamlover rt: an authored folded scalar keeps its `>` spelling and wrap', () => {
  const src = 'p: >\n  one two\n  three\n';
  const doc = parseYamlover(src, 't');
  assert.equal((doc.root.entries![0].value as Node & { value?: unknown }).value, 'one two three\n');
  assert.equal(serializeYamlover(doc), src);
});

test('yamlover rt: authored chomping spellings survive — |-, >-, >+', () => {
  for (const src of ['p: |-\n  x\n', 'p: >-\n  a\n  b\n', 'p: >+\n  e\n\nq: 1\n', 'p: |+\n  z\n\nq: 1\n']) {
    assert.equal(serializeYamlover(parseYamlover(src, 't')), src, JSON.stringify(src));
  }
});

test('yamlover: a MINTED long paragraph folds (`>-`), wrapped, value breakless', () => {
  const words: string[] = [];
  for (let i = 0; i < 40; i++) words.push('word' + i);
  const text = words.join(' ');
  const doc = parseYamlover('p: short\n', 't');
  const p = doc.root.entries![0].value as Node & { value?: unknown; raw?: string };
  p.value = text;
  delete p.raw; // the editor drops raw on commit — a minted scalar
  const out = serializeYamlover(doc);
  assert.match(out, /^p: >-\n/, 'a long minted paragraph folds');
  for (const line of out.split('\n').slice(1)) assert.ok(line.length <= 120, `wrapped: ${line}`);
  const back = parseYamlover(out, 't') .root.entries![0].value as Node & { value?: unknown };
  assert.equal(back.value, text, 'the fold reparses to the very value');
});

test('yamlover: a minted MULTI-PARAGRAPH string folds with blank-line gaps', () => {
  const para = Array.from({ length: 20 }, (_, i) => 'w' + i).join(' ');
  const text = para + '\n\n' + para;
  const doc = parseYamlover('p: short\n', 't');
  const p = doc.root.entries![0].value as Node & { value?: unknown; raw?: string };
  p.value = text;
  delete p.raw;
  const out = serializeYamlover(doc);
  assert.match(out, /^p: >-\n/);
  const back = parseYamlover(out, 't').root.entries![0].value as Node & { value?: unknown };
  assert.equal(back.value, text);
});

test('yamlover: a minted string with a LONE newline stays literal (folding cannot spell it)', () => {
  const long = Array.from({ length: 20 }, (_, i) => 'w' + i).join(' ');
  const doc = parseYamlover('p: short\n', 't');
  const p = doc.root.entries![0].value as Node & { value?: unknown; raw?: string };
  p.value = long + '\n' + long;
  delete p.raw;
  assert.match(serializeYamlover(doc), /^p: \|-\n/);
});

test('yamlover: a SHORT minted string stays a plain inline token', () => {
  const doc = parseYamlover('p: short\n', 't');
  const p = doc.root.entries![0].value as Node & { value?: unknown; raw?: string };
  p.value = 'a short edited paragraph';
  delete p.raw;
  assert.equal(serializeYamlover(doc), 'p: a short edited paragraph\n');
});

test('yamlover: an authored long PLAIN line keeps its bytes (raw wins over the fold)', () => {
  const long = 'p: ' + Array.from({ length: 40 }, (_, i) => 'word' + i).join(' ') + '\n';
  assert.equal(serializeYamlover(parseYamlover(long, 't')), long);
});

// ---- identity tags on an EMPTIED container root (the cleared data island) ----------------

test('yamlover rt: a tagged EMPTY container root keeps its !!yo / !!set / !!<…> lines', () => {
  for (const src of ['!!yo\n[]\n', '!!set\n{}\n', '!!<*a: b>\n!!yo\n{}\n', '!!<*a: b>\n[]\n']) {
    const doc = parseYamlover(src, 't');
    assert.equal(serializeYamlover(doc), src, JSON.stringify(src));
  }
});
