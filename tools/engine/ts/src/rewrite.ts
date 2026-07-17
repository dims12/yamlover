// Surgical pointer rewriting (ENGINE.md mediated tier; PLAN.md 3e). Given a move
// oldStore → newStore (store paths like '/dir/file.md'), plan the SOURCE-TEXT edits
// that retarget every inbound `*`/`~` pointer — replacing exactly the deref token at
// its recorded span, never re-rendering the file (comments and formatting survive).
// Pure: no filesystem access; `mv.ts` applies the plan.

import * as path from 'node:path';
import type { Document, Pointer } from '../../../parser/ts/src/ir.ts';
import { escapeSegment, parsePointer, renderPointer } from '../../../parser/ts/src/pointer.ts';
import { pointerToken, anchorToken } from '../../../parser/ts/src/serialize-yamlover.ts';
import type { ResolvedEdge } from './resolve.ts';

export interface TextEdit { start: number; end: number; text: string }
export interface RewrittenRef { file: string; from: string; oldRaw: string; newRaw: string }
export interface UnrewrittenRef { file: string; from: string; raw: string; reason: string }

export interface RewritePlan {
  /** Edits grouped by source file (the span's uri — an absolute path). */
  edits: Map<string, TextEdit[]>;
  rewritten: RewrittenRef[];
  unrewritten: UnrewrittenRef[];
}

/** Boundary-aware "p is at or under x" over store paths (colon-form, root ':'). */
export function under(p: string, x: string): boolean {
  if (x === ':') return true; // every store path is under the root
  return p === x || p.startsWith(x + ':') || p.startsWith(x + '[');
}

/** Plan the edits that retarget every pointer whose target sits at or under `oldStore`.
 *  `opts.root` (absolute) guards against editing grafted files outside the served tree. */
export function planRewrites(
  doc: Document,
  edges: ResolvedEdge[],
  oldStore: string,
  newStore: string,
  opts: { root?: string } = {},
): RewritePlan {
  const mapPath = (p: string): string => (under(p, oldStore) ? newStore + p.slice(oldStore.length) : p);
  const plan: RewritePlan = { edits: new Map(), rewritten: [], unrewritten: [] };

  for (const e of edges) {
    if (e.target.kind !== 'node' || !under(e.target.path, oldStore)) continue;

    const miss = (reason: string): void => {
      plan.unrewritten.push({ file: e.ptr.span?.uri ?? '<unknown>', from: e.from, raw: e.raw, reason });
    };
    if (e.anchor) {
      // a `&` path anchor whose CONTAINER moved: rebuild the path portion of the token —
      // an anchor's relative scopes resolve from the holder's PARENT — then re-attach the
      // key / `[]` tail. The whole `&…` token sits at the recorded span.
      const span = e.ptr.span;
      if (!span) { miss('anchor has no source span'); continue; }
      if (opts.root !== undefined && path.relative(opts.root, span.uri).startsWith('..')) {
        miss('source file is outside the served root (grafted)');
        continue;
      }
      const holder = mapPath(e.holder);
      const docRoot = mapPath(e.docRoot);
      const container = mapPath(e.target.path);
      let cRaw: string | null = null;
      switch (e.ptr.base.scope) {
        case 'link':
          cRaw = '//' + renderSuffix('/', container).replace(/^\//, '');
          break;
        case 'document':
          cRaw = under(container, docRoot) ? docForm(docRoot, container) : null;
          break;
        case 'current': {
          const p = parentOf(holder);
          if (p !== null && under(container, p)) cRaw = renderSuffix(p, container).replace(/^\//, '');
          else if (under(container, docRoot)) cRaw = docForm(docRoot, container);
          break;
        }
        case 'parent': {
          const p1 = parentOf(holder);
          const p2 = p1 === null ? null : parentOf(p1);
          if (p2 !== null && under(container, p2)) cRaw = '..' + suffixAfter(p2, container);
          else if (under(container, docRoot)) cRaw = docForm(docRoot, container);
          break;
        }
      }
      if (cRaw === null) { miss("anchor container left the holder's document"); continue; }
      let newBody = e.label != null
        ? (cRaw === '' ? '' : cRaw === '/' ? '/' : cRaw + '/') + escapeSegment(e.label)
        : cRaw + '[]';
      const tail = newBody.endsWith('[]') ? '[]' : '';
      newBody = matchStyle(newBody.slice(0, newBody.length - tail.length), e.raw) + tail;
      if (newBody === e.raw.slice(1)) continue; // the authored spelling survived the move
      const tok = isJson5pUri(span.uri) ? json5pAnchorToken(newBody) : anchorToken(newBody);
      const list = plan.edits.get(span.uri) ?? [];
      list.push({ start: span.start, end: span.end, text: tok });
      plan.edits.set(span.uri, list);
      plan.rewritten.push({ file: span.uri, from: e.from, oldRaw: e.raw, newRaw: '&' + newBody });
      continue;
    }
    // holder and target moved together: a current-scoped spelling (or a document-scoped
    // one whose document root rides along) never names the moved root, so the authored
    // raw — including a spelling through an anchor-created key — survives verbatim
    if (under(e.holder, oldStore) &&
        (e.ptr.base.scope === 'current' || (e.ptr.base.scope === 'document' && under(e.docRoot, oldStore)))) {
      continue;
    }
    const span = e.ptr.span;
    if (!span) { miss('pointer has no source span'); continue; }
    if (opts.root !== undefined && path.relative(opts.root, span.uri).startsWith('..')) {
      miss('source file is outside the served root (grafted)');
      continue;
    }

    // map every frame through the move, so refs FROM inside a moved subtree work too
    const holder = mapPath(e.holder);
    const docRoot = mapPath(e.docRoot);
    const target = mapPath(e.target.path);

    let newRaw: string | null = null;
    switch (e.ptr.base.scope) {
      case 'link':
        newRaw = '//' + renderSuffix('/', target).replace(/^\//, ''); // project-root relative
        break;
      case 'document':
        newRaw = under(target, docRoot) ? docForm(docRoot, target) : null;
        break;
      case 'current':
        if (under(target, holder) && target !== holder) newRaw = relForm(holder, target);
        else if (under(target, docRoot)) newRaw = docForm(docRoot, target); // scope-form fallback
        break;
      case 'parent': {
        const p = parentOf(holder);
        if (p !== null && under(target, p)) newRaw = '..' + suffixAfter(p, target);
        else if (under(target, docRoot)) newRaw = docForm(docRoot, target);
        break;
      }
    }
    if (newRaw === null) { miss("target left the holder's document"); continue; }
    newRaw = matchStyle(newRaw, e.raw); // colon-authored files get colon rewrites
    if (newRaw === e.raw) continue; // the relative form survived the move — nothing to edit

    const token = isJson5pUri(span.uri) ? json5pToken(newRaw) : pointerToken(newRaw);
    const list = plan.edits.get(span.uri) ?? [];
    list.push({ start: span.start, end: span.end, text: token });
    plan.edits.set(span.uri, list);
    plan.rewritten.push({ file: span.uri, from: e.from, oldRaw: e.raw, newRaw });
  }
  return plan;
}

/** Apply edits to one file's text: descending offset order; overlaps are an error. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start) {
      throw new Error(`overlapping edits at ${sorted[i].start}..${sorted[i].end} and ${sorted[i - 1].start}..`);
    }
  }
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** The path a pointer NOMINALLY addresses (its frames + steps, no graph lookup), or null
 *  for anchor-named pointers. Used by relink: after an unmediated move the stale pointer
 *  no longer resolves, but its nominal path still says where it MEANT to point. */
export function nominalPath(doc: Document, e: ResolvedEdge): string | null {
  if (e.anchor) return null; // anchor edges: container relink is PLAN.md A4
  let base: string;
  switch (e.ptr.base.scope) {
    case 'link': base = ':' + e.ptr.base.authority; break;
    case 'document': base = e.docRoot; break;
    case 'current': base = e.holder; break;
    case 'parent': base = parentOf(e.holder) ?? '/'; break;
  }
  let p = base === ':' ? '' : base;
  for (const st of e.ptr.steps) {
    if (st.sel === 'parent') {
      const up = parentOf(p === '' ? ':' : p);
      if (up === null) return null;
      p = up === ':' ? '' : up;
    } else if (st.sel === 'key') p += ':' + st.name;
    else if (st.sel === 'index') p += '[' + st.n + ']';
    else return null; // a relative index has no canonical store path (host-frame; MARKLOWER.md)
  }
  return p === '' ? ':' : p;
}

// ---- helpers ---------------------------------------------------------------------

/** Tokens of a store path: keys and [n] indexes. (Keys containing `:`/`[`/`]` would be
 *  ambiguous in store paths themselves — a known limitation, inherited from the `/` era.) */
function tokensOf(p: string): { key?: string; n?: number }[] {
  const out: { key?: string; n?: number }[] = [];
  const re = /\[(\d+)\]|:([^:[]*)/g;
  for (let m = re.exec(p); m !== null; m = re.exec(p)) {
    if (m[1] !== undefined) out.push({ n: Number(m[1]) });
    else if (m[2] !== '') out.push({ key: m[2] });
  }
  return out;
}

function parentOf(p: string): string | null {
  if (p === ':' || p === '') return null;
  const toks = tokensOf(p).slice(0, -1);
  if (toks.length === 0) return ':';
  return renderPath(toks);
}

function renderPath(toks: { key?: string; n?: number }[]): string {
  let s = '';
  for (const t of toks) s += t.key !== undefined ? ':' + t.key : '[' + t.n + ']';
  return s === '' ? ':' : s;
}

/** Render the remainder of `p` below `base` as pointer-path text: `key` segments are
 *  metachar-escaped, `[n]` ride verbatim; segments joined the pointer way. */
function renderSuffix(base: string, p: string): string {
  const toks = tokensOf(p).slice(base === ':' ? 0 : tokensOf(base).length);
  let s = '';
  for (const t of toks) s += t.key !== undefined ? '/' + escapeSegment(t.key) : '[' + t.n + ']';
  return s;
}

/** Document-scope raw: `/a/b`, `/[0]/x`, or `/` for the root itself. */
function docForm(docRoot: string, target: string): string {
  const s = renderSuffix(docRoot, target);
  return s === '' ? '/' : s.startsWith('/') ? s : '/' + s;
}

/** Current-scope raw (a path from the holder): `a/b[0]` — never empty (caller ensures). */
function relForm(holder: string, target: string): string {
  return renderSuffix(holder, target).replace(/^\//, '');
}

/** Parent-scope suffix after `..`: '', '/a/b', or '[0]…'. */
function suffixAfter(base: string, target: string): string {
  return renderSuffix(base, target);
}

function isJson5pUri(uri: string): boolean {
  return /\.(json|json5|json5p)$/i.test(uri);
}

function json5pToken(raw: string): string {
  return `*'${raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Re-render a freshly built (slash-form) raw in the ORIGINAL token's style: a
 *  colon-authored pointer/anchor gets a colon rewrite, a legacy one stays slash —
 *  surgical edits preserve the file's spelling through the dual window. */
function matchStyle(slashRaw: string, originalRaw: string): string {
  if (!originalRaw.includes(':')) return slashRaw;
  try {
    return renderPointer(parsePointer(slashRaw));
  } catch {
    return slashRaw;
  }
}

function json5pAnchorToken(body: string): string {
  return `&'${body.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
