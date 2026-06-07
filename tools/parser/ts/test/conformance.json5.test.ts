// JSON5 conformance — the superset claim for json5/json5-tests.
//
// Convention (per the repo): `.json` = valid JSON (must accept), `.json5` = valid JSON5
// (must accept), `.js`/`.txt` = should be rejected. We assert the POSITIVE direction:
// every .json/.json5 fixture parses, and every .json fixture also matches JSON.parse.
// (Negative .js/.txt are not asserted here — see IR.md / conformance notes.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJson5p } from '../src/json5p.ts';
import { toPlain } from '../src/ir.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', 'conformance', 'json5');

if (!existsSync(root)) {
  test('JSON5 conformance corpus present', () => {
    assert.fail(`missing submodule at ${root} — run: git submodule update --init`);
  });
} else {
  const all = readdirSync(root, { recursive: true }) as string[];
  const files = all.filter(
    (f) => !f.includes('.git') && !f.split(/[\\/]/).includes('todo') &&
      (f.endsWith('.json') || f.endsWith('.json5')),
  ).sort();

  test(`JSON5 corpus discovered (${files.length} positive cases)`, () => {
    assert.ok(files.length > 20, `expected many .json/.json5 files, found ${files.length}`);
  });

  for (const rel of files) {
    test(`accepts: ${rel}`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      const doc = parseJson5p(src, rel); // must not throw
      // For `.json` fixtures, also match JSON.parse — but a few `.json`-named files in the
      // corpus actually carry JSON5-only features (e.g. comments/irregular-block-comment.json),
      // a known mislabeling. When JSON.parse itself rejects, fall back to accept-only.
      if (rel.endsWith('.json')) {
        let expected: unknown;
        try { expected = JSON.parse(src); } catch { return; }
        assert.deepEqual(toPlain(doc.root), expected);
      }
    });
  }
}
