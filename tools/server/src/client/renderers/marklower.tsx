import { ReactNode } from "react";
import { NodeJson } from "../api";
import { scalarValue } from "../render";
import { Chunk } from "./registry";
import { renderMath } from "./latex";
import { NavLink } from "../links";

/**
 * The renderer for a bare `string` with no explicit format — `(string, null)` —
 * our own lightweight markup language, **marklower**: deliberately a notch below
 * Markdown ("downshifted" from it). It is the *default* format for prose strings
 * inside a chapter: a chunk that declares no format routes here rather than to the
 * plain-paragraph fallback.
 *
 * The language is meant to cover inline concerns only — font styling, hyperlinks,
 * images, math, and (perhaps) embedded code — but deliberately **no** chapter
 * structure: no headings/subheadings, since chapters are modeled by the chapter
 * renderer's `children`, not by markup.
 *
 * The syntax so far is all inline:
 *
 *   - **atomic tokens**, whose contents are *not* re-interpreted as markup:
 *     `$$…$$` math (typeset with KaTeX via the shared {@link renderMath}, the same
 *     path the `text/x-latex` renderer uses) and `` `code` `` spans;
 *   - **links**: `[text](target)`, where `target` is a path in the app's JSON
 *     instance space (the same space the whole app navigates). Resolved and made
 *     clickable through the shared {@link NavLink} — the one link concept that refs
 *     and rels are expected to adopt later;
 *   - **text styling** on the plain runs between those: `**bold**`/`__bold__`,
 *     `*italic*`/`_italic_`, and `~~strikethrough~~`.
 *
 * Anything else is passed through verbatim. `parse` is the single seam every entry
 * point goes through, so there is one place to teach the grammar.
 */

/** Escape a plain-text run so it can be dropped into HTML (`parse` emits HTML now
 *  that some tokens — math, code, emphasis — render to markup). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Style a plain-text run (one of the stretches between the atomic tokens): escape
 *  it, then apply emphasis. Bold (`**`/`__`) runs before italic (`*`/`_`) so a
 *  double marker isn't mistaken for two single ones; non-greedy so neighbours don't
 *  merge. The markers (`* _ ~`) survive `escapeHtml`, so styling the escaped text
 *  is safe. */
function styleText(text: string): string {
  return escapeHtml(text)
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}

/** The non-text tokens, in one alternation matched in source order: `$$…$$` math
 *  (group 1; `[\s\S]` so a formula may span lines), a `` `code` `` span (group 2),
 *  or a `[label](target)` link (groups 3 = label, 4 = target). Non-greedy so
 *  adjacent tokens don't merge. The label may contain a balanced `[…]` (so a path
 *  used as its own label — `[/children[0]](/children[0])` — works), but a stray `]`
 *  is not a label, so a non-link `[a]` in prose is left alone. */
const TOKEN = /\$\$([\s\S]+?)\$\$|`([^`]+?)`|\[((?:[^\[\]]|\[[^\]]*\])*?)\]\(([^)]+?)\)/g;

/** Parse marklower into React nodes. Most syntax renders to an HTML string (math,
 *  code, emphasis), accumulated and flushed into `<span>`s; a link must be a real
 *  element so it navigates in-app (an HTML `<a href>` would reload), so the result
 *  is a node list, not one HTML string. `documentPath` anchors a link's `/…`
 *  (document-relative) target. */
function parse(value: unknown, onNavigate: (path: string) => void, documentPath?: string): ReactNode[] {
  const src = String(value ?? "");
  const nodes: ReactNode[] = [];
  let html = ""; // buffer of HTML-rendered runs between links
  let key = 0;
  const flush = () => {
    if (!html) return;
    nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />);
    html = "";
  };
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    html += styleText(src.slice(last, m.index)); // plain run before this token
    if (m[1] !== undefined) {
      html += renderMath(m[1], false); // $$ inline math $$
    } else if (m[2] !== undefined) {
      html += `<code>${escapeHtml(m[2])}</code>`; // `code` — contents literal
    } else {
      // [label](target) — a real anchor so it navigates in JSON instance space; the
      // label keeps its own inline styling.
      flush();
      nodes.push(
        <NavLink key={key++} target={m[4]} documentPath={documentPath} onNavigate={onNavigate}>
          <span dangerouslySetInnerHTML={{ __html: styleText(m[3]) }} />
        </NavLink>,
      );
    }
    last = m.index + m[0].length;
  }
  html += styleText(src.slice(last));
  flush();
  return nodes;
}

export function MarklowerView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  return (
    <div className="marklower">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <p className="chapter-prose">{parse(scalarValue(node.value), onNavigate, node.documentPath)}</p>
    </div>
  );
}

/** A marklower chunk embedded inline in a chapter (the chapter supplies the
 *  surrounding number + anchor). */
export function MarklowerChunk({ chunk, onNavigate }: { chunk: Chunk; onNavigate: (path: string) => void }) {
  return <p className="chapter-prose">{parse(chunk.value, onNavigate, chunk.documentPath)}</p>;
}
