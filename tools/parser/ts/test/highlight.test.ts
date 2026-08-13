// The shared highlighting lexer (highlight.ts): a heuristic classifier, not the grammar —
// so the tests pin (a) TOTALITY: slices always concatenate back to the input, and (b) the
// classification of every construct family the docs' code chunks actually use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, type HlKind, type HlLang } from '../src/highlight.ts';

/** Slices must reassemble the input exactly — the invariant every consumer builds on. */
function total(src: string, lang: HlLang = 'yamlover'): ReturnType<typeof tokenize> {
  const toks = tokenize(src, lang);
  assert.equal(toks.map((t) => t.text).join(''), src);
  return toks;
}

/** The (kind, text) pairs with whitespace runs dropped — the shape most assertions want. */
function kinds(src: string, lang: HlLang = 'yamlover'): [HlKind, string][] {
  return total(src, lang).filter((t) => t.kind !== 'space').map((t) => [t.kind, t.text]);
}

test('hl: keys, scalars, keywords, numbers', () => {
  assert.deepEqual(kinds('name: Rex\nage: 4\nok: true\nnothing: ~\n'), [
    ['key', 'name'], ['punct', ':'], ['plain', 'Rex'],
    ['key', 'age'], ['punct', ':'], ['number', '4'],
    ['key', 'ok'], ['punct', ':'], ['keyword', 'true'],
    ['key', 'nothing'], ['punct', ':'], ['null', '~'],
  ]);
  // hex and the YAML float specials are numbers; a word is plain
  assert.deepEqual(kinds('a: 0xff\nb: -.inf\n').filter(([k]) => k === 'number'), [
    ['number', '0xff'], ['number', '-.inf'],
  ]);
});

test('hl: comments only open after whitespace / BOL', () => {
  assert.deepEqual(kinds('a: b # note\n'), [
    ['key', 'a'], ['punct', ':'], ['plain', 'b'], ['comment', '# note'],
  ]);
  // `a#b` is one scalar — no comment
  assert.deepEqual(kinds('x: a#b\n'), [['key', 'x'], ['punct', ':'], ['plain', 'a#b']]);
});

test('hl: a pointer path runs to end of line, portions as refs', () => {
  assert.deepEqual(kinds('manager: *: pets[1]: name\n'), [
    ['key', 'manager'], ['punct', ':'],
    ['pointer', '*'], ['punct', ':'], ['ref', 'pets'], ['punct', '['], ['number', '1'], ['punct', ']'],
    ['punct', ':'], ['ref', 'name'],
  ]);
  // an anchor is the same grammar behind `&`; a trailing comment still ends it
  assert.deepEqual(kinds('&:: tags: whole: - # also there\n')[0], ['pointer', '&']);
  assert.ok(kinds('&:: tags: whole: - # also there\n').some(([k, t]) => k === 'comment' && t === '# also there'));
});

test('hl: sequence dashes, flow punctuation, standalone [n] index', () => {
  assert.deepEqual(kinds('- item\n'), [['dash', '-'], ['plain', 'item']]);
  assert.deepEqual(kinds('b: [1, 2]\n'), [
    ['key', 'b'], ['punct', ':'], ['punct', '['], ['number', '1'], ['punct', ','], ['number', '2'], ['punct', ']'],
  ]);
  assert.deepEqual(kinds('[256, 256]: *thumb\n')[0], ['punct', '[']);
});

test('hl: tags — !!<…> and the !!word type tags', () => {
  assert.deepEqual(kinds('!!<*yamlover: $defs: chapter>\n'), [['tag', '!!<*yamlover: $defs: chapter>']]);
  assert.deepEqual(kinds('rating: !!yo 5\n'), [
    ['key', 'rating'], ['punct', ':'], ['tag', '!!yo'], ['number', '5'],
  ]);
});

test('hl: quoted strings and quoted keys', () => {
  assert.deepEqual(kinds("space: 'дорожный знак'\n"), [
    ['key', 'space'], ['punct', ':'], ['string', "'дорожный знак'"],
  ]);
  assert.deepEqual(kinds('"key with spaces": 1\n')[0], ['key', '"key with spaces"']);
});

test('hl: a block scalar body is opaque — never re-lexed', () => {
  const toks = kinds('note: |\n  key: not a key\n  # not a comment\nafter: 1\n');
  // the body rides as plain; the following sibling lexes normally again
  assert.ok(toks.some(([k, t]) => k === 'plain' && t.includes('key: not a key') && t.includes('# not a comment')));
  assert.ok(toks.some(([k, t]) => k === 'key' && t === 'after'));
});

test('hl: a TAGGED block scalar is still a block — the tag decorates the value', () => {
  // `- !!<format: text/plain> |` — an unbalanced quote in the body must NOT bleed a string
  // into the sibling below (the ABNF-in-the-book case)
  const tagged = kinds('- !!<format: text/plain> |\n  name = "\\" CHAR\nafter: 1\n');
  assert.ok(tagged.some(([k, t]) => k === 'plain' && t.includes('name = "\\" CHAR')));
  assert.ok(tagged.some(([k, t]) => k === 'key' && t === 'after'));
  // the bare-name tag form: `- !!yo |`
  const bare = kinds('- !!yo |\n  a: "open\nafter: 1\n');
  assert.ok(bare.some(([k, t]) => k === 'plain' && t.includes('a: "open')));
  assert.ok(bare.some(([k, t]) => k === 'key' && t === 'after'));
  // but a `>` that is ordinary scalar content still does not open a block: the next line's
  // `c:` lexes as a real key, not as opaque body
  assert.ok(kinds('x: a > b |\n  c: 1\n').some(([k, t]) => k === 'key' && t === 'c'));
  total('x: a > b |\n  c: 1\n');
});

test('hl: totality on adversarial half-typed input', () => {
  total('x: "unterminated\n  - *:\n!!<open\n| \n');
  total('*');
  total('');
});

test('hl json5p: slash comments, quoted pointers, no # comments', () => {
  const toks = kinds("{a: 1, b: *': pets[1]'} // tail\n", 'json5p');
  assert.ok(toks.some(([k, t]) => k === 'comment' && t === '// tail'));
  assert.ok(toks.some(([k, t]) => k === 'ref' && t === "': pets[1]'"));
  assert.deepEqual(kinds('x: a#b // c\n', 'json5p').find(([, t]) => t.includes('#')), ['plain', 'a#b']);
  total('/* block\ncomment */ {a: 1}', 'json5p');
});

test('hl yaml: a bare alias/anchor name is one ref, no colon run', () => {
  assert.deepEqual(kinds('a: &x 1\nb: *x\n', 'yaml'), [
    ['key', 'a'], ['punct', ':'], ['pointer', '&'], ['ref', 'x'], ['number', '1'],
    ['key', 'b'], ['punct', ':'], ['pointer', '*'], ['ref', 'x'],
  ]);
});

test('hl: FLAT rows - every path segment colours as a KEY, the `-:` segment as the DASH', () => {
  // docs/language/flattening: `a: a: a: 12` is a flat row — each word-before-colon is a key
  assert.deepEqual(kinds('a: a: a: 12\n'), [
    ['key', 'a'], ['punct', ':'], ['key', 'a'], ['punct', ':'], ['key', 'a'], ['punct', ':'], ['number', '12'],
  ]);
  // the keyless segment `-:` keeps the sequence-marker colour, never a key's
  assert.deepEqual(kinds('human1: pets: -: 1\n'), [
    ['key', 'human1'], ['punct', ':'], ['key', 'pets'], ['punct', ':'], ['dash', '-:'], ['number', '1'],
  ]);
});
