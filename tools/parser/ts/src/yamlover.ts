// Hand-written parser for yamlover (YAML + pointers) → the IR. Spec: ../../../YAMLOVER.md.
//
// Covers a practical YAML subset: block mappings & sequences (incl. compact `- key:` and
// `- &anchor`), flow `{}`/`[]`, plain/single/double-quoted scalars, `#` comments. Plus the
// yamlover extensions: value `*pointer` (unquoted), `&anchor`, and `~key:` back-edges.
//
// NOT yet handled (Phase 2c TODO): block scalars (`|`, `>`), tags (`!!`), multi-document
// (`---`), merge keys (`<<`), and flow that spans multiple lines.

import type { Document, Node, Mapping, Scalar, Entry, Value, Pointer } from './ir.ts';
import { isPointer } from './ir.ts';
import { parsePointer } from './pointer.ts';

interface Line { indent: number; text: string; n: number }

export function parseYamlover(src: string, uri = '<yamlover>'): Document {
  const p = new Block(lex(src));
  const root = p.node(0) ?? nul();
  if (p.i < p.lines.length) p.fail('unexpected content');
  if (isPointer(root)) throw new SyntaxError('yamlover: a top-level pointer is not allowed');
  return { root, anchors: p.anchors, source: { concrete: 'yamlover', uri } };
}

// ---- line lexing: indentation + quote-aware comment stripping ----------------
function lex(src: string): Line[] {
  const out: Line[] = [];
  const raw = src.split(/\r\n|\r|\n/);
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n];
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') indent++;
    const content = stripComment(line.slice(indent)).replace(/\s+$/, '');
    if (content === '') continue; // blank or comment-only
    out.push({ indent, text: content, n });
  }
  return out;
}

function stripComment(s: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return s.slice(0, i);
    }
  }
  return s;
}

class Block {
  lines: Line[];
  i = 0;
  anchors = new Map<string, Node>();

  constructor(lines: Line[]) { this.lines = lines; }

  peek(): Line | undefined { return this.lines[this.i]; }
  fail(msg: string): never {
    const l = this.lines[this.i] ?? this.lines[this.i - 1];
    throw new SyntaxError(`yamlover: ${msg}${l ? ` at line ${l.n + 1}` : ''}`);
  }

  /** Parse a block node whose content lives at a column >= minIndent (null if none). */
  node(minIndent: number): Node | Pointer | null {
    const l = this.peek();
    if (!l || l.indent < minIndent) return null;
    if (isSeqLine(l.text)) return this.seq(l.indent);
    if (splitKV(l.text)) return this.map(l.indent);
    // a lone scalar/flow/pointer/anchor occupying the line
    this.i++;
    return this.valueInline(l.text, l.indent, /*allowBlock*/ true);
  }

  map(indent: number): Mapping {
    const entries: Entry[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent || isSeqLine(l.text)) break;
      const kv = splitKV(l.text);
      if (!kv) break;
      this.i++;
      let key = kv.key;
      let back = false;
      if (key.startsWith('~')) { back = true; key = key.slice(1); }
      const value = this.valueAfter(kv.rest, indent);
      entries.push({ key: unquoteKey(key), edge: back ? 'back' : isPointer(value) ? 'ref' : 'contain', value });
    }
    return { kind: 'mapping', entries, array: false };
  }

  seq(indent: number): Mapping {
    const entries: Entry[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent || !isSeqLine(l.text)) break;
      this.i++;
      const afterDash = l.text.slice(1);
      const lead = afterDash.length - afterDash.trimStart().length;
      const contentCol = l.indent + 1 + lead;
      const rest = afterDash.trim();
      let value: Value;
      if (rest === '') {
        value = this.node(indent + 1) ?? nul();
      } else if (splitKV(rest)) {
        // compact `- key: value`: re-read this line (and deeper siblings) as a map at contentCol
        this.i--;
        this.lines[this.i] = { indent: contentCol, text: rest, n: l.n };
        value = this.map(contentCol);
      } else {
        value = this.valueAfter(rest, indent);
      }
      entries.push({ key: null, edge: isPointer(value) ? 'ref' : 'contain', value });
    }
    return { kind: 'mapping', entries, array: true };
  }

  /** The value after `key:` or `- ` (inline `rest`, with a possible deeper block). */
  valueAfter(rest: string, parentIndent: number): Value {
    rest = rest.trim();
    let anchor: string | undefined;
    if (rest.startsWith('&')) {
      const r = readName(rest.slice(1));
      anchor = r.name;
      rest = r.rest.trim();
    }
    let value: Value;
    if (rest === '') {
      // YAML allows a block SEQUENCE value at the SAME indent as its key:
      //   markup:
      //   - a
      // (mappings must be deeper; sequences may be level). Otherwise a deeper block, or null.
      const nxt = this.peek();
      if (nxt && nxt.indent === parentIndent && isSeqLine(nxt.text)) {
        value = this.seq(parentIndent);
      } else {
        value = this.node(parentIndent + 1) ?? nul();
      }
    } else {
      value = this.valueInline(rest, parentIndent, /*allowBlock*/ false);
    }
    if (anchor !== undefined) {
      if (isPointer(value)) this.fail('cannot anchor a pointer');
      this.anchors.set(anchor, value);
    }
    return value;
  }

  /** Parse a single-line inline value: flow, pointer, anchor, quoted or plain scalar. */
  valueInline(text: string, parentIndent: number, allowBlock: boolean): Value {
    text = text.trim();
    const c = text[0];
    if (c === '{' || c === '[') return new Flow(text, this.anchors).parse();
    if (c === '*') return parsePointer(unquoteIfQuoted(text.slice(1)));
    if (c === '&') {
      const r = readName(text.slice(1));
      const rest = r.rest.trim();
      const v = rest === '' && allowBlock ? (this.node(parentIndent + 1) ?? nul()) : this.valueInline(rest, parentIndent, allowBlock);
      if (isPointer(v)) this.fail('cannot anchor a pointer');
      this.anchors.set(r.name, v);
      return v;
    }
    if (c === "'" || c === '"') return quotedScalar(text);
    return plainScalar(text);
  }
}

// ---- flow context ({…}, […]) -------------------------------------------------
class Flow {
  s: string;
  i = 0;
  anchors: Map<string, Node>;

  constructor(s: string, anchors: Map<string, Node>) { this.s = s; this.anchors = anchors; }

  fail(msg: string): never { throw new SyntaxError(`yamlover (flow): ${msg} at offset ${this.i}`); }

  parse(): Node | Pointer {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i < this.s.length) this.fail('trailing characters in flow value');
    return v;
  }

  ws(): void { while (this.i < this.s.length && ' \t'.includes(this.s[this.i])) this.i++; }

  value(): Node | Pointer {
    const c = this.s[this.i];
    if (c === '{') return this.map();
    if (c === '[') return this.seq();
    if (c === '*') { this.i++; return parsePointer(unquoteIfQuoted(this.readPlain())); }
    if (c === '&') {
      this.i++;
      const r = readName(this.s.slice(this.i));
      this.i += this.s.slice(this.i).length - r.rest.length;
      this.ws();
      const v = this.value();
      if (isPointer(v)) this.fail('cannot anchor a pointer');
      this.anchors.set(r.name, v);
      return v;
    }
    if (c === "'" || c === '"') return this.quoted();
    const tok = this.readPlain();
    if (tok === '') this.fail('expected a value');
    return plainScalar(tok);
  }

  map(): Mapping {
    this.i++; // {
    const entries: Entry[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') { this.i++; break; }
      if (this.i >= this.s.length) this.fail('unterminated flow map');
      let back = false;
      if (this.s[this.i] === '~') { back = true; this.i++; }
      const key = this.s[this.i] === "'" || this.s[this.i] === '"'
        ? (this.quoted().value as string)
        : unquoteKey(this.readPlain(':,}'));
      this.ws();
      if (this.s[this.i] !== ':') this.fail('expected ":" in flow map');
      this.i++;
      this.ws();
      const v = this.value();
      entries.push({ key, edge: back ? 'back' : isPointer(v) ? 'ref' : 'contain', value: v });
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === '}') { this.i++; break; }
      this.fail('expected "," or "}"');
    }
    return { kind: 'mapping', entries, array: false };
  }

  seq(): Mapping {
    this.i++; // [
    const entries: Entry[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') { this.i++; break; }
      if (this.i >= this.s.length) this.fail('unterminated flow seq');
      const v = this.value();
      entries.push({ key: null, edge: isPointer(v) ? 'ref' : 'contain', value: v });
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === ']') { this.i++; break; }
      this.fail('expected "," or "]"');
    }
    return { kind: 'mapping', entries, array: true };
  }

  quoted(): Scalar {
    const start = this.i;
    const q = this.s[this.i];
    this.i++;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (q === '"' && c === '\\') { this.i += 2; continue; }
      if (q === "'" && c === "'" && this.s[this.i + 1] === "'") { this.i += 2; continue; }
      this.i++;
      if (c === q) break;
    }
    return quotedScalar(this.s.slice(start, this.i));
  }

  /** Read a plain scalar up to a stop char (default flow stops). */
  readPlain(stop = ',:[]{} '): string {
    const start = this.i;
    while (this.i < this.s.length && !stop.includes(this.s[this.i])) this.i++;
    return this.s.slice(start, this.i).trim();
  }
}

// ---- helpers -----------------------------------------------------------------
function isSeqLine(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/** Find the `key:` split: the first unquoted `:` followed by space or EOL. */
function splitKV(text: string): { key: string; rest: string } | null {
  let inS = false;
  let inD = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ':' && !inS && !inD) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        return { key: text.slice(0, i).trim(), rest: text.slice(i + 1).trim() };
      }
    }
  }
  return null;
}

function readName(s: string): { name: string; rest: string } {
  let i = 0;
  while (i < s.length && !' \t,[]{}'.includes(s[i])) i++;
  return { name: s.slice(0, i), rest: s.slice(i) };
}

function unquoteIfQuoted(s: string): string {
  s = s.trim();
  if ((s[0] === "'" || s[0] === '"') && s[s.length - 1] === s[0]) return quotedScalar(s).value as string;
  return s;
}

function unquoteKey(key: string): string {
  key = key.trim();
  if ((key[0] === "'" || key[0] === '"') && key[key.length - 1] === key[0]) return quotedScalar(key).value as string;
  return backslashUnescape(key);
}

function quotedScalar(text: string): Scalar {
  const q = text[0];
  const body = text.slice(1, text.length - 1);
  if (q === "'") return { kind: 'scalar', value: body.replace(/''/g, "'"), raw: text };
  // double-quoted: JSON-ish escapes
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      const c = body[++i];
      switch (c) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '0': out += '\0'; break;
        case 'u': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; break;
        case 'x': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; break;
        default: out += c ?? '';
      }
    } else out += body[i];
  }
  return { kind: 'scalar', value: out, raw: text };
}

function plainScalar(text: string): Scalar {
  const t = text.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return { kind: 'scalar', value: null, raw: text };
  if (t === 'true' || t === 'True' || t === 'TRUE') return { kind: 'scalar', value: true, raw: text };
  if (t === 'false' || t === 'False' || t === 'FALSE') return { kind: 'scalar', value: false, raw: text };
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return { kind: 'scalar', value: Number(t), raw: text };
  if (/^[-+]?0x[0-9a-fA-F]+$/.test(t)) return { kind: 'scalar', value: Number(t), raw: text };
  return { kind: 'scalar', value: t, raw: text };
}

function backslashUnescape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
    out += s[i];
  }
  return out;
}

function nul(): Scalar { return { kind: 'scalar', value: null, raw: '' }; }
