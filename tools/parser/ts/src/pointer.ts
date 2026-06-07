// Shared pointer parser: a pointer expression (the text after `*`, already string-
// unquoted) → an unresolved Pointer. Grammar: URIs.md "Pointer grammar & resolution".
//
// Escaping is backslash-based: `\X` makes X a literal in a key (so `\/` is a literal
// slash in a key name, `\.\.` is the literal key "..", not the parent scope).

import type { Pointer, PointerBase, Step } from './ir.ts';

const LINK_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//;

export function parsePointer(raw: string): Pointer {
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
