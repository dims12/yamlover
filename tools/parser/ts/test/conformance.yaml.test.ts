// YAML conformance — the superset claim, positive direction (cf. conformance.json.test.ts).
//
// For every single-document "must accept" case in the yaml/yaml-test-suite (a dir with `in.json`
// and no `error`), the yamlover parser SHOULD accept `in.yaml` and project to the SAME value as
// `in.json`. Aliases are resolved first (yamlover models `*alias` as a pointer EDGE, not an inlined
// copy — so we follow the edge to compare by value, the YAML ⊂ yamlover claim at the value level).
//
// yamlover today reads a SUBSET of YAML. Cases it does not yet handle are listed in ALLOWLIST,
// grouped by the missing feature (see ../../YAML-CONFORMANCE.md for the prioritized roadmap). The
// list is kept HONEST in both directions: a non-allowlisted case must pass, and an allowlisted case
// must still fail — so when the parser gains a feature, this test tells you exactly which ids to
// delete. Multi-document `in.json` (several JSON values) is out of scope and skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYamlover } from '../src/yamlover.ts';
import { isPointer } from '../src/ir.ts';
import type { Document, Node, Entry } from '../src/ir.ts';
import { resolvePointer } from '../../../engine/ts/src/resolve.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', '..', 'conformance', 'yaml');

// --- known gaps: cases yamlover does not yet read, grouped by the missing YAML feature ---------
// Keep grouped by cause; the union is what the gate consults. Shrink as features land.
const MULTI_DOC = ['27NA','2LFX','2XXW','33X3','36F6','3MYT','4Q9F','4V8U','52DL','5MUD','6CK3','6FWR','6JQW','6KGN','6LVF','6WPF','753E','7BMT','7BUB','7TMG','7ZZ5','82AN','8CWC','8KB6','8XYN','93WF','96L6','9BXH','9SA2','9TFX','9U5K','B3HG','BEC7','C4HZ','CC74','CPZ3','DK3J','EX5H','EXG3','F3CP','F6MC','FP8R','FTA2','H3Z8','J7PZ','J9HZ','K3WX','M29M','M7NX','MYW6','NAT4','NJ66','P76L','Q8AD','R52L','RTP8','S4T7','S7BG','SKE5','SSW6','T26H','T4YY','T5N4','U3C3','U3XV','UGM3','X8DW','XLQ9','Y2GN','Z9M4','ZWK4'];
const TAGS = ['565N','57H4','6JWB','BU8L','EHF6','M5C3','WZ62','Z67P'];
const EXPLICIT_KEY = ['5WE3','7W2P','A2M4','CT4Q','GH63','JTV5','L94M','RR7F','S9E8'];
// otherParse = scalar/flow/folding/tab gaps that error; mismatch = parses but the value differs.
// 3R3P removed 2026-06-12 (anchor refactor): a root `&sequence` anchor + sequence now reads
// correctly — path anchors land on the root node's meta and the value projects as the plain
// sequence (the anchor itself is dangling-reported at engine level, not a value concern).
// G992/M9B4/MJS9 removed 2026-07-08 (tagless block-scalar omni): a bare block-scalar self-value
// mixed with entries now parses (omni-by-default, no `!!var`), so these read correctly.
// 3ALJ/W42U removed 2026-07-18 (first corpus run since the omni rounds): both now read correctly.
// 54T7/5C5M/MXS3/Q88A removed 2026-07-25 (root-level flow): a line OPENING a flow token used to be
// split at its first `: ` as a keyed entry, so a document root `{a: 1}` read as the key `{a` with
// the string value `1}`. splitKV now scans a leading flow token whole (flowTokenEnd) and treats it
// as a key only when a `:` follows it — the `[256, 256]: *…` overlay shape.
// 652Z/ZF4X/ZK9H removed 2026-07-26 (multi-line flow): a flow collection may SPAN LINES (YAML Ch.
// 7). `Flow.ws()` now skips line breaks and an unterminated first line is sliced from the source by
// bracket balance, so `{ ?foo: bar,\nbar: 42\n}` reads whole. On the YAMLOVER surface that spanning
// additionally means an inline concrete switch to json5p (docs/language/concretes/00-storage/00-inlined); in YAML
// mode it is plain flow, which is what these cases assert.
const OTHER_PARSE = ['2EBW','4CQQ','4ZYM','5GBF','5T43','6BCT','6CA3','6HB6','6VJK','7A4E','7T8X','87E4','8UDB','9YRD','A984','AB8U','C2DT','CN3R','D83L','DBG4','DWX9','FBC9','HS5T','JR7V','K527','L9U5','LP6E','LQZ7','NB6Z','NP9H','P2AD','PRH3','QF4Y','TL85','TS54','UV7Q','XV9V','YD5X'];
const VALUE_MISMATCH = ['26DV','2AUY','2SXE','3GZX','4QFQ','4UYU','58MP','74H7','7FWL','8MK2','A6F9','AZW3','CUP7','E76Z','F2C7','H2RW','HMQ5','K54U','K858','LE5A','Q5MG','R4YG','S4JQ','UDM2','ZH7C'];
// Diverges BY DESIGN since the colon round (docs/language/pointers/paths, 2026-06-13): `:` is the path
// separator, so a YAML anchor/alias NAME containing `:` reads as a colon path. One-time
// reclassification, like the anchor round's — documented in YAML-CONFORMANCE.md.
const COLON_SEPARATOR = ['W5VH'];
const ALLOWLIST = new Set([...MULTI_DOC, ...TAGS, ...EXPLICIT_KEY, ...OTHER_PARSE, ...VALUE_MISMATCH, ...COLON_SEPARATOR]);

/** Project an IR node to a plain JS value, following `*`/`~` pointer edges to their target (so a
 *  YAML alias compares by VALUE). Mirrors YAML's object/array/scalar shapes; yamlover's mix/omni
 *  do not arise in valid YAML inputs. */
function materialize(doc: Document, node: Node, chain: Node[]): unknown {
  if (node.kind === 'blob') return '<blob>';
  if (node.entries && node.entries.length) {
    const keyed = node.entries.some((e) => e.key != null);
    if (keyed) {
      const o: Record<string, unknown> = {};
      for (const e of node.entries) o[e.key ?? '?'] = matChild(doc, e, chain.concat(node));
      return o;
    }
    return node.entries.map((e) => matChild(doc, e, chain.concat(node)));
  }
  if (node.kind === 'scalar') return node.value;
  return null;
}
function matChild(doc: Document, e: Entry, chain: Node[]): unknown {
  if (isPointer(e.value)) {
    const r = resolvePointer(doc, chain, e.value);
    return r.kind === 'node' ? materialize(doc, r.node, chain) : '<unresolved>';
  }
  return materialize(doc, e.value, chain);
}

/** Does the parser accept `in.yaml` and project to the same value as `in.json`? */
function reads(id: string, want: unknown): boolean {
  try {
    const doc = parseYamlover(readFileSync(join(dir, id, 'in.yaml'), 'utf8'), id);
    return JSON.stringify(materialize(doc, doc.root, [])) === JSON.stringify(want);
  } catch {
    return false;
  }
}

if (!existsSync(dir)) {
  test('YAML conformance corpus present', () => {
    assert.fail(`missing submodule at ${dir} — run: git submodule update --init`);
  });
} else {
  // single-document positive cases: `in.json` present, no `error`, and `in.json` is one JSON value
  const positives: { id: string; want: unknown }[] = [];
  for (const id of readdirSync(dir).sort()) {
    if (!existsSync(join(dir, id, 'in.json')) || existsSync(join(dir, id, 'error'))) continue;
    let want: unknown;
    try { want = JSON.parse(readFileSync(join(dir, id, 'in.json'), 'utf8')); } catch { continue; } // multi-doc → out of scope
    positives.push({ id, want });
  }

  test(`YAML corpus discovered (${positives.length} single-doc positive cases)`, () => {
    assert.ok(positives.length > 150, `expected many positive cases, found ${positives.length}`);
  });

  test('supported cases accept + match in.json (the YAML ⊂ yamlover subset)', () => {
    const regressed = positives.filter(({ id, want }) => !ALLOWLIST.has(id) && !reads(id, want));
    assert.equal(regressed.length, 0, `these supported cases stopped matching:\n  ${regressed.map((c) => c.id).join(', ')}`);
  });

  test('allowlisted gaps still diverge (else delete them — the list only shrinks)', () => {
    const nowPassing = positives.filter(({ id, want }) => ALLOWLIST.has(id) && reads(id, want));
    assert.equal(nowPassing.length, 0, `these now read correctly — remove from the ALLOWLIST:\n  ${nowPassing.map((c) => c.id).join(', ')}`);
  });

  test('allowlist references only real cases', () => {
    const ids = new Set(positives.map((c) => c.id));
    const stale = [...ALLOWLIST].filter((id) => !ids.has(id));
    assert.equal(stale.length, 0, `allowlist has ids not in the positive corpus: ${stale.join(', ')}`);
  });
}
