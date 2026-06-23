// Shared pointer parser: a pointer expression (the text after `*`, already string-
// unquoted) → an unresolved Pointer. Grammar: SEPARATOR.md (colon, canonical) over
// URIs.md (slash, the deprecated legacy form — still parsed through the migration
// window).
//
// COLON form (SEPARATOR.md): portions separated by `:`, canonical styling `: `
// (colon + space; the space is optional on input). Scope ladder — more colons,
// wider scope: bare = current, `:` = document root, `::` = project, `:::` = world
// (an AWS-like project URI). A key containing a SPACE must be quoted
// (`'дорожный знак'`); `/` is an ordinary character in colon portions.
//
// Detection: a raw containing an unescaped/unquoted `:` (or opening with one)
// parses as colon form; anything else takes the legacy slash path. (Slash-form
// emission escapes `:` so legacy raws never trip the heuristic.)
//
// Escaping is backslash-based: `\X` makes X a literal in a key (so `\:` is a literal
// colon, `\.\.` is the literal key "..", not the parent scope).

import type { Anchor, Pointer, PointerBase, Step } from './ir.ts';

const LINK_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//;

/** Parse a pointer's text (the part after `*`). `yaml` switches to YAML link semantics: a
 *  bare alias name (which yamlover would read as current-scope) is a DOCUMENT-wide name, so
 *  it resolves at the document root — `*name` (YAML) ≡ `*: name` (yamlover). The IR is
 *  concrete-agnostic; only the base scope differs. See [[yaml-not-superset]]. */
export function parsePointer(raw: string, yaml = false): Pointer {
  if (yaml) {
    const p = parsePointer(raw); // YAML names never carry a scope sigil → parses as current
    return p.base.scope === 'current' ? { ...p, base: { scope: 'document' } } : p;
  }
  if (looksColon(raw)) return parseColon(raw);
  const lm = LINK_RE.exec(raw);
  if (lm) {
    const after = raw.slice(lm[0].length);
    const { seg, rest } = readUntilSlash(after);
    const base: PointerBase = { scope: 'link', authority: unescape(seg) };
    return { kind: 'pointer', base, steps: parsePath(rest), raw };
  }
  if (raw[0] === '/') {
    return { kind: 'pointer', base: { scope: 'document' }, steps: parsePath(raw), raw };
  }
  // current or parent
  const segs = splitSlash(raw);
  let base: PointerBase = { scope: 'current' };
  if (segs.length > 0 && segs[0] === '..') {
    base = { scope: 'parent' };
    segs.shift();
  }
  const steps: Step[] = [];
  for (const s of segs) {
    if (s === '') continue;
    steps.push(...segToSteps(s));
  }
  return { kind: 'pointer', base, steps, raw };
}

// ---- colon form (SEPARATOR.md) ---------------------------------------------------

/** True when `raw` is colon-form: opens with the ladder, or contains a separator
 *  colon (unescaped, outside quotes). Legacy `scheme://` links stay slash-form. */
function looksColon(raw: string): boolean {
  if (raw.startsWith(':')) return true;
  if (LINK_RE.test(raw)) return false; // scheme:// — the colon belongs to the URI
  let q: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && q === null) { i++; continue; }
    if (q !== null) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === ':') return true;
  }
  return false;
}

function parseColon(raw: string): Pointer {
  let rest = raw;
  let base: PointerBase;
  if (rest.startsWith(':::')) {
    rest = rest.slice(3);
    const portions = splitColon(rest);
    const auth = portions.shift();
    if (auth === undefined || auth === '') throw new SyntaxError(`pointer: ":::" needs an authority in "${raw}"`);
    base = { scope: 'link', authority: portionName(auth), world: true };
    return { kind: 'pointer', base, steps: portionsToSteps(portions), raw };
  }
  if (rest.startsWith('::')) {
    rest = rest.slice(2);
    const portions = splitColon(rest);
    const auth = portions.shift();
    if (auth === undefined || auth === '') throw new SyntaxError(`pointer: "::" needs a first portion in "${raw}"`);
    base = { scope: 'link', authority: portionName(auth) };
    return { kind: 'pointer', base, steps: portionsToSteps(portions), raw };
  }
  if (rest.startsWith(':')) {
    return { kind: 'pointer', base: { scope: 'document' }, steps: portionsToSteps(splitColon(rest.slice(1))), raw };
  }
  const portions = splitColon(rest);
  base = { scope: 'current' };
  if (portions.length > 0 && portions[0] === '..') {
    base = { scope: 'parent' };
    portions.shift();
  }
  return { kind: 'pointer', base, steps: portionsToSteps(portions), raw };
}

/** Split on unescaped, unquoted `:`; trim surrounding whitespace per portion (the
 *  `: ` styling). Quotes and backslash pairs ride through intact. */
function splitColon(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q !== null) { cur += c; if (c === q) q = null; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === ':') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter((p) => p !== '');
}

function portionsToSteps(portions: string[]): Step[] {
  const out: Step[] = [];
  for (const p of portions) out.push(...portionToSteps(p));
  return out;
}

/** One colon portion → steps: `..`, a (possibly quoted) name, optional `[n]` groups.
 *  A bare name containing a SPACE must be quoted (SEPARATOR.md §3). */
function portionToSteps(p: string): Step[] {
  if (p === '..') return [{ sel: 'parent' }];
  let name = '';
  let i = 0;
  if (p[0] === "'" || p[0] === '"') {
    const q = p[0];
    i = 1;
    for (; i < p.length; i++) {
      if (p[i] === q) {
        if (q === "'" && p[i + 1] === "'") { name += q; i++; continue; }
        i++;
        break;
      }
      if (q === '"' && p[i] === '\\' && i + 1 < p.length) { name += p[i + 1]; i++; continue; }
      name += p[i];
    }
  } else {
    for (; i < p.length; i++) {
      const c = p[i];
      if (c === '\\' && i + 1 < p.length) { name += p[i + 1]; i++; continue; }
      if (c === '[') break;
      if (c === ' ' || c === '\t') throw new SyntaxError(`pointer: a key containing a space must be quoted ("${p}")`);
      name += c;
    }
  }
  const steps: Step[] = [];
  if (name !== '') steps.push({ sel: 'key', name });
  while (i < p.length) {
    if (p[i] !== '[') throw new SyntaxError(`pointer: malformed portion "${p}"`);
    let j = i + 1;
    let digits = '';
    while (j < p.length && p[j] >= '0' && p[j] <= '9') { digits += p[j]; j++; }
    if (digits === '' || p[j] !== ']') throw new SyntaxError(`pointer: malformed index in "${p}"`);
    steps.push({ sel: 'index', n: Number.parseInt(digits, 10) });
    i = j + 1;
  }
  return steps;
}

/** The authority portion of `::` / `:::` — a (possibly quoted) plain name. */
function portionName(p: string): string {
  const steps = portionToSteps(p);
  if (steps.length !== 1 || steps[0].sel !== 'key') throw new SyntaxError(`pointer: bad authority portion "${p}"`);
  return steps[0].name;
}

/** Render a pointer in CANONICAL colon form (the dual window's emission side):
 *  `spaced` = the `: ` styling for block positions; compact (no spaces) for flow
 *  and `!!<…>` contexts. The raw is NOT used — base+steps are re-rendered. */
export function renderPointer(p: Pointer, opts: { spaced?: boolean } = {}): string {
  const spaced = opts.spaced !== false;
  const sep = spaced ? ': ' : ':';
  const toks: string[] = [];
  for (const st of p.steps) {
    if (st.sel === 'parent') toks.push('..');
    else if (st.sel === 'key') toks.push(colonSegment(st.name));
    else if (toks.length > 0 && !toks[toks.length - 1].endsWith('..')) toks[toks.length - 1] += `[${st.n}]`;
    else toks.push(`[${st.n}]`);
  }
  const body = toks.join(sep);
  switch (p.base.scope) {
    case 'current': return body;
    case 'parent': return body === '' ? '..' : '..' + sep + body;
    case 'document': return ':' + (body === '' ? '' : (spaced ? ' ' : '') + body);
    case 'link': {
      const ladder = p.base.world === true ? ':::' : '::';
      const auth = colonSegment(p.base.authority);
      return ladder + (spaced ? ' ' : '') + auth + (body === '' ? '' : sep + body);
    }
  }
}

/** One colon-form key portion: quoted when it holds a space (or opens with a quote),
 *  else metachar-escaped — `:` joins the set, `/` has LEFT it (SEPARATOR.md §3). */
export function colonSegment(name: string): string {
  if (name === '..') return '\\.\\.';
  if (/[ \t]/.test(name) || /^['"]/.test(name)) return `'${name.replace(/'/g, "''")}'`;
  return name.replace(/[\\:[\]*&#~?!()<>=|]/g, (c) => '\\' + c);
}

/** Split a path that may start with `/`, dropping the leading empty segment. */
function parsePath(path: string): Step[] {
  const segs = splitSlash(path);
  const out: Step[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '') continue; // leading "/" and accidental "//"
    out.push(...segToSteps(segs[i]));
  }
  return out;
}

/** Split on unescaped `/`, keeping backslash escapes intact within segments. */
function splitSlash(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '/') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function readUntilSlash(s: string): { seg: string; rest: string } {
  let i = 0;
  let seg = '';
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { seg += c + s[i + 1]; i++; continue; }
    if (c === '/') break;
    seg += c;
  }
  return { seg, rest: s.slice(i) }; // rest starts at the '/' or is ''
}

/** A `/`-delimited segment → steps: a name (with optional [n] indices) or `..`. */
function segToSteps(seg: string): Step[] {
  if (seg === '..') return [{ sel: 'parent' }];

  let i = 0;
  let name = '';
  for (; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\\' && i + 1 < seg.length) { name += c + seg[i + 1]; i++; continue; }
    if (c === '[') break;
    name += c;
  }

  const steps: Step[] = [];
  if (name !== '') steps.push({ sel: 'key', name: unescape(name) });

  while (i < seg.length) {
    if (seg[i] !== '[') throw new SyntaxError(`pointer: malformed segment "${seg}"`);
    let j = i + 1;
    let digits = '';
    while (j < seg.length && seg[j] >= '0' && seg[j] <= '9') { digits += seg[j]; j++; }
    if (digits === '' || seg[j] !== ']') throw new SyntaxError(`pointer: malformed index in "${seg}"`);
    steps.push({ sel: 'index', n: Number.parseInt(digits, 10) });
    i = j + 1;
  }
  return steps;
}

function unescape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
    out += s[i];
  }
  return out;
}

/** Build an Anchor (URIs.md §`&`) from the authored path text (after `&`, quotes already
 *  stripped): strip a trailing `[]` (ordinal membership), parse the rest as a pointer, and
 *  check that a keyed anchor ends in a KEY segment — a position may not be claimed. Shared
 *  by both surface parsers; `fail` raises in the caller's error style. */
export function makeAnchor(body: string, fail: (msg: string) => never, yaml = false): Anchor {
  let ordinal = false;
  if (body.endsWith('[]') && !body.endsWith('\\[]')) { ordinal = true; body = body.slice(0, -2); }
  const path = parsePointer(body, yaml);
  if (!ordinal) {
    const last = path.steps[path.steps.length - 1];
    if (last === undefined) fail('an anchor path needs a key segment (or a trailing "[]" for ordinal membership)');
    if (last.sel !== 'key') fail('an anchor may not claim a position — use a trailing "[]" for ordinal membership');
  }
  return { path, ...(ordinal ? { ordinal: true } : {}) };
}

/** Render a key as ONE LEGACY (slash-form) path segment — the inverse of
 *  `unescape`/`segToSteps`: backslash-escape the metachars (incl. the QUERY.md
 *  reservations, and `:` so a legacy raw never trips the colon-form heuristic)
 *  and spell the literal-`..` key `\.\.` so it does not read as the parent step. */
export function escapeSegment(name: string): string {
  if (name === '..') return '\\.\\.';
  return name.replace(/[\\/:[\]*&#~?!()<>=|]/g, (c) => '\\' + c);
}
