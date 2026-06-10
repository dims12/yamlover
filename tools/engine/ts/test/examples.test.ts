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

test('67-pdf-tags: a tag description is its BODY — the node value, untagged scalar+fields', () => {
  const s = new Store(':memory:');
  s.indexDocument(load('67-pdf-tags'));
  // a mid-taxonomy tag: body + sub-tags, authored WITHOUT !!omni (the schema declares variant)
  const math = s.node('/tags/field/mathematics');
  assert.equal(math?.format, 'x-yamlover-tag');
  assert.equal(math?.value, 'Mathematics');
  assert.equal(s.node('/tags/field/mathematics/number-theory')?.value, 'Number theory — Diophantine equations, sums of powers');
  // a leaf tag that is JUST its description (a plain scalar) still carries the tag format
  assert.equal(s.node('/tags/genre/annotation')?.format, 'x-yamlover-tag');
  assert.equal(s.node('/tags/genre/annotation')?.value, 'A secondary / derivative edition of another paper');
  s.close();
});

test('59-all-formats-object: annotations.yamlover reverse-links materials to their annotations', () => {
  // load the example in isolation — its annotations point at materials with RELATIVE pointers
  // (`../../<key>`), so they resolve without depending on where the project is served from.
  const s = new Store(':memory:');
  s.indexDocument(load('59-all-formats-object'));
  const ann = '/annotations.yamlover/markdown-phrase';
  assert.equal(s.node(ann)?.format, 'x-yamlover-annotation'); // the $defs/annotation schema
  assert.equal(s.node(ann + '/selector/exact')?.value, 'Hover a heading to reveal its');
  // the markdown material sees the annotation as an incoming ref edge — the reverse link
  const into = s.relationships('/markdown').in;
  assert.ok(into.some((e) => e.kind === 'ref' && e.from === ann), 'markdown ← its annotation');
  // each annotation is a TAG APPLICATION: a keyless `~-` membership in a built-in color tag,
  // resolvable because the walker grafts the repo's `yamlover/` subtree into the served root
  const tag = '/yamlover/tags/colors/yellow';
  assert.equal(s.node(tag)?.format, 'x-yamlover-tag');
  assert.equal(s.node(tag + '/color')?.value, '#f9e2af');
  assert.ok(
    s.relationships(tag).in.some((e) => e.kind === 'back' && e.from === ann && e.label === null),
    'the annotation is a keyless reverse member of its color tag',
  );
  // every annotation's target AND tag resolves (no dangling), incl. the chapter/image/pdf ones
  assert.deepEqual(buildGraph(load('59-all-formats-object')).unresolved, []);
});
