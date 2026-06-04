import katex from "katex";
import "katex/dist/katex.min.css";
import { NodeJson } from "../api";
import { Chunk } from "./registry";

/**
 * The renderer for a `string`/`text/x-latex` node: LaTeX math typeset with KaTeX.
 * Like the markdown/asciidoc renderers it works straight from the node's string
 * value, so it serves both a whole formula node (`render`) and a single inline
 * chunk (`renderChunk`).
 *
 * `renderMath` is the one place KaTeX is invoked, exported so **marklower** can
 * reuse it for its inline `$$…$$` spans — math is rendered the same way whether it
 * is a standalone `text/x-latex` string or embedded in marklower prose.
 */
export function renderMath(tex: unknown, displayMode: boolean): string {
  // `throwOnError: false` makes KaTeX emit the offending source in red rather than
  // throwing, so a typo in one formula never blanks the whole page.
  return katex.renderToString(String(tex ?? ""), { displayMode, throwOnError: false });
}

export function LatexView({ node }: { node: NodeJson }) {
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <div className="markup" dangerouslySetInnerHTML={{ __html: renderMath(node.value, true) }} />
    </div>
  );
}

/** A LaTeX chunk embedded inline in a chapter: the formula typeset as a display
 *  block (the chapter supplies the surrounding number + anchor). */
export function LatexChunk({ chunk }: { chunk: Chunk }) {
  return <div className="markup" dangerouslySetInnerHTML={{ __html: renderMath(chunk.value, true) }} />;
}
