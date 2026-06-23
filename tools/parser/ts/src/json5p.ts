// Hand-written recursive-descent parser for json5p (JSON5 + pointers) → the IR.
// Spec: JSON5P.md. JSON ⊂ JSON5 ⊂ json5p, so this also accepts all JSON/JSON5.
//
// Adds over JSON5: `*'<pointer>'` (deref), `&'<path>' <value>` (PATH anchor — URIs.md §`&`;
// quoted like a pointer, trailing `[]` = ordinal membership, several may stack; a legacy
// bare `&name` reads as the current-scope path `name`), and the deprecated `~key:` /
// `~*'…'` back-edges (≡ `&'P/key'` / `&'P[]'`).

import type { Document, Node, Mapping, Scalar, Entry, Value } from './ir.ts';
import { isPointer } from './ir.ts';
import { parsePointer, makeAnchor } from './pointer.ts';
import { attachComments, type RawComment } from './comments.ts';

const WS = new Set([' ', '\t', '\n', '\r', '\v', '\f', ' ', '﻿']);

export function parseJson5p(src: string, uri = '<json5p>'): Document {
  const p = new Parser(src, uri);
  p.ws();
  const root = p.value();
  p.ws();
  if (p.i < src.length) p.fail('trailing characters');
  if (isPointer(root)) return p.fail('a top-level pointer is not allowed'); // narrows root → Node
  root.meta = { ...root.meta, span: { uri, start: 0, end: src.length } };
  const doc: Document = { root, source: { concrete: 'json5p', uri } };
  attachComments(doc, p.comments, src, uri);
  return doc;
}

class Parser {
  src: string;
  uri: string;
  i = 0;
  comments: RawComment[] = []; // captured in ws(); placed onto the tree after the parse

  constructor(src: string, uri: string) { this.src = src; this.uri = uri; }

  fail(msg: string): never {
    throw new SyntaxError(`json5p: ${msg} at offset ${this.i}`);
  }
  peek(): string | undefined { return this.src[this.i]; }
  eof(): boolean { return this.i >= this.src.length; }

  ws(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) return;
      if (WS.has(c)) { this.i++; continue; }
      if (c === '/' && this.src[this.i + 1] === '/') {
        const start = this.i;
        this.i += 2;
        while (this.i < this.src.length && this.src[this.i] !== '\n' && this.src[this.i] !== '\r') this.i++;
        this.comments.push({ start, end: this.i, text: this.src.slice(start + 2, this.i).replace(/\s+$/, ''), ownLine: this.atLineStart(start), style: 'line' });
        continue;
      }
      if (c === '/' && this.src[this.i + 1] === '*') {
        const start = this.i;
        this.i += 2;
        while (this.i < this.src.length && !(this.src[this.i] === '*' && this.src[this.i + 1] === '/')) this.i++;
        if (this.i >= this.src.length) this.fail('unterminated block comment');
        this.i += 2;
        this.comments.push({ start, end: this.i, text: this.src.slice(start + 2, this.i - 2).trim(), ownLine: this.atLineStart(start), style: 'block' });
        continue;
      }
      return;
    }
  }

  /** True when only whitespace precedes `off` on its line (so a comment there is own-line). */
  atLineStart(off: number): boolean {
    const ls = this.src.lastIndexOf('\n', off - 1);
    return /^[ \t\r]*$/.test(this.src.slice(ls + 1, off));
  }

  value(): Node | import('./ir.ts').Pointer {
    const c = this.peek();
    if (c === undefined) this.fail('unexpected end of input');
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '*') return this.pointer();
    if (c === '&') return this.anchored();
    if (c === '"' || c === "'") return this.string();
    return this.numberOrKeyword();
  }

  object(): Mapping {
    this.i++; // {
    const entries: Entry[] = [];
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === '}') { this.i++; break; }
      if (c === undefined) this.fail('unterminated object');
      const entryStart = this.i; // the entry's source range starts at its key (or `~`) …
      let back = false;
      if (this.peek() === '~') { back = true; this.i++; }
      if (back && this.peek() === '*') {
        // `~*'…'` — a KEYLESS back member (reverse positional membership, URIs.md §`~-`):
        // no key, no colon; the pointer names the container that holds this node.
        entries.push(withSpan({ key: null, edge: 'back', value: this.pointer() }, this.uri, entryStart, this.i));
      } else {
        const key = this.key();
        this.ws();
        if (this.peek() !== ':') this.fail('expected ":" after key');
        this.i++;
        this.ws();
        const v = this.value();
        entries.push(withSpan(makeEntry(key, back, v), this.uri, entryStart, this.i)); // … and ends after the value
      }
      this.ws();
      const n = this.peek();
      if (n === ',') { this.i++; continue; }
      if (n === '}') { this.i++; break; }
      this.fail('expected "," or "}"');
    }
    return { kind: 'mapping', entries, array: false };
  }

  array(): Mapping {
    this.i++; // [
    const entries: Entry[] = [];
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === ']') { this.i++; break; }
      if (c === undefined) this.fail('unterminated array');
      const entryStart = this.i;
      if (c === '~') {
        // `~*'…'` — a keyless back member, allowed among array elements too (it is NOT an
        // element: a back-edge takes no position).
        this.i++;
        if (this.peek() !== '*') this.fail('expected a pointer after "~" (keyless back member)');
        entries.push(withSpan({ key: null, edge: 'back', value: this.pointer() }, this.uri, entryStart, this.i));
      } else {
        entries.push(withSpan(makeEntry(null, false, this.value()), this.uri, entryStart, this.i));
      }
      this.ws();
      const n = this.peek();
      if (n === ',') { this.i++; continue; }
      if (n === ']') { this.i++; break; }
      this.fail('expected "," or "]"');
    }
    return { kind: 'mapping', entries, array: true };
  }

  key(): string {
    const c = this.peek();
    if (c === '"' || c === "'") return this.string().value as string;
    return this.identifier();
  }

  identifier(): string {
    const start = this.i;
    const c = this.peek();
    if (c === undefined || !isIdStart(c)) this.fail('expected an identifier key');
    this.i++;
    while (!this.eof() && isIdPart(this.src[this.i])) this.i++;
    return this.src.slice(start, this.i);
  }

  pointer(): import('./ir.ts').Pointer {
    const start = this.i; // at '*'
    this.i++;
    const c = this.peek();
    if (c !== '"' && c !== "'") this.fail('a json5p pointer must be a quoted string after "*"');
    const s = this.string();
    const p = parsePointer(s.value as string);
    p.span = { uri: this.uri, start, end: this.i }; // `*` + the quoted pointer string
    return p;
  }

  anchored(): Node {
    const start = this.i; // at '&'
    this.i++;
    const c = this.peek();
    // quoted = the canonical path form; a bare identifier is the legacy spelling, read as
    // the current-scope path `name` (the container gains the sibling key `name`)
    const body = c === '"' || c === "'" ? (this.string().value as string) : this.identifier();
    const anchor = makeAnchor(body, (m) => this.fail(m));
    anchor.path.span = { uri: this.uri, start, end: this.i }; // the whole `&…` token
    this.ws();
    const v = this.value(); // several anchors stack via recursion (`&'a' &'b' 30`)
    if (isPointer(v)) this.fail('cannot anchor a pointer');
    // recursion attaches inner anchors first — PREPEND to keep the authored order
    v.meta = { ...v.meta, anchors: [anchor, ...(v.meta?.anchors ?? [])] };
    return v;
  }

  string(): Scalar {
    const quote = this.src[this.i];
    const start = this.i;
    this.i++; // opening quote
    let out = '';
    for (;;) {
      if (this.eof()) this.fail('unterminated string');
      const c = this.src[this.i];
      if (c === quote) { this.i++; break; }
      if (c === '\\') { out += this.escape(); continue; }
      out += c;
      this.i++;
    }
    return { kind: 'scalar', value: out, raw: this.src.slice(start, this.i) };
  }

  escape(): string {
    this.i++; // '\'
    const c = this.src[this.i];
    if (c === undefined) this.fail('bad escape sequence');
    this.i++;
    switch (c) {
      case '"': return '"';
      case "'": return "'";
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'v': return '\v';
      case '0': return '\0';
      case 'x': { const h = this.src.slice(this.i, this.i + 2); this.i += 2; return String.fromCharCode(parseInt(h, 16)); }
      case 'u': { const h = this.src.slice(this.i, this.i + 4); this.i += 4; return String.fromCharCode(parseInt(h, 16)); }
      case '\n': return ''; // line continuation
      case '\r': if (this.src[this.i] === '\n') this.i++; return '';
      default: return c; // identity escape (JSON5)
    }
  }

  numberOrKeyword(): Scalar {
    const start = this.i;
    while (!this.eof() && !isDelim(this.src[this.i])) this.i++;
    const tok = this.src.slice(start, this.i);
    if (tok === '') this.fail(`unexpected character ${JSON.stringify(this.src[this.i])}`);
    if (tok === 'true') return scalar(true, tok);
    if (tok === 'false') return scalar(false, tok);
    if (tok === 'null') return scalar(null, tok);
    const n = json5number(tok);
    if (n === undefined) this.fail(`invalid token "${tok}"`);
    return scalar(n, tok);
  }
}

function makeEntry(key: string | null, back: boolean, v: Value): Entry {
  const edge = back ? 'back' : isPointer(v) ? 'ref' : 'contain';
  return { key, edge, value: v };
}

/** Attach the entry's source range (absolute char offsets) — key/`~` start … value end. */
function withSpan(e: Entry, uri: string, start: number, end: number): Entry {
  e.meta = { ...e.meta, span: { uri, start, end } };
  return e;
}

function scalar(value: string | number | boolean | null, raw: string): Scalar {
  return { kind: 'scalar', value, raw };
}

function isIdStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
}
function isIdPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;
}
function isDelim(c: string): boolean {
  return WS.has(c) || c === ',' || c === ':' || c === '{' || c === '}' ||
    c === '[' || c === ']' || c === '"' || c === "'" || c === '/';
}

function json5number(tok: string): number | undefined {
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(tok)) return Number(tok);
  if (/^[+-]?Infinity$/.test(tok)) return tok[0] === '-' ? -Infinity : Infinity;
  if (/^[+-]?NaN$/.test(tok)) return NaN;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(tok)) return Number(tok);
  return undefined;
}
