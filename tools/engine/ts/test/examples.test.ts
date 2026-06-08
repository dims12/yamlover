import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { parseJson5p } from '../../../parser/ts/src/json5p.ts';
import type { Document } from '../../../parser/ts/src/ir.ts';
import { walkDir } from '../src/walk.ts';
import { Store } from '../src/store.ts';
import { buildGraph } from '../src/graph.ts';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'examples');

/** Load one example as its OWN document — a directory via the walker, a file via the parser its
 *  extension selects (anchors preserved). This is the granularity each sample is authored at;
 *  walking the whole `examples/` tree as one document would merge them and drop per-file anchors. */
function load(name: string): Document {
  const p = join(examples, name);
  if (statSync(p).isDirectory()) return walkDir(p);
  const src = readFileSync(p, 'utf8');
  const ext = extname(name);
  return ext === '.json' || ext === '.json5' || ext === '.json5p' ? parseJson5p(src, name) : parseYamlover(src, name);
}

const entries = readdirSync(examples).filter((n) => !n.startsWith('.') && n !== 'README.md');

// SMOKE — every sample loads, indexes into SQLite, projects a TOC, and resolves its graph
// without throwing. A cheap regression net over all 24 samples (this is the "show intention"
// baseline; behaviours get pinned with focused assertions over time).
for (const name of entries) {
  test(`example loads, indexes & projects: ${name}`, () => {
    const doc = load(name);
    assert.ok(doc.root, 'has a root node');
    const s = new Store(':memory:');
    s.indexDocument(doc); // IR → node/edge tables
    s.toc('/'); // TOC projects
    buildGraph(doc); // every `*`/`~` resolves (or is recorded), no throw
    s.close();
  });
}

// REPRESENTATION INTENT — the relationship-heavy samples must have NO dangling pointers; a
// broken `*`/`~` (a deleted file, a typo'd path) is a real bug here, not a syntax demo.
test('58-genealogy-dag: every pointer resolves (no dangling)', () => {
  assert.deepEqual(buildGraph(load('58-genealogy-dag')).unresolved, []);
});

test('67-pdf-tags: every tag membership pointer resolves (no dangling)', () => {
  assert.deepEqual(buildGraph(load('67-pdf-tags')).unresolved, []);
});
