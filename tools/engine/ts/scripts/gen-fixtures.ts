// Golden generator for the test-examples fixture corpus (test-examples/README.md).
//
//   npm run gen:fixtures                 regenerate ir.json / out.yamlover for every fixture
//   npm run gen:fixtures -- --only 03 09 restrict to fixtures whose id starts with a prefix
//   npm run gen:fixtures -- --check      diff against committed goldens, write NOTHING,
//                                        exit 1 on drift (the CI idempotence gate)
//
// Error fixtures (an `error` file) are skipped — they have no goldens; the harness asserts
// the throw. A LossyError from serializeYamlover (blob-carrying doc) removes/omits
// out.yamlover — the harness pins the refusal instead. An existing out.json5p is
// regenerated; an error.json5p is authored by hand and only verified by the harness.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serializeYamlover } from '../../../parser/ts/src/serialize-yamlover.ts';
import { serializeJson5p } from '../../../parser/ts/src/serialize-json5p.ts';
import { LossyError } from '../../../parser/ts/src/serialize-common.ts';
import { canonJson } from '../../../parser/ts/src/canon.ts';
import { listFixtures, detectInput } from '../test/fixtures-util.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const corpus = join(repo, 'test-examples');

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const onlyIdx = argv.indexOf('--only');
const prefixes = onlyIdx >= 0 ? argv.slice(onlyIdx + 1).filter((a) => !a.startsWith('--')) : [];

const ids = listFixtures(corpus).filter(
  (id) => prefixes.length === 0 || prefixes.some((p) => id.startsWith(p)),
);
if (ids.length === 0) {
  console.error(`gen-fixtures: no fixtures matched under ${corpus}`);
  process.exit(1);
}

/** file → desired content; null = the file must not exist */
function desired(dir: string): Map<string, string | null> | null {
  if (existsSync(join(dir, 'error'))) return null; // error fixture: nothing to generate
  const doc = detectInput(dir, repo).load();
  const want = new Map<string, string | null>();
  want.set('ir.json', canonJson(doc));
  try {
    want.set('out.yamlover', serializeYamlover(doc));
  } catch (e) {
    if (!(e instanceof LossyError)) throw e;
    want.set('out.yamlover', null); // blob-carrying doc: the refusal is the pinned behavior
  }
  if (existsSync(join(dir, 'out.json5p'))) want.set('out.json5p', serializeJson5p(doc));
  return want;
}

let drift = 0;
let wrote = 0;
for (const id of ids) {
  const dir = join(corpus, id);
  let want: Map<string, string | null> | null;
  try {
    want = desired(dir);
  } catch (e) {
    console.error(`✗ ${id}: ${(e as Error).message}`);
    drift++;
    continue;
  }
  if (want === null) continue;
  for (const [name, content] of want) {
    const abs = join(dir, name);
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (current === content) continue;
    if (check) {
      console.error(`✗ ${id}/${name}: ${content === null ? 'should not exist' : current === null ? 'missing' : 'differs'}`);
      drift++;
    } else if (content === null) {
      rmSync(abs);
      console.log(`- ${id}/${name} removed (LossyError — blob doc)`);
      wrote++;
    } else {
      writeFileSync(abs, content, 'utf8');
      console.log(`+ ${id}/${name}`);
      wrote++;
    }
  }
}

if (check) {
  if (drift > 0) {
    console.error(`gen-fixtures --check: ${drift} file(s) drifted — run npm run gen:fixtures and review the diff`);
    process.exit(1);
  }
  console.log(`gen-fixtures --check: ${ids.length} fixture(s) clean`);
} else {
  if (drift > 0) {
    console.error(`gen-fixtures: ${drift} fixture(s) FAILED (see above); ${wrote} file(s) written`);
    process.exit(1);
  }
  console.log(`gen-fixtures: ${ids.length} fixture(s) processed, ${wrote} file(s) written`);
}
