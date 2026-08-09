// Shared pointer parser: a pointer expression (the text after `*`, already string-
// unquoted) → an unresolved Pointer. Grammar: docs/language/pointers/paths (colon — the ONLY form).
//
// COLON form (docs/language/pointers/paths): portions separated by `:`, canonical styling `: `
// (colon + space; the space is optional on input). Scope ladder — more colons,
// wider scope: bare = current, `:` = document root, `::` = project, `:::` = world
// (an AWS-like project URI). A key containing a SPACE must be quoted
// (`'дорожный знак'`); `/` is an ORDINARY character in a key (MIME types, dates).
//
// The legacy slash-separator form (the pre-colon spelling, `*/a/b`) is DEAD:
// the migration window is CLOSED (2026-07-24). A `/` never separates — `*/pets` is a
// (dangling) reference to the literal key "/pets", and `*/pets[0]/name` is a syntax
// error (text after an index group). Tests pin both.
//
// Escaping is backslash-based: `\X` makes X a literal in a key (so `\:` is a literal
// colon, `\.\.` is the literal key "..", not the parent scope).

import type { Anchor, Pointer, PointerBase, Step } from './ir.ts';

/** Parse a pointer's text (the part after `*`). `yaml` switches to YAML link semantics: a
 *  bare alias name (which yamlover would read as current-scope) is a DOCUMENT-wide name, so
 *  it resolves at the document root — `*name` (YAML) ≡ `*: name` (yamlover). The IR is
 *  concrete-agnostic; only the base scope differs. See [[yaml-not-superset]]. */
export function parsePointer(raw: string, yaml = false, opts: { allowAppend?: boolean } = {}): Pointer {
  if (yaml) {
    const p = parsePointer(raw, false, opts); // YAML names never carry a scope sigil → parses as current
    return p.base.scope === 'current' ? { ...p, base: { scope: 'document' } } : p;
  }
  const p = parseColon(raw);
  // The arity rule: a bare `-` segment is a bookmark's append or a query's any-position
  // wildcard — never link-legal in a plain `*` reference. makeAnchor opts in.
  if (opts.allowAppend !== true && p.steps.some((s) => s.sel === 'append')) {
    throw new SyntaxError(`pointer: the "-" segment is a bookmark append or a query wildcard — not link-legal ("${raw}")`);
  }
  return p;
}

// ---- colon form (docs/language/pointers/paths) ---------------------------------------------------

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

/** One colon portion → steps: `..`, a (possibly quoted) name, optional `[.±k]` groups
 *  (`[n]` reads as a legacy alias of the bare-integer portion). A bare name containing a
 *  SPACE must be quoted (docs/language/pointers/paths).
 *
 *  THE BARE-TOKEN TYPING RULE (the YAML-keys round, 2026-08-01): an UNQUOTED, UNESCAPED
 *  portion of pure digits is the INTEGER KEY — a position (`: pets: 1`); a bare `~` is the
 *  NULL KEY (YAML: `: v` ≡ `~: v`). Everything quoted or escaped is a string key, so `'1'`
 *  is the numeric STRING key and `'~'` / `\~` the literal tilde — quotes carry the
 *  distinction, exactly as in YAML. All other bare tokens (`-1`, `1.5`, `01`, `true`)
 *  remain ordinary string keys; `-1` stays reserved for a future from-the-end index. */
function portionToSteps(p: string): Step[] {
  if (p === '..') return [{ sel: 'parent' }];
  // `..` with attached index groups (`..[.-1][.]` — the table rowspan idiom): the uplink,
  // then the indexes. (The literal key ".." arrives escaped, `\.\.`, and takes the name path.)
  if (p.startsWith('..') && p[2] === '[') return [{ sel: 'parent' }, ...indexGroups(p.slice(2), p)];
  let name = '';
  let i = 0;
  let plain = true; // false once quoted or backslash-escaped — a literal string key either way
  if (p[0] === "'" || p[0] === '"') {
    plain = false;
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
      if (c === '\\' && i + 1 < p.length) { name += p[i + 1]; i++; plain = false; continue; }
      if (c === '[') break;
      if (c === ' ' || c === '\t') throw new SyntaxError(`pointer: a key containing a space must be quoted ("${p}")`);
      name += c;
    }
  }
  const steps: Step[] = [];
  if (name !== '') {
    if (plain && name === '~') steps.push({ sel: 'nullkey' });
    else if (plain && name === '-') steps.push({ sel: 'append' }); // the keyless segment (quote a literal '-' key)
    else if (plain && /^\d+$/.test(name)) steps.push({ sel: 'index', n: Number.parseInt(name, 10) });
    else steps.push({ sel: 'key', name });
  }
  if (i < p.length) steps.push(...indexGroups(p.slice(i), p));
  return steps;
}

/** A run of bracket groups on a portion tail: `[n]` (absolute — the integer key n)
 *  or `[.]` / `[.±k]` (RELATIVE — the host's own position at this depth, ± k; docs/language/pointers/relative-indexes). Bracket bodies are disjoint by form: digits = absolute, a leading
 *  `.` = relative; an offset requires an explicit sign (`[.5]` is malformed). `whole`
 *  shapes the error text of the calling grammar. */
function indexGroups(s: string, whole: string): Step[] {
  const steps: Step[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '[') throw new SyntaxError(`pointer: malformed portion "${whole}"`);
    let j = i + 1;
    if (s[j] === '.') {
      j++;
      let k = 0;
      if (s[j] === '+' || s[j] === '-') {
        const sign = s[j] === '-' ? -1 : 1;
        j++;
        let digits = '';
        while (j < s.length && s[j] >= '0' && s[j] <= '9') { digits += s[j]; j++; }
        if (digits === '') throw new SyntaxError(`pointer: malformed index in "${whole}"`);
        k = sign * Number.parseInt(digits, 10);
      }
      if (s[j] !== ']') throw new SyntaxError(`pointer: malformed index in "${whole}"`);
      steps.push({ sel: 'relindex', k });
      i = j + 1;
      continue;
    }
    let digits = '';
    while (j < s.length && s[j] >= '0' && s[j] <= '9') { digits += s[j]; j++; }
    if (digits === '' || s[j] !== ']') throw new SyntaxError(`pointer: malformed index in "${whole}"`);
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
    if (st.sel === 'parent') { toks.push('..'); continue; }
    if (st.sel === 'key') { toks.push(colonSegment(st.name)); continue; }
    if (st.sel === 'nullkey') { toks.push('~'); continue; }
    if (st.sel === 'append') { toks.push('-'); continue; } // the keyless segment
    if (st.sel === 'index') { toks.push(String(st.n)); continue; } // the bare integer segment; `[n]` is read-only
    // a relative group `[.]` / `[.±k]` attaches to the preceding token (`..[.-1][.]`,
    // `pets[.-1]` — it is a frame operator, not a portion of its own)
    const t = `[.${st.k === 0 ? '' : (st.k > 0 ? '+' : '') + st.k}]`;
    if (toks.length > 0) toks[toks.length - 1] += t;
    else toks.push(t);
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

/** THE canonical key spelling — one policy, every emitter (the YAML-keys round retired
 *  five disagreeing copies). A string key is QUOTED whenever its bare form would read as
 *  something else: empty, pure digits (a position), `~` (the null key), a leading `-` with
 *  digits (reserved), a space, or a leading quote; otherwise it rides bare with metachars
 *  backslash-escaped — `:` in the set, `/` out of it (docs/language/pointers/paths). */
export function keyPortion(name: string): string {
  if (name === '..') return '\\.\\.';
  if (
    name === '' ||
    /^\d+$/.test(name) ||
    name === '~' ||
    name === '-' || // bare '-' is the keyless segment now — a literal '-' key rides quoted
    /^-\d/.test(name) ||
    /[ \t]/.test(name) ||
    /^['"]/.test(name)
  ) {
    return `'${name.replace(/'/g, "''")}'`;
  }
  return name.replace(/[\\:[\]*&#~?!()<>=|]/g, (c) => '\\' + c);
}

/** Back-compat alias — the historical name for {@link keyPortion}. */
export const colonSegment = keyPortion;

/** Build an Anchor — a BOOKMARK (docs/language/pointers/bookmarks) — from the authored path text
 *  (after `&`, quotes already stripped): a trailing `-` segment marks keyless appended
 *  membership (ordinal); otherwise the path must end in a KEY segment — a position may not
 *  be claimed. The removed `[]` suffix is a hard parse error naming the replacement.
 *  Shared by both surface parsers; `fail` raises in the caller's error style. */
export function makeAnchor(body: string, fail: (msg: string) => never, yaml = false): Anchor {
  if (body.endsWith('[]') && !body.endsWith('\\[]')) {
    fail('the "[]" append was removed — write a trailing ": -" segment (a bookmark\'s keyless membership)');
  }
  const path = parsePointer(body, yaml, { allowAppend: true });
  // a relative index is link-only (docs/language/pointers/relative-indexes): a bookmark claiming a
  // relative position is still a position claim
  if (path.steps.some((s) => s.sel === 'relindex')) fail('a bookmark may not claim a position — "[.±k]" is link-only');
  let ordinal = false;
  const last = path.steps[path.steps.length - 1];
  if (last?.sel === 'append') { ordinal = true; path.steps = path.steps.slice(0, -1); }
  if (path.steps.some((s) => s.sel === 'append')) fail('a mid-path "-" segment is reserved — only the trailing append is defined');
  if (!ordinal) {
    if (last === undefined) fail('a bookmark path needs a key segment (or a trailing ": -" for keyless membership)');
    if (last.sel === 'nullkey') fail('a bookmark cannot create the null key');
    if (last.sel !== 'key') fail('a bookmark may not claim a position — use a trailing ": -" for keyless membership');
  }
  return { path, ...(ordinal ? { ordinal: true } : {}) };
}
