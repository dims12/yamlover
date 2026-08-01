// THE canonical path-segment spelling and tokenizer — one policy for every surface that
// writes or reads a node path: the engine store (path IS identity), resolve/graph child
// paths, the server's API paths, the client URL transport, and mv's pointer rewriting.
// The YAML-keys round (2026-08-01) retired the `[n]` segment: a position is the integer
// key and rides as a bare-digit segment (`:pets:1`); a numeric STRING key is quoted
// (`:pets:'1'`); the NULL key is `:~` (`:'~'` is the literal tilde). Bracket spellings
// (`[n]`) are read forever as aliases, written never.

import { keyPortion } from './pointer.ts';

/** One path segment: a string key, an integer position, or NULL — the null key. */
export type Seg = string | number | null;

/** One segment's canonical token (WITHOUT the leading `:`). */
export function segToken(seg: Seg): string {
  if (seg === null) return '~';
  if (typeof seg === 'number') return String(seg);
  return keyPortion(seg);
}

/** A canonical compact path from segments — root is `:`. */
export function pathOfSegs(segs: readonly Seg[]): string {
  if (segs.length === 0) return ':';
  return segs.map((s) => ':' + segToken(s)).join('');
}

/** Append one segment to a canonical path. */
export function childSeg(path: string, seg: Seg): string {
  return (path === ':' ? '' : path) + ':' + segToken(seg);
}

/**
 * Tokenize a canonical compact path back into segments — the inverse of {@link pathOfSegs},
 * quote-aware (a quoted segment is a string key whatever it holds), with the retired
 * spellings read as aliases: `[n]` → the integer position, and percent-encoded key text
 * decoded when `decode` is set (the client URL/transport form).
 */
export function segsOfPath(path: string, opts: { decode?: boolean } = {}): Seg[] {
  const segs: Seg[] = [];
  let i = 0;
  const s = path;
  while (i < s.length) {
    const c = s[i];
    if (c === ':') { i++; continue; }
    if (c === '[') {
      // the retired `[n]` alias — read forever, written never
      let j = i + 1;
      let digits = '';
      while (j < s.length && s[j] >= '0' && s[j] <= '9') { digits += s[j]; j++; }
      if (digits !== '' && s[j] === ']') { segs.push(Number.parseInt(digits, 10)); i = j + 1; continue; }
      // not an index group — fall through and read it as raw key text
    }
    if (c === "'" || c === '"') {
      const q = c;
      let name = '';
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === q) {
          if (q === "'" && s[j + 1] === "'") { name += q; j++; continue; }
          j++;
          break;
        }
        if (q === '"' && s[j] === '\\' && j + 1 < s.length) { name += s[j + 1]; j++; continue; }
        name += s[j];
      }
      segs.push(name);
      i = j;
      continue;
    }
    let raw = '';
    let plain = true;
    let j = i;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === '\\' && j + 1 < s.length) { raw += s[j + 1]; j++; plain = false; continue; }
      if (ch === ':') break;
      if (ch === '[') {
        // an attached retired index group ends the bare segment (`pets[1]`)
        let k = j + 1;
        let digits = '';
        while (k < s.length && s[k] >= '0' && s[k] <= '9') { digits += s[k]; k++; }
        if (digits !== '' && s[k] === ']') break;
      }
      raw += ch;
    }
    const text = opts.decode ? safeDecode(raw) : raw;
    if (plain && raw === '~') segs.push(null);
    else if (plain && /^\d+$/.test(raw)) segs.push(Number.parseInt(raw, 10));
    else if (text !== '') segs.push(text);
    i = j;
  }
  return segs;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
