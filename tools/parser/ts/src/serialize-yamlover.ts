// IR → yamlover text (PLAN.md 2d). FREE-FORM canonical emission: the IR keeps the graph,
// not the typography (comments, quote styles and block-scalar layout are not stored —
// IR.md), so the output is a clean re-rendering whose reparse is IR-EQUAL to the input:
// same values, entry order, keys, edge kinds, pointer texts (verbatim `raw`), anchors,
// `!!set` and `!!<…>` schema tags — with `!!mix` re-derived from the shape and `!!omni`
// implied by it (explicit only at the document root, where a bare scalar cannot precede
// the keys). Inexpressible content — blobs, non-finite numbers, an anchored document
// root — raises LossyError: refuse, never drop. (Blobs are refused only for now: the IR
// carries the content HASH, not the bytes; once a byte source is wired in, a blob can
// emit INLINE as base64 — META.md `type: binary` — the same node in a different concrete.)

import type { Document, Node, Entry, Value, Scalar, Pointer } from './ir.ts';
import { isPointer } from './ir.ts';
import { plainScalar, splitKV } from './yamlover.ts';
import { LossyError, anchorIndex } from './serialize-common.ts';

const STEP = 2;

export function serializeYamlover(doc: Document): string {
  return new Emitter(doc).serialize();
}

class Emitter {
  out: string[] = [];
  doc: Document;
  anchorOf: WeakMap<Node, string>;
  pending: Set<string>; // anchor names not yet written

  constructor(doc: Document) {
    this.doc = doc;
    this.anchorOf = anchorIndex(doc);
    this.pending = new Set(doc.anchors.keys());
  }

  serialize(): string {
    const root = this.doc.root;
    if (root.kind === 'blob') throw new LossyError('a blob has no yamlover text form (its bytes live in a file)');
    if (this.anchorOf.get(root) !== undefined) throw new LossyError('cannot serialize an anchor on the document root');
    if (root.meta?.schema !== undefined) this.out.push(`!!<${this.schemaText(root.meta.schema)}>`);
    const ents = root.entries ?? [];
    if (root.kind === 'scalar') {
      // The root value must be inline (block indicators are read only after a key); with
      // fields it needs the explicit `!!omni` — at the root the shape alone cannot say it.
      const tok = this.inline(root, /*needToken*/ ents.length > 0);
      this.out.push(ents.length > 0 ? `!!omni ${tok}` : tok);
      this.entries(ents, 0);
    } else if (ents.length === 0) {
      this.out.push(root.array ? '[]' : '{}');
    } else {
      const tag = this.containerTag(root);
      if (tag !== null) this.out.push(tag);
      this.entries(ents, 0);
    }
    if (this.pending.size > 0) {
      throw new LossyError(`anchored node(s) not reachable in the tree: &${[...this.pending].join(', &')}`);
    }
    return this.out.join('\n') + '\n';
  }

  entries(ents: Entry[], indent: number): void {
    const pad = ' '.repeat(indent);
    for (const e of ents) {
      if (e.key === null && e.edge === 'back') {
        // reverse positional membership — the value is by definition a pointer (URIs.md §`~-`)
        if (!isPointer(e.value)) throw new LossyError('a keyless back-edge ("~-") must hold a pointer');
        this.out.push(`${pad}~- *${this.ptrText(e.value)}`);
      } else if (e.key === null) {
        this.seqItem(e.value, indent);
      } else {
        const head = (e.edge === 'back' ? '~' : '') + keyText(e.key) + ':';
        this.keyed(head, e.value, indent);
      }
    }
  }

  /** Emit `head <value>` at `indent` — `head` is `key:`, `~key:`, or the `-` seq marker
   *  (their value/indent grammar is identical: a deeper block belongs to the entry). */
  keyed(head: string, value: Value, indent: number): void {
    const pad = ' '.repeat(indent);
    if (isPointer(value)) {
      this.out.push(`${pad}${head} *${this.ptrText(value)}`);
      return;
    }
    if (value.kind === 'blob') throw new LossyError('a blob has no yamlover text form (its bytes live in a file)');
    const parts = this.decorations(value);
    const ents = value.entries ?? [];
    if (value.kind === 'scalar') {
      const block = typeof value.value === 'string' && value.value.includes('\n')
        ? blockLines(value.value) : null;
      if (block !== null) {
        // block-scalar content sits DEEPER than any `!!omni` fields, so the fields'
        // dedent ends the block (the parser's rule) while staying deeper than the key
        const inner = indent + STEP + (ents.length > 0 ? STEP : 0);
        this.out.push(joinLine(pad + head, [...parts, block.header]));
        for (const l of block.lines) this.out.push(l === '' ? '' : ' '.repeat(inner) + l);
      } else {
        const tok = this.inline(value, /*needToken*/ ents.length > 0 || parts.length > 0);
        this.out.push(joinLine(pad + head, tok === '' ? parts : [...parts, tok]));
      }
      this.entries(ents, indent + STEP);
    } else if (ents.length === 0) {
      this.out.push(joinLine(pad + head, [...parts, value.array ? '[]' : '{}']));
    } else {
      this.out.push(joinLine(pad + head, parts));
      this.entries(ents, indent + STEP);
    }
  }

  seqItem(value: Value, indent: number): void {
    const pad = ' '.repeat(indent);
    if (!isPointer(value) && value.kind === 'mapping') {
      const parts = this.decorations(value);
      const ents = value.entries;
      if (ents.length === 0) {
        this.out.push(`${pad}- ${value.array ? '[]' : '{}'}`);
        return;
      }
      if (parts.length === 0 && ents[0].key !== null) {
        // compact `- key: …`: render the entries, then fold the first line onto the dash
        // (STEP === the `- ` marker width, so the columns line up exactly)
        const at = this.out.length;
        this.entries(ents, indent + STEP);
        this.out[at] = pad + '- ' + this.out[at].slice(indent + STEP);
        return;
      }
      this.out.push(joinLine(pad + '-', parts)); // `- !!mix` / `- &a` / bare `-`
      this.entries(ents, indent + STEP);
      return;
    }
    this.keyed('-', value, indent);
  }

  /** Value-position prefixes, in the parser's reading order: `!!<…>` schema, `!!mix`/
   *  `!!set` (shape/meta), `&anchor`. */
  decorations(node: Node): string[] {
    const parts: string[] = [];
    if (node.meta?.schema !== undefined) parts.push(`!!<${this.schemaText(node.meta.schema)}>`);
    const tag = this.containerTag(node);
    if (tag !== null) parts.push(tag);
    const anchor = this.anchorOf.get(node);
    if (anchor !== undefined) {
      parts.push(`&${anchor}`);
      this.pending.delete(anchor);
    }
    return parts;
  }

  containerTag(node: Node): string | null {
    const set = node.meta?.set === true;
    const owned = (node.entries ?? []).filter((e) => e.edge !== 'back');
    const mixed = node.kind === 'mapping' && owned.some((e) => e.key !== null) && owned.some((e) => e.key === null);
    if (set && mixed) throw new LossyError('a !!set that also mixes keyed and keyless entries has no single-tag spelling');
    return set ? '!!set' : mixed ? '!!mix' : null;
  }

  /** A single-line scalar token (never contains a newline — multiline strings go through
   *  blockLines or the double-quoted fallback). `needToken`: an empty rendering (`key:`)
   *  is not available — e.g. omni fields follow, which would otherwise become the value. */
  inline(s: Scalar, needToken: boolean): string {
    const v = s.value;
    if (v === null) return needToken ? 'null' : '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new LossyError(`yamlover has no literal for ${v}`);
      const raw = s.raw.trim();
      if (raw !== '' && plainSafe(raw) && plainScalar(raw).value === v) return raw; // keep 0x1F etc.
      return String(v);
    }
    if (v === '') return "''";
    if (v.includes('\n') || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) return dq(v);
    if (plainSafe(v)) return v;
    return `'${v.replace(/'/g, "''")}'`;
  }

  /** The text after `*`. The raw pointer is kept verbatim; quote it only when the line
   *  context would eat it (a ` #` comment, leading quote, outer whitespace). */
  ptrText(p: Pointer): string {
    const r = p.raw;
    if (r !== r.trim() || /(^|[ \t])#/.test(r) || /^['"]/.test(r)) return `'${r.replace(/'/g, "''")}'`;
    return r;
  }

  /** The contents of a `!!<…>` tag: a pointer (`*…`) or an inline node. The contents are
   *  reparsed as one-line yamlover, where a leading `{` does NOT reach the flow reader (the
   *  block `key:` split runs first) — so a keyed schema must be the brace-less one-liner
   *  `key: value`, which holds exactly one top-level entry. `>` would close the tag early —
   *  refuse it. */
  schemaText(v: Value): string {
    const text = isPointer(v) ? `*${v.raw}` : schemaNodeText(v);
    if (/[>\n]/.test(text)) throw new LossyError(`a !!<…> schema tag cannot contain ">" or a newline: ${text}`);
    return text;
  }
}

// ---- helpers -------------------------------------------------------------------

function joinLine(head: string, parts: string[]): string {
  return parts.length === 0 ? head : head + ' ' + parts.join(' ');
}

/** A string is safe to emit as a PLAIN scalar iff the reparse (in every context we emit:
 *  after `key:`, after `- `, alone on a line) returns the identical string. */
function plainSafe(text: string): boolean {
  if (text === '' || text !== text.trim()) return false;
  if ("'\"*&~!|>{[".includes(text[0])) return false; // value-position sigils & quotes
  if (text === '-' || text.startsWith('- ')) return false; // would read as a seq marker
  if (/(^|[ \t])#/.test(text)) return false; // comment stripping
  if (splitKV(text) !== null) return false; // would read as `key: value` in a compact item
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return false;
  return plainScalar(text).value === text;
}

/** Double-quoted, JSON-escape style — the parser's dq escapes are a JSON superset. */
function dq(s: string): string {
  return JSON.stringify(s);
}

/** Render a multiline string as a literal block scalar, or null if the block form cannot
 *  hold it losslessly (the parser de-indents by the FIRST content line and reads all-space
 *  lines as empty): then the caller falls back to a double-quoted scalar. */
function blockLines(v: string): { header: string; lines: string[] } | null {
  if (/\r/.test(v)) return null;
  let trailing = 0;
  let end = v.length;
  while (end > 0 && v[end - 1] === '\n') { trailing++; end--; }
  const body = v.slice(0, end);
  if (body === '') return null; // whitespace-only string
  const lines = body.split('\n');
  if (/^[ \t]/.test(lines[0])) return null; // would corrupt the block's indent base
  if (lines.some((l) => l !== '' && /^ +$/.test(l))) return null; // all-space lines read as empty
  const header = trailing === 0 ? '|-' : trailing === 1 ? '|' : '|+';
  for (let i = 1; i < trailing; i++) lines.push('');
  return { header, lines };
}

/** Plain keys carry the pointer-metachar escaping (URIs.md §escaping); keys the line
 *  grammar itself would misread are double-quoted instead. */
function keyText(key: string): string {
  const needsQuote =
    key === '' || key !== key.trim() ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.includes(': ') || // splitKV would split at the inner colon
    key === '-' || key.startsWith('- ') ||
    /^['"]/.test(key) ||
    key.includes('\\'); // plain keys are backslash-UNescaped on parse
  if (needsQuote) return dq(key);
  // escape the pointer metachars (incl. the QUERY.md reservations) — parse strips them back
  return key.replace(/[/[\]*&#~?!()<>=|]/g, (c) => '\\' + c);
}

/** The one-line rendering of an inline `!!<…>` schema node. Top level: a scalar, a
 *  keyless seq (`[…]`), or ONE `key: value` block one-liner; nested values may be flow. */
function schemaNodeText(n: Node): string {
  if (n.kind === 'mapping') {
    const ents = n.entries;
    const keyed = ents.filter((e) => e.key !== null);
    if (keyed.length === ents.length && ents.length === 1 && ents[0].edge !== 'back') {
      const e = ents[0];
      const v = isPointer(e.value) ? flowPtr(e.value) : flowText(e.value);
      return `${keyText(e.key!)}: ${v}`;
    }
    if (keyed.length > 0) {
      // `{a: 1, b: 2}` on one line is read as a BLOCK `key:` line, not flow — refuse
      throw new LossyError('an inline !!<…> schema holds at most one top-level key');
    }
  }
  return flowText(n);
}

/** Single-line FLOW rendering — used only inside `!!<…>` schema tags, so the supported
 *  surface is the schema vocabulary (nested maps/seqs, scalars, `*` pointers). */
function flowText(n: Node): string {
  if (n.kind === 'blob') throw new LossyError('a blob has no flow form');
  if (n.meta?.schema !== undefined || n.meta?.set === true) {
    throw new LossyError('tags inside an inline !!<…> schema are not serializable');
  }
  const ents = n.entries ?? [];
  if (n.kind === 'scalar') {
    if (ents.length > 0) throw new LossyError('a value-plus-fields node has no flow form');
    return flowTok(n);
  }
  if (ents.length === 0) return n.array ? '[]' : '{}';
  const keyed = ents.filter((e) => e.key !== null);
  if (keyed.length > 0 && keyed.length < ents.length) throw new LossyError('a mixed container has no flow form');
  if (ents.some((e) => e.edge === 'back')) throw new LossyError('back-edges inside an inline !!<…> schema are not serializable');
  const item = (e: Entry): string => {
    const v = isPointer(e.value) ? flowPtr(e.value) : flowText(e.value);
    return e.key === null ? v : `${flowKey(e.key)}: ${v}`;
  };
  return keyed.length === 0 ? `[${ents.map(item).join(', ')}]` : `{${ents.map(item).join(', ')}}`;
}

function flowTok(s: Scalar): string {
  const v = s.value;
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new LossyError(`yamlover has no literal for ${v}`);
    return String(v);
  }
  if (v !== '' && /^[^,:[\]{}'"#\s]+$/.test(v) && !'*&~!|>'.includes(v[0]) && plainScalar(v).value === v) return v;
  if (/[\n\r\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) throw new LossyError('a control character has no flow form inside a !!<…> tag');
  return `'${v.replace(/'/g, "''")}'`;
}

function flowPtr(p: Pointer): string {
  // flow plain tokens stop at `,:[]{}` and whitespace — a raw that contains them cannot ride
  if (!/^[^,:[\]{}'"\s]+$/.test(p.raw)) throw new LossyError(`pointer "*${p.raw}" does not fit a flow context`);
  return `*${p.raw}`;
}

function flowKey(k: string): string {
  return /^[\w.$/-]+$/.test(k) ? k : `'${k.replace(/'/g, "''")}'`;
}
