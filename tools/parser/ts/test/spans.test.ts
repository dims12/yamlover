// Pointer source spans (PLAN.md 3e: the prerequisite for `mv`'s surgical ref rewriting).
// Contract: `Pointer.span` covers the WHOLE deref token — from the `*` sigil through the
// end of the (possibly quoted) pointer text — as absolute offsets into the source, so
// `src.slice(span.start, span.end)` is exactly the token to replace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Document, Entry, Node, Pointer, Value } from '../src/ir.ts';
import { isPointer } from '../src/ir.ts';
import { parseYamlover } from '../src/yamlover.ts';
import { parseJson5p } from '../src/json5p.ts';

/** All pointers in document order (entries, omni fields, schema metas). */
function pointers(doc: Document): Pointer[] {
  const out: Pointer[] = [];
  const visitValue = (v: Value): void => {
    if (isPointer(v)) { out.push(v); return; }
    visitNode(v);
  };
  const visitNode = (n: Node): void => {
    if (n.meta?.schema !== undefined) visitValue(n.meta.schema);
    for (const e of n.entries ?? []) visitValue(e.value);
  };
  visitNode(doc.root);
  return out;
}

/** Assert every pointer has a span and each slices to the expected token, in order. */
function expectTokens(src: string, doc: Document, tokens: string[]): void {
  const ps = pointers(doc);
  assert.equal(ps.length, tokens.length, `pointer count in:\n${src}`);
  ps.forEach((p, i) => {
    assert.ok(p.span, `pointer ${i} ("*${p.raw}") has no span`);
    assert.equal(src.slice(p.span!.start, p.span!.end), tokens[i], `pointer ${i} span in:\n${src}`);
  });
}

const y = (src: string, tokens: string[]) => expectTokens(src, parseYamlover(src, '<t>'), tokens);
const j = (src: string, tokens: string[]) => expectTokens(src, parseJson5p(src, '<t>'), tokens);

// ---- yamlover ------------------------------------------------------------------

test('span: keyed value pointer', () => {
  y('feline: *pets[1]\n', ['*pets[1]']);
});

test('span: quoted pointer (spaces, comment chars)', () => {
  y("odd: *'has #comment and spaces'\n", ["*'has #comment and spaces'"]);
});

test('span: keyed back-edge ~k:', () => {
  y('adam:\n  cain:\n    ~cain: */eve\neve:\n  cain: */adam/cain\n', ['*/eve', '*/adam/cain']);
});

test('span: keyless back-edge ~- (incl. extra spacing)', () => {
  y('fan:\n  name: Bob\n  ~-   */favorites\nfavorites:\n  - x\n', ['*/favorites']);
});

test('span: seq item pointer', () => {
  y('list:\n  - */a\n  - *b\na: 1\nb: 2\n', ['*/a', '*b']);
});

test('span: compact "- k: *p" (the line-rewrite path)', () => {
  y('people:\n  - name: Al\n    boss: */people[1]\n  - name: Bo\n', ['*/people[1]']);
});

test('span: after !!<…> and !!set strips (valueAfter column chain)', () => {
  const src = 'crew: !!set\n  - */fan\nfan: x\nt: !!<*yamlover/$defs/tag> body\n';
  // entry pointer first (document order), then the schema pointer (visited via meta)
  const doc = parseYamlover(src, '<t>');
  const ps = pointers(doc);
  const toks = ps.map((p) => src.slice(p.span!.start, p.span!.end));
  assert.deepEqual(new Set(toks), new Set(['*/fan', '*yamlover/$defs/tag']));
});

test('span: root !!<…> schema pointer', () => {
  const src = '!!<*yamlover/$defs/annotation>\ntarget: *//x/y\n';
  y(src, ['*yamlover/$defs/annotation', '*//x/y']);
});

test('span: flow duplicates get distinct spans', () => {
  const src = 'pair: [*a, *a]\na: 1\n';
  const doc = parseYamlover(src, '<t>');
  const ps = pointers(doc);
  assert.equal(ps.length, 2);
  assert.notEqual(ps[0].span!.start, ps[1].span!.start);
  for (const p of ps) assert.equal(src.slice(p.span!.start, p.span!.end), '*a');
});

test('span: flow map values', () => {
  y('m: {x: *t, y: *t}\nt: 1\n', ['*t', '*t']);
});

test('span: CRLF source offsets', () => {
  const src = 'a: 1\r\nfeline: *a\r\n~back: */a\r\n';
  y(src, ['*a', '*/a']);
});

test('span: trailing comment after a pointer is excluded', () => {
  y('feline: *pets[1]   # the cat\npets:\n  - x\n  - y\n', ['*pets[1]']);
});

test('span: anchored value is not a pointer; pointer after &name in seq', () => {
  // `- &a *p` is illegal (cannot anchor a pointer) — instead check the &-strip column
  // chain with a scalar, then a separate pointer entry
  const src = 'boss: &chief\n  name: Rex\nlead: *chief\n';
  y(src, ['*chief']);
});

test('span: deep indentation', () => {
  const src = 'a:\n  b:\n    c:\n      d: */a/b\n';
  y(src, ['*/a/b']);
});

test('span: spaced pointer path (unquoted raw with spaces)', () => {
  y('ref: */some file, with spaces.pdf\n', ['*/some file, with spaces.pdf']);
});

// ---- json5p --------------------------------------------------------------------

test('span: json5p single- and double-quoted pointers', () => {
  j(`{ a: *'x/y', b: *"z" , x: {y: 1}, z: 2 }`, [`*'x/y'`, `*"z"`]);
});

test('span: json5p keyless back members in object and array', () => {
  j(`{ fan: { name: 'Bob', ~*'/favorites' }, favorites: [ *'/fan' ] }`, [`~*'/favorites'`.slice(1), `*'/fan'`]);
});

test('span: json5p pointers across comments and lines', () => {
  const src = `{
  // a comment
  feline: *'pets[1]', /* block */ top: *'/pets[0]',
  pets: [1, 2],
}`;
  j(src, [`*'pets[1]'`, `*'/pets[0]'`]);
});

test('span: json5p escaped pointer string', () => {
  j(`{ oddRef: *'odd\\\\/key/n', "odd/key": { n: 1 } }`, [`*'odd\\\\/key/n'`]);
});

// ---- entry spans (EntryMeta.span) ----------------------------------------------
// The whole entry: key/`-`/`~` marker start … value end (post-strip — a trailing
// comment / whitespace is excluded). `src.slice(span)` is the editable entry text.

/** Map every entry of the root node to its source slice (document order, top level only). */
function rootEntrySlices(src: string, doc: Document): string[] {
  return (doc.root.entries ?? []).map((e) => {
    assert.ok(e.meta?.span, `entry "${e.key}" has no span`);
    return src.slice(e.meta!.span!.start, e.meta!.span!.end);
  });
}

/** Recursively collect (key, slice) for every entry that has a span. */
function allEntrySlices(src: string, doc: Document): Array<[string | null, string]> {
  const out: Array<[string | null, string]> = [];
  const walk = (n: Node): void => {
    for (const e of n.entries ?? []) {
      if (e.meta?.span) out.push([e.key, src.slice(e.meta.span.start, e.meta.span.end)]);
      if (!isPointer(e.value)) walk(e.value);
    }
  };
  walk(doc.root);
  return out;
}

test('entry span: yamlover inline scalar entries', () => {
  const src = 'name: Alice\nage: 30\n';
  assert.deepEqual(rootEntrySlices(src, parseYamlover(src, '<t>')), ['name: Alice', 'age: 30']);
});

test('entry span: yamlover excludes a trailing comment', () => {
  const src = 'name: Alice   # full name\nage: 30\n';
  assert.deepEqual(rootEntrySlices(src, parseYamlover(src, '<t>')), ['name: Alice', 'age: 30']);
});

test('entry span: yamlover nested block covers the whole subtree', () => {
  const src = 'user:\n  name: Alice\n  age: 30\nflag: true\n';
  const doc = parseYamlover(src, '<t>');
  assert.deepEqual(rootEntrySlices(src, doc), ['user:\n  name: Alice\n  age: 30', 'flag: true']);
  // and the inner entries carry their own (narrower) spans
  assert.deepEqual(allEntrySlices(src, doc), [
    ['user', 'user:\n  name: Alice\n  age: 30'],
    ['name', 'name: Alice'],
    ['age', 'age: 30'],
    ['flag', 'flag: true'],
  ]);
});

test('entry span: yamlover sequence items and pointer entries', () => {
  const src = 'list:\n  - a\n  - b\nref: *list[0]\n';
  const doc = parseYamlover(src, '<t>');
  assert.deepEqual(allEntrySlices(src, doc), [
    ['list', 'list:\n  - a\n  - b'],
    [null, '- a'],
    [null, '- b'],
    ['ref', 'ref: *list[0]'],
  ]);
});

test('entry span: yamlover block scalar value', () => {
  const src = 'doc: |\n  line one\n  line two\nafter: 1\n';
  const doc = parseYamlover(src, '<t>');
  const slices = rootEntrySlices(src, doc);
  assert.match(slices[0], /^doc: \|\n {2}line one\n {2}line two$/);
  assert.equal(slices[1], 'after: 1');
});

test('entry span: yamlover CRLF offsets', () => {
  const src = 'name: Alice\r\nage: 30\r\n';
  assert.deepEqual(rootEntrySlices(src, parseYamlover(src, '<t>')), ['name: Alice', 'age: 30']);
});

test('entry span: yamlover compact "- key: value"', () => {
  const src = 'people:\n  - name: Al\n    age: 9\n';
  const doc = parseYamlover(src, '<t>');
  // the seq item spans the compact block; the inner keyed entries narrow in
  assert.deepEqual(allEntrySlices(src, doc), [
    ['people', 'people:\n  - name: Al\n    age: 9'],
    [null, '- name: Al\n    age: 9'], // the keyless item span includes the `- ` marker
    ['name', 'name: Al'],
    ['age', 'age: 9'],
  ]);
});

test('node span: yamlover root covers the document', () => {
  const src = 'a: 1\nb: 2\n';
  const doc = parseYamlover(src, '<t>');
  assert.ok(doc.root.meta?.span);
  assert.equal(doc.root.meta!.span!.start, 0);
  assert.equal(doc.root.meta!.span!.end, src.length);
});

test('entry span: json5p object and array entries', () => {
  const src = `{ name: "Alice", age: 30, list: [1, 2] }`;
  const doc = parseJson5p(src, '<t>');
  assert.deepEqual(allEntrySlices(src, doc), [
    ['name', 'name: "Alice"'],
    ['age', 'age: 30'],
    ['list', 'list: [1, 2]'],
    [null, '1'],
    [null, '2'],
  ]);
});

test('entry span: json5p excludes trailing whitespace/comment before comma', () => {
  const src = `{\n  a: 1, // first\n  b: 2,\n}`;
  const doc = parseJson5p(src, '<t>');
  assert.deepEqual(rootEntrySlices(src, doc), ['a: 1', 'b: 2']);
});

test('node span: json5p root covers the document', () => {
  const src = `{ a: 1 }`;
  const doc = parseJson5p(src, '<t>');
  assert.ok(doc.root.meta?.span);
  assert.equal(doc.root.meta!.span!.start, 0);
  assert.equal(doc.root.meta!.span!.end, src.length);
});
