// The 3g acceptance gate: every case in query.cases.ts runs through the evaluator
// (docs/language/pointers/queries obligations, restated for the colon grammar in the cases file header).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { Store } from '../src/store.ts';
import { walkDir } from '../src/walk.ts';
import { evalQuery, isPointerShapedQuery } from '../src/query.ts';
import { CASES, INLINE_FIXTURE } from './query.cases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', '..', 'examples');

const stores = new Map<string, Store>();

function fixture(name: string): Store {
  let s = stores.get(name);
  if (s) return s;
  s = new Store(':memory:');
  switch (name) {
    case 'inline':
      s.indexDocument(parseYamlover(INLINE_FIXTURE, 'inline.yo'));
      break;
    case '06-tour':
      s.indexDocument(parseYamlover(readFileSync(join(examples, '06-tour.yo'), 'utf8'), '06-tour.yo'));
      break;
    case '58-genealogy':
      s.indexDocument(walkDir(join(examples, '58-genealogy-dag')));
      break;
    case '67-pdf-tags':
      s.indexDocument(walkDir(join(examples, '67-pdf-tags')));
      break;
    case 'graft': {
      const root = mkdtempSync(join(tmpdir(), 'yo-query-'));
      process.on('exit', () => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, '$defs'));
      writeFileSync(
        join(root, '$defs', 'onto'),
        'type: object\nformat: x-yamlover-onto\nproperties:\n  color:\n    type: string\nadditionalProperties: *:: yamlover: $defs: onto\n',
      );
      mkdirSync(join(root, '$defs', '.yo'));
      writeFileSync(join(root, '$defs', '.yo', 'meta.yo'), 'properties:\n  onto:\n    type: string\n    format: yamlover/meta\n');
      mkdirSync(join(root, 'ontos'));
      mkdirSync(join(root, 'ontos', '.yo'));
      writeFileSync(
        join(root, 'ontos', '.yo', 'body.yo'),
        '!!<*yamlover:$defs:onto>\ncolors: The palette\n  yellow:\n    color: "#f9e2af"\n  green:\n    color: "#a6e3a1"\n',
      );
      writeFileSync(join(root, 'data.yo'), 'x: 1\n');
      s.indexDocument(walkDir(root));
      break;
    }
    default:
      throw new Error(`unknown fixture ${name}`);
  }
  stores.set(name, s);
  return s;
}

for (const c of CASES) {
  test(`query [${c.fixture}] ${c.q}`, () => {
    const got = evalQuery(fixture(c.fixture), c.q, c.from ?? ':');
    assert.deepEqual(got, c.expect, c.note);
  });
}

// §6.2 — every pointer-shaped query yields at most one result (spot-checked over the
// singleton fragment of the corpus).
test('isPointerShapedQuery: keys/indices/ups are explicit; wildcards, sweeps and tests are searches', () => {
  for (const q of [': pets: 1', 'team: alice: age', '..: ontos', ': d: .yo', ':: yamlover: ontos', '1'])
    assert.equal(isPointerShapedQuery(q), true, q);
  for (const q of [': ?', ': ...: colors', ': pets: []', '= 5', ': a: !!<format: x>', '::: '])
    assert.equal(isPointerShapedQuery(q), false, q);
});

test('pointer-shaped queries are singletons', () => {
  const s = fixture('inline');
  for (const q of ['team: alice: age', ': pets: 1', 'team: zoe', '1', '..: ontos', 'team: alice: pet: name']) {
    assert.ok(evalQuery(s, q, ':team:alice').length <= 1, q);
  }
});
