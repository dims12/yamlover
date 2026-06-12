// Reconcile-era engine pieces (PLAN.md 3e): the file manifest + hash cache behind `reindex`,
// schema-version invalidation, persisted dangling refs, and the FS watcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { reindex } from '../src/walk.ts';
import { watchTree } from '../src/watch.ts';

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yo-reconcile-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  return root;
}

// --------------------------------------------------------------------------- //
// reindex: manifest diff
// --------------------------------------------------------------------------- //

test('reindex reports added / changed / removed files across runs', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'a.md'), '# a');
  writeFileSync(join(root, 'b.yamlover'), 'x: 1\n');
  const s = new Store(':memory:');

  const first = reindex(s, root);
  assert.deepEqual(new Set(first.added), new Set(['a.md', 'b.yamlover']));
  assert.deepEqual(first.changed, []);
  assert.deepEqual(first.removed, []);

  // no edits → an empty diff (and the index still answers)
  const second = reindex(s, root);
  assert.deepEqual(second, { added: [], changed: [], removed: [], moved: [] });
  assert.equal(s.node(':b.yamlover:x')?.value, 1);

  // one modified, one new, one gone
  writeFileSync(join(root, 'b.yamlover'), 'x: 2\n');
  writeFileSync(join(root, 'c.md'), '# c');
  rmSync(join(root, 'a.md'));
  const third = reindex(s, root);
  assert.deepEqual(third, { added: ['c.md'], changed: ['b.yamlover'], removed: ['a.md'], moved: [] });
  assert.equal(s.node(':b.yamlover:x')?.value, 2);
  assert.equal(s.node(':a.md'), null);
});

test('reindex manifests overlay files, so a body.yamlover edit is a change', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'd', '.yamlover'), { recursive: true });
  writeFileSync(join(root, 'd', 'f.md'), 'hello');
  writeFileSync(join(root, 'd', '.yamlover', 'body.yamlover'), 'title: First\n');
  const s = new Store(':memory:');
  reindex(s, root);
  assert.equal(s.node(':d:title')?.value, 'First');

  writeFileSync(join(root, 'd', '.yamlover', 'body.yamlover'), 'title: Second\n');
  const diff = reindex(s, root);
  assert.deepEqual(diff.changed, ['d/.yamlover/body.yamlover']);
  assert.equal(s.node(':d:title')?.value, 'Second');
});

test('hash cache: an unchanged (size, mtime) blob is not re-read', () => {
  const root = tmpRoot();
  const png = join(root, 'pic.png');
  // pin a whole-second mtime: ext4 mtimes carry sub-ms precision that utimesSync cannot
  // reproduce exactly, and the cache key is an exact (size, mtimeMs) match
  const T = 1_000_000_000;
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  utimesSync(png, T, T);
  const s = new Store(':memory:');
  reindex(s, root);
  const hash1 = s.node(':pic.png')?.content_hash;
  assert.ok(hash1?.startsWith('xxh64:'));

  // rewrite with DIFFERENT bytes but the SAME size and mtime: a cache hit must reuse the old
  // hash (proving the bytes were not re-read) and the diff must be empty
  writeFileSync(png, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  utimesSync(png, T, T);
  const diff = reindex(s, root);
  assert.deepEqual(diff, { added: [], changed: [], removed: [], moved: [] });
  assert.equal(s.node(':pic.png')?.content_hash, hash1);
});

// --------------------------------------------------------------------------- //
// move inference (ENGINE.md tiers 2/3): removed + added with one hash ⇒ moved
// --------------------------------------------------------------------------- //

test('move inference: an unambiguous rename is reported as moved, not added+removed', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'old.md'), '# unique content');
  const s = new Store(':memory:');
  reindex(s, root);

  rmSync(join(root, 'old.md'));
  writeFileSync(join(root, 'new.md'), '# unique content');
  const diff = reindex(s, root);
  assert.deepEqual(diff, { added: [], changed: [], removed: [], moved: [{ from: 'old.md', to: 'new.md' }] });
});

test('move inference: duplicate content is ambiguous — the engine declines to guess', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'a.md'), 'same');
  writeFileSync(join(root, 'b.md'), 'same');
  const s = new Store(':memory:');
  reindex(s, root);

  rmSync(join(root, 'a.md'));
  rmSync(join(root, 'b.md'));
  writeFileSync(join(root, 'c.md'), 'same');
  const diff = reindex(s, root);
  assert.deepEqual(diff.moved, []);
  assert.deepEqual(diff.added, ['c.md']);
  assert.deepEqual(new Set(diff.removed), new Set(['a.md', 'b.md']));
});

test('move inference: a rename-plus-edit stays added+removed (hash differs)', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'old.md'), 'v1');
  const s = new Store(':memory:');
  reindex(s, root);

  rmSync(join(root, 'old.md'));
  writeFileSync(join(root, 'new.md'), 'v2');
  const diff = reindex(s, root);
  assert.deepEqual(diff.moved, []);
  assert.deepEqual(diff.added, ['new.md']);
  assert.deepEqual(diff.removed, ['old.md']);
});

// --------------------------------------------------------------------------- //
// schema-version invalidation
// --------------------------------------------------------------------------- //

test('a schema-version mismatch drops the on-disk index and marks the store stale', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'a.md'), '# a');
  const dbPath = join(root, 'index.db');

  const s1 = new Store(dbPath);
  assert.equal(s1.stale, true); // a brand-new DB has no usable index…
  reindex(s1, root);
  assert.equal(s1.stale, false); // …until the first successful index
  assert.ok(s1.node(':a.md'));
  s1.close();

  const s2 = new Store(dbPath);
  assert.equal(s2.stale, false); // same era → the persisted index is usable as-is
  assert.ok(s2.node(':a.md'));
  assert.ok(s2.manifest().has('a.md'));
  s2.close();

  // simulate an old-era DB: stamp a foreign version
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA user_version = 1;');
  raw.close();
  const s3 = new Store(dbPath);
  assert.equal(s3.stale, true);
  assert.equal(s3.node(':a.md'), null); // dropped — caller must reindex
  assert.equal(s3.manifest().size, 0); // stale manifest gone with it (no poisoned cache)
  reindex(s3, root);
  assert.ok(s3.node(':a.md'));
  s3.close();
});

// --------------------------------------------------------------------------- //
// dangling refs
// --------------------------------------------------------------------------- //

test('an unresolved pointer is persisted as dangling, and clears once it resolves', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'doc.yamlover'), 'friend: *missing\n');
  const s = new Store(':memory:');
  reindex(s, root);
  const d = s.dangling();
  assert.equal(d.length, 1);
  assert.equal(d[0].from, ':doc.yamlover:friend');
  assert.equal(d[0].raw, 'missing'); // Pointer.raw is the path text, sans the `*` sigil
  assert.match(d[0].reason, /missing/);

  writeFileSync(join(root, 'doc.yamlover'), 'missing: 1\nfriend: *missing\n');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

// --------------------------------------------------------------------------- //
// watcher
// --------------------------------------------------------------------------- //

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('watchTree batches new-file events and ignores .yamlover internals', async () => {
  const root = tmpRoot();
  mkdirSync(join(root, '.yamlover'));
  const batches: string[][] = [];
  const close = watchTree(root, (b) => batches.push(b), { debounceMs: 50 });
  try {
    writeFileSync(join(root, 'new.md'), '# new');
    writeFileSync(join(root, '.yamlover', 'index.db'), 'not really'); // must be filtered
    await until(() => batches.length > 0);
    assert.deepEqual(batches.flat().includes('new.md'), true);
    assert.equal(batches.flat().some((p) => p.includes('index.db')), false);

    // an overlay file IS data — its events must pass the filter
    writeFileSync(join(root, '.yamlover', 'body.yamlover'), 'title: T\n');
    await until(() => batches.flat().includes('.yamlover/body.yamlover'));
  } finally {
    close();
  }
});
