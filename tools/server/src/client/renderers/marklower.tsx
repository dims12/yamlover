import { NodeJson } from "../api";
import { Chunk } from "./registry";
import { renderMath } from "./latex";

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
 * So far the only syntax is inline math: a `$$…$$` span is typeset with KaTeX
 * (via the shared {@link renderMath}, the same path the `text/x-latex` renderer
 * uses). Everything else is still passed through verbatim — the grammar will grow
 * here, and `parse` is the single seam every entry point goes through, so there is
 * one place to teach the syntax.
 */

/** Escape the plain-text runs between markup so they can be dropped into HTML
 *  (`parse` emits HTML now that one token — math — renders to markup). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Inline math: `$$…$$`. Non-greedy so adjacent formulas don't merge; `[\s\S]`
 *  so a formula may span lines. */
const MATH = /\$\$([\s\S]+?)\$\$/g;

function parse(value: unknown): string {
  const src = String(value ?? "");
  let out = "";
  let last = 0;
  for (const m of src.matchAll(MATH)) {
    out += escapeHtml(src.slice(last, m.index));
    out += renderMath(m[1], false); // inline (non-display) math
    last = m.index + m[0].length;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

export function MarklowerView({ node }: { node: NodeJson }) {
  return (
    <div className="marklower">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <p className="chapter-prose" dangerouslySetInnerHTML={{ __html: parse(node.value) }} />
    </div>
  );
}

/** A marklower chunk embedded inline in a chapter (the chapter supplies the
 *  surrounding number + anchor). */
export function MarklowerChunk({ chunk }: { chunk: Chunk }) {
  return <p className="chapter-prose" dangerouslySetInnerHTML={{ __html: parse(chunk.value) }} />;
}
