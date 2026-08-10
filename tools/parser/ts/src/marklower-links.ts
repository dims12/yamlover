// The marklower TOKEN grammar's framework-free half — shared between the client renderer
// (tools/server/src/client/renderers/marklower.tsx, which turns the tokens into React) and
// the engine's move planner (engine/ts/src/resolve.ts scanTextLinks, which only needs the
// LINK TARGETS so a rename can report the prose refs it cannot rewrite). One grammar, one
// place to teach it — the renderer re-exports nothing; both sides import from here.

/** A link/embed label: may contain a balanced `[…]` (so a path used as its own label —
 *  `[:children[0]](:children[0])` — works), but a stray `]` is not a label, so a non-link `[a]` in
 *  prose is left alone. Non-greedy so adjacent tokens don't merge. */
export const LABEL = String.raw`(?:[^\[\]]|\[[^\]]*\])*?`;

/** The non-text tokens, in one alternation matched in source order:
 *
 *   1. `$$…$$` math (group 1; `[\s\S]` so a formula may span lines);
 *   2. `` `code` `` (group 2);
 *   3. `*[label](target)` — an EMBED (groups 3 = label, 4 = target): the target is *inlined*
 *      rather than pointed at, `*` carrying the same deref sense it has in yamlover proper;
 *   4. `[label](target)` — an ordinary link (groups 5 = label, 6 = target).
 *
 * The embed's `(?!\*)` guard keeps the one collision with emphasis honest: `*[a](b)*` is an
 * *italic link* (the `*`s pair around it), while `*[a](b)` is an embed. Bold (`**[a](b)**`) is
 * likewise unaffected — the second `*` starts an embed that the trailing `*` immediately vetoes,
 * and the alternation falls through to the plain link.
 */
export const TOKEN = new RegExp(
  String.raw`\$\$([\s\S]+?)\$\$|` + // 1: math
    "`([^`]+?)`|" + // 2: code
    String.raw`\*\[(${LABEL})\]\(([^)]+?)\)(?!\*)|` + // 3,4: embed
    String.raw`\[(${LABEL})\]\(([^)]+?)\)`, // 5,6: link
  "g",
);

export interface LinkTarget {
  target: string; // the parenthesized target, verbatim
  raw: string; // the whole `[label](target)` / `*[label](target)` token
  start: number; // token offsets into `src`
  end: number;
  /** Offsets of the BARE target inside `src` — the token always ends with `(${target})`,
   *  so the target occupies [end - 1 - target.length, end - 1). The move planner edits
   *  exactly this span when it retargets a link. */
  targetStart: number;
  targetEnd: number;
}

/** Every link and embed TARGET in a marklower source, with token offsets — math and code
 *  tokens are consumed by the same alternation, so a `[x](y)` inside a code span is not
 *  a link here either, exactly as the renderer sees it. */
export function linkTargets(src: string): LinkTarget[] {
  const out: LinkTarget[] = [];
  for (const m of src.matchAll(TOKEN)) {
    const target = m[4] ?? m[6];
    if (target === undefined) continue; // math or code
    const end = m.index + m[0].length;
    out.push({ target, raw: m[0], start: m.index, end, targetStart: end - 1 - target.length, targetEnd: end - 1 });
  }
  return out;
}
