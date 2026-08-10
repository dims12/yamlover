// Shared bits for the IR → concrete serializers (PLAN.md 2d).

import type { Anchor, Entry, Pointer } from './ir.ts';
import { isPointer } from './ir.ts';
import { renderPointer } from './pointer.ts';

/** The target concrete cannot express this construct. The lossy policy (PLAN.md 2d) is
 *  REFUSE: a serializer never drops or silently rewrites graph data — route inexpressible
 *  metadata through the meta layer (docs/meta/attaching) or pick a fuller concrete instead. */
export class LossyError extends Error {}

/** Double-quoted, JSON-escape style — the parser's dq escapes are a JSON superset. */
export function dq(s: string): string {
  return JSON.stringify(s);
}

/** The KEYLESS MARKER at the head of a block line — the ONE law, shared by the parser, every
 *  serializer, and the server's line scanner (three places that must never disagree about what
 *  opens an entry). Returns the marker's WIDTH, or null when the line opens no keyless entry:
 *
 *    `-` / `- value`     width 1 — the canonical spelling, the only one ever EMITTED
 *    `-:` / `-: value`   width 2 — the explicit conversion sugar (docs/language/vs-yaml/differences),
 *                        an unquoted `-` in key position is the marker, not a key
 *
 *  The colon sits TIGHT against the dash and must be followed by space or EOL, so `-:x` is a plain
 *  scalar and `- : x` stays a keyless entry holding a NULL-KEYED one. A literal `-` key is quoted
 *  (see {@link keyText}) — the same trade the plain numeric key makes.
 *  `yaml` = the YAML concrete, where `-: v` is faithfully the string key `-` and only the dash counts. */
export function seqMarkLen(text: string, yaml = false): number | null {
  if (text === '-' || text.startsWith('- ')) return 1;
  if (!yaml && (text === '-:' || text.startsWith('-: '))) return 2;
  return null;
}

/** The content past a keyless marker, trimmed — null when the line opens no keyless entry. */
export function stripSeqMark(text: string, yaml = false): string | null {
  const n = seqMarkLen(text, yaml);
  return n === null ? null : text.slice(n).trim();
}

/** The CANONICAL key emission. Plain keys carry the pointer-metachar escaping (docs/language/pointers/escaping); keys the line grammar itself would misread are double-quoted instead. A
 *  NUMERIC key is always quoted (the YAML-keys round): bare `1:` is a position claim — a
 *  parse error — so the string key "1" round-trips as `"1":`. Shared with the PARSER: an
 *  authored key token that differs from this emission is representation worth keeping
 *  (EntryMeta.keyRaw), and "differs" must be judged by the one law. */
export function keyText(key: string): string {
  const needsQuote =
    key === '' || key !== key.trim() ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.includes(': ') || // splitKV would split at the inner colon
    seqMarkLen(key + ': ') !== null || // the emitted line would open a KEYLESS entry, not a key

    /^\d+$/.test(key) || // a bare numeric key reads as a position - quote the string key
    /^['"]/.test(key) ||
    key.includes('\\'); // plain keys are backslash-UNescaped on parse
  if (needsQuote) return dq(key);
  // escape the pointer metachars (incl. the docs/language/pointers/escaping reservations) — parse strips them back
  return key.replace(/[/[\]*&#~?!()<>=|]/g, (c) => '\\' + c);
}

/** The FLOW key emission: bare when word-like, single-quoted otherwise (the flow separators
 *  make more tokens unsafe than the block line grammar does). A lone `-` is the KEYLESS marker on
 *  both surfaces, so the literal key is quoted — but `-1` and `a-b` stay bare word-like keys. */
export function flowKeyText(k: string): string {
  if (k === '-') return "'-'";
  return /^[\w.$/-]+$/.test(k) ? k : `'${k.replace(/'/g, "''")}'`;
}

/** Is this authored key token REPRESENTATION worth keeping (EntryMeta.keyRaw)? — iff EITHER
 *  canonical emitter (block keyText, flow flowKeyText) would spell the key differently. A
 *  `{}` token key is keyText-canonical but flow would quote it: without the raw, a flow
 *  round-trip drifts to `'{}'`. */
export function keyRawWorthKeeping(raw: string, key: string): boolean {
  return raw !== keyText(key) || raw !== flowKeyText(key);
}

/** The CANONICAL (colon-form, spaced) path text of a bookmark token (after `&`):
 *  re-rendered from base+steps — the dual window emits `:` regardless of how the
 *  bookmark was authored — plus the ordinal trailing `-` segment. */
export function anchorBody(a: Anchor): string {
  return renderPointer(a.path) + (a.ordinal ? ': -' : '');
}

/** Deprecated `~` back entries re-emit as `&` anchors (ANCHOR_REFACTOR; serializers emit
 *  anchors only) — but ONLY the absolute-scoped ones: an anchor path resolves from the
 *  node's CONTAINER while a back entry's pointer resolves from the node itself, so a
 *  current-/parent-scoped raw cannot be transplanted verbatim. Those (none in the corpus)
 *  keep the `~` spelling through the migration window. */
export function isAnchorizableBack(e: Entry): boolean {
  return e.edge === 'back' && isPointer(e.value) &&
    (e.value.base.scope === 'document' || e.value.base.scope === 'link');
}

/** The bookmark-token body equivalent of a back entry, in canonical colon form:
 *  `~k: *P` → `P: k`, `~- *P` → `P: -`. */
export function backAnchorBody(e: Entry): string {
  if (!isPointer(e.value)) throw new LossyError('a back entry must hold a pointer');
  if (e.key === null) return renderPointer(e.value) + ': -';
  const withKey: Pointer = { ...e.value, steps: [...e.value.steps, { sel: 'key', name: e.key }] };
  return renderPointer(withKey);
}
