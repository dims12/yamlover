// The test-examples fixture corpus (test-examples/README.md): every fixture pins the
// canonical IR of its input (`ir.json`), the byte-exact serializer output (`out.yamlover`),
// and the losslessness of the round-trip (the golden reparses IR-equal). Error fixtures
// pin the thrown message instead. Goldens come from `npm run gen:fixtures` (reviewed and
// committed); this harness only ever READS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { parseJson5p } from '../../../parser/ts/src/json5p.ts';
import { serializeYamlover } from '../../../parser/ts/src/serialize-yamlover.ts';
import { serializeJson5p } from '../../../parser/ts/src/serialize-json5p.ts';
import { LossyError } from '../../../parser/ts/src/serialize-common.ts';
import { canonDoc } from '../../../parser/ts/src/canon.ts';
import { listFixtures, detectInput } from './fixtures-util.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const corpus = join(repo, 'test-examples');

const ids = existsSync(corpus) ? listFixtures(corpus) : [];

test('test-examples corpus is present and populated', () => {
  assert.ok(ids.length >= 100, `expected >= 100 fixtures under test-examples/, found ${ids.length}`);
});

for (const id of ids) {
  const dir = join(corpus, id);
  const title = readFileSync(join(dir, '==='), 'utf8').trim();

  test(`fixture ${id}: ${title}`, () => {
    const input = detectInput(dir, repo);

    const errPath = join(dir, 'error');
    if (existsSync(errPath)) {
      const re = new RegExp(readFileSync(errPath, 'utf8').trim());
      assert.throws(() => input.load(), re, `${id}: expected parse of ${input.name} to throw ${re}`);
      assert.ok(!existsSync(join(dir, 'ir.json')) && !existsSync(join(dir, 'out.yamlover')),
        `${id}: an error fixture carries no ir.json/out.yamlover`);
      return;
    }

    // 1. parse → canonical IR matches the committed ir.json
    const doc = input.load();
    const expected = JSON.parse(readFileSync(join(dir, 'ir.json'), 'utf8'));
    assert.deepEqual(canonDoc(doc), expected, `${id}: canonical IR diverged from ir.json`);

    // 2+3. golden serialization, byte-for-byte — and the golden reparses IR-equal
    const outPath = join(dir, 'out.yamlover');
    if (existsSync(outPath)) {
      const golden = readFileSync(outPath, 'utf8');
      assert.equal(serializeYamlover(doc), golden, `${id}: serializeYamlover diverged from out.yamlover`);
      // a `lossy` marker documents a graph shape a yamlover FILE cannot reproduce (e.g. a
      // walked dir's array-projection over keyed entries) — the byte golden above still pins
      // the serializer; only the reparse-equality below is inapplicable.
      if (!existsSync(join(dir, 'lossy'))) {
        const re = parseYamlover(golden, `${id}/out.yamlover`);
        assert.deepEqual(canonDoc(re), canonDoc(doc), `${id}: out.yamlover does not reparse IR-equal`);
      }
    } else {
      // out.yamlover may be omitted ONLY for a blob-carrying doc (a blob has no yamlover
      // text form) — and then the LossyError refusal is itself the pinned behavior.
      assert.ok(JSON.stringify(expected).includes('"blob"'),
        `${id}: out.yamlover may be omitted only when ir.json carries a blob node`);
      assert.throws(() => serializeYamlover(doc), LossyError,
        `${id}: expected serializeYamlover to refuse a blob-carrying doc`);
    }

    // optional cross-concrete goldens
    const out5Path = join(dir, 'out.json5p');
    if (existsSync(out5Path)) {
      const golden5 = readFileSync(out5Path, 'utf8');
      assert.equal(serializeJson5p(doc), golden5, `${id}: serializeJson5p diverged from out.json5p`);
      const re5 = parseJson5p(golden5, `${id}/out.json5p`);
      assert.deepEqual(canonDoc(re5), canonDoc(doc), `${id}: out.json5p does not reparse IR-equal`);
    }
    const err5Path = join(dir, 'error.json5p');
    if (existsSync(err5Path)) {
      const re5 = new RegExp(readFileSync(err5Path, 'utf8').trim());
      assert.throws(() => serializeJson5p(doc),
        (e: unknown) => e instanceof LossyError && re5.test((e as Error).message),
        `${id}: expected serializeJson5p to throw LossyError matching ${re5}`);
    }
  });
}
