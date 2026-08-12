// FLATTENED yamlover (docs/language/flattening): flat rows are path-paving COMMANDS — the
// multicomponent key reads exactly as the nested spelling, `-` segments append (trailing) or
// address the last keyless element (middle), a value lands write-once, and the authored fold
// survives round-trips as the yamlover/key/flat entry concrete. Nested is the normalized form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseYamlover } from '../src/yamlover.ts';
import { serializeYamlover } from '../src/serialize-yamlover.ts';
import { flattenYamlover, deflattenYamlover } from '../src/flatten.ts';
import { canonDoc } from '../src/canon.ts';

const parse = (s: string) => parseYamlover(s, '<flat>');
const eqNested = (flat: string, nested: string) =>
  assert.deepEqual(canonDoc(parse(flat)), canonDoc(parse(nested)), `flat ${JSON.stringify(flat)} ≠ nested ${JSON.stringify(nested)}`);

// ---- the doc's own examples, verbatim ---------------------------------------------------- //

test('flat: `key1: key2: key3: value` reads exactly as the nested spelling', () => {
  eqNested('key1: key2: key3: value\n', 'key1:\n  key2:\n    key3: value\n');
});

test('flat: the continuation block indents to the nested-equivalent columns', () => {
  eqNested('key1: key2: key3:\n      value\n', 'key1:\n  key2:\n    key3:\n      value\n');
  // parse-tolerant: ANY deeper column reads the same (the column law is an emission law)
  eqNested('key1: key2: key3:\n         value\n', 'key1:\n  key2:\n    key3: value\n');
});

test('flat: a trailing `-` APPENDS a new element and puts the value there', () => {
  eqNested('key1: key2: -: scalar\n', 'key1:\n  key2:\n    - scalar\n');
  eqNested('list: -: 1\nlist: -: 2\n', 'list:\n  - 1\n  - 2\n');
});

test('flat: switching from the flat key to nested keying also appends', () => {
  eqNested('key1: key2: -:\n      name: Alice\n      age: 30\n',
    'key1:\n  key2:\n    - name: Alice\n      age: 30\n');
});

test('flat: a middle `-` addresses the LAST keyless element and never adds one', () => {
  eqNested('key1: -: 1\nkey1: -: key3: 100\n', 'key1:\n  - 1\n    key3: 100\n');
  // with nothing to address it refuses — minting an element silently would betray "never adds"
  assert.throws(() => parse('key1: -: key3: 100\n'), /middle "-" segment/);
});

test('flat: WRITE-ONCE — a value lands only on a null-valued AND childless node', () => {
  // the doc's first invalid example: the value already holds 12
  assert.throws(() => parse('key1: key2: 12\nkey1: key2: 13\n'), /write-once/);
  // the doc's second: the value is null, but key3 is already under it
  assert.throws(() => parse('key1: key2: key3: 100\nkey1: key2: 13\n'), /write-once/);
  // …and landing on a genuinely null, childless node is the ordinary fill
  eqNested('key1: key2:\nkey1: key2: 13\n', 'key1:\n  key2: 13\n');
});

test('flat: the omni stays reachable — the value row FIRST, then children pave into it', () => {
  eqNested('k: 13\nk: sub: x\n', 'k: 13\n  sub: x\n');
});

// ---- combinations ------------------------------------------------------------------------ //

/** Walk entry values by key-position: `down(root, 0, 0)` descends entries[0].value twice. */
const down = (v: unknown, ...idx: number[]): { value?: unknown; meta?: { anchors?: { path: { raw: string } }[]; keyConcrete?: string }; entries?: unknown[] } => {
  let cur = v as { entries?: { value: unknown }[] };
  for (const i of idx) cur = (cur.entries ?? [])[i].value as typeof cur;
  return cur;
};

test('flat: `&` bookmark chains precede the value; each runs to the next `&` or the value', () => {
  const d = parse('normal: flat: key: &book: mark1: &another: book: mark: scalar\n');
  const key = down(d.root, 0, 0, 0);
  assert.equal(key.value, 'scalar');
  assert.deepEqual(key.meta?.anchors?.map((a) => a.path.raw), ['book: mark1', 'another: book: mark']);
});

test('flat: the continuation block carries further bookmark rows, fields and elements', () => {
  eqNested(
    'normal: flat: key: &book: mark: scalar\n      &third: book: mark\n      field1: value1\n      - value2\n',
    'normal:\n  flat:\n    key: scalar\n      &book: mark\n      &third: book: mark\n      field1: value1\n      - value2\n');
});

test('flat: a `*` reference lands as the value — and is EXCLUSIVE', () => {
  eqNested('normal: flat: key: *pull: link\n', 'normal:\n  flat:\n    key: *pull: link\n');
  // no bookmark may share the row: a pointer is an edge, not a node
  assert.throws(() => parse('a: b: &book: mark: *pull: link\n'), /reference is exclusive/);
  assert.throws(() => parse('a: &b *x\n'), /reference is exclusive/);
});

// ---- the path grammar -------------------------------------------------------------------- //

test('flat: quoted segments spell string keys, as everywhere', () => {
  eqNested("a: 'two words': v\n", "a:\n  'two words': v\n");
});

test('flat: a bare integer segment is a position — reserved, refused loudly', () => {
  assert.throws(() => parse('a: 0: x\n'), /plain numeric key is a position/);
});

test('flat: paving merges into the LAST same-key sibling', () => {
  eqNested('k1: a: 1\nk1: b: 2\n', 'k1:\n  a: 1\n  b: 2\n');
  // duplicate PLAIN rows still tolerate as siblings; the flat row paves into the last one
  const d = parse('k1: x\nk1: y\nk1: b: 2\n');
  const roots = (d.root as never as { entries: { key: string | null }[] }).entries;
  assert.deepEqual(roots.map((e) => e.key), ['k1', 'k1']);
});

test('flat: the concrete rides every segment after the first — canon ignores it', () => {
  const d = parse('key1: key2: key3: value\n');
  const e1 = (d.root as never as { entries: { meta?: { keyConcrete?: string }; value: { entries: { meta?: { keyConcrete?: string }; value: { entries: { meta?: { keyConcrete?: string } }[] } }[] } }[] }).entries[0];
  assert.equal(e1.meta?.keyConcrete, undefined); // the first segment owns the line
  assert.equal(e1.value.entries[0].meta?.keyConcrete, 'yamlover/key/flat');
  assert.equal(e1.value.entries[0].value.entries[0].meta?.keyConcrete, 'yamlover/key/flat');
});

// ---- what does NOT flatten --------------------------------------------------------------- //

test('flat: a `:`-led value token is a VALUE, never a path segment', () => {
  // the settings spelling `uri: ::: host` — a world-scope sigil value — must keep its reading
  const d = parse('uri: ::: yamlover.example\n');
  assert.equal((down(d.root, 0) as { value?: unknown }).value, '::: yamlover.example');
});

test('flat: quotes still make strings — the escape spelling holds the colon', () => {
  const d = parse("key1: 'key2: value'\n");
  assert.equal((d.root as never as { entries: { value: { value: unknown } }[] }).entries[0].value.value, 'key2: value');
});

test('flat: `.yaml` mode is exempt — YAML semantics untouched', () => {
  // YAML rejects the line; yamlover's yaml-mode parser keeps its own (non-flat) reading
  const d = parseYamlover('a: b: c\n', '<y>', { yaml: true });
  assert.equal((d.root as never as { entries: { value: { value: unknown } }[] }).entries[0].value.value, 'b: c');
});

test('flat: the legacy `-:` conversions survive byte-for-byte', () => {
  assert.equal(serializeYamlover(parse('a: 1\n-: 2\n')), 'a: 1\n- 2\n');
  assert.equal(serializeYamlover(parse('-:\n  name: Whiskers\n')), '- name: Whiskers\n');
  assert.equal(serializeYamlover(parse('-: - x\n')), '- - x\n');
  assert.equal(serializeYamlover(parse('-:x\n')), '-:x\n'); // tight colon: a plain scalar
});

// ---- emission: the authored fold is a byte FIXED POINT ----------------------------------- //

const fixpoint = (src: string) => {
  const out = serializeYamlover(parse(src));
  assert.equal(out, src, 'the authored fold must re-emit byte-identically');
  assert.equal(serializeYamlover(parse(out)), out, 'the emission must be serialize-stable');
};

test('flat: authored folds re-emit byte-identically (the concrete re-spells them)', () => {
  fixpoint('key1: key2: key3: value\n');
  fixpoint('k1: a: 1\nk1: b: 2\n');
  fixpoint('list: -: 1\nlist: -: 2\n');
  fixpoint('key1: key2: -:\n      name: Alice\n      age: 30\n');
  fixpoint('normal: flat: key: *pull: link\n');
});

test('flat: the fallback list DROPS the fold — nested emits, losslessly', () => {
  // the omni self value cannot fold: the value-first rows normalize to the nested omni
  assert.equal(serializeYamlover(parse('k: 13\nk: sub: x\n')), 'k: 13\n  sub: x\n');
  // comments between segments un-fold the chain (typography needs its own lines)
  const commented = parseYamlover('a: b: 1\n', '<c>');
  const seg = (commented.root as unknown as { entries: { value: { entries: { meta?: object }[] } }[] }).entries[0].value.entries[0];
  seg.meta = { ...seg.meta, comments: [{ text: ' x', placement: 'leading', style: 'line', span: { uri: '<c>', start: 0, end: 0 } }] };
  assert.equal(serializeYamlover(commented, { comments: true }).includes('a: b: 1'), false);
});

test('flat: a scalar VALUE containing ": " always emits quoted (reparse safety)', () => {
  const d = parse("a: 'b: c'\n");
  assert.equal(serializeYamlover(d), "a: 'b: c'\n");
});

// ---- the flatten / deflatten routines ---------------------------------------------------- //

test('flatten: nested → fully flat text; deflatten: back to the nested form — IR-equal throughout', () => {
  const nested = 'human1:\n  name: Alice\n  pets:\n    - name: Whiskers\n      kind: cat\n    - name: Rex\n';
  const doc = parse(nested);
  const flatText = serializeYamlover(flattenYamlover(doc));
  // the element blocks sit at the nested-equivalent columns: depth 3 (human1 > pets > -) × step 2
  assert.equal(flatText,
    'human1: name: Alice\nhuman1: pets: -:\n      name: Whiskers\n      kind: cat\nhuman1: pets: -:\n      name: Rex\n');
  const re = parse(flatText);
  assert.deepEqual(canonDoc(re), canonDoc(doc), 'the flat text must reparse IR-equal');
  assert.equal(serializeYamlover(re), flatText, 'the flat form is a fixed point');
  assert.equal(serializeYamlover(deflattenYamlover(re)), nested, 'deflatten returns the nested bytes');
});

test('flatten: does not mutate its input; deflatten strips every mark', () => {
  const doc = parse('a:\n  b: 1\n');
  const before = JSON.stringify(doc.root);
  flattenYamlover(doc);
  assert.equal(JSON.stringify(doc.root), before);
  const flat = flattenYamlover(doc);
  const marks = JSON.stringify(flat.root).match(/yamlover\/key\/flat/g) ?? [];
  assert.ok(marks.length > 0);
  assert.equal(JSON.stringify(deflattenYamlover(flat).root).includes('yamlover/key/flat'), false);
});

// ---- the corpus round-trip --------------------------------------------------------------- //

test('flatten round-trip over the corpus: every test-examples in.yo survives flatten→parse→deflatten', () => {
  const corpus = join(import.meta.dirname, '../../../../test-examples');
  const ids = readdirSync(corpus).filter((d) => /^\d{4}(-\d{2})?$/.test(d) && existsSync(join(corpus, d, 'in.yo')));
  assert.ok(ids.length >= 90, `corpus went missing? found ${ids.length}`);
  let flattened = 0;
  for (const id of ids) {
    const src = readFileSync(join(corpus, id, 'in.yo'), 'utf8');
    let doc;
    try { doc = parseYamlover(src, `test-examples/${id}/in.yo`); } catch { continue; } // error fixtures
    const flat = flattenYamlover(doc);
    let flatText: string;
    try { flatText = serializeYamlover(flat); } catch { continue; } // blob docs have no text form
    if (flatText.match(/^\S[^\n]*: \S[^\n]*: /m)) flattened++;
    const re = parseYamlover(flatText, `flat:${id}`);
    assert.deepEqual(canonDoc(re), canonDoc(doc), `${id}: the flattened text must reparse IR-equal`);
    assert.equal(serializeYamlover(re), flatText, `${id}: the flat form must be a fixed point`);
    const nested = serializeYamlover(deflattenYamlover(re));
    assert.deepEqual(canonDoc(parseYamlover(nested, `nested:${id}`)), canonDoc(doc), `${id}: deflatten must stay IR-equal`);
  }
  assert.ok(flattened >= 20, `suspiciously few fixtures actually flattened: ${flattened}`);
});
