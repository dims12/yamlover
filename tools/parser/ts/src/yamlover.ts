// Hand-written parser for yamlover (YAML + pointers) → the IR. Spec: ../../../YAMLOVER.md.
//
// Covers a practical YAML subset: block mappings & sequences (incl. compact `- key:`,
// `- - nested` and `- &anchor`), flow `{}`/`[]`, plain/single/double-quoted scalars,
// `#` comments. Plus the
// yamlover extensions: value `*pointer` (unquoted), PATH anchors `&path` / `&path[]`
// (URIs.md §`&` — same line as the value or on their own lines; multiple per node), the
// deprecated `~key:` back-edges and `~-` keyless back-edges (≡ `&P/key` / `&P[]`), and
// omni-by-default: an untagged node may mix keyed+keyless entries and carry a scalar
// value line anywhere in its block (`!!mix` parses as a no-op marker; `!!yo` — aliases
// `!!var`/`!!omni` — and `!!set` are semantic and survive into the graph).
//
// NOT yet handled (Phase 2c TODO): multi-document (`---`), merge keys (`<<`), and flow
// that spans multiple lines.

import type { Document, Node, Mapping, Scalar, Entry, Value, Pointer, Span, Anchor } from './ir.ts';
import { isPointer } from './ir.ts';
import { parsePointer, makeAnchor } from './pointer.ts';
import { attachComments, type RawComment } from './comments.ts';

interface Line { indent: number; text: string; n: number; blankBefore?: boolean }
/** A captured `#` comment plus the raw line it sat on (so block-scalar content lines, where
 *  `#` is data not a comment, can be purged before attachment). */
interface YComment extends RawComment { n: number }

export function parseYamlover(src: string, uri = '<yamlover>', opts: { yaml?: boolean } = {}): Document {
  const yaml = opts.yaml === true; // YAML concrete: bare `&`/`*` are document-wide (see [[yaml-not-superset]])
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
  const lexed = lex(raw, lineStarts, uri);
  const p = new Block(lexed.lines, raw, uri, lineStarts, yaml, src);
  // YAML document markers are reserved until multi-document lands (Phase 2c). Without this
  // guard, omni-by-default would read a `---` line as the node's scalar VALUE — a misparse
  // that can accidentally project to the right value. Refuse instead.
  for (let k = 0; k < p.lines.length; k++) {
    const l = p.lines[k];
    if (l.indent === 0 && (l.text === '---' || l.text.startsWith('--- ') || l.text === '...')) {
      p.i = k;
      p.fail('multi-document streams ("---" / "...") are not yet supported (Phase 2c)');
    }
  }
  // a document-root schema tag on its own line: `!!<*yamlover/$defs/chapter>`
  let rootSchema: Value | undefined;
  const first = p.peek();
  if (first && /^!!<[^>]*>$/.test(first.text.trim())) {
    rootSchema = parseSchemaRef(first.text.trim().slice(3, -1), { block: p, lineN: first.n, col: first.indent + 3 });
    p.i++;
  }
  let root = p.node(0) ?? nul();
  if (isPointer(root)) throw new SyntaxError(`yamlover: a top-level pointer is not allowed in ${uri}`);
  // Omni by default: a root that began as a lone scalar (or flow) line may CONTINUE with
  // entries and/or anchor lines at the root indent — `30` + `&//tags/…[]` is the two-line
  // tagged-scalar file (URIs.md §`&`); `30` + `- one` + `two: three` is a root omni node.
  if (p.i < p.lines.length && p.peek()!.indent === 0) {
    root = p.mergeCont(root, p.container(0));
  }
  if (p.i < p.lines.length) p.fail('unexpected content');
  if (rootSchema !== undefined) root.meta = { ...root.meta, schema: rootSchema };
  root.meta = { ...root.meta, span: { uri, start: 0, end: src.length } };
  const doc: Document = { root, source: { concrete: yaml ? 'yaml' : 'yamlover', uri } };
  // `#` inside a `|`/`>` block scalar is CONTENT, not a comment — drop those records.
  const comments = lexed.comments.filter((c) => !p.blockLines.has(c.n)).map(({ n: _n, ...r }) => r);
  attachComments(doc, comments, src, uri);
  return doc;
}

// ---- line lexing: indentation + quote-aware comment capture ------------------
function lex(raw: string[], lineStarts: number[], uri: string): { lines: Line[]; comments: YComment[] } {
  const out: Line[] = [];
  const comments: YComment[] = [];
  let prevBlank = false; // the immediately preceding raw line was empty (not a comment)
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n];
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') indent++;
    const body = line.slice(indent);
    const at = commentStart(body); // index of the `#` within `body`, or -1
    const content = (at >= 0 ? body.slice(0, at) : body).replace(/\s+$/, '');
    if (at >= 0) {
      const base = lineStarts[n] ?? 0;
      comments.push({
        start: base + indent + at,
        end: base + line.replace(/\s+$/, '').length, // through the last non-blank char
        text: body.slice(at + 1).replace(/\s+$/, ''), // body after `#`, trailing ws trimmed
        ownLine: content === '',
        style: 'line',
        n,
      });
    }
    if (content === '') { prevBlank = at < 0; continue; } // a truly blank line; a comment line clears it
    out.push({ indent, text: content, n, ...(prevBlank ? { blankBefore: true } : {}) });
    prevBlank = false;
  }
  return { lines: out, comments };
}

/** Index of an unquoted `#` that begins a trailing comment in `s` (quote-aware, the same
 *  rule lexing uses), or -1 if there is none. */
function commentStart(s: string): number {
  let inS = false; // inside a single-quoted scalar ('' is the only escape — net no toggle)
  let inD = false; // inside a double-quoted scalar (backslash escapes the next char, incl. \" and \\)
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inD && c === '\\') { i++; continue; } // skip the escaped char so \" / \\ don't end the string
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return i;
    }
  }
  return -1;
}

class Block {
  lines: Line[];
  raw: string[];      // all source lines (for block scalars, which keep blanks and `#`)
  src: string;        // the whole source — a MULTI-LINE flow token is sliced from it verbatim, so
                      // its spans stay byte-exact whatever the line separators were (\r\n is 2)
  uri: string;        // source path/id, surfaced in parse-error messages
  lineStarts: number[]; // absolute offset of each raw line's first character
  blockLines = new Set<number>(); // raw lines consumed by a block scalar (their `#` is content)
  yaml: boolean;        // YAML concrete: bare `&`/`*` resolve at the document root
  i = 0;

  constructor(lines: Line[], raw: string[], uri = '<yamlover>', lineStarts: number[] = [], yaml = false, src = '') {
    this.lines = lines; this.raw = raw; this.uri = uri; this.lineStarts = lineStarts; this.yaml = yaml;
    this.src = src;
  }

  /** Consume every content line that BEGINS before absolute offset `absEnd` — how a multi-line flow
   *  token takes its interior (and its own opening line, when the caller had not consumed it yet)
   *  out of the block cursor's way. */
  skipThrough(absEnd: number): void {
    while (this.i < this.lines.length && (this.lineStarts[this.lines[this.i].n] ?? 0) < absEnd) this.i++;
  }

  /** Absolute span of `len` chars starting at column `col` of raw line `lineN`. Valid
   *  because every Line.text is a prefix-aligned slice of its raw line (lex strips only
   *  the comment/trailing-ws SUFFIX), so tracked columns are raw-line columns. */
  spanAt(lineN: number, col: number, len: number): Span {
    const start = (this.lineStarts[lineN] ?? 0) + col;
    return { uri: this.uri, start, end: start + len };
  }

  peek(): Line | undefined { return this.lines[this.i]; }

  /** Read ONE `&` anchor token at the head of `text` (URIs.md §`&`): `&path`, `&path[]`,
   *  or the quoted form `&'path with spaces'`. Plain tokens run to unescaped whitespace.
   *  `inline` — the anchor PREFIXES a same-line value (valueAfter): the colon-form's
   *  run-to-end-of-line rule then reads only the HEAD token (up to the first whitespace) —
   *  a colon later in the line belongs to the value (`&item01 !!<…: …>`), not the anchor.
   *  Returns the Anchor plus the remaining text/column. */
  anchorToken(text: string, lineN: number, col: number, inline = false): { anchor: Anchor; rest: string; col: number } {
    let body: string;
    let tokenLen: number;
    if (text[1] === "'" || text[1] === '"') {
      const q = text[1];
      let j = 2;
      while (j < text.length) {
        if (q === '"' && text[j] === '\\') { j += 2; continue; }
        if (text[j] === q) { if (q === "'" && text[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      if (j >= text.length) this.fail('unterminated quoted anchor path');
      body = quotedScalar(text.slice(1, j + 1)).value as string;
      tokenLen = j + 1;
    } else if (hasSeparatorColon(inline ? text.slice(1).split(/[ \t]/, 1)[0] : text.slice(1))) {
      // COLON-form anchor (SEPARATOR.md): the `: ` styling holds spaces, so the token
      // runs to END OF LINE — a same-line value needs the quoted form (M3).
      body = text.slice(1).trim();
      tokenLen = text.length;
    } else {
      let j = 1;
      while (j < text.length && text[j] !== ' ' && text[j] !== '\t') {
        if (text[j] === '\\' && j + 1 < text.length) j++;
        j++;
      }
      body = text.slice(1, j);
      tokenLen = j;
    }
    const anchor = makeAnchor(body, (m) => this.fail(m), this.yaml);
    anchor.path.span = this.spanAt(lineN, col, tokenLen); // the whole `&…` token
    const a = adv(text, tokenLen, col);
    return { anchor, rest: a.rest, col: a.col };
  }

  /** Attach anchors to a (non-pointer) node's meta, appending to any it already has. */
  attachAnchors(value: Value, anchors: Anchor[]): void {
    if (anchors.length === 0) return;
    if (isPointer(value)) this.fail('cannot anchor a pointer');
    value.meta = { ...value.meta, anchors: [...(value.meta?.anchors ?? []), ...anchors] };
  }

  /** Merge a container() CONTINUATION into a node that already holds its value: entries
   *  and anchors append. A continuation carrying its own value line is a second value —
   *  an error — except the bare anchors-only case (a synthesized null with no raw). */
  mergeCont(v: Node, cont: Node): Node {
    const bare = cont.kind === 'scalar' && cont.value === null && cont.raw === '' && (cont.entries?.length ?? 0) === 0;
    if (cont.kind === 'scalar' && !bare) this.fail('a node may carry at most one scalar value line');
    const entries = [...(v.entries ?? []), ...(cont.entries ?? [])];
    const out: Node = {
      ...v,
      ...(entries.length > 0 ? { entries, array: cont.kind === 'mapping' ? cont.array : v.array } : {}),
    };
    this.attachAnchors(out, cont.meta?.anchors ?? []);
    return out;
  }
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
    // a lone type tag (no preceding key): `!!yo` (≡ deprecated `!!var`/`!!omni`) / `!!mix` /
    // `!!set` at the document root or as a block value. Hand to valueAfter with the block one
    // column shallower so the tag's own line (its inline value, plus the fields/entries below
    // it) parses as that value.
    if (/^!!(mix|var|omni|yo|set)(?=\s|$)/.test(l.text)) {
      this.i++;
      return this.valueAfter(l.text, l.indent - 1, l.n, l.indent);
    }
    if (isSeqLine(l.text) || isBackSeqLine(l.text) || l.text.startsWith('&') || splitKV(l.text)) {
      return this.container(l.indent);
    }
    // a lone scalar/flow/pointer — or a bare block scalar — occupying the line
    this.i++;
    let v: Value;
    if (/^[|>][+-]?\d*$/.test(l.text)) {
      // a bare block-scalar SELF-VALUE (omni, tagless): the first/root-line form, e.g. a document
      // whose root value is a multi-line block scalar that then carries fields/entries below it.
      v = this.blockScalar(l.text, l.indent, l.n);
    } else {
      v = this.valueInline(l.text, l.indent, /*allowBlock*/ true, l.n, l.indent);
    }
    // omni by default: a scalar value line may CONTINUE with entries/anchors at the same indent
    const nxt = this.peek();
    if (nxt && nxt.indent === l.indent && nxt.indent >= minIndent && !isPointer(v) && v.kind === 'scalar') {
      v = this.mergeCont(v, this.container(l.indent));
    }
    return v;
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
  container(indent: number, keylessOnly = false): Node {
    const entries: Entry[] = [];
    const anchors: Anchor[] = [];           // own-line `&…` anchors — they belong to THIS node
    let self: Scalar | undefined;           // the node's scalar value line (at most one; any position)
    let selfAt: number | undefined;         // its display position: entries authored before it (order-preserving)
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent) break;
      const startLineN = l.n;       // an entry's source range starts at its key/`-`/`~`
      const startCol = l.indent;    // marker, at this line's indent column
      const startBlank = l.blankBefore === true; // a blank source line precedes this entry
      let value: Value;
      let entry: Entry;
      if (l.text.startsWith('&')) {
        // own-line anchor(s); a trailing inline value makes this also the self-value line
        if (keylessOnly) break;
        this.i++;
        let { rest, col } = { rest: l.text, col: l.indent };
        while (rest.startsWith('&')) {
          const r = this.anchorToken(rest, l.n, col);
          anchors.push(r.anchor);
          ({ rest, col } = r);
        }
        if (rest !== '') {
          const v = this.valueInline(rest, indent, /*allowBlock*/ false, l.n, col);
          if (isPointer(v) || v.kind !== 'scalar') this.fail('only a scalar value may share a line with an own-line anchor');
          if (self !== undefined) this.fail('a node may carry at most one scalar value line');
          self = v;
          selfAt = entries.length;
        }
        continue;
      }
      if (isSeqLine(l.text)) {
        // a keyless (positional) entry
        this.i++;
        const afterDash = l.text.slice(1);
        const lead = afterDash.length - afterDash.trimStart().length;
        const contentCol = l.indent + 1 + lead;
        const rest = afterDash.trim();
        if (rest === '') {
          value = this.node(indent + 1) ?? nul();
        } else if (isSeqLine(rest) || (!/^(!!<|\*|&)/.test(rest) && splitKV(rest))) {
          // compact `- key: value` or compact nesting `- - item`: re-read this line
          // (+ deeper siblings) as a container — the rewrite recurses, so `- - - x`
          // nests to any depth. (a `!!<…>` tag, a `*` pointer, or a `&` anchor is a
          // VALUE — a colon-form token's inner `: ` must not look like a key)
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
        const ptr = parsePointer(rest.slice(1).trim());
        ptr.span = this.spanAt(l.n, a.col, rest.length);
        value = ptr;
        entry = { key: null, edge: 'back', value };
      } else {
        // a keyed entry — or, failing the `key:` split, the node's scalar VALUE line
        // (omni by default: the value line may sit anywhere among the entries)
        if (keylessOnly) break;
        if (/^~[ \t]/.test(l.text)) this.fail('the "~" sigil must sit tight against the key or "-" marker (write "~key:" or "~-")');
        const kv = splitKV(l.text);
        if (!kv) {
          this.i++;
          let v: Scalar;
          if (/^[|>][+-]?\d*$/.test(l.text)) {
            // a bare block-scalar SELF-VALUE (omni, tagless — no `!!var` needed): its content is
            // the deeper-indented run, and a dedent back to this node's indent ends it, so sibling
            // entries resume. (YAMLOVER.md §4 — the value line may sit anywhere among the entries.)
            v = this.blockScalar(l.text, indent, l.n);
          } else {
            const iv = this.valueInline(l.text, indent, /*allowBlock*/ false, l.n, l.indent);
            if (isPointer(iv) || iv.kind !== 'scalar') this.fail('unexpected content (expected an entry, an anchor, or a scalar value line)');
            v = iv;
          }
          if (self !== undefined) this.fail('a node may carry at most one scalar value line');
          self = v;
          selfAt = entries.length; // remember where the value line sat, to render/serialize it in place
          continue;
        }
        this.i++;
        let rawKey = kv.key;
        let back = false;
        // the NULL KEY (YAML's rule, adopted 2026-08-01): `: v` and `~: v` are a keyed entry
        // whose key is the null value — NOT keyless, NOT the empty string, NOT a back-edge
        // (a back-edge sigil needs a nonempty relation name: `~cain:`)
        const nullKey = rawKey === '' || rawKey === '~';
        if (!nullKey && rawKey.startsWith('~')) { back = true; rawKey = rawKey.slice(1); }
        value = this.valueAfter(kv.rest, indent, l.n, l.indent + kv.restCol);
        if (nullKey) {
          entry = { key: null, nullKey: true, edge: isPointer(value) ? 'ref' : 'contain', value };
        } else {
          const key = unquoteKey(rawKey);
          // a PLAIN numeric key is a position, and order is the container's own data — refuse
          // loudly (yamlover surface only; a .yaml file reads it faithfully as the string key)
          if (!this.yaml && !/^['"]/.test(rawKey) && /^\d+$/.test(key)) {
            this.fail(`a plain numeric key is a position — author it by order ("- value"), or quote a numeric STRING key ("'${key}':")`);
          }
          entry = { key, edge: back ? 'back' : isPointer(value) ? 'ref' : 'contain', value };
        }
      }
      // … and ends at the last source line the value consumed — a contiguous run, so
      // `this.lines[this.i - 1]` is that line. Post-strip (`indent + text.length`) so a
      // trailing `#` comment / whitespace is excluded.
      const endLine = this.lines[this.i - 1];
      const start = (this.lineStarts[startLineN] ?? 0) + startCol;
      const end = endLine
        ? (this.lineStarts[endLine.n] ?? 0) + endLine.indent + endLine.text.length
        : start;
      entry.meta = { ...entry.meta, span: { uri: this.uri, start, end }, ...(startBlank ? { blankBefore: true } : {}) };
      entries.push(entry);
    }
    // projection hint: a pure sequence — judged over OWNED entries only (a `~-` back-edge
    // is not a member of THIS node and must not make it look like an array; a NULL-KEYED
    // entry is keyed, so it breaks pure-sequence-ness like any key).
    const owned = entries.filter((e) => e.edge !== 'back');
    const array = owned.length > 0 && owned.every((e) => e.key === null && e.nullKey !== true);
    const node: Node = self !== undefined
      ? { ...self, entries, array }                 // value + fields: one omni node
      : entries.length === 0
        ? nul()                                     // only anchor lines — a null scalar, NOT a mapping
        : { kind: 'mapping', entries, array };
    // preserve where the self-value line sat among the entries (order-preserving display/round-trip;
    // the value stays positionless DATA — entries keep their own [n]). Omit 0 (the canonical first).
    if (self !== undefined && selfAt !== undefined && selfAt > 0) node.meta = { ...node.meta, selfAt };
    this.attachAnchors(node, anchors);
    return node;
  }

  /** The value after `key:` or `- ` (inline `rest`, with a possible deeper block).
   *  `col` = the column of `rest` in raw line `srcLineN` (span tracking). */
  valueAfter(rest: string, parentIndent: number, srcLineN: number, col: number): Value {
    ({ rest, col } = adv(rest, 0, col));
    // the DECORATION PREFIX, in any authored order: a `!!<…>` schema tag, type tags
    // (`!!mix` mixed container — a no-op marker / `!!yo` plain-yamlover, `!!var <v>` and
    // `!!omni` its deprecated aliases / `!!set` set semantics — NodeMeta.yo / NodeMeta.set),
    // and inline `&` anchors — `&item01 !!<…>` is as legal as `!!<…> &item01` (the
    // anchor-first spelling is what positional projections show)
    let schema: Value | undefined;
    const typeTags = new Set<'mix' | 'yo' | 'set'>();
    const anchors: Anchor[] = [];
    for (;;) {
      if (schema === undefined && rest.startsWith('!!<')) {
        const close = rest.indexOf('>');
        if (close < 0) this.fail('unterminated "!!<…>" schema tag');
        schema = parseSchemaRef(rest.slice(3, close), { block: this, lineN: srcLineN, col: col + 3 });
        ({ rest, col } = adv(rest, close + 1, col));
        continue;
      }
      const tag = /^!!(mix|var|omni|yo|set)(?=\s|$)/.exec(rest);
      if (tag) {
        const t = (tag[1] === 'var' || tag[1] === 'omni' ? 'yo' : tag[1]) as 'mix' | 'yo' | 'set';
        if (typeTags.has(t)) break;
        typeTags.add(t);
        ({ rest, col } = adv(rest, tag[0].length, col));
        continue;
      }
      if (rest.startsWith('&')) {
        const r = this.anchorToken(rest, srcLineN, col, /*inline*/ true);
        anchors.push(r.anchor);
        ({ rest, col } = r);
        continue;
      }
      break;
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
    } else if (anchors.length > 0 && (isSeqLine(rest) || (!/^(!!<|\*|&)/.test(rest) && splitKV(rest)))) {
      // COMPACT NESTED CONTENT after an inline anchor (`- &item01 - x` / `- &a k: v` — the
      // positional projection's spelling): the first entry rides this line, and a deeper
      // block CONTINUES the same container. Without this, the line read as the plain scalar
      // "- x" — the reported mangling.
      this.i--;
      this.lines[this.i] = { indent: col, text: rest, n: srcLineN };
      value = this.container(col);
      const nxt = this.peek();
      if (nxt && nxt.indent > parentIndent && nxt.indent < col) value = this.mergeCont(value, this.container(nxt.indent));
    } else {
      value = this.valueInline(rest, parentIndent, /*allowBlock*/ false, srcLineN, col);
      value = this.attachFields(value, parentIndent);
    }
    this.attachAnchors(value, anchors);
    // `!!mix` is a no-op marker (the omni shape is the default); `!!set` and `!!yo` carry
    // real semantics and survive into the graph
    if (typeTags.has('set') && !isPointer(value)) value.meta = { ...value.meta, set: true };
    if (typeTags.has('yo') && !isPointer(value)) value.meta = { ...value.meta, yo: true };
    if (schema !== undefined && !isPointer(value)) value.meta = { ...value.meta, schema };
    return value;
  }

  /** A node = value + fields: a scalar value (inline OR a block scalar) followed by a DEEPER
   *  block attaches that block's (positional and/or keyed) entries onto the scalar — one node
   *  carrying its value and its fields (the `!!omni` shape). Non-scalars/pointers pass through. */
  attachFields(value: Value, parentIndent: number): Value {
    const nxt = this.peek();
    if (nxt && nxt.indent > parentIndent && !isPointer(value) && value.kind !== 'blob') {
      // a deeper block after an inline value CONTINUES the node: fields for a scalar
      // (the omni shape), and — since M3 puts anchors own-line in the block — anchors
      // (and further entries) for a flow mapping/sequence too
      return this.mergeCont(value, this.container(nxt.indent));
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
      if (ind >= r.length) { lines.push(''); lastN = n; this.blockLines.add(n); continue; } // blank line
      if (ind <= parentIndent) break;                               // dedent to/under key → ends
      if (blockIndent >= 0 && ind < blockIndent) break;             // dedent under content → !!omni fields begin
      if (blockIndent < 0) blockIndent = ind;                       // first content line sets indent
      lines.push(r.slice(blockIndent));
      lastN = n;
      this.blockLines.add(n);                                       // its `#`/blanks are content
    }
    while (this.peek() && this.peek()!.n <= lastN) this.i++;        // skip consumed lines

    let last = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i] !== '') last = i;
    const core = lines.slice(0, last + 1);
    let body = folded ? foldLines(core) : core.join('\n');
    if (chomp === 'keep') body += '\n'.repeat(lines.length - (last + 1) + (last >= 0 ? 1 : 0));
    else if (chomp === 'clip' && last >= 0) body += '\n';          // strip → nothing
    // `raw` is the AUTHORED representation, normalized: the header token plus the de-indented
    // content lines (trailing blanks only when `+` keeps them — under clip/strip they separate,
    // they are not content). Renderers reproduce this instead of re-deriving a block from `value`.
    const header = (folded ? '>' : '|') + (chomp === 'strip' ? '-' : chomp === 'keep' ? '+' : '');
    const kept = chomp === 'keep' ? lines : core;
    return { kind: 'scalar', value: body, raw: kept.length ? header + '\n' + kept.join('\n') : header };
  }

  /** Parse a single-line inline value: flow, pointer, anchor, quoted or plain scalar.
   *  `col` = the column of `text` in raw line `lineN` (span tracking). */
  valueInline(text: string, parentIndent: number, allowBlock: boolean, lineN: number, col: number): Value {
    ({ rest: text, col } = adv(text, 0, col));
    const c = text[0];
    if (c === '{' || c === '[') {
      const start = (this.lineStarts[lineN] ?? 0) + col;
      // A token that does not close on its own line SPANS lines — K&R braces. Slice it from the
      // source by bracket balance (flowTokenEnd is newline-agnostic: it counts quotes and brackets),
      // hand the whole thing to the flow reader, and take its interior lines out of the block
      // cursor. On the yamlover surface that spanning IS a concrete switch to json5p
      // (CONCRETES.md §Collection style); in YAML it is ordinary multi-line flow (Ch. 7).
      if (flowTokenEnd(text) < 0) {
        const end = flowTokenEnd(this.src.slice(start));
        if (end < 0) this.fail('unterminated flow token');
        const tok = this.src.slice(start, start + end);
        // v1: the flow reader collects no comments, and dropping one silently would lose content
        if (commentStart(tok) >= 0) this.fail('a comment inside a multi-line flow token is not supported');
        const v = new Flow(tok, this.uri, start, this.yaml).parse();
        this.skipThrough(start + end);
        // PER-CONTAINER LAYOUT: each container marked itself as it was read (layoutMeta) — the
        // outer token by its own span, an inner one-liner keeping `style: 'flow'`, an inner
        // multi-liner its own `concrete` — so nothing to stamp or strip here.
        return v;
      }
      return new Flow(text, this.uri, start, this.yaml).parse();
    }
    if (c === '*') {
      const p = parsePointer(text.slice(1).trim(), this.yaml);
      p.span = this.spanAt(lineN, col, text.length); // the whole `*…` deref token
      return p;
    }
    if (c === '&') {
      const anchors: Anchor[] = [];
      let rest = text;
      let acol = col;
      while (rest.startsWith('&')) {
        const r = this.anchorToken(rest, lineN, acol);
        anchors.push(r.anchor);
        ({ rest, col: acol } = r);
      }
      const v = rest === ''
        ? (allowBlock ? (this.node(parentIndent + 1) ?? nul()) : nul())
        : this.valueInline(rest, parentIndent, allowBlock, lineN, acol);
      this.attachAnchors(v, anchors);
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
  uri: string;
  base: number; // absolute offset of s[0] in the source (span tracking)
  yaml: boolean;

  constructor(s: string, uri = '<flow>', base = 0, yaml = false) {
    this.s = s; this.uri = uri; this.base = base; this.yaml = yaml;
  }

  fail(msg: string): never { throw new SyntaxError(`yamlover (flow): ${msg} at offset ${this.i}`); }

  parse(): Node | Pointer {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i < this.s.length) this.fail('trailing characters in flow value');
    return v;
  }

  /** Flow whitespace INCLUDES line breaks (YAML Ch. 7 — a flow collection may span lines; on the
   *  yamlover surface that spanning is the json5p switch, see valueInline). */
  ws(): void { while (this.i < this.s.length && ' \t\r\n'.includes(this.s[this.i])) this.i++; }

  value(): Node | Pointer {
    const c = this.s[this.i];
    if (c === '{') return this.map();
    if (c === '[') return this.seq();
    if (c === '*') {
      const start = this.i;
      this.i++;
      // a flow pointer reads to the next , } or ] at bracket depth 0 — colon-form
      // raws contain `:`/`[n]`/styling spaces, which the generic plain stop-set eats
      let txt: string;
      if (this.s[this.i] === "'" || this.s[this.i] === '"') {
        txt = this.quoted().value as string;
      } else {
        const st = this.i;
        let depth = 0;
        while (this.i < this.s.length) {
          const ch = this.s[this.i];
          if (ch === '\\' && this.i + 1 < this.s.length) { this.i += 2; continue; }
          if (ch === '[') depth++;
          else if (ch === ']') { if (depth === 0) break; depth--; }
          else if (ch === ',' || ch === '}') break;
          this.i++;
        }
        txt = this.s.slice(st, this.i).trim();
      }
      const p = parsePointer(txt, this.yaml);
      p.span = { uri: this.uri, start: this.base + start, end: this.base + this.i };
      return p;
    }
    if (c === '&') {
      // a path anchor in flow: `&'path'` (quoted — needed for `[]`/`[n]`) or a plain run
      const start = this.i;
      this.i++;
      let body: string;
      if (this.s[this.i] === "'" || this.s[this.i] === '"') {
        body = this.quoted().value as string;
      } else {
        const st = this.i;
        while (this.i < this.s.length && !' \t,]}'.includes(this.s[this.i])) {
          if (this.s[this.i] === '\\' && this.i + 1 < this.s.length) this.i++;
          this.i++;
        }
        body = this.s.slice(st, this.i);
      }
      const anchor = makeAnchor(body, (m) => this.fail(m), this.yaml);
      anchor.path.span = { uri: this.uri, start: this.base + start, end: this.base + this.i };
      this.ws();
      const v = this.value();
      if (isPointer(v)) this.fail('cannot anchor a pointer');
      v.meta = { ...v.meta, anchors: [...(v.meta?.anchors ?? []), anchor] };
      return v;
    }
    if (c === "'" || c === '"') return this.quoted();
    const tok = this.readPlain();
    if (tok === '') this.fail('expected a value');
    return plainScalar(tok);
  }

  /** The layout meta of the token that started at `open` and ends at the CURRENT position: its
   *  own text decides — one line ⇒ `style: 'flow'`; spanning lines ⇒ the json5p switch, PER
   *  CONTAINER (an inner one-liner inside a K&R token keeps its one-line form and round-trips).
   *  YAML mode never switches concretes: multi-line flow there is plain YAML flow. */
  layoutMeta(open: number): { style: 'flow' } | { concrete: 'json5p' } {
    return !this.yaml && this.s.slice(open, this.i).includes('\n') ? { concrete: 'json5p' } : { style: 'flow' };
  }

  map(): Mapping {
    const open = this.i;
    this.i++; // {
    const entries: Entry[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') { this.i++; break; }
      if (this.i >= this.s.length) this.fail('unterminated flow map');
      let back = false;
      let nullKey = false;
      if (this.s[this.i] === '~') {
        // `~:` (spaces allowed) is the NULL KEY (YAML); `~name:` is the back-edge sigil
        let j = this.i + 1;
        while (this.s[j] === ' ' || this.s[j] === '\t') j++;
        if (this.s[j] === ':') { nullKey = true; this.i = j; }
        else { back = true; this.i++; }
      }
      // A FLOW TOKEN may be the KEY — `{[1, 2]: 3}`, `{{}: 12}` — the flow-context twin of the
      // block surface's `[256, 256]: *…` (splitKV scans a leading token whole for exactly this).
      // The key is the token's VERBATIM TEXT, as it is there: a container key is a string key
      // spelled that way, not a second kind of key. Without this the plain reader stopped at the
      // nested closer and the pair failed with `expected ":" in flow map`.
      const kc = this.s[this.i];
      let key = '';
      let quoted = false;
      if (nullKey) {
        // the key is the null value — nothing to read; `this.i` already sits at the `:`
      } else if (kc === "'" || kc === '"') {
        quoted = true;
        key = this.quoted().value as string;
      } else if (kc === '[' || kc === '{') {
        const end = flowTokenEnd(this.s.slice(this.i));
        if (end < 0) this.fail('unterminated flow token in a key');
        key = this.s.slice(this.i, this.i + end);
        this.i += end;
      } else {
        key = unquoteKey(this.readPlain(':,}\r\n'));
        if (key === '') nullKey = true; // `{: v}` — the empty spelling of the null key
      }
      if (!nullKey && !quoted && !this.yaml && /^\d+$/.test(key)) {
        this.fail(`a plain numeric key is a position — author it by order ("- value"), or quote a numeric STRING key ("'${key}':")`);
      }
      this.ws();
      if (this.s[this.i] !== ':') this.fail('expected ":" in flow map');
      this.i++;
      this.ws();
      const v = this.value();
      const edge = back ? 'back' as const : isPointer(v) ? 'ref' as const : 'contain' as const;
      entries.push(nullKey ? { key: null, nullKey: true, edge, value: v } : { key, edge, value: v });
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === '}') { this.i++; break; }
      this.fail('expected "," or "}"');
    }
    // `style: 'flow'` records the AUTHORED one-line form so the serializer re-emits it and a
    // projection can offer flow cells — the `yaml/flow` representation concrete (CONCRETES.md).
    return { kind: 'mapping', entries, array: false, meta: this.layoutMeta(open) };
  }

  seq(): Mapping {
    const open = this.i;
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
    return { kind: 'mapping', entries, array: true, meta: this.layoutMeta(open) };
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
  // a LINE BREAK ends a plain flow scalar, like any other flow whitespace — else a multi-line
  // token's `1\n  ]` would read the newline and the following indent into the token
  readPlain(stop = ',:[]{} \r\n'): string {
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
/** The index just PAST a leading flow token (`[…]` / `{…}`), quote- and nesting-aware. 0 when the
 *  text opens no flow token; -1 when it opens one that never closes. */
function flowTokenEnd(text: string): number {
  if (text[0] !== '[' && text[0] !== '{') return 0;
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === q) {
        if (q === "'" && text[i + 1] === "'") i++; // a doubled '' is a literal quote
        else q = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { if (--depth === 0) return i + 1; }
  }
  return -1;
}

export function splitKV(text: string): { key: string; rest: string; restCol: number } | null {
  // A leading FLOW token is scanned WHOLE before the colon hunt: its interior colons belong to the
  // flow grammar, not to a key. The token is a KEY only when a `:` follows it (`[256, 256]: *…` —
  // the thumbnail overlay's flow-seq key); otherwise the line is a flow VALUE and this returns
  // null so `valueInline` hands it to the flow reader. Without this a document root `{a: 1}` split
  // at its first `: ` and parsed as the key `{a` with the string value `1}` — a SILENT misparse —
  // while `{a: [1]}` failed outright on the trailing `}`.
  const from = flowTokenEnd(text);
  if (from < 0) return null; // an unterminated flow token: a value, and the flow reader says why
  let inS = false;
  let inD = false;
  for (let i = from; i < text.length; i++) {
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
 *  `at` (when known) locates `src` in its raw line, so a schema pointer gets a span too.
 *  Exported for the server's yed loader: the comment sidecar carries the authored tag as
 *  TEXT (`bucket.tag`), and loading it back into `meta.schema` must parse it the one way. */
export function parseSchemaRef(src: string, at?: { block: Block; lineN: number; col: number }): Value {
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
/** YAML folding: adjacent content lines join with a space, blank lines stay breaks.
 *  Exported for the serializer — the authored-`>` round-trip check reuses the one law. */
export function foldLines(lines: string[]): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out += lines[i] === '' || lines[i - 1] === '' ? '\n' : ' ';
    out += lines[i];
  }
  return out;
}


/** An unescaped, unquoted `:` anywhere — marks a colon-form (SEPARATOR.md) token. */
function hasSeparatorColon(s: string): boolean {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q !== null) { if (c === q) q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === ':') return true;
  }
  return false;
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
  // YAML float specials (yamlover follows YAML, not json5's `Infinity`/`NaN` words).
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(t)) return { kind: 'scalar', value: t[0] === '-' ? -Infinity : Infinity, raw: text };
  if (/^\.(?:nan|NaN|NAN)$/.test(t)) return { kind: 'scalar', value: NaN, raw: text };
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
