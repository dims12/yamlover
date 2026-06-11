// Stat-first indexing + progress (long-running tasks work): the size-tiered hash policy
// (small blobs inline, large blobs deferred to the background hasher), the generator walk's
// progress ticks, reindexAsync ≡ reindex, stat-tier move inference, and the chunked hasher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { reindex, reindexAsync, walkTree, walkTreeGen, hashFileAsync } from '../src/walk.ts';

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yo-progress-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  return root;
}

// PNG magic so the sniffer takes the blob branch without an extension fight
const png = (size: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.alloc(size - 5, 7)]);

test('size tiers: a small blob is hashed inline, a large one is stat-only (never read)', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'small.png'), png(64));
  writeFileSync(join(root, 'large.png'), png(4096));
  const { doc, files } = walkTree(root, { hashInlineMax: 1024 });
  const entry = (k: string) => doc.root.entries!.find((e) => e.key === k)!.value as { contentHash: string | null };
  assert.ok(entry('small.png').contentHash?.startsWith('xxh64:'));
  assert.equal(entry('large.png').contentHash, null);
  const manifest = new Map(files.map((f) => [f.path, f]));
  assert.ok(manifest.get('small.png')!.hash);
  assert.equal(manifest.get('large.png')!.hash, null);
});

test('the manifest carries a large blob forward unhashed; unhashedFiles lists it for the hasher', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'big.png'), png(4096));
  const s = new Store(':memory:');
  reindex(s, root, { hashInlineMax: 1024 });
  assert.deepEqual(s.unhashedFiles().map((f) => f.path), ['big.png']);
  // an unchanged re-index keeps it null (and quiet)
  const diff = reindex(s, root, { hashInlineMax: 1024 });
  assert.deepEqual(diff, { added: [], changed: [], removed: [], moved: [] });
  assert.deepEqual(s.unhashedFiles().map((f) => f.path), ['big.png']);
});

test('setFileHash fills the manifest + blob node, guarded by (size, mtime)', async () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'big.png'), png(4096));
  const s = new Store(':memory:');
  reindex(s, root, { hashInlineMax: 1024 });
  const [rec] = s.unhashedFiles();
  const hash = await hashFileAsync(join(root, 'big.png'));
  assert.ok(hash.startsWith('xxh64:'));
  assert.equal(s.setFileHash(rec.path, hash, rec.size, rec.mtimeMs), true);
  assert.equal(s.unhashedFiles().length, 0);
  assert.equal(s.node('/big.png')?.content_hash, hash);
  // a stale (size, mtime) writes nothing
  assert.equal(s.setFileHash(rec.path, 'xxh64:0000000000000000', rec.size + 1, rec.mtimeMs), false);
  assert.equal(s.node('/big.png')?.content_hash, hash);
});

test('the chunked hasher and the inline hash agree on the same bytes', async () => {
  const root = tmpRoot();
  const bytes = png(512);
  writeFileSync(join(root, 'a.png'), bytes); // small ⇒ inline-hashed by the walk
  writeFileSync(join(root, 'b.png'), bytes); // same bytes, hashed via the chunked reader
  const { doc } = walkTree(root);
  const inline = (doc.root.entries!.find((e) => e.key === 'a.png')!.value as { contentHash: string }).contentHash;
  assert.equal(await hashFileAsync(join(root, 'b.png')), inline);
});

test('walkTreeGen yields one progress tick per filesystem child', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'd'));
  writeFileSync(join(root, 'a.md'), '# a');
  writeFileSync(join(root, 'd', 'b.md'), '# b');
  writeFileSync(join(root, 'd', 'c.png'), png(16));
  const ticks: { done: number; path: string }[] = [];
  const g = walkTreeGen(root);
  let r = g.next();
  while (!r.done) {
    ticks.push(r.value);
    r = g.next();
  }
  // 4 children: a.md, d, d/b.md, d/c.png — `done` is monotonically 1..N
  assert.deepEqual(ticks.map((t) => t.done), [1, 2, 3, 4]);
  assert.deepEqual(new Set(ticks.map((t) => t.path)), new Set(['a.md', 'd', 'd/b.md', 'd/c.png']));
});

test('reindexAsync returns the same diff as reindex and reports determinate progress', async () => {
  const rootA = tmpRoot();
  const rootB = tmpRoot();
  for (const root of [rootA, rootB]) {
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'a.md'), '# a');
    writeFileSync(join(root, 'd', 'b.yamlover'), 'x: 1\n');
  }
  const syncDiff = reindex(new Store(':memory:'), rootA);

  const progress: { done: number; total?: number; message?: string }[] = [];
  const asyncDiff = await reindexAsync(new Store(':memory:'), rootB, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(asyncDiff, syncDiff);
  assert.ok(progress.length > 0);
  assert.ok(progress.every((p) => p.total === 3)); // a.md, d, d/b.yamlover
  assert.equal(progress.at(-1)!.message, 'writing index…');
  assert.equal(progress.at(-2)!.done, 3);
});

test('move inference falls back to (size, mtime) for an unhashed large blob', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'big-old.png'), png(4096));
  const s = new Store(':memory:');
  reindex(s, root, { hashInlineMax: 1024 });
  assert.equal(s.manifest().get('big-old.png')!.hash, null); // never hashed

  renameSync(join(root, 'big-old.png'), join(root, 'big-new.png')); // rename keeps size+mtime
  const diff = reindex(s, root, { hashInlineMax: 1024 });
  assert.deepEqual(diff, { added: [], changed: [], removed: [], moved: [{ from: 'big-old.png', to: 'big-new.png' }] });
});

test('stat-tier move inference declines when known hashes prove different content', () => {
  // a removed and an added file with IDENTICAL (size, mtime) — pinned — but different bytes,
  // both hashed: the stat tier would 1↔1-match them, the hash guard must refuse
  const root = tmpRoot();
  const T = 1_000_000_000; // pin whole-second mtimes (sub-ms precision is not reproducible)
  writeFileSync(join(root, 'one.png'), png(2048));
  utimesSync(join(root, 'one.png'), T, T);
  const s = new Store(':memory:');
  reindex(s, root); // default inline max (1 MiB) hashes the 2 KiB file
  const oldHash = s.manifest().get('one.png')!.hash!;
  assert.ok(oldHash.startsWith('xxh64:'));

  rmSync(join(root, 'one.png'));
  writeFileSync(join(root, 'two.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.alloc(2043, 9)]));
  utimesSync(join(root, 'two.png'), T, T); // same size AND same mtime as one.png had
  const diff = reindex(s, root);
  assert.deepEqual(diff.moved, []);
  assert.deepEqual(diff.removed, ['one.png']);
  assert.deepEqual(diff.added, ['two.png']);
});
