import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYamlover } from '../src/yamlover.ts';
import { toPlain, isPointer } from '../src/ir.ts';
import type { Mapping } from '../src/ir.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', '..', 'examples');

const asMap = (n: unknown) => n as Mapping;
const entry = (m: Mapping, k: string) => m.entries.find((e) => e.key === k)!;

test('block mapping with scalars', () => {
  const d = parseYamlover('name: Alice\nage: 30\nadmin: true\nnote: ~');
  assert.deepEqual(toPlain(d.root), { name: 'Alice', age: 30, admin: true, note: null });
});

test('nested block mapping', () => {
  const d = parseYamlover('user:\n  name: Alice\n  age: 30\n');
  assert.deepEqual(toPlain(d.root), { user: { name: 'Alice', age: 30 } });
});

test('block sequence of scalars', () => {
  const d = parseYamlover('- a\n- 2\n- true\n');
  assert.deepEqual(toPlain(d.root), ['a', 2, true]);
});

test('compact sequence of mappings', () => {
  const d = parseYamlover('pets:\n  - name: Rex\n    species: dog\n  - name: Whiskers\n    species: cat\n');
  assert.deepEqual(toPlain(d.root), { pets: [{ name: 'Rex', species: 'dog' }, { name: 'Whiskers', species: 'cat' }] });
});

test('block sequence at the SAME indent as its key (zero-indent seq)', () => {
  // YAML allows `key:` then `- …` at the parent's column (the 61-image-with-markup shape)
  const d = parseYamlover('markup:\n- x: 1\n  y: 2\n- x: 3\n  y: 4\nother: 9\n');
  assert.deepEqual(toPlain(d.root), { markup: [{ x: 1, y: 2 }, { x: 3, y: 4 }], other: 9 });
});

test('flow mapping and sequence', () => {
  const d = parseYamlover('a: {x: 1, y: 2}\nb: [1, 2, 3]\n');
  assert.deepEqual(toPlain(d.root), { a: { x: 1, y: 2 }, b: [1, 2, 3] });
});

test('pointer value → ref edge with parsed base/steps (unquoted)', () => {
  const d = parseYamlover('manager: */pets[1]/name\n');
  const e = entry(asMap(d.root), 'manager');
  assert.equal(e.edge, 'ref');
  assert.ok(isPointer(e.value));
  assert.deepEqual((e.value as any).base, { scope: 'document' });
  assert.deepEqual((e.value as any).steps, [
    { sel: 'key', name: 'pets' }, { sel: 'index', n: 1 }, { sel: 'key', name: 'name' },
  ]);
});

test('& anchor on a block value; alias is a pointer', () => {
  const d = parseYamlover('boss: &chief\n  name: Rex\nteam:\n  lead: *chief\n');
  assert.ok(d.anchors.has('chief'));
  const lead = entry(asMap(entry(asMap(d.root), 'team').value as Mapping), 'lead');
  assert.equal(lead.edge, 'ref');
  assert.deepEqual((lead.value as any).steps, [{ sel: 'key', name: 'chief' }]);
});

test('~ back-edge key (sigil outside the key)', () => {
  const d = parseYamlover('adam:\n  cain:\n    ~cain: */eve\n');
  const cain = entry(asMap(entry(asMap(d.root), 'adam').value as Mapping), 'cain');
  const back = entry(cain.value as Mapping, 'cain');
  assert.equal(back.edge, 'back');
  assert.deepEqual((back.value as any).base, { scope: 'document' });
});

test('escaping: literal key with slash, and \\.\\.', () => {
  const d = parseYamlover('weird:\n  cat\\/dog:\n    n: 1\nref: *weird/cat\\/dog/n\ndots: *\\.\\.\n');
  // the literal key is "cat/dog"
  const weird = entry(asMap(d.root), 'weird').value as Mapping;
  assert.equal(weird.entries[0].key, 'cat/dog');
  const ref = entry(asMap(d.root), 'ref');
  assert.deepEqual((ref.value as any).steps, [
    { sel: 'key', name: 'weird' }, { sel: 'key', name: 'cat/dog' }, { sel: 'key', name: 'n' },
  ]);
  const dots = entry(asMap(d.root), 'dots');
  assert.deepEqual((dots.value as any).steps, [{ sel: 'key', name: '..' }]);
});

test('parses examples/05-tour.yaml (YAML anchors/aliases)', () => {
  const d = parseYamlover(readFileSync(join(examples, '05-tour.yaml'), 'utf8'), '05-tour.yaml');
  assert.ok(d.anchors.has('whiskers'));
  const pets = entry(asMap(d.root), 'pets').value as Mapping;
  assert.equal(pets.array, true);
  assert.equal(pets.entries.length, 3);
  // humans[0].manager is an alias (pointer) to the whiskers anchor
  const humans = entry(asMap(d.root), 'humans').value as Mapping;
  const mgr = entry(humans.entries[0].value as Mapping, 'manager');
  assert.equal(mgr.edge, 'ref');
  assert.deepEqual((mgr.value as any).steps, [{ sel: 'key', name: 'whiskers' }]);
});

test('parses examples/06-tour.yamlover (full pointer layer)', () => {
  const d = parseYamlover(readFileSync(join(examples, '06-tour.yamlover'), 'utf8'), '06-tour.yamlover');
  const root = asMap(d.root);
  assert.ok(d.anchors.has('chief'));
  // a representative set of edges
  assert.equal(entry(root, 'feline').edge, 'ref');
  assert.equal(entry(root, 'topDog').edge, 'ref');
  assert.equal(entry(root, 'secondName').edge, 'ref');
  // back-edge deep in adam.cain
  const cain = entry(asMap(entry(root, 'adam').value as Mapping), 'cain').value as Mapping;
  assert.equal(cain.entries[0].edge, 'back');
  // escaping resolved to the literal key "cat/dog"
  assert.deepEqual((entry(root, 'ref').value as any).steps, [
    { sel: 'key', name: 'weird' }, { sel: 'key', name: 'cat/dog' }, { sel: 'key', name: 'n' },
  ]);
});
