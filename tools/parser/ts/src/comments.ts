// Comment attachment (IR.md). Both parsers capture comments as flat RawComments (offset +
// kind) while lexing, then hand them here for placement onto the parsed tree. Doing this as
// a post-pass over the finished IR — using the entry/node spans Phase A populates — keeps
// the recursive parsers untouched and gives ONE attachment policy for both concretes.
//
// Policy (the libyaml / ruamel / tree-sitter convention):
//  • a comment SHARING a line with content (trailing) → the innermost entry ending on that
//    line, just before it;
//  • an OWN-LINE comment (leading) → the next entry that begins after it;
//  • a top-of-file block set off by a blank line → Document.head;
//  • anything left over (e.g. a comment after the final entry) → the root node's meta,
//    so no comment is ever dropped.

import type { Comment, Document, Entry, Node } from './ir.ts';
import { isPointer } from './ir.ts';

/** A comment as the lexer sees it, before placement. `start`/`end` are absolute offsets of
 *  the whole token (sigils included); `ownLine` is true when only whitespace precedes it. */
export interface RawComment {
  start: number;
  end: number;
  text: string;
  ownLine: boolean;
  style: 'line' | 'block';
}

/** Place `raws` onto `doc` (mutating entry/node meta and doc.head). `src` is the source text
 *  (for blank-line detection); `uri` stamps each Comment.span. */
export function attachComments(doc: Document, raws: RawComment[], src: string, uri: string): void {
  if (raws.length === 0) return;
  raws.sort((a, b) => a.start - b.start);

  // entries in document order, each carrying the span Phase A gave it, with its parent node
  const entries: Entry[] = [];
  const parentOf = new Map<Entry, Node>();
  const collect = (n: Node): void => {
    for (const e of n.entries ?? []) {
      if (e.meta?.span) { entries.push(e); parentOf.set(e, n); }
      if (!isPointer(e.value)) collect(e.value);
    }
  };
  collect(doc.root);
  const firstStart = entries.length
    ? Math.min(...entries.map((e) => e.meta!.span!.start))
    : src.length;

  const lineOf = lineIndexer(src);
  const blankBetween = (a: number, b: number): boolean => b > a && /\r?\n[ \t]*\r?\n/.test(src.slice(a, b));
  const make = (r: RawComment, placement: 'leading' | 'trailing'): Comment => ({
    text: r.text,
    span: { uri, start: r.start, end: r.end },
    placement,
    style: r.style,
    ...(precededByBlank(src, r.start) ? { blankBefore: true } : {}),
  });
  const push = (host: { comments?: Comment[] }, c: Comment): void => {
    host.comments = [...(host.comments ?? []), c];
  };

  const used = new Set<RawComment>();

  // HEAD: the top contiguous own-line block, IF a blank line sets it off from what follows.
  const pre = raws.filter((r) => r.ownLine && r.start < firstStart);
  if (pre.length > 0) {
    let m = 0;
    while (m + 1 < pre.length && !blankBetween(pre[m].end, pre[m + 1].start)) m++;
    const after = m + 1 < pre.length ? pre[m + 1].start : firstStart;
    if (blankBetween(pre[m].end, after)) {
      doc.head = pre.slice(0, m + 1).map((r) => make(r, 'leading'));
      for (let i = 0; i <= m; i++) used.add(pre[i]);
    }
  }

  for (const r of raws) {
    if (used.has(r)) continue;
    if (!r.ownLine) {
      // trailing: the entry ending closest before it ON THE SAME LINE
      const rl = lineOf(r.start);
      let best: Entry | undefined;
      for (const e of entries) {
        const s = e.meta!.span!;
        if (s.end > r.start || lineOf(s.end) !== rl) continue;
        // closest before the comment on this line; on an end tie (an ancestor and its last
        // descendant both end here) prefer the INNERMOST — the greater start.
        const b = best ? best.meta!.span! : undefined;
        if (!b || s.end > b.end || (s.end === b.end && s.start > b.start)) best = e;
      }
      if (best) { push(best.meta!, make(r, 'trailing')); used.add(r); continue; }
      const next = nextEntryAfter(entries, r.start);
      if (next && lineOf(next.meta!.span!.start) === rl) {
        // an inline comment that PRECEDES an entry on the same line (`{ /* x */ a: 1 }`) leads
        // that entry — it doesn't trail a value.
        push(next.meta!, make(r, 'leading')); used.add(r); continue;
      }
      // otherwise no entry shares its line — it trails a NODE's self-value (an omni root's `5`,
      // or a nested `rating: !!var 5 # …`). Attach to that node (the parent of the next entry,
      // whose value-line it sits on) as `trailing` — NOT as leading-on-next.
      const host = next ? parentOf.get(next)! : doc.root;
      host.meta = host.meta ?? {};
      push(host.meta, make(r, 'trailing'));
      used.add(r);
      continue;
    }
    // leading (own-line): the next entry to begin after the comment
    const target = nextEntryAfter(entries, r.start);
    if (target) { push(target.meta!, make(r, 'leading')); used.add(r); continue; }
    // leftover (e.g. a trailing remark after the final entry) → the root node, never dropped
    doc.root.meta = doc.root.meta ?? {};
    push(doc.root.meta, make(r, r.ownLine ? 'leading' : 'trailing'));
    used.add(r);
  }
}

/** The entry whose span begins soonest after `off` (the "next" entry in document order). */
function nextEntryAfter(entries: Entry[], off: number): Entry | undefined {
  let best: Entry | undefined;
  for (const e of entries) {
    const st = e.meta!.span!.start;
    if (st > off && (!best || st < best.meta!.span!.start)) best = e;
  }
  return best;
}

/** Returns offset → 0-based line index via binary search over line-start offsets. */
function lineIndexer(src: string): (off: number) => number {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (off: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
}

/** True when the line immediately above `off`'s line is blank. False on the first line —
 *  the file start is not a blank line (this would otherwise add a spurious leading gap). */
function precededByBlank(src: string, off: number): boolean {
  const ls = src.lastIndexOf('\n', off - 1);
  if (ls < 0) return false; // first line of the file — nothing above it
  const ps = src.lastIndexOf('\n', ls - 1);
  return /^[ \t\r]*$/.test(src.slice(ps + 1, ls));
}
