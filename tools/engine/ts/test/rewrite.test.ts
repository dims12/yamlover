// planRewrites / applyEdits (PLAN.md 3e mediated tier) — pure, no FS: parse fixture text
// with a file uri, resolve, plan a move, and check the planned source edits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { parseJson5p } from '../../../parser/ts/src/json5p.ts';
import { resolveDocument } from '../src/resolve.ts';
import { planRewrites, applyEdits, nominalPath } from '../src/rewrite.ts';
import type { TextEdit } from '../src/rewrite.ts';

const URI = '/root/doc.yamlover';

function plan(src: string, oldStore: string, newStore: string, uri = URI) {
  const doc = parseYamlover(src, uri);
  doc.root.meta = { ...doc.root.meta, documentRoot: true };
  return { doc, src, p: planRewrites(doc, resolveDocument(doc), oldStore, newStore, { root: '/root' }) };
}

function applied(src: string, edits: Map<string, TextEdit[]>, uri = URI): string {
  return applyEdits(src, edits.get(uri) ?? []);
}

test('rewrite: document-scope pointer', () => {
  const { p, src } = plan('a:\n  ref: */old.md\nold.md: x\n', '/old.md', '/new.md');
  assert.equal(p.rewritten.length, 1);
  assert.equal(p.rewritten[0].newRaw, '/new.md');
  assert.equal(applied(src, p.edits), 'a:\n  ref: */new.md\nold.md: x\n');
});

test('rewrite: link-scope pointer (project-root relative)', () => {
  const { p, src } = plan('ref: *//dir/old.md\ndir:\n  old.md: x\n', '/dir/old.md', '/dir/new.md');
  assert.equal(p.rewritten[0].newRaw, '//dir/new.md');
  assert.match(applied(src, p.edits), /\*\/\/dir\/new\.md/);
});

test('rewrite: current-scope sibling stays relative', () => {
  const { p, src } = plan('ref: *old\nold: x\n', '/old', '/new');
  assert.equal(p.rewritten[0].newRaw, 'new');
  assert.equal(applied(src, p.edits), 'ref: *new\nold: x\n');
});

test('rewrite: current-scope deepens but stays current when still under the holder', () => {
  // from the root mapping, `sub/new` is still a current-scope path (first step = sibling key)
  const { p } = plan('ref: *old\nold: x\nsub: {}\n', '/old', '/sub/new');
  assert.equal(p.rewritten[0].newRaw, 'sub/new');
});

test('rewrite: current-scope falls back to document form when the target leaves the holder', () => {
  const { p } = plan('a:\n  ref: *old\n  old: x\nb: {}\n', '/a/old', '/b/new');
  assert.equal(p.rewritten[0].newRaw, '/b/new');
});

test('rewrite: parent-scope keeps the .. form', () => {
  const { p } = plan('a:\n  ref: *../old\nold: x\n', '/old', '/new');
  assert.equal(p.rewritten[0].newRaw, '../new');
});

test('rewrite: directory move retargets descendants (prefix)', () => {
  const { p, src } = plan('r1: */dir/x.md\nr2: */dir/sub/y.md\ndir:\n  x.md: 1\n  sub:\n    y.md: 2\n', '/dir', '/moved');
  assert.equal(p.rewritten.length, 2);
  assert.deepEqual(p.rewritten.map((r) => r.newRaw).sort(), ['/moved/sub/y.md', '/moved/x.md']);
  const out = applied(src, p.edits);
  assert.match(out, /\*\/moved\/x\.md/);
  assert.match(out, /\*\/moved\/sub\/y\.md/);
});

test('rewrite: a ref INSIDE the moved subtree that survives relatively is untouched', () => {
  // sibling ref within the moved dir: holder and target move together → same raw
  const { p } = plan('dir:\n  a:\n    ref: *../b\n  b: x\n', '/dir', '/moved');
  assert.equal(p.rewritten.length, 0);
  assert.equal(p.unrewritten.length, 0);
});

test('rewrite: keyed back-edge and ~- membership are rewritten too', () => {
  const src = 'tags:\n  t:\n    m: */doc.md\ndoc.md:\n  ~m: */tags/t\n  ~- */tags/t\n';
  const { p } = plan(src, '/tags/t', '/tags/u');
  assert.deepEqual(p.rewritten.map((r) => r.newRaw), ['/tags/u', '/tags/u']);
});

test('rewrite: anchor-named pointer is skipped (names survive moves)', () => {
  const { p } = plan('boss: &chief\n  name: Rex\nlead: *chief\n', '/boss', '/captain');
  assert.equal(p.rewritten.length, 0);
  assert.equal(p.unrewritten.length, 0);
});

test('rewrite: metachar keys are escaped in the new raw', () => {
  const { p } = plan('ref: */plain\nplain: x\n', '/plain', '/we ird/odd~key');
  assert.equal(p.rewritten[0].newRaw, '/we ird/odd\\~key');
});

test('rewrite: json5p surface gets a quoted token', () => {
  const uri = '/root/doc.json5p';
  const src = `{ ref: *'/old.md', "old.md": 1 }`;
  const doc = parseJson5p(src, uri);
  doc.root.meta = { ...doc.root.meta, documentRoot: true };
  const p = planRewrites(doc, resolveDocument(doc), '/old.md', '/new.md', { root: '/root' });
  assert.equal(p.edits.get(uri)![0].text, `*'/new.md'`);
});

test('rewrite: source outside the served root is reported, not edited', () => {
  const { p } = plan('ref: */old.md\nold.md: x\n', '/old.md', '/new.md', '/elsewhere/doc.yamlover');
  assert.equal(p.rewritten.length, 0);
  assert.equal(p.unrewritten.length, 1);
  assert.match(p.unrewritten[0].reason, /outside the served root/);
});

test('applyEdits: descending application, overlap rejection', () => {
  const text = 'aaa bbb ccc';
  assert.equal(applyEdits(text, [
    { start: 0, end: 3, text: 'X' },
    { start: 8, end: 11, text: 'YYYY' },
  ]), 'X bbb YYYY');
  assert.throws(() => applyEdits(text, [
    { start: 0, end: 5, text: 'X' },
    { start: 4, end: 8, text: 'Y' },
  ]), /overlap/);
});

test('nominalPath: frames + steps without resolution', () => {
  const src = 'a:\n  doc: */x/y\n  cur: *sib\n  up: *../z\nlink: *//auth/p\n';
  const doc = parseYamlover(src, URI);
  doc.root.meta = { ...doc.root.meta, documentRoot: true };
  const by = new Map(resolveDocument(doc).map((e) => [e.from, e]));
  assert.equal(nominalPath(doc, by.get('/a/doc')!), '/x/y');
  assert.equal(nominalPath(doc, by.get('/a/cur')!), '/a/sib');
  assert.equal(nominalPath(doc, by.get('/a/up')!), '/z');
  assert.equal(nominalPath(doc, by.get('/link')!), '/auth/p');
});
