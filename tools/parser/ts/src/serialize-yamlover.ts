// IR → yamlover text (PLAN.md 2d). FREE-FORM canonical emission: the IR keeps the graph,
// not the typography (comments, quote styles and block-scalar layout are not stored —
// IR.md), so the output is a clean re-rendering whose reparse is IR-EQUAL to the input:
// same values, entry order, keys, edge kinds, pointer texts (verbatim `raw`), anchors,
// `!!set` and `!!<…>` schema tags. The no-op shape tags `!!mix` (a mixed keyed+keyless
// container) and `!!var` (a scalar-plus-fields) are NOT emitted — omni is the default, so an
// untagged mixture reparses to the same IR (YAMLOVER.md §4). Inexpressible content — blobs,
// non-finite numbers, an anchored document
// root — raises LossyError: refuse, never drop. (Blobs are refused only for now: the IR
// carries the content HASH, not the bytes; once a byte source is wired in, a blob can
// emit INLINE as base64 — META.md `type: binary` — the same node in a different concrete.)

import type { Document, Node, Entry, Value, Scalar, Pointer, Comment } from './ir.ts';
import { isPointer } from './ir.ts';
import { foldLines, plainScalar, splitKV, unquoteKey } from './yamlover.ts';
import { renderPointer } from './pointer.ts';
import { LossyError, anchorBody, dq, flowKeyText, isAnchorizableBack, backAnchorBody, keyText } from './serialize-common.ts';
import { json5pSubtree } from './serialize-json5p.ts';

const STEP = 2;

/** An inline concrete switch (`NodeMeta.concrete === 'json5p'` — a flow token that SPANS lines) as
 *  its K&R lines, or null when json5p cannot hold the subtree (a `!!<…>` tag, `!!set`, an omni
 *  value-plus-fields, a keyed+keyless mixture, a blob). Null ⇒ the caller writes block form, the
 *  same graceful degradation {@link flowTextOrNull} gives when flow refuses a value. */
function json5pLines(value: Node, indent: number): string[] | null {
  if (value.meta?.concrete !== 'json5p') return null;
  // An anchor ON THE SWITCH ITSELF would be emitted twice — inline by the json5p emitter and again
  // as a yamlover anchor line by the caller. Block form carries it once, so refuse. (Anchors DEEPER
  // in the subtree are the json5p emitter's alone and ride along fine.)
  if ((value.meta?.anchors?.length ?? 0) > 0 || (value.entries ?? []).some(isAnchorizableBack)) return null;
  try {
    return json5pSubtree(value, indent).split('\n');
  } catch (e) {
    if (e instanceof LossyError) return null;
    throw e;
  }
}

/** Emit options. `comments` re-emits the retained comments (IR.md); off by default, so the
 *  output stays byte-identical to a comment-free serialization. */
export interface SerializeOpts { comments?: boolean }

export function serializeYamlover(doc: Document, opts?: SerializeOpts): string {
  return new Emitter(doc, opts).serialize();
}

class Emitter {
  out: string[] = [];
  doc: Document;
  comments: boolean;

  constructor(doc: Document, opts?: SerializeOpts) {
    this.doc = doc;
    this.comments = opts?.comments ?? false;
  }

  serialize(): string {
    const root = this.doc.root;
    if (root.kind === 'blob') throw new LossyError('a blob has no yamlover text form (its bytes live in a file)');
    if (this.comments && (this.doc.head?.length ?? 0) > 0) {
      for (const c of this.doc.head!) this.out.push('#' + c.text);
      this.out.push(''); // blank line sets the head banner off from the body (round-trips as head)
    }
    if (root.meta?.schema !== undefined) this.out.push(schemaTagToken(root.meta.schema));
    const ents = root.entries ?? [];
    const kept = ents.filter((e) => !isAnchorizableBack(e)); // conv backs re-emit as anchors
    if (root.kind === 'scalar') {
      // A root omni self-value is written among its entries at its AUTHORED position (`meta.selfAt`,
      // 0 = first) — order-preserving, though the value stays positionless DATA. The omni SHAPE
      // needs no tag (omni is the default), but the SEMANTIC tags (`!!yo`, `!!set`) ride their own
      // lone line first — the "lone tag marks the document root" form; a multi-line value becomes a
      // block scalar (see `selfLine`), a single-line one stays inline.
      for (const tag of this.containerTags(root)) this.out.push(tag);
      const at = Math.min(root.meta?.selfAt ?? 0, ents.length);
      this.entries(ents.slice(0, at), 0);
      this.selfLine(root, 0);
      this.rootAnchors(root);
      this.entries(ents.slice(at), 0);
    } else if (kept.length === 0) {
      // the semantic container tags (`!!yo`, `!!set`) ride their own lines here too — an
      // emptied tagged root (a cleared data island) must not shed its identity
      for (const tag of this.containerTags(root)) this.out.push(tag);
      this.out.push(root.array ? '[]' : '{}');
      this.rootAnchors(root);
    } else if (root.meta?.schema === undefined && root.meta?.yo !== true && root.meta?.set !== true && json5pLines(root, 0) !== null) {
      // a whole DOCUMENT written as a K&R token — an inline concrete switch at the root
      for (const l of json5pLines(root, 0)!) this.out.push(l);
      this.rootAnchors(root);
    } else if (root.meta?.style === 'flow' && root.meta?.schema === undefined && flowTextOrNull(root) !== null) {
      // a whole DOCUMENT authored as one flow token (`[12, 13, 14]`, `{a: 1}`) stays one line
      this.out.push(flowTextOrNull(root)!);
      this.rootAnchors(root);
    } else {
      for (const tag of this.containerTags(root)) this.out.push(tag);
      this.rootAnchors(root);
      this.entries(ents, 0);
    }
    // comments with no entry to host them (after the last entry, trailing-of-file)
    if (this.comments) for (const c of root.meta?.comments ?? []) this.out.push('#' + c.text);
    return this.out.join('\n') + '\n';
  }

  /** Root anchors go on their own lines (there is no key line to share) — the node's own
   *  `&` anchors plus its deprecated `~` back entries re-emitted in anchor form. Own-line
   *  colon-form anchors ride UNQUOTED (the token runs to end of line). */
  rootAnchors(root: Node): void {
    for (const t of this.anchorTokens(root, /*ownLine*/ true)) this.out.push(t);
  }

  /** Every anchor token a node carries: meta anchors + anchorizable `~` back entries
   *  (ANCHOR_REFACTOR — serializers emit anchors, never `~`, for absolute scopes).
   *  `ownLine` tokens run to EOL so colon bodies ride bare; same-line tokens (the
   *  decorations on a key line) quote them (SEPARATOR.md M3). */
  anchorTokens(node: Node, ownLine = false): string[] {
    const bodies = (node.meta?.anchors ?? []).map(anchorBody);
    for (const e of node.entries ?? []) if (isAnchorizableBack(e)) bodies.push(backAnchorBody(e));
    return bodies.map((b) => (ownLine ? '&' + b : anchorToken(b)));
  }

  entries(ents: Entry[], indent: number): void {
    const pad = ' '.repeat(indent);
    for (const e of ents) {
      if (this.comments) {
        // a BLANK source line before the entry (or before its leading-comment block) is part
        // of the retained typography — re-emit it so blankBefore round-trips like the texts
        const lead = leadingOf(e);
        const blank = (e.meta as { blankBefore?: boolean } | undefined)?.blankBefore === true || lead[0]?.blankBefore === true;
        if (blank && this.out.length > 0 && this.out[this.out.length - 1] !== '') this.out.push('');
        for (const c of lead) this.out.push(pad + '#' + c.text);
      }
      const before = this.out.length;
      if (isAnchorizableBack(e)) {
        continue; // re-emitted as an `&` anchor in decorations()/rootAnchors(), not as `~`
      } else if (e.key === null && e.nullKey !== true && e.edge === 'back') {
        // a RELATIVE-scoped keyless back-edge keeps the `~-` spelling (see isAnchorizableBack)
        if (!isPointer(e.value)) throw new LossyError('a keyless back-edge ("~-") must hold a pointer');
        this.out.push(`${pad}~- *${this.ptrText(e.value)}`);
      } else if (e.nullKey === true) {
        // the NULL KEY: canonical emission `~:` (the empty `: v` spelling reads as an alias)
        this.keyed('~:', e.value, indent);
      } else if (e.key === null) {
        this.seqItem(e.value, indent);
      } else {
        const head = (e.edge === 'back' ? '~' : '') + (authoredKey(e) ?? keyText(e.key)) + ':';
        this.keyed(head, e.value, indent);
      }
      if (this.comments) this.emitTrailing(e, indent, before);
    }
  }

  /** A `trailing` comment rides the entry's line when the entry emitted a single line;
   *  otherwise (a block scalar / nested block) it falls to its own line below — never lost. */
  emitTrailing(e: Entry, indent: number, before: number): void {
    const t = (e.meta?.comments ?? []).find((c) => c.placement === 'trailing');
    if (!t) return;
    if (this.out.length === before + 1 && !this.out[before].includes('\n')) {
      this.out[before] += ' #' + t.text;
    } else {
      this.out.push(' '.repeat(indent) + '#' + t.text);
    }
  }

  /** The self-value of an omni scalar as a BARE line (or block-scalar lines) at `indent` — used
   *  when the value sits AMONG the entries at its authored position (`meta.selfAt`), rather than
   *  folded onto a `key:`/`- ` head. A multi-line value becomes a block scalar (content one STEP
   *  deeper, so a dedent back to `indent` ends it and the following entries resume). */
  selfLine(v: Scalar, indent: number): void {
    const pad = ' '.repeat(indent);
    const block = typeof v.value === 'string' ? blockOf(v) : null;
    if (block !== null) {
      this.out.push(pad + block.header);
      for (const l of block.lines) this.out.push(l === '' ? '' : ' '.repeat(indent + STEP) + l);
    } else {
      this.out.push(pad + this.inline(v, /*needToken*/ true));
    }
  }

  /** A container's LEFTOVER comments — own-line remarks after its last entry, attached to
   *  the node meta (comments.ts tail rule) — re-emitted inside the block, at the block's own
   *  indent, so the round-trip re-attaches them identically. */
  tailComments(value: Value, indent: number): void {
    if (!this.comments || isPointer(value)) return;
    const pad = ' '.repeat(indent);
    for (const c of (value.meta?.comments ?? []).filter((x) => x.placement === 'leading')) {
      this.out.push(pad + '#' + c.text);
    }
  }

  /** Emit `head <value>` at `indent` — `head` is `key:`, `~key:`, or the `-` seq marker
   *  (their value/indent grammar is identical: a deeper block belongs to the entry). */
  keyed(head: string, value: Value, indent: number): void {
    this.keyedInner(head, value, indent);
    this.tailComments(value, indent + STEP);
  }

  keyedInner(head: string, value: Value, indent: number): void {
    const pad = ' '.repeat(indent);
    if (isPointer(value)) {
      this.out.push(`${pad}${head} *${this.ptrText(value)}`);
      return;
    }
    if (value.kind === 'blob') throw new LossyError('a blob has no yamlover text form (its bytes live in a file)');
    const parts = this.decorations(value);
    const ents = value.entries ?? [];
    const kept = ents.filter((e) => !isAnchorizableBack(e)); // conv backs ride `parts` as anchors
    if (value.kind === 'scalar' && (value.meta?.selfAt ?? 0) > 0 && kept.length > 0) {
      // the self-value was authored AMONG the fields (`meta.selfAt`), not on the key line: emit a
      // bare head, then the fields with the value line interleaved at its position (order-preserving)
      const inner = indent + STEP;
      const at = Math.min(value.meta!.selfAt!, ents.length);
      this.out.push(joinLine(pad + head, parts));
      this.entries(ents.slice(0, at), inner);
      this.selfLine(value, inner);
      this.anchorLines(value, inner);
      this.entries(ents.slice(at), inner);
    } else if (value.kind === 'scalar') {
      const block = typeof value.value === 'string' ? blockOf(value as Scalar) : null;
      if (block !== null) {
        // block-scalar content sits DEEPER than any fields, so the fields'
        // dedent ends the block (the parser's rule) while staying deeper than the key
        const inner = indent + STEP + (kept.length > 0 ? STEP : 0);
        this.out.push(joinLine(pad + head, [...parts, block.header]));
        for (const l of block.lines) this.out.push(l === '' ? '' : ' '.repeat(inner) + l);
        // (anchors follow below, after the block — the dedent ends the scalar)
      } else {
        const tok = this.inline(value, /*needToken*/ kept.length > 0 || parts.length > 0);
        this.out.push(joinLine(pad + head, tok === '' ? parts : [...parts, tok]));
      }
      this.anchorLines(value, indent + STEP);
      this.entries(ents, indent + STEP);
    } else if (kept.length === 0) {
      this.out.push(joinLine(pad + head, [...parts, value.array ? '[]' : '{}']));
      this.anchorLines(value, indent + STEP);
    } else if (this.flowLine(pad + head, value, parts, indent)) {
      // an AUTHORED flow container rides the key line as one token — nothing further to emit
    } else {
      this.out.push(joinLine(pad + head, parts));
      this.anchorLines(value, indent + STEP);
      this.entries(ents, indent + STEP);
    }
  }

  /** Emit `head [1, 2]` when the node was AUTHORED in flow form and flow can still hold it
   *  losslessly (`flowTextOrNull`). False ⇒ nothing was emitted and the caller writes block form,
   *  which is how a flow container that has since grown an anchor, a tag or a multiline value
   *  degrades gracefully instead of producing invalid source. */
  flowLine(head: string, value: Node, parts: string[], indent: number): boolean {
    // an inline concrete switch first: it spans lines, so its opener rides the head and its
    // remaining lines (already padded by the json5p emitter) follow verbatim
    const kr = json5pLines(value, indent);
    if (kr !== null) {
      this.out.push(joinLine(head, [...parts, kr[0]]));
      for (const l of kr.slice(1)) this.out.push(l);
      return true;
    }
    if (value.meta?.style !== 'flow') return false;
    const tok = flowTextOrNull(value);
    if (tok === null) return false;
    this.out.push(joinLine(head, [...parts, tok]));
    return true;
  }

  seqItem(value: Value, indent: number): void {
    this.seqItemInner(value, indent);
    this.tailComments(value, indent + STEP);
  }

  seqItemInner(value: Value, indent: number): void {
    const pad = ' '.repeat(indent);
    if (!isPointer(value) && value.kind === 'mapping') {
      const parts = this.decorations(value);
      const ents = value.entries;
      const kept = ents.filter((e) => !isAnchorizableBack(e));
      if (kept.length === 0) {
        this.out.push(joinLine(pad + '-', [...parts, value.array ? '[]' : '{}']));
        this.anchorLines(value, indent + STEP);
        return;
      }
      if (this.flowLine(pad + '-', value, parts, indent)) return; // `- [1, 2]`, or a K&R block
      const anchored = this.anchorTokens(value).length > 0;
      if (parts.length === 0 && !anchored && (kept[0].key !== null || kept[0].nullKey === true || kept[0].edge === 'contain')) {
        // compact `- key: …` / `- - item`: render the entries, then fold the first line onto
        // the dash (STEP === the `- ` marker width, so the columns line up exactly). A keyless
        // first entry folds only when it is containment — a leading `~-` back-edge stays block.
        const at = this.out.length;
        this.entries(ents, indent + STEP);
        this.out[at] = pad + '- ' + this.out[at].slice(indent + STEP);
        return;
      }
      this.out.push(joinLine(pad + '-', parts)); // a bare `-` (a `!!set` seq item keeps its tag)
      this.anchorLines(value, indent + STEP);
      this.entries(ents, indent + STEP);
      return;
    }
    this.keyed('-', value, indent);
  }

  /** Value-position prefixes, in the parser's reading order: the `!!<…>` schema, `!!yo`
   *  (plain-yamlover, exempt from the enclosing schema) and `!!set` — the shape tags with
   *  semantics (omni/`!!mix` is the default and is never emitted).
   *  Anchors are NOT here — canonical style (SEPARATOR.md M3) puts them on own lines. */
  decorations(node: Node): string[] {
    const parts: string[] = [];
    if (node.meta?.schema !== undefined) parts.push(schemaTagToken(node.meta.schema));
    parts.push(...this.containerTags(node));
    return parts;
  }

  /** The canonical anchor placement: own lines at `indent`, right after the value line
   *  (SEPARATOR.md M3 — `path: 12` then `  &: another: path`). */
  anchorLines(node: Node, indent: number): void {
    const pad = ' '.repeat(indent);
    for (const t of this.anchorTokens(node, /*ownLine*/ true)) this.out.push(pad + t);
  }

  containerTags(node: Node): string[] {
    // `!!yo` and `!!set` carry semantics and are emitted; `!!mix` (a mixed keyed+keyless
    // container) is the DEFAULT shape (omni-by-default, YAMLOVER.md §4), so it is never
    // emitted — an untagged mixture parses back to the same IR. `!!var`/`!!omni` are read as
    // deprecated aliases of `!!yo` and re-emit as `!!yo`.
    const tags: string[] = [];
    if (node.meta?.yo === true) tags.push('!!yo');
    if (node.meta?.set === true) tags.push('!!set');
    return tags;
  }

  /** A single-line scalar token (never contains a newline — multiline strings go through
   *  blockLines or the double-quoted fallback). `needToken`: an empty rendering (`key:`)
   *  is not available — e.g. omni fields follow, which would otherwise become the value. */
  inline(s: Scalar, needToken: boolean): string {
    const v = s.value;
    if (v === null) {
      // the null twin of the number-raw rule: an authored null SPELLING (`~`, `null`, …)
      // re-emits verbatim — `a: ~` stays `a: ~`, never silently thins to `a:`. A MINTED
      // null (the wire's bare `key:` — yed-load omits the raw) spells the default.
      const raw = typeof s.raw === 'string' ? s.raw.trim() : '';
      if (/^(~|null|Null|NULL)$/.test(raw)) return raw;
      return needToken ? 'null' : '';
    }
    if (typeof v === 'boolean') {
      // the boolean twin of the raw law: an authored casing (`True`, `FALSE`) that reparses
      // to the same boolean re-emits verbatim; a minted boolean spells the default
      const sr = typeof s.raw === 'string' ? s.raw.trim() : '';
      if (sr !== '' && plainToken(sr) && plainScalar(sr).value === v) return sr;
      return v ? 'true' : 'false';
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return nonFinite(v); // YAML float specials: .inf / -.inf / .nan
      // keep the authored spelling (0x1F, 1.0, .5, -0) when it reparses to the same number —
      // Object.is so `-0` keeps its sign (plain `===` treats -0 and 0 as one value). A MINTED
      // number (no raw — a programmatic node) spells the default, like the null twin above.
      const raw = typeof s.raw === 'string' ? s.raw.trim() : '';
      if (raw !== '' && plainToken(raw) && Object.is(plainScalar(raw).value, v)) return raw;
      return Object.is(v, -0) ? '-0' : String(v);
    }
    // the STRING twin of the number/null raw law: an authored one-line SPELLING that provably
    // reparses to the same string re-emits verbatim — quoting is a choice the author made
    // (`'e = mc^2'` stays quoted, a quoted "42" stays a string). Only the three canonical
    // forms are accepted; anything else falls through to the default rendering.
    if (typeof s.raw === 'string' && !s.raw.includes('\n')) {
      const sr = s.raw.trim();
      if (sr === `'${v.replace(/'/g, "''")}'`) return sr;
      if (sr === dq(v)) return sr;
      if (sr !== '' && plainToken(sr) && plainScalar(sr).value === v) return sr;
    }
    if (v === '') return "''";
    if (v.includes('\n') || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) return dq(v);
    if (plainSafe(v)) return v;
    return `'${v.replace(/'/g, "''")}'`;
  }

  ptrText(p: Pointer): string {
    // the dual window emits CANONICAL colon form (spaced) regardless of authoring style
    return pointerToken(renderPointer(p)).slice(1); // pointerToken includes the `*`; head adds it
  }

}

/** The contents of a `!!<…>` tag: a pointer (`*…`) or an inline node. The contents are
 *  reparsed as one-line yamlover, where a leading `{` does NOT reach the flow reader (the
 *  block `key:` split runs first) — so a keyed schema must be the brace-less one-liner
 *  `key: value`, which holds exactly one top-level entry. `>` would close the tag early —
 *  refuse it. Exported for the server's edit layer: an `/api/edit` op's `meta` facet carries
 *  exactly this content (no `!!<…>` wrapper). */
export function schemaText(v: Value): string {
  const text = isPointer(v) ? `*${renderPointer(v)}` : schemaNodeText(v);
  if (/[>\n]/.test(text)) throw new LossyError(`a !!<…> schema tag cannot contain ">" or a newline: ${text}`);
  return text;
}

/** The full `!!<…>` tag token for an attached schema (NodeMeta.schema) — the canonical
 *  rendering of a tag application. Exported for the server's comment sidecar, so the data
 *  view can show a node's authored tag. Throws LossyError on untaggable content. */
export function schemaTagToken(v: Value): string {
  return `!!<${schemaText(v)}>`;
}

// ---- helpers -------------------------------------------------------------------

/** The `leading` comments of an entry, in source order. */
function leadingOf(e: Entry): Comment[] {
  return (e.meta?.comments ?? []).filter((c) => c.placement === 'leading');
}

function joinLine(head: string, parts: string[]): string {
  return parts.length === 0 ? head : head + ' ' + parts.join(' ');
}

/** The full yamlover deref token for a pointer raw: `*` + the raw, quoted only when
 *  outer whitespace could not survive the line (rendered colon raws self-delimit:
 *  spacey keys arrive PORTION-quoted, `#` arrives escaped — both from renderPointer).
 *  Exported for the engine's `mv` ref-rewriter. */
export function pointerToken(raw: string): string {
  if (raw !== raw.trim()) return `*'${raw.replace(/'/g, "''")}'`;
  return '*' + raw;
}

/** The full yamlover anchor token for a path body (`raw` + optional `[]`): `&` + body,
 *  quoted when the plain token would be cut — anchor tokens end at whitespace, so a path
 *  with spaces (e.g. a Cyrillic tag name) needs the quoted form. Exported for `mv`. */
export function anchorToken(body: string): string {
  if (/^['"]/.test(body) || hasUnquotedSpace(body)) return `&'${body.replace(/'/g, "''")}'`;
  return '&' + body;
}

/** Whitespace OUTSIDE quoted portions — a space inside a quoted key rides fine. */
function hasUnquotedSpace(s: string): boolean {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q !== null) { if (c === q) q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === ' ' || c === '\t') return true;
  }
  return false;
}

/** The token is structurally safe in every context we emit (after `key:`, after `- `,
 *  alone on a line): no sigil/marker/comment/kv misreads. Says nothing about what VALUE
 *  it reparses to — see {@link plainSafe} (strings) and the raw check in `inline` (numbers). */
function plainToken(text: string): boolean {
  if (text === '' || text !== text.trim()) return false;
  if ("'\"*&~!|>{[".includes(text[0])) return false; // value-position sigils & quotes
  if (text === '-' || text.startsWith('- ')) return false; // would read as a seq marker
  if (/(^|[ \t])#/.test(text)) return false; // comment stripping
  if (splitKV(text) !== null) return false; // would read as `key: value` in a compact item
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return false;
  return true;
}

/** A string is safe to emit as a PLAIN scalar iff the reparse (in every context we emit)
 *  returns the identical string. */
function plainSafe(text: string): boolean {
  return plainToken(text) && plainScalar(text).value === text;
}

/** Prose folds at this column when the serializer WRAPS a minted string (see foldedLines) —
 *  the source-file measure, independent of any reader's display width. */
const FOLD_WIDTH = 100;

/** The block spelling of a string scalar, by the raw-first law:
 *    1. the AUTHORED block raw (`|`/`>` + content, as blockScalar normalizes it), when it
 *       still reparses to the very value — the string twin of the number-raw rule in inline();
 *    2. a MINTED long one-paragraph string (no raw — the editor drops it on commit) folds
 *       (`>-`/`>`, wrapped at FOLD_WIDTH): the value stays breakless, the file stays readable;
 *    3. a multiline value renders literal (blockLines);
 *    4. null — the caller emits the inline token.
 *  A PARSED scalar always carries its raw, so authored plain/quoted spellings never reflow. */
function blockOf(s: Scalar): { header: string; lines: string[] } | null {
  const v = s.value as string;
  const authored = rawBlock(s);
  if (authored !== null) return authored;
  if ((s.raw ?? '') === '') {
    const folded = foldedLines(v);
    if (folded !== null) return folded;
  }
  return v.includes('\n') ? blockLines(v) : null;
}

/** The authored block raw re-emitted verbatim — iff it reparses to the same value (the
 *  chomping/folding math mirrors the parser's blockScalar, whose raw this is). */
function rawBlock(s: Scalar): { header: string; lines: string[] } | null {
  const raw = s.raw ?? '';
  const nl = raw.indexOf('\n');
  const header = nl < 0 ? raw : raw.slice(0, nl);
  if (!/^[|>][+-]?$/.test(header)) return null;
  const lines = nl < 0 ? [] : raw.slice(nl + 1).split('\n');
  if (lines.length > 0 && /^[ \t]/.test(lines[0])) return null; // the indent base cannot re-anchor
  if (lines.some((l) => l !== '' && /^ +$/.test(l))) return null; // all-space lines reparse as empty
  const folded = header[0] === '>';
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i] !== '') last = i;
  const core = lines.slice(0, last + 1);
  let body = folded ? foldLines(core) : core.join('\n');
  if (chomp === 'keep') body += '\n'.repeat(lines.length - (last + 1) + (last >= 0 ? 1 : 0));
  else if (chomp === 'clip' && last >= 0) body += '\n';
  return body === s.value ? { header, lines } : null;
}

/** A minted long string as a FOLDED block, wrapped at {@link FOLD_WIDTH}. Paragraph gaps
 *  (`\n\n`+) spell as blank lines; a LONE `\n` has no folded spelling — those stay literal.
 *  Null when folding cannot hold the value losslessly: a lone `\n`, a leading blank line or
 *  space/tab (the indent base), 2+ trailing newlines (the literal `|+` territory), or any
 *  wrap the fold would not rejoin to the very body. */
function foldedLines(v: string): { header: string; lines: string[] } | null {
  if (/\r/.test(v)) return null;
  let trailing = 0;
  let end = v.length;
  while (end > 0 && v[end - 1] === '\n') { trailing++; end--; }
  if (trailing > 1) return null;
  const body = v.slice(0, end);
  if (body === '' || body.length <= FOLD_WIDTH) return null;
  if (/(?<!\n)\n(?!\n)/.test(body)) return null; // a lone \n is unspellable folded
  if (body.startsWith('\n')) return null; // a leading blank line — literal territory
  const lines: string[] = [];
  for (const part of body.split(/(\n+)/)) {
    if (part === '') continue;
    if (part[0] === '\n') { for (let i = 1; i < part.length; i++) lines.push(''); continue; }
    if (/^[ \t]/.test(part)) return null; // a paragraph must anchor the indent base
    lines.push(...wrapPara(part));
  }
  if (lines.length < 2) return null; // nothing folded — the inline token is simpler
  // the round-trip guard, absolute: the parser's own fold must give the very body back
  return foldLines(lines) === body ? { header: trailing === 0 ? '>-' : '>', lines } : null;
}

/** Greedy wrap of one paragraph: break at a SINGLE space between non-spaces (folding rejoins
 *  with exactly one space) — the last such point within the width, else the first beyond it;
 *  an unbreakable run simply stays long. */
function wrapPara(para: string): string[] {
  const lines: string[] = [];
  let rest = para;
  while (rest.length > FOLD_WIDTH) {
    let cut = -1;
    for (let i = FOLD_WIDTH; i > 0; i--) {
      if (rest[i] === ' ' && rest[i - 1] !== ' ' && rest[i + 1] !== ' ' && rest[i + 1] !== undefined) { cut = i; break; }
    }
    if (cut < 0) {
      for (let i = FOLD_WIDTH + 1; i < rest.length - 1; i++) {
        if (rest[i] === ' ' && rest[i - 1] !== ' ' && rest[i + 1] !== ' ') { cut = i; break; }
      }
    }
    if (cut < 0) break;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }
  if (rest !== '') lines.push(rest);
  return lines;
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

/** The AUTHORED key token (EntryMeta.keyRaw), if it survives the reparse guard: the token
 *  must still read as this very key (unquoteKey) and still split as a key at all (splitKV)
 *  — a stale or hand-forged raw must never change what the document says. Null: emit
 *  canonically (keyText). */
function authoredKey(e: Entry): string | null {
  const raw = e.meta?.keyRaw;
  if (raw === undefined || e.key === null) return null;
  try { if (unquoteKey(raw) !== e.key) return null; } catch { return null; }
  const sp = splitKV(raw + ': v');
  return sp !== null && sp.key === raw ? raw : null;
}

/** The FLOW-position twin: the raw must also be safe among the flow separators — a quoted
 *  token, a balanced flow token (splitKV consumed it whole above), or a plain token free of
 *  `,`/braces/brackets. A block-only-safe raw (`a,b`) falls back to the canonical flow key. */
function authoredFlowKey(e: Entry): string | null {
  const raw = authoredKey(e);
  if (raw === null) return null;
  if (/^['"[{]/.test(raw)) return raw;
  return /[,{}[\]]/.test(raw) ? null : raw;
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

/** Single-line FLOW rendering for the `!!<…>` tag interior, where there is NO block fallback —
 *  so anything flow cannot hold is an error. Content goes through {@link flowTextOrNull}, which
 *  reports the same refusals as `null` and lets the caller emit block form instead. */
function flowText(n: Node): string {
  const t = flowTextOrNull(n);
  if (t === null) throw new LossyError('this node has no flow form');
  return t;
}

/** Single-line FLOW rendering, or null when flow cannot hold the node LOSSLESSLY.
 *
 *  THE REFUSAL LIST IS A CONTRACT: the projectional editor's `flowFits` mirrors it exactly, so a
 *  container the editor still draws as flow cells is one this can still write. Adding a refusal
 *  here without adding it there makes the screen and the file disagree. */
function flowTextOrNull(n: Node): string | null {
  if (n.kind === 'blob') return null; // a blob's bytes live in a file, not in a token
  if (n.meta?.schema !== undefined || n.meta?.set === true || n.meta?.yo === true) return null; // a tag needs its own line
  // a path anchor has NO flow spelling — emitting the node inline would silently drop it (which
  // is what the tag-interior path did); block form carries it on its own line
  if ((n.meta?.anchors ?? []).length > 0) return null;
  // a LEADING comment has nowhere to live on a one-liner. A trailing one still rides: `emitTrailing`
  // appends it to the single line this returns.
  if ((n.entries ?? []).some((e) => (e.meta?.comments ?? []).some((c) => c.placement !== 'trailing'))) return null;
  if ((n.meta?.comments ?? []).some((c) => c.placement === 'leading')) return null; // a tail comment needs its block
  const ents = n.entries ?? [];
  if (n.kind === 'scalar') {
    if (ents.length > 0) return null; // a value-plus-fields (omni) node needs two lines
    return flowTok(n);
  }
  if (ents.length === 0) return n.array ? '[]' : '{}';
  const keyed = ents.filter((e) => e.key !== null || e.nullKey === true); // the null key is KEYED
  if (keyed.length > 0 && keyed.length < ents.length) return null; // a mixed container has no flow form
  if (ents.some((e) => e.edge === 'back')) return null; // a `~` back-edge is authored on its own line
  const items: string[] = [];
  for (const e of ents) {
    const v = isPointer(e.value) ? flowPtr(e.value) : flowTextOrNull(e.value);
    if (v === null) return null; // one unrepresentable member demotes the whole token
    items.push(e.key === null && e.nullKey !== true ? v : `${e.nullKey === true ? '~' : (authoredFlowKey(e) ?? flowKeyText(e.key!))}: ${v}`);
  }
  return keyed.length === 0 ? `[${items.join(', ')}]` : `{${items.join(', ')}}`;
}

/** The YAML float-special literal for a non-finite number (yamlover follows YAML). */
function nonFinite(v: number): string {
  return Number.isNaN(v) ? '.nan' : v === Infinity ? '.inf' : '-.inf';
}

function flowTok(s: Scalar): string | null {
  const v = s.value;
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return nonFinite(v);
    // Keep the AUTHORED spelling (0xff, 1.0, .5, -0) when it reparses to the same number and holds
    // no flow metachar — the rule `inline()` applies in block form, so a number's representation
    // concrete (repr.ts: yaml/hex, yaml/exp, …) survives a flow round-trip too.
    const raw = (s.raw ?? '').trim();
    if (raw !== '' && !/[,:[\]{}'"#\s]/.test(raw) && plainToken(raw) && Object.is(plainScalar(raw).value, v)) return raw;
    return Object.is(v, -0) ? '-0' : String(v);
  }
  if (v !== '' && /^[^,:[\]{}'"#\s]+$/.test(v) && !'*&~!|>'.includes(v[0]) && plainScalar(v).value === v) return v;
  if (/[\n\r\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) return null; // a control char needs a quoted or block form
  return `'${v.replace(/'/g, "''")}'`;
}

function flowPtr(p: Pointer): string | null {
  // flow plain pointers read to the next , } ] at depth 0 — emit COMPACT colon form;
  // a quoted portion (spacey key) cannot ride plain in flow
  const compact = renderPointer(p, { spaced: false });
  if (/['"\s]/.test(compact)) return null;
  return `*${compact}`;
}

