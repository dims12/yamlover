// The fragment-token scanner (docs/documents/marklower/grammar): [..](..) as flow syntax for an
// omni fragment — bookmarks + self-value in [], the field kseq in (), a keyless pointer/URL the
// link, with the whole-content classification keeping every plain hyperlink reading unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanMarklower, linkTargets, type FragToken } from '../src/marklower-links.ts';

const frag = (src: string): FragToken => {
  const toks = scanMarklower(src).filter((t) => t.kind === 'frag');
  assert.equal(toks.length, 1, src);
  return toks[0] as FragToken;
};

test('a plain pointer link is unchanged — whole-content classification wins', () => {
  const t = frag('see [the intro](*::a:b) please');
  assert.equal(t.plainLink, true);
  assert.equal(t.link, '*::a:b');
  assert.equal(t.value, 'the intro');
  assert.deepEqual(t.bookmarks, []);
  const [l] = linkTargets('see [the intro](*::a:b) please');
  assert.equal(l.target, '*::a:b');
  assert.equal('see [the intro](*::a:b) please'.slice(l.targetStart, l.targetEnd), '*::a:b');
});

test('a URL with parens balances — the old first-close truncation is gone', () => {
  const t = frag('[x](https://en.wikipedia.org/wiki/Foo_(bar))');
  assert.equal(t.link, 'https://en.wikipedia.org/wiki/Foo_(bar)');
});

test('empty parens define a fragment with no fields', () => {
  const t = frag('reads twice: [once to scan](), once to build');
  assert.equal(t.link, null);
  assert.equal(t.value, 'once to scan');
  assert.deepEqual(t.fields, []);
  assert.deepEqual(linkTargets('reads twice: [once to scan]()'), []); // no link — nothing to rewrite
});

test('a membership bookmark rides the label, self-delimited by its trailing `-`', () => {
  const t = frag('[&:: yamlover: ontos: colors: yellow: -: once to scan]()');
  assert.deepEqual(t.bookmarks, ['&:: yamlover: ontos: colors: yellow: -']);
  assert.equal(t.value, 'once to scan');
});

test('a quoted label value follows the yamlover scalar rules', () => {
  assert.equal(frag("['reads: twice']()").value, 'reads: twice');
  assert.equal(frag("[&'a: b' hello]()").bookmarks.length, 1);
  assert.equal(frag("[&'a: b' hello]()").value, 'hello');
});

test('keyed fields parse from the kseq; a keyless pointer among them is the link', () => {
  const t = frag("[a](*: b, description: 'x, y')");
  assert.equal(t.link, '*: b');
  assert.deepEqual(t.fields, [{ key: 'description', raw: "'x, y'" }]);
  const [l] = linkTargets("[a](*: b, description: 'x, y')");
  assert.equal("[a](*: b, description: 'x, y')".slice(l.targetStart, l.targetEnd), '*: b');
});

test('a description-only kseq is a fragment, not a link', () => {
  const t = frag('[a](description: something)');
  assert.equal(t.link, null);
  assert.deepEqual(t.fields, [{ key: 'description', raw: 'something' }]);
});

test('the scheme collision resolves by precedence: a whole mailto is the external link', () => {
  const t = frag('[e](mailto:x@y.z)');
  assert.equal(t.plainLink, true);
  assert.equal(t.link, 'mailto:x@y.z');
});

test('a code span hides its bracket pairs; a bare [word] stays prose', () => {
  assert.deepEqual(scanMarklower('use `[a](b)` here').filter((t) => t.kind === 'frag'), []);
  assert.deepEqual(scanMarklower('a [bracketed] word').length, 0);
});

test('a path with [n] indices still works as its own label', () => {
  const t = frag('[:children[0]](:children[0])');
  assert.equal(t.link, ':children[0]');
  assert.equal(t.value, ':children[0]');
});
