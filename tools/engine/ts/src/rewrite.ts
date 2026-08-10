// Surgical pointer rewriting (ENGINE.md mediated tier; PLAN.md 3e). Given a move
// oldStore → newStore (store paths like ':dir:file.md'), plan the SOURCE-TEXT edits
// that retarget every inbound `*`/`~` pointer — replacing exactly the deref token at
// its recorded span, never re-rendering the file (comments and formatting survive).
// Rewrites are emitted in colon form only (the slash separator is dead —
// docs/language/pointers/paths), keeping the authored token's spacing style.
// Pure: no filesystem access; `mv.ts` applies the plan.

import * as path from 'node:path';
import type { Document, Pointer, PointerBase, Step } from '../../../parser/ts/src/ir.ts';
import { renderPointer } from '../../../parser/ts/src/pointer.ts';
import { pathOfSegs, segsOfPath, segToken } from '../../../parser/ts/src/pathseg.ts';
import { pointerToken, anchorToken } from '../../../parser/ts/src/serialize-yamlover.ts';
import type { ResolvedEdge, TextLinkRef } from './resolve.ts';
import { linkTargets } from '../../../parser/ts/src/marklower-links.ts';

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
  return p === x || p.startsWith(x + ':');
}

/** Plan the edits that retarget every pointer whose target sits at or under `oldStore`.
 *  `opts.root` (absolute) guards against editing grafted files outside the served tree.
 *  `opts.textLinks` (resolve.ts scanTextLinks) are the marklower prose links — engine-owned
 *  like yamlover, so a stranded one is REWRITTEN in place when `opts.read` supplies the
 *  source text to locate the authored token in; without a reader (or a span) it is
 *  REPORTED in `unrewritten` instead of being silently dropped (the mv.ts promise). */
export function planRewrites(
  doc: Document,
  edges: ResolvedEdge[],
  oldStore: string,
  newStore: string,
  opts: { root?: string; textLinks?: TextLinkRef[]; read?: (uri: string) => string } = {},
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
      let cPtr: Pointer | null = null;
      switch (e.ptr.base.scope) {
        case 'link':
          cPtr = linkPtr(container);
          break;
        case 'document':
          cPtr = under(container, docRoot) ? docPtr(docRoot, container) : null;
          break;
        case 'current': {
          const p = parentOf(holder);
          if (p !== null && under(container, p)) cPtr = ptr({ scope: 'current' }, stepsBelow(p, container));
          else if (under(container, docRoot)) cPtr = docPtr(docRoot, container);
          break;
        }
        case 'parent': {
          const p1 = parentOf(holder);
          const p2 = p1 === null ? null : parentOf(p1);
          if (p2 !== null && under(container, p2)) cPtr = ptr({ scope: 'parent' }, stepsBelow(p2, container));
          else if (under(container, docRoot)) cPtr = docPtr(docRoot, container);
          break;
        }
      }
      // no relative spelling reaches the container — escalate to the project-root form
      // rather than refuse: an expressible ref is NEVER left stale (the committer's
      // labor survives the move, re-rooted)
      if (cPtr === null) cPtr = linkPtr(container);
      if (cPtr === null) { miss('anchor container has no project-root spelling'); continue; }
      // COMPACT colon rendering: an anchor token ends at whitespace in inline positions,
      // so the spaceless spelling stays a single token anywhere without quoting.
      const newBody = e.label != null
        ? renderPointer(ptr(cPtr.base, [...cPtr.steps, { sel: 'key', name: e.label }]), { spaced: false })
        : renderPointer(cPtr, { spaced: false }) + ':-'; // the trailing keyless segment (compact)
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

    let newPtr: Pointer | null = null;
    switch (e.ptr.base.scope) {
      case 'link':
        newPtr = linkPtr(target); // project-root relative
        break;
      case 'document':
        newPtr = under(target, docRoot) ? docPtr(docRoot, target) : null;
        break;
      case 'current':
        if (under(target, holder) && target !== holder) newPtr = ptr({ scope: 'current' }, stepsBelow(holder, target));
        else if (under(target, docRoot)) newPtr = docPtr(docRoot, target); // scope-form fallback
        break;
      case 'parent': {
        const p = parentOf(holder);
        if (p !== null && under(target, p)) newPtr = ptr({ scope: 'parent' }, stepsBelow(p, target));
        else if (under(target, docRoot)) newPtr = docPtr(docRoot, target);
        break;
      }
    }
    // the target left every relative frame — escalate to the project-root `::` form
    // instead of refusing: any in-tree path is expressible there, and a rewritten
    // absolute ref beats a silently stale relative one (never drop the committer's
    // labor). Only the project root itself / a position-first path has no spelling.
    if (newPtr === null) newPtr = linkPtr(target);
    if (newPtr === null) { miss('target has no project-root spelling'); continue; }
    // colon form, in the AUTHORED spacing style — a rename refactor replaces the token, it
    // does not restyle it: a compact `*::a:b` stays compact, a spaced `*:: a: b` spaced. A
    // raw with no separator at all (`*old`) shows no style — the spaced default applies.
    const spaced = e.raw.includes(': ') || !e.raw.includes(':');
    const newRaw = renderPointer(newPtr, { spaced });
    if (newRaw === e.raw) continue; // the relative form survived the move — nothing to edit

    const token = isJson5pUri(span.uri) ? json5pToken(newRaw) : pointerToken(newRaw);
    const list = plan.edits.get(span.uri) ?? [];
    list.push({ start: span.start, end: span.end, text: token });
    plan.edits.set(span.uri, list);
    plan.rewritten.push({ file: span.uri, from: e.from, oldRaw: e.raw, newRaw });
  }

  // marklower prose links the move strands: not IR pointers, but engine-owned all the same —
  // locate the authored token VERBATIM inside its recorded source region (the tokenizer is
  // the locator, so a code span cannot false-positive and a `>`-folded or escape-decoded
  // token simply fails to match) and retarget it in place. Identical tokens in one region
  // all take the same replacement. What cannot be located is REPORTED, never dropped.
  // A document-relative link whose own document moved travels with it and stays valid.
  const groups = new Map<string, { t: TextLinkRef; n: number }>();
  for (const t of opts.textLinks ?? []) {
    if (t.scope === 'document' && under(t.docRoot, oldStore)) continue;
    if (!under(t.target, oldStore)) continue;
    const key = JSON.stringify([t.span?.uri, t.span?.start, t.raw]);
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { t, n: 1 });
  }
  for (const { t, n } of groups.values()) {
    const missLink = (reason: string): void => {
      plan.unrewritten.push({ file: t.span?.uri ?? t.uri ?? '<unknown>', from: t.from, raw: t.raw, reason });
    };
    // the new spelling keeps the authored scope; a document-relative target that left its
    // document escalates to the project form — same law as the pointer fallback above
    const newTarget = mapPath(t.target);
    const newDocRoot = mapPath(t.docRoot);
    const spelling = t.scope === 'link'
      ? linkSpelling(newTarget)
      : under(newTarget, newDocRoot) ? docSpelling(newDocRoot, newTarget) : linkSpelling(newTarget);
    if (spelling === null) { missLink('target has no project-root spelling'); continue; }
    if (t.span === null || opts.read === undefined) {
      missLink('marklower prose link — no source span/reader (report only)');
      continue;
    }
    if (opts.root !== undefined && path.relative(opts.root, t.span.uri).startsWith('..')) {
      missLink('source file is outside the served root (grafted)');
      continue;
    }
    let text: string;
    try { text = opts.read(t.span.uri); } catch { missLink('source file unreadable'); continue; }
    const slice = text.slice(t.span.start, t.span.end);
    const hits = linkTargets(slice).filter((h) => h.raw === t.raw);
    if (hits.length === 0) { missLink('link token not found verbatim in source (folded or escaped)'); continue; }
    const list = plan.edits.get(t.span.uri) ?? [];
    for (const h of hits) list.push({ start: t.span.start + h.targetStart, end: t.span.start + h.targetEnd, text: spelling });
    plan.edits.set(t.span.uri, list);
    const newRaw = t.raw.slice(0, hits[0].targetStart - hits[0].start) + spelling + ')';
    plan.rewritten.push({ file: t.span.uri, from: t.from, oldRaw: t.raw, newRaw });
    if (hits.length < n) missLink(`only ${hits.length} of ${n} occurrences found verbatim (folded or escaped)`);
  }
  return plan;
}

/** Compact colon spelling of a store path as a marklower link target: `::a:b` (project-root).
 *  Null when the path has no such spelling (the project root itself, or a position-first path —
 *  mirroring {@link linkPtr}). */
function linkSpelling(target: string): string | null {
  const segs = segsOfPath(target);
  if (segs.length === 0 || typeof segs[0] !== 'string') return null;
  return '::' + segs.map((s) => segToken(s)).join(':');
}

/** Document-relative colon spelling: `:a:b` — the continuation below `docRoot`. */
function docSpelling(docRoot: string, target: string): string {
  const segs = segsOfPath(target).slice(docRoot === ':' ? 0 : segsOfPath(docRoot).length);
  return ':' + segs.map((s) => segToken(s)).join(':');
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
    } else if (st.sel === 'key') p += ':' + segToken(st.name);
    else if (st.sel === 'index') p += ':' + st.n;
    else if (st.sel === 'nullkey') p += ':~';
    else return null; // a relative index has no canonical store path (host-frame; docs/documents/marklower)
  }
  return p === '' ? ':' : p;
}

// ---- helpers ---------------------------------------------------------------------

function parentOf(p: string): string | null {
  if (p === ':' || p === '') return null;
  const segs = segsOfPath(p).slice(0, -1);
  return pathOfSegs(segs);
}

/** The remainder of `p` below `base` as pointer steps (store segments → steps). */
function stepsBelow(base: string, p: string): Step[] {
  const segs = segsOfPath(p).slice(base === ':' ? 0 : segsOfPath(base).length);
  return segs.map((t): Step =>
    t === null ? { sel: 'nullkey' } : typeof t === 'number' ? { sel: 'index', n: t } : { sel: 'key', name: t });
}

/** A Pointer value for renderPointer (the raw is re-rendered, never read). */
function ptr(base: PointerBase, steps: Step[]): Pointer {
  return { kind: 'pointer', base, steps, raw: '' };
}

/** Document-scope pointer: `: a: b`, `: [0]: x`, or `:` for the root itself. */
function docPtr(docRoot: string, target: string): Pointer {
  return ptr({ scope: 'document' }, stepsBelow(docRoot, target));
}

/** Project-root pointer (`:: first: rest…`): the first store token is the `::` authority
 *  portion. Null when the target is the project root itself or starts at a position —
 *  neither has a `::` spelling. */
function linkPtr(target: string): Pointer | null {
  const steps = stepsBelow(':', target);
  const head = steps[0];
  if (head === undefined || head.sel !== 'key') return null;
  return ptr({ scope: 'link', authority: head.name }, steps.slice(1));
}

function isJson5pUri(uri: string): boolean {
  return /\.(json|json5|json5p)$/i.test(uri);
}

function json5pToken(raw: string): string {
  return `*'${raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function json5pAnchorToken(body: string): string {
  return `&'${body.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
