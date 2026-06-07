// JSON conformance — the superset claim, positive direction.
//
// For every "must accept" (y_) file in nst/JSONTestSuite, the json5p parser must (a)
// succeed and (b) project to the SAME value as JSON.parse. The n_/i_ files are NOT
// asserted: json5p is deliberately more permissive (comments, trailing commas, …), so
// rejecting them is not required by the superset claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJson5p } from '../src/json5p.ts';
import { toPlain } from '../src/ir.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', '..', 'conformance', 'json', 'test_parsing');

if (!existsSync(dir)) {
  test('JSON conformance corpus present', () => {
    assert.fail(`missing submodule at ${dir} — run: git submodule update --init`);
  });
} else {
  const files = readdirSync(dir).filter((f) => f.startsWith('y_') && f.endsWith('.json')).sort();
  test(`JSON corpus discovered (${files.length} positive cases)`, () => {
    assert.ok(files.length > 50, `expected many y_ files, found ${files.length}`);
  });
  for (const f of files) {
    test(`accepts + matches JSON.parse: ${f}`, () => {
      const src = readFileSync(join(dir, f), 'utf8');
      const expected = JSON.parse(src);
      const got = toPlain(parseJson5p(src, f).root);
      assert.deepEqual(got, expected);
    });
  }
}
