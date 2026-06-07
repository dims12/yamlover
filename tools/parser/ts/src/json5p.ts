// Hand-written recursive-descent parser for json5p (JSON5 + pointers) → the IR.
// Spec: JSON5P.md. JSON ⊂ JSON5 ⊂ json5p, so this also accepts all JSON/JSON5.
//
// Adds over JSON5: `*'<pointer>'` (deref), `&name <value>` (anchor), `~key:` (back-edge).

import type { Document, Node, Mapping, Scalar, Entry, Value } from './ir.ts';
import { isPointer } from './ir.ts';
import { parsePointer } from './pointer.ts';

const WS = new Set([' ', '\t', '\n', '\r', '\v', '\f', ' ', '﻿']);

export function parseJson5p(src: string, uri = '<json5p>'): Document {
  const p = new Parser(src);
  p.ws();
  const root = p.value();
  p.ws();
  if (p.i < src.length) p.fail('trailing characters');
  if (isPointer(root)) p.fail('a top-level pointer is not allowed');
  return { root, anchors: p.anchors, source: { concrete: 'json5p', uri } };
}

class Parser {
  src: string;
  i = 0;
  anchors = new Map<string, Node>();

  constructor(src: string) { this.src = src; }

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
        this.i += 2;
        while (this.i < this.src.length && this.src[this.i] !== '\n' && this.src[this.i] !== '\r') this.i++;
        continue;
      }
      if (c === '/' && this.src[this.i + 1] === '*') {
        this.i += 2;
        while (this.i < this.src.length && !(this.src[this.i] === '*' && this.src[this.i + 1] === '/')) this.i++;
        if (this.i >= this.src.length) this.fail('unterminated block comment');
        this.i += 2;
        continue;
      }
      return;
    }
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
      let back = false;
      if (this.peek() === '~') { back = true; this.i++; }
      const key = this.key();
      this.ws();
      if (this.peek() !== ':') this.fail('expected ":" after key');
      this.i++;
      this.ws();
      const v = this.value();
      entries.push(makeEntry(key, back, v));
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
      const v = this.value();
      entries.push(makeEntry(null, false, v));
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
    this.i++; // *
    const c = this.peek();
    if (c !== '"' && c !== "'") this.fail('a json5p pointer must be a quoted string after "*"');
    const s = this.string();
    return parsePointer(s.value as string);
  }

  anchored(): Node {
    this.i++; // &
    const name = this.identifier();
    this.ws();
    const v = this.value();
    if (isPointer(v)) this.fail('cannot anchor a pointer');
    this.anchors.set(name, v);
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
