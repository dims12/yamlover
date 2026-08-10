// The move-relink INTEGRATION matrix: yamlover pointers AND marklower prose links updating
// together, across both tiers (mediated `mv`, unmediated `relinkMoved`), against real temp
// trees with byte-exact expectations. Pins the round-2 laws: an expressible pointer is NEVER
// refused (escalate to the `*::` project form — the committer's labor survives re-rooted,
// never deleted), prose links are engine-owned and rewritten surgically in place, and what
// cannot be located verbatim (a `>`-folded token) is REPORTED, never silently dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { reindex } from '../src/walk.ts';
import { mv, relinkMoved } from '../src/mv.ts';

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yo-relink-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The shared fixture: a dir document D with a body ORDER entry for x.md and a prose chunk,
 *  plus inbound refs of every spelling from inside and outside D. */
function fixture(root: string): void {
  mkdirSync(join(root, 'D', '.yo'), { recursive: true });
  writeFileSync(join(root, 'D', '.yo', 'body.yo'), 'Doc D\n- *: x.md\n- >\n  see [rel](:x.md) inline\n');
  writeFileSync(join(root, 'D', 'x.md'), 'X\n');
  writeFileSync(join(root, 'D', 'refs.yo'), 'sib: *..: x.md\nmd: "see [abs](::D:x.md)"\n');
  writeFileSync(join(root, 'pages.md'), 'Intro [a](::D:x.md) and [w](https://example.com/keep) end\n');
  writeFileSync(join(root, 'refs.yo'), 'r: *:: D: x.md\n');
}

test('relink-links: tier-1 mv out of the directory updates every ref spelling', () => {
  const root = tmpRoot();
  fixture(root);
  const r = mv(root, 'D/x.md', 'E/x.md');

  // the escalation law: no relative frame reaches :E:x.md, so every stranded ref is
  // re-rooted at the project form — spacing style preserved per spelling
  assert.equal(readFileSync(join(root, 'refs.yo'), 'utf8'), 'r: *:: E: x.md\n');
  assert.equal(readFileSync(join(root, 'D', 'refs.yo'), 'utf8'), 'sib: *:: E: x.md\nmd: "see [abs](::E:x.md)"\n');
  assert.equal(readFileSync(join(root, 'pages.md'), 'utf8'), 'Intro [a](::E:x.md) and [w](https://example.com/keep) end\n');
  // the body ORDER entry is REWRITTEN, never deleted (the ordering was committed work) —
  // via the post-rename pass, since the consumed pointer is invisible to the pre-move plan;
  // the doc-relative prose link escalates the same way
  assert.equal(
    readFileSync(join(root, 'D', '.yo', 'body.yo'), 'utf8'),
    'Doc D\n- *:: E: x.md\n- >\n  see [rel](::E:x.md) inline\n',
  );
  assert.deepEqual(r.unrewritten, []);

  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('relink-links: tier-1 same-dir rename keeps the relative spellings', () => {
  const root = tmpRoot();
  fixture(root);
  const r = mv(root, 'D/x.md', 'D/y.md');

  assert.equal(readFileSync(join(root, 'D', '.yo', 'body.yo'), 'utf8'), 'Doc D\n- *: y.md\n- >\n  see [rel](:y.md) inline\n');
  assert.equal(readFileSync(join(root, 'D', 'refs.yo'), 'utf8'), 'sib: *..: y.md\nmd: "see [abs](::D:y.md)"\n');
  assert.equal(readFileSync(join(root, 'pages.md'), 'utf8'), 'Intro [a](::D:y.md) and [w](https://example.com/keep) end\n');
  assert.equal(readFileSync(join(root, 'refs.yo'), 'utf8'), 'r: *:: D: y.md\n');
  assert.deepEqual(r.unrewritten, []);

  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('relink-links: a bare current-scope order pointer (`- *anyfile01`) is repaired too', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'D2', '.yo'), { recursive: true });
  writeFileSync(join(root, 'D2', '.yo', 'body.yo'), 'Doc D2\n- *anyfile01\n');
  writeFileSync(join(root, 'D2', 'anyfile01'), 'first\n');

  mv(root, 'D2/anyfile01', 'D2/renamed01'); // same-dir: the relative spelling survives
  assert.equal(readFileSync(join(root, 'D2', '.yo', 'body.yo'), 'utf8'), 'Doc D2\n- *renamed01\n');

  mv(root, 'D2/renamed01', 'OUT/renamed01'); // out of the dir: escalate, never delete
  // a style-less raw (`renamed01`, no separators) takes the spaced default (the rewrite.ts rule)
  assert.equal(readFileSync(join(root, 'D2', '.yo', 'body.yo'), 'utf8'), 'Doc D2\n- *:: OUT: renamed01\n');
});

test('relink-links: tier-1 directory move — outside refs re-root, inside links travel', () => {
  const root = tmpRoot();
  fixture(root);
  const r = mv(root, 'D', 'Dm');

  assert.equal(readFileSync(join(root, 'pages.md'), 'utf8'), 'Intro [a](::Dm:x.md) and [w](https://example.com/keep) end\n');
  assert.equal(readFileSync(join(root, 'refs.yo'), 'utf8'), 'r: *:: Dm: x.md\n');
  // everything document-relative INSIDE the moved dir rides along untouched
  assert.equal(readFileSync(join(root, 'Dm', '.yo', 'body.yo'), 'utf8'), 'Doc D\n- *: x.md\n- >\n  see [rel](:x.md) inline\n');
  // the parent-scope sibling ref inside D still reaches x.md relatively; the abs link re-roots
  assert.equal(readFileSync(join(root, 'Dm', 'refs.yo'), 'utf8'), 'sib: *..: x.md\nmd: "see [abs](::Dm:x.md)"\n');
  assert.deepEqual(r.unrewritten, []);

  const s = new Store(':memory:');
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('relink-links: the watcher tier repairs the same matrix from file-level diff entries', () => {
  const root = tmpRoot();
  fixture(root);
  const s = new Store(':memory:');
  reindex(s, root);

  // an external actor: mv D/x.md E/x.md (unmediated — the body pointer dangles)
  mkdirSync(join(root, 'E'));
  renameSync(join(root, 'D', 'x.md'), join(root, 'E', 'x.md'));
  const r = relinkMoved(root, [{ from: 'D/x.md', to: 'E/x.md' }]);

  assert.equal(readFileSync(join(root, 'refs.yo'), 'utf8'), 'r: *:: E: x.md\n');
  assert.equal(readFileSync(join(root, 'D', 'refs.yo'), 'utf8'), 'sib: *:: E: x.md\nmd: "see [abs](::E:x.md)"\n');
  assert.equal(readFileSync(join(root, 'pages.md'), 'utf8'), 'Intro [a](::E:x.md) and [w](https://example.com/keep) end\n');
  assert.equal(
    readFileSync(join(root, 'D', '.yo', 'body.yo'), 'utf8'),
    'Doc D\n- *:: E: x.md\n- >\n  see [rel](::E:x.md) inline\n',
  );
  assert.deepEqual(r.unrewritten, []);
  reindex(s, root);
  assert.deepEqual(s.dangling(), []);
});

test('relink-links: a `>`-folded token straddling lines is REPORTED, bytes untouched', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'F', '.yo'), { recursive: true });
  // the label folds across a source line break — the value token ("[a b](::F:x.md)") never
  // appears verbatim in the source, so the locator must refuse and the report must say so
  const body = 'Doc F\n- >\n  see [a\n  b](::F:x.md) end\n';
  writeFileSync(join(root, 'F', '.yo', 'body.yo'), body);
  writeFileSync(join(root, 'F', 'x.md'), 'X\n');

  const r = mv(root, 'F/x.md', 'G/x.md');
  assert.equal(r.unrewritten.length, 1);
  assert.equal(r.unrewritten[0].raw, '[a b](::F:x.md)');
  assert.match(r.unrewritten[0].reason, /folded|escaped/);
  assert.equal(readFileSync(join(root, 'F', '.yo', 'body.yo'), 'utf8'), body); // untouched
});
