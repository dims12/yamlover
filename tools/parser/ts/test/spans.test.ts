// Pointer source spans (PLAN.md 3e: the prerequisite for `mv`'s surgical ref rewriting).
// Contract: `Pointer.span` covers the WHOLE deref token — from the `*` sigil through the
// end of the (possibly quoted) pointer text — as absolute offsets into the source, so
// `src.slice(span.start, span.end)` is exactly the token to replace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Document, Node, Pointer, Value } from '../src/ir.ts';
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
