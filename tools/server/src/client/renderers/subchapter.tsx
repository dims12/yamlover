// A subchapter rendered INLINE, one nesting level per component (docs/documents/chapter, chapter.tsx).
//
// A chapter page reads as ONE document: its subchapters are laid out in place, indented, under
// their own heading — not as links that navigate away. Three shapes reach us:
//
//   - an INLINE subchapter (a container inside the chapter's own source) — its value is already
//     in hand at the parent's fetch depth, nothing to load;
//   - a MEMBER subchapter (the chapter's own file or directory child, `- *: dogs`) — it arrives
//     as a `$yamloverLink` marker carrying its target `path`, and its content is FETCHED here;
//   - a REFERENCE (`- *..: …`, `- *:: …` — any pointer whose target is NOT this chapter's own
//     direct child): a CITATION of another part of the book, not containment. It ALWAYS renders
//     as the navigable heading link, marked `↗` — never inlined. Inlining would duplicate the
//     cited chapter's content in place; and before this rule the two directions read as
//     different things (a backward ref collapsed on the cycle guard, a forward ref inlined)
//     when both are the same authored construct.
//
// Why per-level fetching rather than one deep fetch: the projection never inlines a `*` reference.
// At a finite depth a reference RESOLVES to a summary link marker, at `.inf` it becomes pointer
// TEXT — neither is content. So a directory-backed chapter (the common shape for a book) could not
// be inlined at any single fetch depth. Fetching each level as it renders makes both shapes behave
// identically, and it is the pattern list.tsx `ListChunk` / table.tsx `TableChunk` already use.
//
// Everything that can stop the recursion — the depth budget running out, a POINTER CYCLE, the hard
// caps, a load in flight, a load that failed — degrades to the same face: the navigable heading
// link this page used to show for every subchapter. So the anchor exists before the body lands,
// there is no layout jank, and a `#fragment` to a non-inlined subchapter still resolves.

import { useEffect, useState } from "react";
import { fetchNode, NodeJson } from "../api";
import { noteUnfoldFinish, noteUnfoldStart } from "../landing-progress";
import { ParseErrorBanner } from "../ParseErrorBanner";
import { asLink, asRef } from "../render";
import { canonPath, strToSegs } from "../paths";
import { useSubtreeDiffBump } from "../live";
import { childPath } from "./chapter-model";

/** The deepest nesting a page will inline, and the most subchapters it will pull in — a cheap,
 *  deterministic guard against a pathological tree (a book with hundreds of leaf chapters would
 *  otherwise issue hundreds of requests on open). Past either cap the rest stay links. */
export const MAX_INLINE_LEVELS = 12;
export const MAX_INLINE_NODES = 200;

/** How a subchapter renders when it is NOT inlined — supplied by chapter.tsx, so this module stays
 *  free of the page's own presentation. */
export interface SubchapterLinkProps {
  path?: string;
  title?: string;
  level: number;
  id: string;
  note?: string;
  /** True for a REFERENCE (a citation of a chapter that is not this chapter's own member) —
   *  the page must NOT give its heading the target's anchor id (see chapter-shared renderLink). */
  reference?: boolean;
}

/** The page's own body renderer, applied to an inlined subchapter. */
export interface SubchapterBodyProps {
  value: unknown;
  nodePath: string;
  documentPath?: string;
  slot: string;
  level: number;
  ancestors: readonly string[];
}

export interface InlineSubchapterProps {
  /** The body element as the parent projected it: a link marker, a ref, or an inline container. */
  marker: unknown;
  /** The parent chapter's node path — an INLINE subchapter's own path is this plus its index. */
  parentPath: string;
  /** Its absolute entry index in the parent (the addressing rule `P[i]`, docs/documents/chapter). */
  absIndex: number;
  /** Its render position on the PAGE, as an index chain from the page root — its anchor id. */
  slot: string;
  /** Nesting level: 0 is the page root, so a subchapter is 1 or more (heading = h(level+1)). */
  level: number;
  /** Subchapter levels still allowed to inline; `Infinity` for all, `<= 0` for none. */
  budget: number;
  /** The canonical path of every enclosing chapter — the CYCLE guard. `*` pointers form an
   *  arbitrary graph and nothing upstream forbids a chapter that points at its own ancestor;
   *  without this an unlimited budget is an infinite fetch loop, not a deep page. */
  ancestors: readonly string[];
  /** Fires when a lazily-loaded subtree lands, so the page can re-run its `#fragment` scroll. */
  onLoaded?: () => void;
  renderBody: (p: SubchapterBodyProps) => JSX.Element;
  renderLink: (p: SubchapterLinkProps) => JSX.Element;
}

/** The node a body element addresses: a link/ref marker names its own target (a separate document);
 *  an INLINE container has none — the parent already holds its value, at slot `P[i]`. */
export function subchapterTarget(marker: unknown): { path: string | null; linked: boolean } {
  const link = asLink(marker);
  if (link) return { path: typeof link.path === "string" ? link.path : null, linked: true };
  const ref = asRef(marker);
  if (ref) return { path: ref.path, linked: true }; // pointer TEXT (an `.inf` fetch) — still a target
  return { path: null, linked: false };
}

/** CONTAINMENT: the target is the citing chapter's own DIRECT child — exactly what an anchored
 *  member (`- *: dogs`) resolves to. Anything else (an ancestor, a cousin subtree, even the
 *  chapter's own grandchild) is a REFERENCE, and a reference is cited, never inlined. */
function isOwnMember(parentPath: string, target: string): boolean {
  const p = strToSegs(canonPath(parentPath));
  const t = strToSegs(canonPath(target));
  return t.length === p.length + 1 && p.every((s, i) => s === t[i]);
}

/** One subchapter, inlined when the budget and the guards allow, else the page's heading link. */
export function InlineSubchapter({
  marker, parentPath, absIndex, slot, level, budget, ancestors, onLoaded, renderBody, renderLink,
}: InlineSubchapterProps) {
  const { path: target, linked } = subchapterTarget(marker);
  const link = asLink(marker);
  // the reference rule (the module banner): only a chapter's OWN member inlines; a pointer
  // anywhere else — above or forward — is a citation and keeps the link face, ALWAYS
  const reference = linked && !!target && !isOwnMember(parentPath, target);
  const cyclic = !!target && ancestors.includes(canonPath(target));
  const capped = level > MAX_INLINE_LEVELS || ancestors.length > MAX_INLINE_NODES;
  const allowed = budget > 0 && !reference && !cyclic && !capped;
  const needsFetch = allowed && linked && !!target;

  const [node, setNode] = useState<NodeJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The page's own refetch stops at this seam: the parent projected us as a link MARKER, so an
  // edit to our body — from this window, another tab, or a shell — leaves the parent's content
  // unchanged. The subtree bump is what carries the change across (live.ts).
  const bump = useSubtreeDiffBump(needsFetch ? target : null);
  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    // depth 1 — the shape the chapter body renderer is written against (its own chunks as link
    // markers, its subchapters inlined by the next level of this component)
    noteUnfoldStart(); // the task-strip "unfolding" chip counts the in-flight landings
    fetchNode(target!, 1)
      .then((n) => { if (!cancelled) { setNode(n); onLoaded?.(); } })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(noteUnfoldFinish);
    return () => { cancelled = true; };
    // `onLoaded` is a stable page-level notifier — listing it would refetch on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, needsFetch, bump]);

  const asLinkFace = (note?: string) => renderLink({ path: target ?? undefined, title: link?.title, level, id: slot, note, reference });

  if (!allowed) return asLinkFace(reference ? "↗" : cyclic ? "↻ already shown above" : undefined);
  if (!linked) {
    // already in hand — render the parent's own value for this slot
    const nodePath = childPath(parentPath, absIndex);
    return renderBody({ value: marker, nodePath, slot, level, ancestors: [...ancestors, canonPath(nodePath)] });
  }
  if (error) return asLinkFace(`failed to load: ${error}`);
  if (!node) return asLinkFace("…");
  return (
    <>
      {/* a DEGRADED member (its source failed to parse) says so IN PLACE — the body below is
          the fallback, and an embedded blank would otherwise pose as an empty subchapter */}
      {node.parseError && <ParseErrorBanner error={node.parseError} />}
      {renderBody({
        value: node.value,
        nodePath: node.path,
        // the subchapter's OWN document: a marklower `/…` link inside `dogs/` resolves against `dogs/`,
        // not against the page root — passing the parent's would silently misresolve every such link
        documentPath: node.documentPath,
        slot,
        level,
        ancestors: [...ancestors, canonPath(node.path)],
      })}
    </>
  );
}
