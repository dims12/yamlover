// Node-KIND classification — the rule a regression in `omni/mix` once broke (example 67-pdf-tags).
//
// A node's TYPE is constituted only by the entries it OWNS: its containment children and forward
// `*` refs. Reverse (`~`) members — e.g. tag membership — are UPSTREAM relations the node does not
// own, so they must never change its type. The 67-pdf-tags papers are blob files filed under a tag
// taxonomy PURELY via `~slug` back-edges: each must stay `binary` (and keep its pdf renderer), not
// be promoted to `variant`/`omni`. The reverse direction is guarded too: a genuine `!!omni`, which
// DOES own fields, must still be a `variant`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { walkDir } from '../src/walk.ts';
import { Store } from '../src/store.ts';
import { displayKind, typeName } from '../../../server/src/server/node-kind.ts';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'examples');

// Every paper in 67-pdf-tags — real files, real (messy) names — filed under tags only via `~slug`.
const PAPERS = [
  'Chemical-Free.pdf',
  '1110.2832v2.pdf',
  'jaba00061-0143a.pdf',
  'S0002-9904-1966-11654-3.pdf',
  '1105-2_abstract_Is the sequence of earthquake in southern California, with aftershocks removed, Poissonian.pdf',
];

test('67-pdf-tags: a PDF filed under tags by REVERSE members stays a binary', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(join(examples, '67-pdf-tags')));
  for (const file of PAPERS) {
    const p = '/' + file;
    const row = s.node(p);
    assert.ok(row, `indexed ${file}`);
    // sanity: the paper's ONLY entries are reverse `~tag` memberships (nothing owned)
    const ents = s.entries(p);
    assert.ok(ents.length > 0 && ents.every((e) => e.kind === 'back'), `${file}: only reverse members`);
    // therefore it is still a binary blob (keeps its pdf renderer), NOT an omni/variant
    assert.equal(displayKind(s, p, row!), 'binary', `${file} displayKind`);
    assert.equal(typeName(s, p, row!), 'binary', `${file} type`);
  }
  s.close();
});

test('a node that OWNS fields is a variant (omni) — 07-omni.yamlover', () => {
  const s = new Store(':memory:');
  s.indexDocument(parseYamlover(readFileSync(join(examples, '07-omni.yamlover'), 'utf8'), '07-omni.yamlover'));
  const row = s.node('/');
  assert.ok(row);
  assert.ok(s.entries('/').some((e) => e.kind !== 'back'), 'owns at least one forward/contain entry');
  assert.equal(displayKind(s, '/', row!), 'omni');
  assert.equal(typeName(s, '/', row!), 'variant');
  s.close();
});
