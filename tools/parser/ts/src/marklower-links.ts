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
 *   1. ```` ``` ```` fenced block (group 1 = the opening backtick run; the closer is the
 *      SAME run, via backreference) — marklower does not claim the fence as syntax, but the
 *      markdown files this scanner also reads are full of them, and without this arm a
 *      fence's odd backtick count DESYNCS the code arm: every later inline span leaks its
 *      contents to link scanning (the fence-desync dogfooding report). Consumed whole,
 *      passed through verbatim;
 *   2. `$$…$$` math (group 2; `[\s\S]` so a formula may span lines);
 *   3. `` `code` `` (group 3);
 *   4. `[label](target)` — a link (groups 4 = label, 5 = target).
 *
 * There is no embed arm: a leading `*` before a link is plain text now — a link is an
 * emphasis BOUNDARY (labels style themselves: `[*a*](b)`), so `*[a](b)*` is a literal
 * asterisk pair around a link and a bare `*[a](b)` is a literal `*` followed by a link.
 */
export const TOKEN = new RegExp(
  '(`{3,})[\\s\\S]*?\\1|' + // 1: fenced block — atomic, never re-interpreted
    String.raw`\$\$([\s\S]+?)\$\$|` + // 2: math
    "`([^`]+?)`|" + // 3: code
    String.raw`\[(${LABEL})\]\(([^)]+?)\)`, // 4,5: link
  "g",
);

// ───────────────────────────── THE FRAGMENT-TOKEN SCANNER ─────────────────────────────
// `[…](…)` is flow syntax for an omni FRAGMENT (docs/documents/marklower/grammar): the `[]`
// part holds optional `&` bookmarks + the self-value, the `()` part the field kseq — a keyless
// pointer/URL among the fields is the LINK, and a parens content that classifies whole as a
// pointer/URL is today's plain hyperlink, unchanged. The regex arms above cannot carry this
// (quotes may hide `)` and `,`, URLs balance parens), so the boundary is found by a small
// quote/depth-aware scan — THE one seam the renderer, the editor, and the engine's move
// planner all share.

const ATOMIC = new RegExp(
  '(`{3,})[\\s\\S]*?\\1|' + // 1: fenced block
    String.raw`\$\$([\s\S]+?)\$\$|` + // 2: math
    "`([^`]+?)`", // 3: code
  "g",
);

export type MarkToken =
  | { kind: "fence" | "math" | "code"; start: number; end: number; raw: string; body: string }
  | FragToken;

export interface FragToken {
  kind: "frag";
  start: number;
  end: number;
  raw: string;
  /** The `[]` contents, verbatim. */
  label: string;
  /** The `()` contents, verbatim (may be ""). */
  parens: string;
  /** The label's leading `&` bookmark tokens, verbatim (`&::ontos:x:-`, `&'a: b'`). */
  bookmarks: string[];
  /** The visible text / member self-value, UNQUOTED (yamlover scalar rules inside `[]`). */
  value: string;
  /** The self-value as spelled (quotes kept). */
  valueRaw: string;
  /** The keyless pointer/URL field — the fragment's link — verbatim, or null. */
  link: string | null;
  /** Absolute offsets of `link` inside the source (-1 when none) — the move planner's span. */
  linkStart: number;
  linkEnd: number;
  /** The keyed fields (`description: …`), values verbatim. */
  fields: { key: string; raw: string }[];
  /** True when the WHOLE parens content classified as one pointer/URL (a plain hyperlink). */
  plainLink: boolean;
}

/** Unquote a `[]` value by the yamlover scalar rules: single quotes double to escape,
 *  double quotes read JSON-style; a bare token is itself. */
function unquoteScalar(t: string): string {
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); }
  }
  return t;
}

/** Split the label into leading bookmark tokens and the value. A bookmark is self-delimiting
 *  when its ladder ends in a `-` segment (`&:: ontos: x: -` — an onto membership) or when its
 *  path is quoted (`&'a: b'`); the remainder (past one separating `:` or whitespace) is the
 *  value (docs/documents/marklower/grammar). */
function parseLabel(label: string): { bookmarks: string[]; valueRaw: string } {
  const bookmarks: string[] = [];
  let rest = label;
  for (;;) {
    const t = rest.replace(/^\s+/, "");
    if (!t.startsWith("&")) { rest = t; break; }
    if (t[1] === "'") {
      const close = t.indexOf("'", 2);
      if (close < 0) { rest = t; break; } // unterminated — the whole thing is the value
      bookmarks.push(t.slice(0, close + 1));
      rest = t.slice(close + 1).replace(/^\s*:?\s*/, "");
    } else {
      const m = /^&[^,]*?:\s*-\s*(?=:|$)/.exec(t); // the ladder up to its first `-` segment
      if (!m) { rest = t; break; }
      bookmarks.push(m[0].replace(/\s+/g, " ").trim());
      rest = t.slice(m[0].length).replace(/^\s*:?\s*/, "");
    }
  }
  return { bookmarks, valueRaw: rest.trim() };
}

/** Top-level comma split of the parens content — quotes hide commas; nested `[]{}()` balance. */
function splitFields(inner: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) { out.push({ text: inner.slice(start, i), at: start }); start = i + 1; }
  }
  out.push({ text: inner.slice(start), at: start });
  return out;
}

/** Try to read one fragment token opening at `src[at] === "["`. Null when the shape is not a
 *  token (a plain bracketed word stays prose — marklower claims only the FULL `[..](..)`). */
function readFragToken(src: string, at: number): FragToken | null {
  // the label: quote-aware, one nesting level of bare brackets (a path used as its own label)
  let i = at + 1;
  let depth = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[") { if (depth > 0) return null; depth++; }
    else if (ch === "]") { if (depth > 0) { depth--; continue; } break; }
    else if (ch === "\n") return null; // a label never spans lines
  }
  if (i >= src.length || src[i] !== "]" || src[i + 1] !== "(") return null;
  const label = src.slice(at + 1, i);
  // the parens: quote-aware, depth-balanced (URLs with parens ride quoted or balanced)
  let j = i + 2;
  depth = 0;
  quote = null;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") { if (depth > 0) { depth--; continue; } break; }
  }
  if (j >= src.length || src[j] !== ")") return null;
  const parens = src.slice(i + 2, j);
  const end = j + 1;

  const { bookmarks, valueRaw } = parseLabel(label);
  const value = unquoteScalar(valueRaw);

  let link: string | null = null;
  let linkStart = -1;
  let linkEnd = -1;
  let plainLink = false;
  const fields: { key: string; raw: string }[] = [];
  const parensAbs = i + 2;
  const trimmed = parens.trim();
  if (trimmed !== "") {
    // CLASSIFICATION PRECEDENCE (docs/documents/marklower/link-targets): the whole content as
    // one pointer/URL wins — today's plain hyperlink reading, unchanged.
    if (parseLinkTarget(trimmed).kind !== "unresolved") {
      link = trimmed;
      linkStart = parensAbs + (parens.length - parens.replace(/^\s+/, "").length);
      linkEnd = linkStart + trimmed.length;
      plainLink = true;
    } else {
      for (const part of splitFields(parens)) {
        const pt = part.text.trim();
        if (!pt) continue;
        if (link === null && parseLinkTarget(pt).kind !== "unresolved") {
          link = pt;
          linkStart = parensAbs + part.at + (part.text.length - part.text.replace(/^\s+/, "").length);
          linkEnd = linkStart + pt.length;
          continue;
        }
        const kv = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:\s*([\s\S]*)$/.exec(pt);
        if (kv) fields.push({ key: kv[1], raw: kv[2] });
        // junk parts are ignored here — the doctor's suspect list is the place to surface them
      }
    }
  }
  return {
    kind: "frag", start: at, end, raw: src.slice(at, end),
    label, parens, bookmarks, value, valueRaw, link, linkStart, linkEnd, fields, plainLink,
  };
}

/** THE SCANNER: every marklower token of `src` in source order — fences, math, code (atomic,
 *  never re-entered) and fragment tokens. A `[` that opens no well-formed token stays prose. */
export function scanMarklower(src: string): MarkToken[] {
  const out: MarkToken[] = [];
  ATOMIC.lastIndex = 0;
  let i = 0;
  let m = ATOMIC.exec(src);
  while (i < src.length) {
    // the next atomic token at/after i
    while (m && m.index < i) m = ATOMIC.exec(src);
    // the next fragment token at/after i, before the atomic one
    let frag: FragToken | null = null;
    const limit = m ? m.index : src.length;
    for (let k = src.indexOf("[", i); k >= 0 && k < limit; k = src.indexOf("[", k + 1)) {
      const f = readFragToken(src, k);
      if (f) { frag = f; break; }
    }
    if (frag) {
      out.push(frag);
      i = frag.end;
      continue;
    }
    if (!m) break;
    const kind = m[1] !== undefined ? "fence" : m[2] !== undefined ? "math" : "code";
    out.push({ kind, start: m.index, end: m.index + m[0].length, raw: m[0], body: m[2] ?? m[3] ?? m[0] });
    i = m.index + m[0].length;
    m = ATOMIC.exec(src);
  }
  return out;
}

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
 *  consumed by the same scanner, so a `[x](y)` inside a code span is not a link here either,
 *  exactly as the renderer sees it. A fragment token contributes its keyless LINK field (the
 *  span the move planner rewrites); a link-less fragment contributes nothing. */
export function linkTargets(src: string): LinkTarget[] {
  const out: LinkTarget[] = [];
  for (const t of scanMarklower(src)) {
    if (t.kind !== "frag" || t.link === null) continue;
    out.push({ target: t.link, raw: t.raw, start: t.start, end: t.end, targetStart: t.linkStart, targetEnd: t.linkEnd });
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
 *  A `::`-rooted path is not a scheme (the head before `:` must be a plain scheme name), and
 *  neither is a spaced `key: value` head — a real URI never has whitespace after its colon
 *  (the fragment-token kseq collision, docs/documents/marklower/link-targets). */
const hasScheme = (s: string): boolean => /^[a-z][a-z0-9+.-]*:(?!\s|$)/i.test(s);

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
