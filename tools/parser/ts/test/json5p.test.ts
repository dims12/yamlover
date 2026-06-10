import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson5p } from '../src/json5p.ts';
import { toPlain, isPointer } from '../src/ir.ts';

test('plain JSON parses and projects', () => {
  const d = parseJson5p('{"a":1,"b":[1,2,3],"c":null,"d":true,"e":"hi"}');
  assert.deepEqual(toPlain(d.root), { a: 1, b: [1, 2, 3], c: null, d: true, e: 'hi' });
});

test('JSON5 ergonomics: comments, unquoted keys, single quotes, trailing commas, numbers', () => {
  const src = `{
    // line comment
    unquoted: 'single',
    hex: 0xFF, frac: .5, trail: 5., neg: -3, exp: 1e3,
    inf: Infinity, ninf: -Infinity, nan: NaN,
    arr: [1, 2, 3,], /* block comment */
  }`;
  const v = toPlain(parseJson5p(src).root) as Record<string, unknown>;
  assert.equal(v.unquoted, 'single');
  assert.equal(v.hex, 255);
  assert.equal(v.frac, 0.5);
  assert.equal(v.trail, 5);
  assert.equal(v.neg, -3);
  assert.equal(v.exp, 1000);
  assert.equal(v.inf, Infinity);
  assert.equal(v.ninf, -Infinity);
  assert.ok(Number.isNaN(v.nan));
  assert.deepEqual(v.arr, [1, 2, 3]);
});

test('pointer value → ref edge with parsed base + steps', () => {
  const d = parseJson5p(`{ manager: *'/pets[1]/name' }`);
  const e = (d.root as any).entries[0];
  assert.equal(e.key, 'manager');
  assert.equal(e.edge, 'ref');
  assert.ok(isPointer(e.value));
  assert.deepEqual(e.value.base, { scope: 'document' });
  assert.deepEqual(e.value.steps, [
    { sel: 'key', name: 'pets' },
    { sel: 'index', n: 1 },
    { sel: 'key', name: 'name' },
  ]);
});

test('current-mapping pointer (no scope sigil)', () => {
  const e = (parseJson5p(`{ feline: *'pets[1]' }`).root as any).entries[0];
  assert.deepEqual(e.value.base, { scope: 'current' });
  assert.deepEqual(e.value.steps, [{ sel: 'key', name: 'pets' }, { sel: 'index', n: 1 }]);
});

test('link scope (// authority)', () => {
  const e = (parseJson5p(`{ x: *'//pet.store.com/pets' }`).root as any).entries[0];
  assert.deepEqual(e.value.base, { scope: 'link', authority: 'pet.store.com' });
  assert.deepEqual(e.value.steps, [{ sel: 'key', name: 'pets' }]);
});

test('back-edge: ~ sits outside the key', () => {
  const e = (parseJson5p(`{ ~cain: *'/eve' }`).root as any).entries[0];
  assert.equal(e.key, 'cain');
  assert.equal(e.edge, 'back');
  assert.deepEqual(e.value.base, { scope: 'document' });
});

test('& anchor recorded; *name is a current-scope pointer', () => {
  const d = parseJson5p(`{ boss: &chief { n: 1 }, ref: *'chief' }`);
  assert.ok(d.anchors.has('chief'));
  const ref = (d.root as any).entries[1];
  assert.equal(ref.edge, 'ref');
  assert.deepEqual(ref.value.base, { scope: 'current' });
  assert.deepEqual(ref.value.steps, [{ sel: 'key', name: 'chief' }]);
});

test('escaping: backslash makes a metachar literal (two layers)', () => {
  // JSON5 string '\\/' -> pointer text '\/' -> the literal key with a slash.
  const d = parseJson5p(String.raw`{ r: *'odd\\/key/n', dd: *'\\.\\.' }`);
  const [r, dd] = (d.root as any).entries;
  assert.deepEqual(r.value.steps, [{ sel: 'key', name: 'odd/key' }, { sel: 'key', name: 'n' }]);
  assert.deepEqual(dd.value.base, { scope: 'current' });
  assert.deepEqual(dd.value.steps, [{ sel: 'key', name: '..' }]);
});

test('duplicate keys: last wins on projection (matches JSON.parse)', () => {
  assert.deepEqual(toPlain(parseJson5p('{"a":1,"a":2}').root), JSON.parse('{"a":1,"a":2}'));
});

test('top-level scalar', () => {
  assert.equal(toPlain(parseJson5p('42').root), 42);
  assert.equal(toPlain(parseJson5p('"hi"').root), 'hi');
});

// ---- `~*'…'` keyless back members (reverse positional membership) ---------------

test('~*… in an object: a keyless back-edge member (no key, no colon)', () => {
  const d = parseJson5p("{ my_node: { name: 'x', ~*'/some/list' } }");
  const my = (d.root as Mapping).entries[0].value as Mapping;
  const back = my.entries.find((e) => e.edge === 'back')!;
  assert.equal(back.key, null);
  assert.ok(isPointer(back.value));
  assert.equal((back.value as { raw: string }).raw, '/some/list');
});

test('~*… among array elements: a back member that takes no position', () => {
  const d = parseJson5p("[1, ~*'/some/list', 2]");
  const m = d.root as Mapping;
  assert.equal(m.array, true);
  assert.deepEqual(m.entries.map((e) => e.edge), ['contain', 'back', 'contain']);
  assert.equal(m.entries[1].key, null);
});

test('~ in an array must introduce a pointer', () => {
  assert.throws(() => parseJson5p('[~1]'), /expected a pointer/);
});
