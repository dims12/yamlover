// Hand-written parser for yamlover (YAML + pointers) → the IR. Spec: ../../../YAMLOVER.md.
//
// Covers a practical YAML subset: block mappings & sequences (incl. compact `- key:` and
// `- &anchor`), flow `{}`/`[]`, plain/single/double-quoted scalars, `#` comments. Plus the
// yamlover extensions: value `*pointer` (unquoted), `&anchor`, `~key:` back-edges, and
// `~-` keyless back-edges (reverse positional membership, URIs.md §`~-`).
//
// NOT yet handled (Phase 2c TODO): block scalars (`|`, `>`), tags (`!!`), multi-document
// (`---`), merge keys (`<<`), and flow that spans multiple lines.

import type { Document, Node, Mapping, Scalar, Entry, Value, Pointer, Span } from './ir.ts';
import { isPointer } from './ir.ts';
import { parsePointer } from './pointer.ts';

interface Line { indent: number; text: string; n: number }

export function parseYamlover(src: string, uri = '<yamlover>'): Document {
  // one pass: lines + their absolute start offsets (separators vary — \r\n is 2 chars)
  const raw: string[] = [];
  const lineStarts: number[] = [];
  const sep = /\r\n|\r|\n/g;
  let at = 0;
  for (let m = sep.exec(src); m !== null; m = sep.exec(src)) {
    raw.push(src.slice(at, m.index));
    lineStarts.push(at);
    at = m.index + m[0].length;
  }
  raw.push(src.slice(at));
  lineStarts.push(at);
  const p = new Block(lex(raw), raw, uri, lineStarts);
  // a document-root schema tag on its own line: `!!<*yamlover/$defs/chapter>`
  let rootSchema: Value | undefined;
  const first = p.peek();
  if (first && /^!!<[^>]*>$/.test(first.text.trim())) {
    rootSchema = parseSchemaRef(first.text.trim().slice(3, -1), { block: p, lineN: first.n, col: first.indent + 3 });
    p.i++;
  }
  const root = p.node(0) ?? nul();
  if (p.i < p.lines.length) p.fail('unexpected content');
  if (isPointer(root)) throw new SyntaxError(`yamlover: a top-level pointer is not allowed in ${uri}`);
  if (rootSchema !== undefined) root.meta = { ...root.meta, schema: rootSchema };
  p.validateMixtures(root); // mixtures require an explicit !!mix / !!omni tag
  return { root, anchors: p.anchors, source: { concrete: 'yamlover', uri } };
}

// ---- line lexing: indentation + quote-aware comment stripping ----------------
function lex(raw: string[]): Line[] {
  const out: Line[] = [];
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
  let inS = false; // inside a single-quoted scalar ('' is the only escape — net no toggle)
  let inD = false; // inside a double-quoted scalar (backslash escapes the next char, incl. \" and \\)
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inD && c === '\\') { i++; continue; } // skip the escaped char so \" / \\ don't end the string
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
  raw: string[];      // all source lines (for block scalars, which keep blanks and `#`)
  uri: string;        // source path/id, surfaced in parse-error messages
  lineStarts: number[]; // absolute offset of each raw line's first character
  i = 0;
  anchors = new Map<string, Node>();
  typed = new WeakMap<Node, 'mix' | 'omni' | 'set'>(); // nodes typed via `!!mix`/`!!omni`/`!!set`

  constructor(lines: Line[], raw: string[], uri = '<yamlover>', lineStarts: number[] = []) {
    this.lines = lines; this.raw = raw; this.uri = uri; this.lineStarts = lineStarts;
  }

  /** Absolute span of `len` chars starting at column `col` of raw line `lineN`. Valid
   *  because every Line.text is a prefix-aligned slice of its raw line (lex strips only
   *  the comment/trailing-ws SUFFIX), so tracked columns are raw-line columns. */
  spanAt(lineN: number, col: number, len: number): Span {
    const start = (this.lineStarts[lineN] ?? 0) + col;
    return { uri: this.uri, start, end: start + len };
  }

  /** Enforce: mixing keyed+keyless entries needs `!!mix`. A scalar/blob value WITH fields (the
   *  omni shape) needs NO tag: a deeper-indented block under a scalar value is invalid YAML, so
   *  reading it as the node's fields extends YAML without ambiguity — the shape itself is the
   *  intention (`!!omni` stays legal as optional explicitness; schemas declare it as
   *  `type: variant`, META.md). Plain (pure seq / pure map / pure scalar) needs no tag.
   *  Back-edge entries (`~key:` / `~-`) are not OWNED members and never count. */
  validateMixtures(node: Node): void {
    const ents = node.entries;
    if (!ents || ents.length === 0) return;
    const tag = this.typed.get(node);
    const owned = ents.filter((e) => e.edge !== 'back');
    if (node.kind === 'mapping' && owned.some((e) => e.key !== null) && owned.some((e) => e.key === null)) {
      // a mapping mixing keyed and keyless entries
      if (tag !== 'mix' && tag !== 'omni') this.fail('a container mixing keyed and keyless entries must be tagged !!mix');
    }
    for (const e of ents) if (!isPointer(e.value)) this.validateMixtures(e.value);
  }

  peek(): Line | undefined { return this.lines[this.i]; }
  fail(msg: string): never {
    const l = this.lines[this.i] ?? this.lines[this.i - 1];
    const where = l ? `${this.uri}:${l.n + 1}` : this.uri;
    const ctx = l ? `\n  ${l.n + 1} | ${this.raw[l.n]}` : '';
    throw new SyntaxError(`yamlover: ${msg} at ${where}${ctx}`);
  }

  /** Parse a block node whose content lives at a column >= minIndent (null if none). */
  node(minIndent: number): Node | Pointer | null {
    const l = this.peek();
    if (!l || l.indent < minIndent) return null;
    // a lone type tag (no preceding key): `!!omni 5` / `!!mix` / `!!set` at the document root
    // or as a block value. Hand to valueAfter with the block one column shallower so the tag's
    // own line (its inline value, plus the fields/entries below it) parses as that value.
    if (/^!!(mix|omni|set)(?=\s|$)/.test(l.text)) {
      this.i++;
      return this.valueAfter(l.text, l.indent - 1, l.n, l.indent);
    }
    if (isSeqLine(l.text) || isBackSeqLine(l.text) || splitKV(l.text)) return this.container(l.indent);
    // a lone scalar/flow/pointer/anchor occupying the line
    this.i++;
    return this.valueInline(l.text, l.indent, /*allowBlock*/ true, l.n, l.indent);
  }

  /**
   * One ordered container at `indent` — yamlover's single container model. Entries keep
   * their order (→ integer keys [0],[1],…); each MAY also carry a string key. So keyless
   * (`- value`) and keyed (`key: value`) entries can be MIXED in one node ("partially
   * ordered, partially keyed"). `array` is just a projection hint: true iff all-keyless.
   *
   * `keylessOnly` is for the same-indent sequence-under-a-key case, where a keyed line at
   * this indent is a SIBLING of the outer key, not a member — so we stop at it.
   */
  container(indent: number, keylessOnly = false): Mapping {
    const entries: Entry[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent) break;
      let value: Value;
      let entry: Entry;
      if (isSeqLine(l.text)) {
        // a keyless (positional) entry
        this.i++;
        const afterDash = l.text.slice(1);
        const lead = afterDash.length - afterDash.trimStart().length;
        const contentCol = l.indent + 1 + lead;
        const rest = afterDash.trim();
        if (rest === '') {
          value = this.node(indent + 1) ?? nul();
        } else if (!rest.startsWith('!!<') && splitKV(rest)) {
          // compact `- key: value`: re-read this line (+ deeper siblings) as a container
          // (a `!!<…>` tag is a value, not a key — its inner `: ` must not look like a key)
          this.i--;
          this.lines[this.i] = { indent: contentCol, text: rest, n: l.n };
          value = this.container(contentCol);
        } else {
          value = this.valueAfter(rest, indent, l.n, contentCol);
        }
        entry = { key: null, edge: isPointer(value) ? 'ref' : 'contain', value };
      } else if (isBackSeqLine(l.text)) {
        // a KEYLESS back-edge — reverse positional membership (URIs.md §`~-`): the value
        // names the container that holds this node, so it must be a pointer.
        if (keylessOnly) break;
        this.i++;
        const a = adv(l.text, 2, l.indent); // past the `~-` marker, to the pointer token
        const rest = a.rest;
        if (!rest.startsWith('*')) this.fail('a "~-" entry needs a pointer value (the container that holds this node)');
        const ptr = parsePointer(unquoteIfQuoted(rest.slice(1)));
        ptr.span = this.spanAt(l.n, a.col, rest.length);
        value = ptr;
        entry = { key: null, edge: 'back', value };
      } else {
        // a keyed entry
        if (keylessOnly) break;
        if (/^~[ \t]/.test(l.text)) this.fail('the "~" sigil must sit tight against the key or "-" marker (write "~key:" or "~-")');
        const kv = splitKV(l.text);
        if (!kv) break;
        this.i++;
        let key = kv.key;
        let back = false;
        if (key.startsWith('~')) { back = true; key = key.slice(1); }
        value = this.valueAfter(kv.rest, indent, l.n, l.indent + kv.restCol);
        entry = { key: unquoteKey(key), edge: back ? 'back' : isPointer(value) ? 'ref' : 'contain', value };
      }
      entries.push(entry);
    }
    // projection hint: a pure sequence — judged over OWNED entries only (a `~-` back-edge
    // is not a member of THIS node and must not make it look like an array).
    const owned = entries.filter((e) => e.edge !== 'back');
    const array = owned.length > 0 && owned.every((e) => e.key === null);
    return { kind: 'mapping', entries, array };
  }

  /** The value after `key:` or `- ` (inline `rest`, with a possible deeper block).
   *  `col` = the column of `rest` in raw line `srcLineN` (span tracking). */
  valueAfter(rest: string, parentIndent: number, srcLineN: number, col: number): Value {
    ({ rest, col } = adv(rest, 0, col));
    let schema: Value | undefined;
    if (rest.startsWith('!!<')) {
      const close = rest.indexOf('>');
      if (close < 0) this.fail('unterminated "!!<…>" schema tag');
      schema = parseSchemaRef(rest.slice(3, close), { block: this, lineN: srcLineN, col: col + 3 });
      ({ rest, col } = adv(rest, close + 1, col));
    }
    // an opt-in type tag in value position: `key: !!mix` (mixed container), `key: !!omni 5`
    // (scalar value + fields), or `key: !!set` (set-semantics container — NodeMeta.set).
    let typeTag: 'mix' | 'omni' | 'set' | undefined;
    const tag = /^!!(mix|omni|set)(?=\s|$)/.exec(rest);
    if (tag) { typeTag = tag[1] as 'mix' | 'omni' | 'set'; ({ rest, col } = adv(rest, tag[0].length, col)); }
    let anchor: string | undefined;
    if (rest.startsWith('&')) {
      const r = readName(rest.slice(1));
      anchor = r.name;
      ({ rest, col } = adv(rest, 1 + r.name.length, col));
    }
    let value: Value;
    if (/^[|>][+-]?\d*$/.test(rest)) {
      value = this.blockScalar(rest, parentIndent, srcLineN); // `|` literal, `>` folded
      // an `!!omni` node whose value is a block scalar: lines that dedent BELOW the block's
      // content (but stay deeper than the key) are the node's fields. The block scalar is
      // bounded by its own content indent (YAML's rule), so the fields read cleanly after it.
      value = this.attachFields(value, parentIndent);
    } else if (rest === '') {
      // YAML allows a block SEQUENCE value at the SAME indent as its key:
      //   markup:
      //   - a
      // (mappings must be deeper; sequences may be level). Otherwise a deeper block, or null.
      const nxt = this.peek();
      if (nxt && nxt.indent === parentIndent && isSeqLine(nxt.text)) {
        value = this.container(parentIndent, /*keylessOnly*/ true);
      } else {
        value = this.node(parentIndent + 1) ?? nul();
      }
    } else {
      value = this.valueInline(rest, parentIndent, /*allowBlock*/ false, srcLineN, col);
      value = this.attachFields(value, parentIndent);
    }
    if (anchor !== undefined) {
      if (isPointer(value)) this.fail('cannot anchor a pointer');
      this.anchors.set(anchor, value);
    }
    if (typeTag !== undefined && !isPointer(value)) this.typed.set(value, typeTag);
    if (typeTag === 'set' && !isPointer(value)) value.meta = { ...value.meta, set: true }; // survives into the graph
    if (schema !== undefined && !isPointer(value)) value.meta = { ...value.meta, schema };
    return value;
  }

  /** A node = value + fields: a scalar value (inline OR a block scalar) followed by a DEEPER
   *  block attaches that block's (positional and/or keyed) entries onto the scalar — one node
   *  carrying its value and its fields (the `!!omni` shape). Non-scalars/pointers pass through. */
  attachFields(value: Value, parentIndent: number): Value {
    const nxt = this.peek();
    if (nxt && nxt.indent > parentIndent && !isPointer(value) && value.kind === 'scalar') {
      const fields = this.container(nxt.indent);
      return { ...value, entries: fields.entries, array: fields.array };
    }
    return value;
  }

  /** A block scalar (`|` literal / `>` folded, with `-`/`+` chomping) introduced by the
   *  indicator on line `srcLineN`. Reads RAW lines (blanks + `#` are significant), de-indents
   *  by the block's own indent, and advances past the consumed lines. */
  blockScalar(indicator: string, parentIndent: number, srcLineN: number): Scalar {
    const folded = indicator[0] === '>';
    let chomp: 'clip' | 'strip' | 'keep' = 'clip';
    for (const ch of indicator.slice(1)) { if (ch === '-') chomp = 'strip'; else if (ch === '+') chomp = 'keep'; }

    const lines: string[] = []; // de-indented content lines, including blanks
    let blockIndent = -1;
    let lastN = srcLineN;
    for (let n = srcLineN + 1; n < this.raw.length; n++) {
      const r = this.raw[n];
      let ind = 0;
      while (ind < r.length && r[ind] === ' ') ind++;
      if (ind >= r.length) { lines.push(''); lastN = n; continue; } // blank line
      if (ind <= parentIndent) break;                               // dedent to/under key → ends
      if (blockIndent >= 0 && ind < blockIndent) break;             // dedent under content → !!omni fields begin
      if (blockIndent < 0) blockIndent = ind;                       // first content line sets indent
      lines.push(r.slice(blockIndent));
      lastN = n;
    }
    while (this.peek() && this.peek()!.n <= lastN) this.i++;        // skip consumed lines

    let last = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i] !== '') last = i;
    const core = lines.slice(0, last + 1);
    let body = folded ? foldLines(core) : core.join('\n');
    if (chomp === 'keep') body += '\n'.repeat(lines.length - (last + 1) + (last >= 0 ? 1 : 0));
    else if (chomp === 'clip' && last >= 0) body += '\n';          // strip → nothing
    return { kind: 'scalar', value: body, raw: body };
  }

  /** Parse a single-line inline value: flow, pointer, anchor, quoted or plain scalar.
   *  `col` = the column of `text` in raw line `lineN` (span tracking). */
  valueInline(text: string, parentIndent: number, allowBlock: boolean, lineN: number, col: number): Value {
    ({ rest: text, col } = adv(text, 0, col));
    const c = text[0];
    if (c === '{' || c === '[') {
      return new Flow(text, this.anchors, this.uri, (this.lineStarts[lineN] ?? 0) + col).parse();
    }
    if (c === '*') {
      const p = parsePointer(unquoteIfQuoted(text.slice(1)));
      p.span = this.spanAt(lineN, col, text.length); // the whole `*…` deref token
      return p;
    }
    if (c === '&') {
      const r = readName(text.slice(1));
      const a = adv(text, 1 + r.name.length, col);
      const v = a.rest === '' && allowBlock
        ? (this.node(parentIndent + 1) ?? nul())
        : this.valueInline(a.rest, parentIndent, allowBlock, lineN, a.col);
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
  uri: string;
  base: number; // absolute offset of s[0] in the source (span tracking)

  constructor(s: string, anchors: Map<string, Node>, uri = '<flow>', base = 0) {
    this.s = s; this.anchors = anchors; this.uri = uri; this.base = base;
  }

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
    if (c === '*') {
      const start = this.i;
      this.i++;
      const p = parsePointer(unquoteIfQuoted(this.readPlain()));
      p.span = { uri: this.uri, start: this.base + start, end: this.base + this.i };
      return p;
    }
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

/** A `~-` keyless back-edge entry line (the sigil tight against the `-` marker). */
function isBackSeqLine(text: string): boolean {
  return text === '~-' || text.startsWith('~- ');
}

/** Find the `key:` split: the first unquoted `:` followed by space or EOL. `restCol` is
 *  the offset of `rest` WITHIN `text` (for span tracking).
 *  (Exported for the serializer: a plain token that splits here must be quoted.) */
export function splitKV(text: string): { key: string; rest: string; restCol: number } | null {
  let inS = false;
  let inD = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ':' && !inS && !inD) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        const after = text.slice(i + 1);
        const lead = after.length - after.trimStart().length;
        return { key: text.slice(0, i).trim(), rest: after.trim(), restCol: i + 1 + lead };
      }
    }
  }
  return null;
}

/** s.slice(k).trim(), advancing the column past `k` and the leading whitespace —
 *  the span-tracking twin of the parser's re-slice+trim steps. */
function adv(s: string, k: number, col: number): { rest: string; col: number } {
  const sliced = s.slice(k);
  const lead = sliced.length - sliced.trimStart().length;
  return { rest: sliced.trim(), col: col + k + lead };
}

/** The contents of a `!!<…>` schema tag are themselves yamlover, yielding the attached
 *  schema as a Value: a Pointer to a hosted schema (`*yamlover/$defs/chapter`, or a link
 *  `https://…`) OR an inline schema Node (`format: text/x-plantuml`, `{type: string}`).
 *  `at` (when known) locates `src` in its raw line, so a schema pointer gets a span too. */
function parseSchemaRef(src: string, at?: { block: Block; lineN: number; col: number }): Value {
  const lead = src.length - src.trimStart().length;
  src = src.trim();
  if (src.startsWith('*')) {
    const p = parsePointer(src.slice(1)); // a pointer to a hosted schema
    if (at !== undefined) p.span = at.block.spanAt(at.lineN, at.col + lead, src.length);
    return p;
  }
  return parseYamlover(src).root;                              // inline yamlover/meta literal
}

/** Fold `>` block lines: a single line break between non-empty lines becomes a space; a
 *  blank line becomes a newline. (Simplified — enough for prose/doc chunks.) */
function foldLines(lines: string[]): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out += lines[i] === '' || lines[i - 1] === '' ? '\n' : ' ';
    out += lines[i];
  }
  return out;
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

/** (Exported for the serializer: a string emitted plain must reparse to itself.) */
export function plainScalar(text: string): Scalar {
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
