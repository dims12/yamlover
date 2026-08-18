#!/usr/bin/env node
// migrate-dot-yo — one-time sweep respelling a tree's technical keys to the dot convention
// (docs/annotations): the reserved overlay key `yo:` → `.yo:`, and `yamlover-thumbnails:`
// → the `thumbnails:` mapping under the node's `.yo:` key. Legacy spellings stay READABLE
// forever — this sweep is a tidy-up, never a rescue.
//
// Method: parse with the repo parser → transform the IR (keys only — prose, block scalars
// and comments are untouched by construction) → serialize WITH comments → parse-check →
// write only when changed. Never regex line surgery: a `yo:` inside a block scalar must
// not move.
//
//   node tools/migrate-dot-yo.ts <root> [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { parseYamlover } from './parser/ts/src/yamlover.ts';
import { serializeYamlover } from './parser/ts/src/serialize-yamlover.ts';
import type { Document, Entry, Node, Value } from './parser/ts/src/ir.ts';
import { isPointer } from './parser/ts/src/ir.ts';
import {
  LEGACY_OVERLAY_KEY, LEGACY_THUMBNAILS_KEY, OVERLAY_KEY, THUMBNAILS_SUBKEY,
} from './parser/ts/src/overlay-keys.ts';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const root = args.find((a) => !a.startsWith('--'));
if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('usage: node tools/migrate-dot-yo.ts <root> [--dry-run]');
  process.exit(1);
}

/** Rename `yo:` → `.yo:` and fold `yamlover-thumbnails:` under `.yo: thumbnails:` in place.
 *  Returns whether anything changed. */
function transform(node: Value): boolean {
  if (isPointer(node)) return false;
  let changed = false;
  const entries: Entry[] = (node as Node).entries ?? [];
  // 1) rename the overlay key (merging into an existing `.yo:` if the file carries both)
  const dot = entries.find((e) => e.key === OVERLAY_KEY);
  const legacy = entries.find((e) => e.key === LEGACY_OVERLAY_KEY && !isPointer(e.value));
  if (legacy) {
    if (dot && !isPointer(dot.value)) {
      (dot.value.entries ??= []).push(...((legacy.value as Node).entries ?? []));
      entries.splice(entries.indexOf(legacy), 1);
    } else {
      legacy.key = OVERLAY_KEY;
    }
    changed = true;
  }
  // 2) fold the legacy thumbnails registry under `.yo: thumbnails:`
  const thumbs = entries.find((e) => e.key === LEGACY_THUMBNAILS_KEY && !isPointer(e.value));
  if (thumbs) {
    entries.splice(entries.indexOf(thumbs), 1);
    let yo = entries.find((e) => e.key === OVERLAY_KEY);
    if (!yo || isPointer(yo.value)) {
      yo = { key: OVERLAY_KEY, edge: 'contain', value: { kind: 'mapping', entries: [], array: false } as unknown as Node } as Entry;
      entries.push(yo);
    }
    const yoNode = yo.value as Node;
    let reg = (yoNode.entries ??= []).find((e) => e.key === THUMBNAILS_SUBKEY);
    if (!reg || isPointer(reg.value)) {
      reg = { key: THUMBNAILS_SUBKEY, edge: 'contain', value: { kind: 'mapping', entries: [], array: false } as unknown as Node } as Entry;
      yoNode.entries.push(reg);
    }
    ((reg.value as Node).entries ??= []).push(...((thumbs.value as Node).entries ?? []));
    changed = true;
  }
  for (const e of entries) changed = transform(e.value) || changed;
  return changed;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.trash']);
let migrated = 0;
let failed = 0;

function visitFile(abs: string): void {
  const text = fs.readFileSync(abs, 'utf8');
  let doc: Document;
  try {
    doc = parseYamlover(text, abs);
  } catch (e) {
    console.warn(`SKIP (unparsable): ${abs} — ${(e as Error).message}`);
    failed++;
    return;
  }
  if (!transform(doc.root)) return;
  const out = serializeYamlover(doc, { comments: true });
  try {
    parseYamlover(out, abs); // the parse-check: never write what the parser refuses
  } catch (e) {
    console.warn(`SKIP (re-parse failed): ${abs} — ${(e as Error).message}`);
    failed++;
    return;
  }
  console.log(`${dry ? '[dry] ' : ''}migrate ${abs}`);
  if (!dry) fs.writeFileSync(abs, out);
  migrated++;
}

function visit(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith('.') && name !== '.yo') continue; // foreign dot-dirs stay foreign
      visit(abs);
      continue;
    }
    const inYoDir = path.basename(dir) === '.yo';
    if (inYoDir) {
      if (name === 'body.yo') visitFile(abs); // the one .yo-internal file that carries these keys
      continue;
    }
    if (/\.(yo|yamlover)$/i.test(name)) visitFile(abs);
  }
}

visit(root);
console.log(`migrate-dot-yo: ${migrated} file(s) ${dry ? 'would change' : 'migrated'}${failed ? `, ${failed} skipped` : ''}`);
