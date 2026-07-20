// Shared fixture plumbing for the test-examples corpus (test-examples/README.md):
// id discovery and input detection. Used by BOTH the harness (fixtures.test.ts) and the
// golden generator (scripts/gen-fixtures.ts) so the two can never disagree on what a
// fixture's input is or how it parses.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Document } from '../../../parser/ts/src/ir.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { parseJson5p } from '../../../parser/ts/src/json5p.ts';
import { walkDir } from '../src/walk.ts';

/** `0000` … plus the human-insertion form `0003-01` — plain lexicographic sort orders
 *  `0003 < 0003-01 < 0003-02 < 0004`. */
export const FIXTURE_ID = /^\d{4}(-\d{2})?$/;

export function listFixtures(corpusRoot: string): string[] {
  return readdirSync(corpusRoot)
    .filter((name) => FIXTURE_ID.test(name) && statSync(join(corpusRoot, name)).isDirectory())
    .sort();
}

export interface FixtureInput {
  /** What the input is, for messages: `in.yamlover`, `input/`, or the `from` path. */
  name: string;
  load: () => Document;
}

/** in.<ext> → parser. json/json5 are json5p subsets; yaml is the YAML-concrete mode. */
const FILE_PARSERS: Record<string, (src: string, uri: string) => Document> = {
  yamlover: (src, uri) => parseYamlover(src, uri),
  yaml: (src, uri) => parseYamlover(src, uri, { yaml: true }),
  json: (src, uri) => parseJson5p(src, uri),
  json5: (src, uri) => parseJson5p(src, uri),
  json5p: (src, uri) => parseJson5p(src, uri),
};
const IN_FILES = Object.keys(FILE_PARSERS).map((ext) => `in.${ext}`);

function loaderForPath(abs: string, display: string): FixtureInput {
  if (statSync(abs).isDirectory()) {
    // noGraft: fixtures pin the tree AS WALKED — without the `yamlover` taxonomy self-import
    // the walk would otherwise materialize into any tree that lacks its own `$defs/`.
    return { name: display, load: () => walkDir(abs, { noGraft: true }) };
  }
  const ext = abs.slice(abs.lastIndexOf('.') + 1);
  const parse = FILE_PARSERS[ext] ?? FILE_PARSERS.yamlover; // extensionless file: yamlover text
  return { name: display, load: () => parse(readFileSync(abs, 'utf8'), display) };
}

/** Resolve a fixture dir's single input — `in.<concrete>`, `input/`, or `from` (one
 *  repo-relative path). Exactly one must be present. */
export function detectInput(fixtureDir: string, repoRoot: string): FixtureInput {
  const found: FixtureInput[] = [];
  for (const name of IN_FILES) {
    const abs = join(fixtureDir, name);
    if (existsSync(abs)) found.push(loaderForPath(abs, name));
  }
  const inputDir = join(fixtureDir, 'input');
  if (existsSync(inputDir)) found.push(loaderForPath(inputDir, 'input/'));
  const fromFile = join(fixtureDir, 'from');
  if (existsSync(fromFile)) {
    const rel = readFileSync(fromFile, 'utf8').trim();
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) throw new Error(`fixture ${fixtureDir}: from-path does not exist: ${rel}`);
    found.push(loaderForPath(abs, rel));
  }
  if (found.length !== 1) {
    const names = found.map((f) => f.name).join(', ') || '(none)';
    throw new Error(`fixture ${fixtureDir}: exactly one input required, found ${found.length}: ${names}`);
  }
  return found[0];
}
