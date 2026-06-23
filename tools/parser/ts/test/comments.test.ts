// Comment retention (IR.md). The parsers capture `#` (yamlover) and `//` / block (json5p)
// comments and the attachment pass (comments.ts) places them onto the tree:
//  • leading → the entry below; trailing → the entry on the same line; a top banner set off
//    by a blank line → Document.head; leftovers → the root node (never dropped).
// Comments are typography: they do NOT affect graph identity (see serialize.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Comment, Document, Entry, Node } from '../src/ir.ts';
import { isPointer } from '../src/ir.ts';
import { parseYamlover } from '../src/yamlover.ts';
import { parseJson5p } from '../src/json5p.ts';

/** Find the first entry whose key matches, anywhere in the tree. */
function entry(doc: Document, key: string): Entry {
  let found: Entry | undefined;
  const walk = (n: Node): void => {
    for (const e of n.entries ?? []) {
      if (e.key === key && !found) found = e;
      if (!isPointer(e.value)) walk(e.value);
    }
  };
  walk(doc.root);
  if (!found) throw new Error(`no entry "${key}"`);
  return found;
}

const texts = (cs: Comment[] | undefined, p?: 'leading' | 'trailing'): string[] =>
  (cs ?? []).filter((c) => !p || c.placement === p).map((c) => c.text);

// ---- yamlover ------------------------------------------------------------------

test('comment: yamlover leading attaches to the entry below', () => {
  const doc = parseYamlover('# the name\nname: Alice\nage: 30\n', '<t>');
  assert.deepEqual(texts(entry(doc, 'name').meta?.comments, 'leading'), [' the name']);
  assert.equal(entry(doc, 'age').meta?.comments, undefined);
});

test('comment: yamlover trailing stays on the entry line', () => {
  const doc = parseYamlover('name: Alice   # full name\nage: 30\n', '<t>');
  const c = entry(doc, 'name').meta?.comments ?? [];
  assert.equal(c.length, 1);
  assert.equal(c[0].placement, 'trailing');
  assert.equal(c[0].text, ' full name');
});

test('comment: yamlover trailing span slices to the token', () => {
  const src = 'name: Alice   # full name\n';
  const doc = parseYamlover(src, '<t>');
  const c = entry(doc, 'name').meta!.comments![0];
  assert.equal(src.slice(c.span.start, c.span.end), '# full name');
});

test('comment: yamlover head banner set off by a blank line', () => {
  const doc = parseYamlover('# license\n# v2\n\nname: Alice\n', '<t>');
  assert.deepEqual(texts(doc.head), [' license', ' v2']);
  assert.equal(entry(doc, 'name').meta?.comments, undefined);
});

test('comment: yamlover top comment with NO blank line attaches to first entry (not head)', () => {
  const doc = parseYamlover('# about name\nname: Alice\n', '<t>');
  assert.equal(doc.head, undefined);
  assert.deepEqual(texts(entry(doc, 'name').meta?.comments, 'leading'), [' about name']);
});

test('comment: yamlover leading inside a nested block attaches to the inner entry', () => {
  const doc = parseYamlover('user:\n  # the name\n  name: Alice\n', '<t>');
  assert.deepEqual(texts(entry(doc, 'name').meta?.comments, 'leading'), [' the name']);
  assert.equal(entry(doc, 'user').meta?.comments, undefined);
});

test('comment: yamlover `#` inside a block scalar is CONTENT, not captured', () => {
  const doc = parseYamlover('doc: |\n  line one\n  # not a comment\n  line three\nafter: 1\n', '<t>');
  const v = entry(doc, 'doc').value as Node & { value: string };
  assert.match(v.value, /# not a comment/);
  // nothing attached anywhere from inside the block
  assert.equal(entry(doc, 'doc').meta?.comments, undefined);
  assert.equal(entry(doc, 'after').meta?.comments, undefined);
  assert.equal(doc.head, undefined);
});

test('comment: yamlover trailing attaches to the INNERMOST entry on the line (not the block)', () => {
  // the comment sits on `manager`'s line — it must hang on `manager`, not on the enclosing
  // `humans` block whose span also ends on that line (both end at the same offset).
  const doc = parseYamlover('humans:\n  - name: Alice\n    manager: *: pets[1] # the boss\n', '<t>');
  const humans = entry(doc, 'humans');
  assert.equal(humans.meta?.comments, undefined); // not on the block
  assert.deepEqual(texts(entry(doc, 'manager').meta?.comments, 'trailing'), [' the boss']);
});

test('comment: yamlover omni self-value trailing comment attaches to the NODE (not the first entry)', () => {
  // `!!var 5 # …` — the comment trails the node's own scalar value, not the entry below it.
  const doc = parseYamlover('!!var 5 # the value\n- solid\n- recommended\n', '<t>');
  assert.deepEqual(texts(doc.root.meta?.comments, 'trailing'), [' the value']);
  const first = doc.root.entries![0];
  assert.equal(first.meta?.comments, undefined); // NOT leading on `- solid`
  assert.equal(first.meta?.blankBefore, undefined); // and no spurious blank before it
});

test('comment: first-line comment is not flagged blankBefore (no blank above the file start)', () => {
  const doc = parseYamlover('# top\nname: Alice\n', '<t>');
  assert.equal(entry(doc, 'name').meta?.comments?.[0].blankBefore, undefined);
});

test('comment: yamlover trailing-of-file comment is kept on the root (never dropped)', () => {
  const doc = parseYamlover('a: 1\nb: 2\n# bye\n', '<t>');
  assert.deepEqual(texts(doc.root.meta?.comments), [' bye']);
});

test('comment: yamlover # inside a quoted scalar is not a comment', () => {
  const doc = parseYamlover('tag: "a # b"\n', '<t>');
  assert.equal(entry(doc, 'tag').meta?.comments, undefined);
  assert.equal((entry(doc, 'tag').value as { value: string }).value, 'a # b');
});

// ---- json5p --------------------------------------------------------------------

test('comment: json5p // line comment, leading and trailing', () => {
  const doc = parseJson5p('{\n  // the name\n  name: "Alice", // full name\n  age: 30,\n}', '<t>');
  assert.deepEqual(texts(entry(doc, 'name').meta?.comments, 'leading'), [' the name']);
  assert.deepEqual(texts(entry(doc, 'name').meta?.comments, 'trailing'), [' full name']);
});

test('comment: json5p block comment captured with style "block"', () => {
  const doc = parseJson5p('{ /* hi */ a: 1 }', '<t>');
  const c = entry(doc, 'a').meta?.comments ?? [];
  assert.equal(c.length, 1);
  assert.equal(c[0].style, 'block');
  assert.equal(c[0].text, 'hi');
});

test('comment: json5p head banner set off by a blank line', () => {
  const doc = parseJson5p('// header\n\n{ a: 1 }', '<t>');
  assert.deepEqual(texts(doc.head), [' header']);
});

test('comment: json5p // inside a string is not a comment', () => {
  const doc = parseJson5p(`{ url: "http://x" }`, '<t>');
  assert.equal(entry(doc, 'url').meta?.comments, undefined);
  assert.equal((entry(doc, 'url').value as { value: string }).value, 'http://x');
});
