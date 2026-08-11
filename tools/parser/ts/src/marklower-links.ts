// The marklower TOKEN grammar's framework-free half — shared between the client renderer
// (tools/server/src/client/renderers/marklower.tsx, which turns the tokens into React) and
// the engine's move planner (engine/ts/src/resolve.ts scanTextLinks, which rewrites/reports
// the prose link targets a move strands). One grammar, one place to teach it — and ONE
// target-classification seam (parseLinkTarget), so the client's navigation and the engine's
// rewriting can never disagree about what a target means.
//
// THE TARGET LAW (docs/documents/marklower/link-targets): the parenthesized target is a
// YAMLOVER EXPRESSION. Canonical: a sigiled pointer — `[t](*:: a: b)` project scope,
// `[t](*: child)` document scope, `[t](*..: sib)` parent, `[t](*name)` current. The bare
// colon form (`(::a:b)`, `(:a)`) reads FOREVER as an alias. `&…` bookmark targets are
// RESERVED (parsed, never resolved) — TODO: give them behavior in the annotations refactor.
// Scheme targets are external links; slash forms are legacy-frozen. There is NO text-level
// embed token: embedding is structural (a chapter body element — yamlover owns structure).

import type { Pointer } from './ir.ts';
import { parsePointer } from './pointer.ts';

/** A link label: may contain a balanced `[…]` (so a path used as its own label —
 *  `[:children[0]](:children[0])` — works), but a stray `]` is not a label, so a non-link `[a]` in
 *  prose is left alone. Non-greedy so adjacent tokens don't merge. */
export const LABEL = String.raw`(?:[^\[\]]|\[[^\]]*\])*?`;

/** The non-text tokens, in one alternation matched in source order:
 *
 *   1. `$$…$$` math (group 1; `[\s\S]` so a formula may span lines);
 *   2. `` `code` `` (group 2);
 *   3. `[label](target)` — a link (groups 3 = label, 4 = target).
 *
 * There is no embed arm: a leading `*` before a link is plain emphasis/text now, so
 * `*[a](b)*` is an italic link and a bare `*[a](b)` is a literal `*` followed by a link.
 */
export const TOKEN = new RegExp(
  String.raw`\$\$([\s\S]+?)\$\$|` + // 1: math
    "`([^`]+?)`|" + // 2: code
    String.raw`\[(${LABEL})\]\(([^)]+?)\)`, // 3,4: link
  "g",
);

export interface LinkTarget {
  target: string; // the parenthesized target, verbatim
  raw: string; // the whole `[label](target)` token
  start: number; // token offsets into `src`
  end: number;
  /** Offsets of the BARE target inside `src` — the token always ends with `(${target})`,
   *  so the target occupies [end - 1 - target.length, end - 1). The move planner edits
   *  exactly this span when it retargets a link. */
  targetStart: number;
  targetEnd: number;
}

/** Every link TARGET in a marklower source, with token offsets — math and code tokens are
 *  consumed by the same alternation, so a `[x](y)` inside a code span is not a link here
 *  either, exactly as the renderer sees it. */
export function linkTargets(src: string): LinkTarget[] {
  const out: LinkTarget[] = [];
  for (const m of src.matchAll(TOKEN)) {
    const target = m[4];
    if (target === undefined) continue; // math or code
    const end = m.index + m[0].length;
    out.push({ target, raw: m[0], start: m.index, end, targetStart: end - 1 - target.length, targetEnd: end - 1 });
  }
  return out;
}

/** What a link target MEANS — see THE TARGET LAW in the header. */
export type LinkTargetKind =
  | { kind: 'pointer'; ptr: Pointer; sigiled: boolean } // the in-tree ref (canonical `*…`; bare `:`/`::` alias)
  | { kind: 'anchor'; raw: string }                     // `&…` — RESERVED (annotations refactor TODO)
  | { kind: 'external'; href: string }                  // `scheme:…` — an ordinary external URL
  | { kind: 'legacy-slash'; raw: string }               // `/a/b`, `//a/b` — navigable, frozen
  | { kind: 'unresolved' };

/** True for an external target carrying a URI scheme (`http:`, `https:`, `mailto:`, …).
 *  A `::`-rooted path is not a scheme (the head before `:` must be a plain scheme name). */
const hasScheme = (s: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(s);

/** Classify a link target. THE one seam both sides use: the client resolves/navigates from
 *  it (links.tsx resolveLink), the engine rewrites/reports from it (resolve.ts
 *  scanTextLinks) — so a spelling the client navigates is exactly a spelling a move keeps
 *  alive. Junk (an unparsable pointer expression) is `unresolved`, rendered as plain text. */
export function parseLinkTarget(target: string): LinkTargetKind {
  const raw = target.trim();
  if (!raw) return { kind: 'unresolved' };
  if (raw.startsWith('&')) return { kind: 'anchor', raw }; // reserved — annotations refactor TODO
  if (raw.startsWith('*') || raw.startsWith(':')) {
    const expr = raw.startsWith('*') ? raw.slice(1) : raw; // bare `:`/`::` = the read-forever alias
    try {
      return { kind: 'pointer', ptr: parsePointer(expr), sigiled: raw.startsWith('*') };
    } catch {
      return { kind: 'unresolved' };
    }
  }
  if (raw.startsWith('//') || raw.startsWith('/')) return { kind: 'legacy-slash', raw };
  if (hasScheme(raw)) return { kind: 'external', href: raw };
  return { kind: 'unresolved' };
}
