// Node-KIND classification — the rule a regression in `omni/mix` once broke.
//
// A node's TYPE is constituted only by the entries it OWNS: its containment children and forward
// `*` refs. Reverse (`~`/`&`) members — an UPSTREAM relation the node does not own — must never
// change its type (a reverse-tagged blob stays `binary`, keeping its renderer). The reverse
// direction is guarded too: a node that genuinely OWNS fields is a `variant`/`omni`. Under the
// EMBEDDED tagging model (ANNOTATIONS.md) the 67-pdf-tags papers now OWN a `yamlover-annotations`
// array, so each is an omni-blob; the reverse-member invariant is checked on a synthetic fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { walkDir } from '../src/walk.ts';
import { Store } from '../src/store.ts';
import { displayKind, typeName } from '../../../server/src/server/node-kind.ts';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'examples');

// Every paper in 67-pdf-tags — real files, real (messy) names — now tagged via an embedded array.
const PAPERS = [
  'Chemical-Free.pdf',
  '1110.2832v2.pdf',
  'jaba00061-0143a.pdf',
  'S0002-9904-1966-11654-3.pdf',
  '1105-2_abstract_Is the sequence of earthquake in southern California, with aftershocks removed, Poissonian.pdf',
];

test('67-pdf-tags: an embedded-tagged PDF is an omni-blob (binary value + owned yamlover-annotations)', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(join(examples, '67-pdf-tags')));
  for (const file of PAPERS) {
    const p = ':' + file;
    const row = s.node(p);
    assert.ok(row, `indexed ${file}`);
    assert.equal(row!.type, 'blob', `${file} stored type`); // the bytes are still a blob
    // it OWNS a `yamlover-annotations` array (the embedded tag applications) → an omni-blob
    const ents = s.entries(p);
    assert.ok(ents.some((e) => e.kind === 'contain' && e.label === 'yamlover-annotations'), `${file}: owns yamlover-annotations`);
    assert.equal(displayKind(s, p, row!), 'omni', `${file} displayKind`);
    assert.equal(typeName(s, p, row!), 'variant', `${file} type`);
  }
  s.close();
});

test('a blob with ONLY reverse members stays binary — reverse members never promote the kind', () => {
  // a synthetic stand-in for the OLD 67 shape: a blob whose only entry is a reverse `&` membership
  // (a path anchor into a tag) — it must NOT become an omni/variant.
  const dir = mkdtempSync(join(tmpdir(), 'yo-revkind-'));
  mkdirSync(join(dir, '.yamlover'));
  writeFileSync(join(dir, 'doc.bin'), Buffer.from([0, 1, 2, 3, 0, 255])); // a NUL → a binary blob
  writeFileSync(
    join(dir, '.yamlover', 'body.yamlover'),
    'marker: !!<*::yamlover:$defs:tag> A tag\n"doc.bin":\n  &: marker: mention\n',
  );
  const s = new Store(':memory:');
  s.indexDocument(walkDir(dir));
  const p = ':doc.bin';
  const row = s.node(p);
  assert.ok(row);
  const ents = s.entries(p);
  assert.ok(ents.length > 0 && ents.every((e) => e.kind === 'back'), 'only reverse members, nothing owned');
  assert.equal(displayKind(s, p, row!), 'binary');
  assert.equal(typeName(s, p, row!), 'binary');
  s.close();
});

test('a node that OWNS fields is a variant (omni) — 07-omni.yamlover', () => {
  const s = new Store(':memory:');
  s.indexDocument(parseYamlover(readFileSync(join(examples, '07-omni.yamlover'), 'utf8'), '07-omni.yamlover'));
  const row = s.node(':');
  assert.ok(row);
  assert.ok(s.entries(':').some((e) => e.kind !== 'back'), 'owns at least one forward/contain entry');
  assert.equal(displayKind(s, ':', row!), 'omni');
  assert.equal(typeName(s, ':', row!), 'variant');
  s.close();
});
