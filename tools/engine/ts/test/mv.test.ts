// `mv` — the engine-mediated move (ENGINE.md tier 1): FS rename + surgical inbound-ref
// rewriting, against real temp trees. Reindex afterwards must leave nothing dangling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
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

test('mv: file rename rewrites inbound refs from another file and a body.yo', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'old.md'), '# doc');
  writeFileSync(join(root, 'refs.yo'), 'link: *:: old.md\n');
  mkdirSync(join(root, '.yo'));
  writeFileSync(join(root, '.yo', 'body.yo'), 'fav: *: old.md   # keep me\n');

  const report = mv(root, 'old.md', 'new.md');
  assert.equal(report.from, 'old.md');
  assert.equal(report.to, 'new.md');
  assert.equal(report.unrewritten.length, 0);
  assert.equal(report.rewritten.length, 2);
  assert.ok(!existsSync(join(root, 'old.md')));
  assert.ok(existsSync(join(root, 'new.md')));
  assert.equal(readFileSync(join(root, 'refs.yo'), 'utf8'), 'link: *:: new.md\n');
  // surgical: the comment survives the rewrite
  assert.equal(readFileSync(join(root, '.yo', 'body.yo'), 'utf8'), 'fav: *: new.md   # keep me\n');

  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('mv: directory move retargets descendants; internal relative refs survive untouched', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'dir'));
  writeFileSync(join(root, 'dir', 'a.md'), 'A');
  writeFileSync(join(root, 'dir', 'b.yo'), 'sib: *:: dir: a.md\n'); // link-scope self-ref: must rewrite
  writeFileSync(join(root, 'outside.yo'), 'r: *:: dir: a.md\n');

  const report = mv(root, 'dir', 'moved');
  assert.equal(report.unrewritten.length, 0);
  assert.equal(readFileSync(join(root, 'outside.yo'), 'utf8'), 'r: *:: moved: a.md\n');
  // the ref inside the moved dir was edited BEFORE the rename and landed at the new location
  assert.equal(readFileSync(join(root, 'moved', 'b.yo'), 'utf8'), 'sib: *:: moved: a.md\n');

  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('mv: document-internal refs of a moved standalone file are untouched', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'doc.yo'), 'a: 1\nself: *: a\nsib: *a\n');
  const report = mv(root, 'doc.yo', 'renamed.yo');
  // `/a` and `a` are relative to the file's own document root — they move with the file
  assert.equal(report.rewritten.length, 0);
  assert.equal(readFileSync(join(root, 'renamed.yo'), 'utf8'), 'a: 1\nself: *: a\nsib: *a\n');
  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('mv: anchor-named refs are untouched and still resolve', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'doc.yo'), 'boss: &chief\n  name: Rex\nlead: *chief\n');
  mv(root, 'doc.yo', 'team.yo');
  assert.equal(readFileSync(join(root, 'team.yo'), 'utf8'), 'boss: &chief\n  name: Rex\nlead: *chief\n');
  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('mv: a link-scoped ordinal bookmark is rewritten when its tag container moves (A4)', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'ontos'));
  writeFileSync(join(root, 'ontos', 'chem.yo'), 'Chemistry\n');
  writeFileSync(join(root, 'ann.yo'), '30\n&:: ontos: chem.yo: -\n');
  mv(root, 'ontos', 'labels');
  assert.equal(readFileSync(join(root, 'ann.yo'), 'utf8'), '30\n&::labels:chem.yo:-\n');
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
  assert.throws(() => mv(root, '.yo', 'x'), /hidden/);
  assert.throws(() => mv(root, 'a.md', '../escape.md'), /escapes the served root/);
  assert.ok(existsSync(join(root, 'a.md'))); // nothing was mutated
});

test('mv: to a new subdirectory (created on demand)', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'a.md'), 'A');
  writeFileSync(join(root, 'r.yo'), 'x: *:: a.md\n');
  mv(root, 'a.md', 'sub/deep/a.md');
  assert.ok(existsSync(join(root, 'sub', 'deep', 'a.md')));
  assert.equal(readFileSync(join(root, 'r.yo'), 'utf8'), 'x: *:: sub: deep: a.md\n');
});

test('relinkMoved: repairs refs after an UNMEDIATED move', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'old.md'), '# doc');
  writeFileSync(join(root, 'refs.yo'), 'link: *:: old.md\n');
  const s = new Store(':memory:');
  reindex(s, root);

  // an external actor moves the file (no engine mediation)
  rmSync(join(root, 'old.md'));
  writeFileSync(join(root, 'new.md'), '# doc');

  const r = relinkMoved(root, [{ from: 'old.md', to: 'new.md' }]);
  assert.equal(r.rewritten.length, 1);
  assert.equal(readFileSync(join(root, 'refs.yo'), 'utf8'), 'link: *:: new.md\n');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('relinkMoved: a directory move arriving as its N file-level entries relinks like tier-1', () => {
  const root = tmpRoot();
  // two chapters, one of each overlay flavor (dir/.yo and dir/index.yo)
  mkdirSync(join(root, 'privacy', 'tax', '.yo'), { recursive: true });
  writeFileSync(join(root, 'privacy', 'tax', '.yo', 'body.yo'), 'Taxonomy\n');
  mkdirSync(join(root, 'privacy', 'gdpr'));
  writeFileSync(join(root, 'privacy', 'gdpr', 'index.yo'), 'GDPR\n');
  writeFileSync(join(root, 'probe.yo'), 'ptr: *::privacy:tax\nmd: "see [tax](::privacy:tax)"\n');
  const s = new Store(':memory:');
  reindex(s, root);

  // an external actor: mv privacy kb/privacy
  mkdirSync(join(root, 'kb'));
  renameSync(join(root, 'privacy'), join(root, 'kb', 'privacy'));

  // the watcher's diff is FILE-level (walk.ts IndexDiff) — the directory never appears itself
  const r = relinkMoved(root, [
    { from: 'privacy/tax/.yo/body.yo', to: 'kb/privacy/tax/.yo/body.yo' },
    { from: 'privacy/gdpr/index.yo', to: 'kb/privacy/gdpr/index.yo' },
  ]);

  // the pointer keeps its authored compact spelling; the link emits SIGILED canonical
  assert.equal(r.rewritten.length, 2);
  assert.deepEqual(r.rewritten.map((x) => x.newRaw).sort(), ['::kb:privacy:tax', '[tax](*::kb:privacy:tax)']);
  assert.deepEqual(r.unrewritten, []);
  assert.deepEqual(r.editedFiles, ['probe.yo']);
  assert.equal(readFileSync(join(root, 'probe.yo'), 'utf8'), 'ptr: *::kb:privacy:tax\nmd: "see [tax](*::kb:privacy:tax)"\n');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('relinkMoved: nested moved directories coalesce to the outermost — one plan pass', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'outer', 'inner', '.yo'), { recursive: true });
  writeFileSync(join(root, 'outer', 'inner', '.yo', 'body.yo'), 'Inner\n');
  writeFileSync(join(root, 'outer', 'inner', 'leaf.md'), 'L\n');
  mkdirSync(join(root, 'outer', '.yo'), { recursive: true });
  writeFileSync(join(root, 'outer', '.yo', 'body.yo'), 'Outer\n');
  writeFileSync(join(root, 'refs.yo'), 'a: *::outer:inner\nb: *::outer:inner:leaf.md\n');

  renameSync(join(root, 'outer'), join(root, 'moved'));
  const r = relinkMoved(root, [
    { from: 'outer/.yo/body.yo', to: 'moved/.yo/body.yo' },
    { from: 'outer/inner/.yo/body.yo', to: 'moved/inner/.yo/body.yo' },
    { from: 'outer/inner/leaf.md', to: 'moved/inner/leaf.md' },
  ]);
  assert.deepEqual(r.rewritten.map((x) => x.newRaw).sort(), ['::moved:inner', '::moved:inner:leaf.md']);
  assert.equal(readFileSync(join(root, 'refs.yo'), 'utf8'), 'a: *::moved:inner\nb: *::moved:inner:leaf.md\n');
});

test('relinkMoved: one file moved OUT of a directory stays file-level — no false coalescing', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'a.md'), 'A\n');
  writeFileSync(join(root, 'docs', 'b.md'), 'B\n');
  writeFileSync(join(root, 'refs.yo'), 'r: *::docs:a.md\nkeep: *::docs:b.md\n');

  mkdirSync(join(root, 'archive'));
  renameSync(join(root, 'docs', 'a.md'), join(root, 'archive', 'a.md'));
  const r = relinkMoved(root, [{ from: 'docs/a.md', to: 'archive/a.md' }]);
  assert.equal(r.rewritten.length, 1);
  assert.equal(readFileSync(join(root, 'refs.yo'), 'utf8'), 'r: *::archive:a.md\nkeep: *::docs:b.md\n');
});

test('mv: a marklower prose link is REWRITTEN in place, surgically', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'a.md'), 'A\n');
  writeFileSync(join(root, 'note.yo'), 'md: "see [a](::a.md)"  # keep me\n');
  const report = mv(root, 'a.md', 'b.md');
  assert.deepEqual(report.unrewritten, []);
  assert.equal(report.rewritten.length, 1);
  assert.equal(report.rewritten[0].newRaw, '[a](*::b.md)'); // sigiled canonical emission
  // surgical: quotes, prose, and the comment all survive — only the target changed
  assert.equal(readFileSync(join(root, 'note.yo'), 'utf8'), 'md: "see [a](*::b.md)"  # keep me\n');
});
