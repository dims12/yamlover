// `mv` — the engine-mediated move (ENGINE.md tier 1): FS rename + surgical inbound-ref
// rewriting, against real temp trees. Reindex afterwards must leave nothing dangling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { reindex } from '../src/walk.ts';
import { mv, relinkMoved } from '../src/mv.ts';

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yo-mv-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('mv: file rename rewrites inbound refs from another file and a body.yamlover', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'old.md'), '# doc');
  writeFileSync(join(root, 'refs.yamlover'), 'link: *//old.md\n');
  mkdirSync(join(root, '.yamlover'));
  writeFileSync(join(root, '.yamlover', 'body.yamlover'), 'fav: */old.md   # keep me\n');

  const report = mv(root, 'old.md', 'new.md');
  assert.equal(report.from, 'old.md');
  assert.equal(report.to, 'new.md');
  assert.equal(report.unrewritten.length, 0);
  assert.equal(report.rewritten.length, 2);
  assert.ok(!existsSync(join(root, 'old.md')));
  assert.ok(existsSync(join(root, 'new.md')));
  assert.equal(readFileSync(join(root, 'refs.yamlover'), 'utf8'), 'link: *//new.md\n');
  // surgical: the comment survives the rewrite
  assert.equal(readFileSync(join(root, '.yamlover', 'body.yamlover'), 'utf8'), 'fav: */new.md   # keep me\n');

  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('mv: directory move retargets descendants; internal relative refs survive untouched', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'dir'));
  writeFileSync(join(root, 'dir', 'a.md'), 'A');
  writeFileSync(join(root, 'dir', 'b.yamlover'), 'sib: *//dir/a.md\n'); // link-scope self-ref: must rewrite
  writeFileSync(join(root, 'outside.yamlover'), 'r: *//dir/a.md\n');

  const report = mv(root, 'dir', 'moved');
  assert.equal(report.unrewritten.length, 0);
  assert.equal(readFileSync(join(root, 'outside.yamlover'), 'utf8'), 'r: *//moved/a.md\n');
  // the ref inside the moved dir was edited BEFORE the rename and landed at the new location
  assert.equal(readFileSync(join(root, 'moved', 'b.yamlover'), 'utf8'), 'sib: *//moved/a.md\n');

  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('mv: document-internal refs of a moved standalone file are untouched', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'doc.yamlover'), 'a: 1\nself: */a\nsib: *a\n');
  const report = mv(root, 'doc.yamlover', 'renamed.yamlover');
  // `/a` and `a` are relative to the file's own document root — they move with the file
  assert.equal(report.rewritten.length, 0);
  assert.equal(readFileSync(join(root, 'renamed.yamlover'), 'utf8'), 'a: 1\nself: */a\nsib: *a\n');
  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('mv: anchor-named refs are untouched and still resolve', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'doc.yamlover'), 'boss: &chief\n  name: Rex\nlead: *chief\n');
  mv(root, 'doc.yamlover', 'team.yamlover');
  assert.equal(readFileSync(join(root, 'team.yamlover'), 'utf8'), 'boss: &chief\n  name: Rex\nlead: *chief\n');
  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('mv: a link-scoped ordinal anchor is rewritten when its tag container moves (A4)', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'tags'));
  writeFileSync(join(root, 'tags', 'chem.yamlover'), 'Chemistry\n');
  writeFileSync(join(root, 'ann.yamlover'), '30\n&//tags/chem.yamlover[]\n');
  mv(root, 'tags', 'labels');
  assert.equal(readFileSync(join(root, 'ann.yamlover'), 'utf8'), '30\n&//labels/chem.yamlover[]\n');
  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('mv: refusals — missing source, existing target, dir into itself, hidden segments, escapes', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'dir'));
  writeFileSync(join(root, 'a.md'), 'A');
  writeFileSync(join(root, 'b.md'), 'B');
  assert.throws(() => mv(root, 'nope.md', 'x.md'), /does not exist/);
  assert.throws(() => mv(root, 'a.md', 'b.md'), /already exists/);
  assert.throws(() => mv(root, 'dir', 'dir/sub'), /into itself/);
  assert.throws(() => mv(root, '.yamlover', 'x'), /hidden/);
  assert.throws(() => mv(root, 'a.md', '../escape.md'), /escapes the served root/);
  assert.ok(existsSync(join(root, 'a.md'))); // nothing was mutated
});

test('mv: to a new subdirectory (created on demand)', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'a.md'), 'A');
  writeFileSync(join(root, 'r.yamlover'), 'x: *//a.md\n');
  mv(root, 'a.md', 'sub/deep/a.md');
  assert.ok(existsSync(join(root, 'sub', 'deep', 'a.md')));
  assert.equal(readFileSync(join(root, 'r.yamlover'), 'utf8'), 'x: *//sub/deep/a.md\n');
});

test('relinkMoved: repairs refs after an UNMEDIATED move', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'old.md'), '# doc');
  writeFileSync(join(root, 'refs.yamlover'), 'link: *//old.md\n');
  const s = new Store(':memory:');
  reindex(s, root);

  // an external actor moves the file (no engine mediation)
  rmSync(join(root, 'old.md'));
  writeFileSync(join(root, 'new.md'), '# doc');

  const r = relinkMoved(root, [{ from: 'old.md', to: 'new.md' }]);
  assert.equal(r.rewritten.length, 1);
  assert.equal(readFileSync(join(root, 'refs.yamlover'), 'utf8'), 'link: *//new.md\n');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});
