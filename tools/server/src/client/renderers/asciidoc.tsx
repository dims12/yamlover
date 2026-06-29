import Asciidoctor from "@asciidoctor/core";
import { NodeJson } from "../api";
import { scalarValue } from "../render";
import { Chunk } from "./registry";
import { anchorizeHeadings, useHashScroll } from "./headings";
import { Markup, markupClick, rewriteRelativeLinks } from "./markup";

// One processor instance for the app; `convert` is pure per call.
const processor = Asciidoctor();

/**
 * The renderer for a `string`/`text/asciidoc` node: AsciiDoc converted to HTML
 * with `@asciidoctor/core`. Like the text/markdown renderer it works from the
 * node's string value, so it serves both a whole `.adoc` file (`render`) and a
 * single inline chunk (`renderChunk`). Each heading is then given a `§` anchor link
 * (see {@link anchorizeHeadings}); Asciidoctor's own section ids are kept, so the
 * anchors line up with the document's internal cross-references.
 */
function adoc(value: unknown, anchorPath?: string): string {
  const html = anchorizeHeadings(processor.convert(String(value ?? ""), { standalone: false }) as string);
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
