// IR → json5p text (PLAN.md 2d). json5p is the smaller full-graph concrete: pointers,
// anchors and back-edges all fit, but yamlover's value-position tags do not — a node
// carrying `!!mix` (keyed+keyless in one container), `!!var` (value-plus-fields),
// `!!set`, or a `!!<…>` schema raises LossyError (refuse, never drop; such metadata
// routes through the meta layer instead — cf. the note in examples/03-tour.json5p).
// Round-trip contract: parseJson5p(serializeJson5p(doc)) is IR-equal to doc.

import type { Document, Node, Entry, Value, Scalar, Pointer, Comment } from './ir.ts';
import { isPointer } from './ir.ts';
import { LossyError, anchorBody, isAnchorizableBack, backAnchorBody } from './serialize-common.ts';
import { renderPointer } from './pointer.ts';

const STEP = 2;

/** Emit options. `comments` re-emits retained comments; off by default (byte-identical output). */
export interface SerializeOpts { comments?: boolean }

export function serializeJson5p(doc: Document, opts?: SerializeOpts): string {
  const e = new Emitter(opts?.comments ?? false);
  const head = e.comments && (doc.head?.length ?? 0) > 0
    ? doc.head!.map((c) => commentText(c)).join('\n') + '\n\n' // blank line → reparses as head
    : '';
  const tail = e.comments
    ? (doc.root.meta?.comments ?? []).map((c) => '\n' + commentText(c)).join('') // leftovers, never dropped
    : '';
  return head + e.value(doc.root, 0) + tail + '\n';
}

class Emitter {
  comments: boolean;

  constructor(comments: boolean) { this.comments = comments; }

  value(v: Value, indent: number): string {
    if (isPointer(v)) return ptr(v);
    // `&` path anchors stack before the value, each in the canonical quoted form — the
    // node's own anchors plus its deprecated `~` back entries re-emitted as anchors
    let prefix = '';
    for (const a of v.meta?.anchors ?? []) prefix += '&' + JSON.stringify(anchorBody(a)) + ' ';
    for (const e of v.entries ?? []) if (isAnchorizableBack(e)) prefix += '&' + JSON.stringify(backAnchorBody(e)) + ' ';
    return prefix + this.node(v, indent);
  }

  node(n: Node, indent: number): string {
    if (n.kind === 'blob') throw new LossyError('a blob has no json5p text form (its bytes live in a file)');
    if (n.meta?.schema !== undefined) throw new LossyError('json5p has no !!<…> schema tag — attach the schema via the meta layer (META.md)');
    if (n.meta?.set === true) throw new LossyError('json5p has no !!set — set semantics come from the meta layer (uniqueItems: true)');
    if (n.kind === 'scalar') {
      if ((n.entries ?? []).filter((e) => !isAnchorizableBack(e)).length > 0) {
        throw new LossyError('a value-plus-fields node (!!var) is not expressible in json5p');
      }
      return scalarTok(n);
    }
    const ents = n.entries.filter((e) => !isAnchorizableBack(e)); // conv backs ride the & prefix
    if (ents.length === 0) return n.array ? '[]' : '{}';
    const owned = ents.filter((e) => e.edge !== 'back');
    const keyed = owned.filter((e) => e.key !== null);
    if (keyed.length > 0 && keyed.length < owned.length) {
      throw new LossyError('a container mixing keyed and keyless entries (!!mix) is not expressible in json5p');
    }
    const asArray = owned.length > 0 ? keyed.length === 0 : n.array === true;
    const pad = ' '.repeat(indent);
    const inner = ' '.repeat(indent + STEP);
    const items = ents.map((e) => {
      const lead = this.comments ? leadingOf(e).map((c) => inner + commentText(c) + '\n').join('') : '';
      // a trailing comment rides the entry as a BLOCK comment so the joining comma stays
      // outside it (a `//` line comment would swallow the comma)
      const trail = this.comments ? trailingOf(e) : undefined;
      return lead + inner + this.entry(e, asArray, indent + STEP) + (trail ? ' ' + blockComment(trail.text) : '');
    });
    return (asArray ? '[' : '{') + '\n' + items.join(',\n') + '\n' + pad + (asArray ? ']' : '}');
  }

  entry(e: Entry, inArray: boolean, indent: number): string {
    if (e.key === null && e.edge === 'back') {
      // a RELATIVE-scoped keyless back member keeps `~*'…'` (see isAnchorizableBack)
      if (!isPointer(e.value)) throw new LossyError('a keyless back-edge ("~") must hold a pointer');
      return '~' + ptr(e.value);
    }
    if (e.key === null) return this.value(e.value, indent);
    if (inArray) throw new LossyError(`a keyed entry ("${e.key}") cannot live in a json5p array`);
    return (e.edge === 'back' ? '~' : '') + keyText(e.key) + ': ' + this.value(e.value, indent);
  }
}

// ---- comments ------------------------------------------------------------------

function leadingOf(e: Entry): Comment[] {
  return (e.meta?.comments ?? []).filter((c) => c.placement === 'leading');
}
function trailingOf(e: Entry): Comment | undefined {
  return (e.meta?.comments ?? []).find((c) => c.placement === 'trailing');
}
// Block fences built by concatenation — a literal `/*`…`*/` in source trips the type stripper.
const BO = '/' + '*';
const BC = '*' + '/';

/** Own-line rendering: `//…` for a line comment, a slash-star block for a block one. */
function commentText(c: Comment): string {
  return c.style === 'block' ? `${BO} ${c.text.trim()} ${BC}` : '//' + c.text;
}
/** Inline (trailing) form — always a block, so the joining comma stays outside it. */
function blockComment(text: string): string {
  return `${BO} ${text.trim()} ${BC}`;
}

// ---- tokens --------------------------------------------------------------------

function ptr(p: Pointer): string {
  // canonical colon form inside the JSON string (the dual window's emission side)
  return '*' + JSON.stringify(renderPointer(p));
}

function keyText(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function scalarTok(s: Scalar): string {
  const v = s.value;
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  // number: keep the source spelling (hex, +Infinity, …) when it still reads back the same
  const raw = s.raw.trim();
  if (raw !== '' && Object.is(json5number(raw), v)) return raw;
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  return String(v);
}

/** Mirror of the parser's number recognizer (json5p.ts). */
function json5number(tok: string): number | undefined {
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(tok)) return Number(tok);
  if (/^[+-]?Infinity$/.test(tok)) return tok[0] === '-' ? -Infinity : Infinity;
  if (/^[+-]?NaN$/.test(tok)) return NaN;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(tok)) return Number(tok);
  return undefined;
}
