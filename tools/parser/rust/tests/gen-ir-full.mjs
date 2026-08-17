// Dump every test-examples fixture's FULL IR as JSON, so the Rust serializer can be gated
// byte-for-byte against the committed `out.yo` goldens before a Rust parser exists.
//
//   node tools/parser/rust/tests/gen-ir-full.mjs
//
// Writes tools/parser/rust/tests/ir-full/<id>.json (gitignored) and skips error fixtures.
// Run it, then `cargo test --test conformance`.
//
// WHY NOT `ir.json`. The committed golden is `canonJson`, and canon deliberately drops
// scalar `raw`, comments and layout — "graph identity, not typography" (canon.ts). But the
// serializer has a RAW-FIRST LAW: a scalar carrying `raw` re-emits in its authored spelling
// once that spelling proves to reparse to the same value. Feeding it canon IR would produce
// canonical output, which differs from `out.yo` on every fixture whose source carried a
// preserved spelling. So this dumps what the serializer actually consumes.
//
// WHY NOT COMMITTED. This is scaffolding for the writer-first phase. Once the Rust parser
// lands, the gate becomes parse → serialize → compare `out.yo`, needing no intermediate
// file at all — so committing ~149 more goldens would be paying permanently for a temporary
// bridge. The Rust test skips with instructions when the directory is absent, the same
// posture the JSON/JSON5/YAML conformance corpora already take.
//
// SPANS ARE OMITTED: the serializer never reads them, and they would triple the size.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listFixtures, detectInput } from '../../../engine/ts/test/fixtures-util.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const corpus = join(repo, 'test-examples');
const outDir = join(here, 'ir-full');

/** JSON cannot hold NaN / ±Infinity / -0 — the same sentinels canon.ts uses. */
function num(v) {
  if (Number.isNaN(v)) return { $num: 'nan' };
  if (v === Infinity) return { $num: 'inf' };
  if (v === -Infinity) return { $num: '-inf' };
  if (Object.is(v, -0)) return { $num: '-0' };
  return v;
}

function scalarValue(v) {
  if (typeof v === 'number') return num(v);
  return v; // string | boolean | null
}

function comments(list) {
  return (list ?? []).map((c) => ({
    text: c.text,
    placement: c.placement,
    style: c.style,
    ...(c.blankBefore === true ? { blankBefore: true } : {}),
  }));
}

function pointer(p) {
  return { kind: 'pointer', base: p.base, steps: p.steps, raw: p.raw };
}

function nodeMeta(m) {
  if (m === undefined) return undefined;
  const out = {};
  if (m.anchors?.length) out.anchors = m.anchors.map((a) => ({ path: pointer(a.path), ...(a.ordinal ? { ordinal: true } : {}) }));
  if (m.schema !== undefined) out.schema = value(m.schema);
  if (m.set === true) out.set = true;
  if (m.yo === true) out.yo = true;
  if (m.hidden === true) out.hidden = true;
  if (m.dirBacked === true) out.dirBacked = true;
  if (m.documentRoot === true) out.documentRoot = true;
  if (m.positional !== undefined) out.positional = m.positional;
  if (m.selfAt !== undefined) out.selfAt = m.selfAt;
  if (m.style !== undefined) out.style = m.style;
  if (m.concrete !== undefined) out.concrete = m.concrete;
  if (m.derivedFormat !== undefined) out.derivedFormat = m.derivedFormat;
  if (m.parseError !== undefined) out.parseError = m.parseError;
  if (m.comments?.length) out.comments = comments(m.comments);
  if (m.head?.length) out.head = comments(m.head);
  return Object.keys(out).length > 0 ? out : undefined;
}

function entryMeta(m) {
  if (m === undefined) return undefined;
  const out = {};
  if (m.keyRaw !== undefined) out.keyRaw = m.keyRaw;
  if (m.keyConcrete !== undefined) out.keyConcrete = m.keyConcrete;
  if (m.blankBefore === true) out.blankBefore = true;
  if (m.comments?.length) out.comments = comments(m.comments);
  return Object.keys(out).length > 0 ? out : undefined;
}

function value(v) {
  if (v?.kind === 'pointer') return pointer(v);
  return node(v);
}

function node(n) {
  const out = { kind: n.kind };
  if (n.kind === 'scalar') {
    out.value = scalarValue(n.value);
    out.raw = n.raw ?? '';
  } else if (n.kind === 'blob') {
    out.format = n.format;
    out.contentHash = n.contentHash;
    out.size = n.size;
  }
  if (n.array === true) out.array = true;
  const meta = nodeMeta(n.meta);
  if (meta !== undefined) out.meta = meta;
  out.entries = (n.entries ?? []).map((e) => {
    const en = { key: e.key, edge: e.edge, value: value(e.value) };
    if (e.nullKey === true) en.nullKey = true;
    const em = entryMeta(e.meta);
    if (em !== undefined) en.meta = em;
    return en;
  });
  return out;
}

function irFull(doc) {
  return {
    source: { concrete: doc.source.concrete, uri: doc.source.uri },
    ...(doc.head?.length ? { head: comments(doc.head) } : {}),
    root: node(doc.root),
  };
}

if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

let wrote = 0;
let skipped = 0;
const failed = [];
for (const id of listFixtures(corpus)) {
  const dir = join(corpus, id);
  if (existsSync(join(dir, 'error'))) {
    skipped++;
    continue; // error fixture: no goldens, the TS harness asserts the throw
  }
  try {
    const doc = detectInput(dir, repo).load();
    writeFileSync(join(outDir, `${id}.json`), JSON.stringify(irFull(doc), null, 1) + '\n');
    wrote++;
  } catch (e) {
    failed.push(`${id}: ${e.message}`);
  }
}
console.log(`gen-ir-full: ${wrote} written, ${skipped} error-fixture(s) skipped` +
  (failed.length ? `, ${failed.length} FAILED:\n  ${failed.join('\n  ')}` : ''));
