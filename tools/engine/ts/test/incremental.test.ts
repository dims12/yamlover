// Incremental reindex (reindexPathAsync + Store.patchSubtree): a single-file edit re-walks only
// the changed directory, splices the fresh subtree into the cached doc, re-resolves in memory, and
// patches just that subtree's rows. The CONTRACT is that the patched index is byte-for-byte equal
// to a full rebuild — so these tests edit a file two ways (incremental vs. a fresh full reindex)
// and assert the two DBs are identical.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { reindexAsyncDoc, reindexPathAsync } from '../src/walk.ts';

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yo-incremental-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The full index state, normalized for comparison: every node/edge/dangling row, sorted. (The
 *  `file` manifest is excluded — mtimes differ between two independent walks of the same tree.) */
function dump(s: Store): { nodes: unknown[]; edges: unknown[]; dangling: unknown[] } {
  const all = (sql: string): Record<string, unknown>[] => s.db.prepare(sql).all() as Record<string, unknown>[];
  const sort = (rows: Record<string, unknown>[]): unknown[] =>
    rows.map((r) => JSON.stringify(r)).sort();
  return {
    nodes: sort(all('SELECT * FROM node')),
    edges: sort(all('SELECT * FROM edge')),
    dangling: sort(all('SELECT * FROM dangling')),
  };
}

/** Build a fresh in-memory index of `root` from scratch — the reference a patch must match. */
async function fullIndex(root: string): Promise<Store> {
  const s = new Store(':memory:');
  await reindexAsyncDoc(s, root);
  return s;
}

// --------------------------------------------------------------------------- //
// the core contract: an incremental patch equals a full rebuild
// --------------------------------------------------------------------------- //

test('standalone-file edit: incremental patch == full rebuild', async () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'things', 'sub'), { recursive: true });
  writeFileSync(join(root, 'things', 'a.yamlover'), 'title: Hello\nself: *title\n');
  writeFileSync(join(root, 'things', 'sub', 'b.yamlover'), 'note: one\n');

  const s = new Store(':memory:');
  const { doc } = await reindexAsyncDoc(s, root);

  // edit a deep standalone file (append a key) and patch incrementally
  appendFileSync(join(root, 'things', 'sub', 'b.yamlover'), 'extra: two\n');
  const res = await reindexPathAsync(s, root, doc, 'things/sub/b.yamlover');
  assert.ok(res, 'a deep standalone-file edit should be patchable incrementally');
  assert.deepEqual(res.diff.changed, ['things/sub/b.yamlover']);
  assert.equal(s.node(':things:sub:b.yamlover:extra')?.value, 'two');

  assert.deepEqual(dump(s), dump(await fullIndex(root)));
});

test('body.yamlover overlay edit: incremental patch == full rebuild', async () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'things', 'sub', '.yamlover'), { recursive: true });
  writeFileSync(join(root, 'things', 'note.md'), 'hi');
  writeFileSync(join(root, 'things', 'sub', '.yamlover', 'body.yamlover'), 'title: First\n');

  const s = new Store(':memory:');
  const { doc } = await reindexAsyncDoc(s, root);
  assert.equal(s.node(':things:sub:title')?.value, 'First');

  writeFileSync(join(root, 'things', 'sub', '.yamlover', 'body.yamlover'), 'title: Second\ncolor: red\n');
  const res = await reindexPathAsync(s, root, doc, 'things/sub/.yamlover/body.yamlover');
  assert.ok(res, 'an overlay edit should be patchable incrementally');
  assert.equal(s.node(':things:sub:title')?.value, 'Second');

  assert.deepEqual(dump(s), dump(await fullIndex(root)));
});

test('cross-file inbound pointer into the changed subtree survives the patch', async () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'things', 'sub', '.yamlover'), { recursive: true });
  mkdirSync(join(root, '.yamlover'), { recursive: true });
  writeFileSync(join(root, 'things', 'sub', '.yamlover', 'body.yamlover'), 'title: Target\n');
  writeFileSync(join(root, 'things', 'note.md'), 'note');
  // a ROOT-scope pointer into the subtree we will edit (root is a document root, `things` a key)
  writeFileSync(join(root, '.yamlover', 'body.yamlover'), 'link: *things:sub:title\n');

  const s = new Store(':memory:');
  const { doc } = await reindexAsyncDoc(s, root);
  // sanity: the inbound edge resolved (not dangling). The edge's from_path is the holder (root `:`)
  // and its label is the entry key `link`.
  const inbound = (st: Store): number => st.relationships(':things:sub:title').in.filter((e) => e.label === 'link' && e.kind === 'ref').length;
  assert.equal(inbound(s), 1, 'the cross-file pointer should resolve to the subtree node');
  assert.deepEqual(s.dangling(), []);

  // edit a sibling file inside `things/` — the inbound target node is unchanged
  appendFileSync(join(root, 'things', 'note.md'), '!');
  const res = await reindexPathAsync(s, root, doc, 'things/note.md');
  assert.ok(res, 'a sibling edit should be patchable; the inbound edge is stable');

  assert.deepEqual(dump(s), dump(await fullIndex(root)));
  assert.equal(inbound(s), 1, 'the inbound edge is still there after the patch');
});

test('outgoing ref + dangling inside the changed subtree are rewritten correctly', async () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'things', 'sub', '.yamlover'), { recursive: true });
  writeFileSync(join(root, 'things', 'sub', '.yamlover', 'body.yamlover'), 'title: T\nself: *title\nbad: *nope\n');
  writeFileSync(join(root, 'things', 'keep.md'), 'k');

  const s = new Store(':memory:');
  const { doc } = await reindexAsyncDoc(s, root);
  assert.equal(s.dangling().filter((d) => d.from === ':things:sub:bad').length, 1);

  // edit the overlay: fix the dangling pointer by adding the key it names
  writeFileSync(join(root, 'things', 'sub', '.yamlover', 'body.yamlover'), 'title: T\nself: *title\nnope: 1\nbad: *nope\n');
  const res = await reindexPathAsync(s, root, doc, 'things/sub/.yamlover/body.yamlover');
  assert.ok(res);
  assert.deepEqual(s.dangling(), [], 'the formerly-dangling pointer now resolves');

  assert.deepEqual(dump(s), dump(await fullIndex(root)));
});

// --------------------------------------------------------------------------- //
// the guard: when a patch can't be proven equal to a full rebuild, fall back
// --------------------------------------------------------------------------- //

test('guard: removing an externally-referenced node forces a full reindex (returns null)', async () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'things', 'sub', '.yamlover'), { recursive: true });
  mkdirSync(join(root, '.yamlover'), { recursive: true });
  writeFileSync(join(root, 'things', 'sub', '.yamlover', 'body.yamlover'), 'gone: 1\nkept: 2\n');
  writeFileSync(join(root, '.yamlover', 'body.yamlover'), 'link: *things:sub:gone\n');

  const s = new Store(':memory:');
  const { doc } = await reindexAsyncDoc(s, root);
  assert.equal(s.relationships(':things:sub:gone').in.filter((e) => e.label === 'link' && e.kind === 'ref').length, 1);

  // remove the node the external pointer targets → the inbound edge would change → not patchable
  writeFileSync(join(root, 'things', 'sub', '.yamlover', 'body.yamlover'), 'kept: 2\n');
  const res = await reindexPathAsync(s, root, doc, 'things/sub/.yamlover/body.yamlover');
  assert.equal(res, null, 'the patch guard must decline and let the caller full-reindex');
});

test('a root-level file edit is not locally patchable (returns null)', async () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'top.yamlover'), 'x: 1\n');
  const s = new Store(':memory:');
  const { doc } = await reindexAsyncDoc(s, root);
  appendFileSync(join(root, 'top.yamlover'), 'y: 2\n');
  assert.equal(await reindexPathAsync(s, root, doc, 'top.yamlover'), null);
});
