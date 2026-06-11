// IR → json5p text (PLAN.md 2d). json5p is the smaller full-graph concrete: pointers,
// anchors and back-edges all fit, but yamlover's value-position tags do not — a node
// carrying `!!mix` (keyed+keyless in one container), `!!omni` (value-plus-fields),
// `!!set`, or a `!!<…>` schema raises LossyError (refuse, never drop; such metadata
// routes through the meta layer instead — cf. the note in examples/03-tour.json5p).
// Round-trip contract: parseJson5p(serializeJson5p(doc)) is IR-equal to doc.

import type { Document, Node, Entry, Value, Scalar, Pointer } from './ir.ts';
import { isPointer } from './ir.ts';
import { LossyError, anchorIndex } from './serialize-common.ts';

const STEP = 2;

export function serializeJson5p(doc: Document): string {
  const e = new Emitter(doc);
  const text = e.value(doc.root, 0);
  if (e.pending.size > 0) {
    throw new LossyError(`anchored node(s) not reachable in the tree: &${[...e.pending].join(', &')}`);
  }
  return text + '\n';
}

class Emitter {
  anchorOf: WeakMap<Node, string>;
  pending: Set<string>;

  constructor(doc: Document) {
    this.anchorOf = anchorIndex(doc);
    this.pending = new Set(doc.anchors.keys());
  }

  value(v: Value, indent: number): string {
    if (isPointer(v)) return ptr(v);
    let prefix = '';
    const anchor = this.anchorOf.get(v);
    if (anchor !== undefined) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(anchor)) {
        throw new LossyError(`anchor name "&${anchor}" is not a json5p identifier`);
      }
      prefix = `&${anchor} `;
      this.pending.delete(anchor);
    }
    return prefix + this.node(v, indent);
  }

  node(n: Node, indent: number): string {
    if (n.kind === 'blob') throw new LossyError('a blob has no json5p text form (its bytes live in a file)');
    if (n.meta?.schema !== undefined) throw new LossyError('json5p has no !!<…> schema tag — attach the schema via the meta layer (META.md)');
    if (n.meta?.set === true) throw new LossyError('json5p has no !!set — set semantics come from the meta layer (uniqueItems: true)');
    if (n.kind === 'scalar') {
      if ((n.entries ?? []).length > 0) {
        throw new LossyError('a value-plus-fields node (!!omni) is not expressible in json5p');
      }
      return scalarTok(n);
    }
    const ents = n.entries;
    if (ents.length === 0) return n.array ? '[]' : '{}';
    const owned = ents.filter((e) => e.edge !== 'back');
    const keyed = owned.filter((e) => e.key !== null);
    if (keyed.length > 0 && keyed.length < owned.length) {
      throw new LossyError('a container mixing keyed and keyless entries (!!mix) is not expressible in json5p');
    }
    const asArray = owned.length > 0 ? keyed.length === 0 : n.array === true;
    const pad = ' '.repeat(indent);
    const inner = ' '.repeat(indent + STEP);
    const items = ents.map((e) => inner + this.entry(e, asArray, indent + STEP));
    return (asArray ? '[' : '{') + '\n' + items.join(',\n') + '\n' + pad + (asArray ? ']' : '}');
  }

  entry(e: Entry, inArray: boolean, indent: number): string {
    if (e.key === null && e.edge === 'back') {
      // `~*'…'` — a keyless back member (reverse positional membership), legal in both forms
      if (!isPointer(e.value)) throw new LossyError('a keyless back-edge ("~") must hold a pointer');
      return '~' + ptr(e.value);
    }
    if (e.key === null) return this.value(e.value, indent);
    if (inArray) throw new LossyError(`a keyed entry ("${e.key}") cannot live in a json5p array`);
    return (e.edge === 'back' ? '~' : '') + keyText(e.key) + ': ' + this.value(e.value, indent);
  }
}

// ---- tokens --------------------------------------------------------------------

function ptr(p: Pointer): string {
  return '*' + JSON.stringify(p.raw);
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
