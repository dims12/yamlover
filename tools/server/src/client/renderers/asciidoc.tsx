import Asciidoctor from "@asciidoctor/core";
import { NodeJson } from "../api";
import { scalarValue } from "../render";
import { Chunk } from "./registry";
import { anchorizeHeadings, useHashScroll } from "./headings";
import { Markup, markupClick, rewriteRelativeLinks } from "./markup";
import { renderMath } from "./latex";

// One processor instance for the app; `convert` is pure per call.
const processor = Asciidoctor();

/** Strip a stem body's surrounding delimiter pair (`\(`/`\[`/`\$` … `\)`/`\]`/`\$`) to bare TeX. */
function stripDelims(s: string): string {
  return s.trim().replace(/^\\[([$]/, "").replace(/\\[)\]$]$/, "");
}

/**
 * Typeset AsciiDoc STEM (math) with KaTeX. With `standalone: false` Asciidoctor does not run
 * MathJax; it emits math as raw delimited source — `\(…\)`/`\[…\]` for latexmath, `\$…\$` for
 * asciimath — so without this pass the delimiters show through as literal text. We route each
 * span through {@link renderMath} (the same KaTeX entry marklower uses for markdown math): block
 * stems (`.stemblock`) in display mode, inline stems inline. KaTeX speaks LaTeX, so asciimath
 * that isn't also valid LaTeX won't convert — declare `:stem: latexmath` for LaTeX content.
 */
function typesetStem(html: string): string {
  // Block stems first, so their delimiters are consumed before the inline pass runs.
  html = html.replace(
    /(<div class="stemblock">\s*<div class="content">)([\s\S]*?)(<\/div>\s*<\/div>)/g,
    (_m, open, body, close) => open + renderMath(stripDelims(body), true) + close,
  );
  // Remaining inline stems embedded in prose.
  return html
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => renderMath(tex, false))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => renderMath(tex, true))
    .replace(/\\\$([\s\S]+?)\\\$/g, (_m, tex) => renderMath(tex, false));
}

/**
 * The renderer for a `string`/`text/asciidoc` node: AsciiDoc converted to HTML
 * with `@asciidoctor/core`. Like the text/markdown renderer it works from the
 * node's string value, so it serves both a whole `.adoc` file (`render`) and a
 * single inline chunk (`renderChunk`). STEM math is typeset with KaTeX (see
 * {@link typesetStem}); each heading is then given a `§` anchor link
 * (see {@link anchorizeHeadings}); Asciidoctor's own section ids are kept, so the
 * anchors line up with the document's internal cross-references.
 */
function adoc(value: unknown, anchorPath?: string): string {
  const html = anchorizeHeadings(typesetStem(processor.convert(String(value ?? ""), { standalone: false }) as string));
  return rewriteRelativeLinks(html, anchorPath);
}

export function AsciidocView({ node, onNavigate }: { node: NodeJson; onNavigate?: (path: string) => void }) {
  useHashScroll(node);
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <Markup html={adoc(scalarValue(node.value), node.path)} onNavigate={onNavigate} />
    </div>
  );
}

export function AsciidocChunk({ chunk, onNavigate }: { chunk: Chunk; onNavigate?: (path: string) => void }) {
  return (
    <div className="markup" onClick={markupClick(onNavigate)} dangerouslySetInnerHTML={{ __html: adoc(chunk.value, chunk.documentPath) }} />
  );
}
