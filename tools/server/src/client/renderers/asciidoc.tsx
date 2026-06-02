import Asciidoctor from "@asciidoctor/core";
import { NodeJson } from "../api";
import { Chunk } from "./registry";

// One processor instance for the app; `convert` is pure per call.
const processor = Asciidoctor();

/**
 * The renderer for a `string`/`text/asciidoc` node: AsciiDoc converted to HTML
 * with `@asciidoctor/core`. Like the text/markdown renderer it works from the
 * node's string value, so it serves both a whole `.adoc` file (`render`) and a
 * single inline chunk (`renderChunk`).
 */
function adoc(value: unknown): string {
  return processor.convert(String(value ?? ""), { standalone: false }) as string;
}

export function AsciidocView({ node }: { node: NodeJson }) {
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <div className="markup" dangerouslySetInnerHTML={{ __html: adoc(node.value) }} />
    </div>
  );
}

export function AsciidocChunk({ chunk }: { chunk: Chunk }) {
  return <div className="markup" dangerouslySetInnerHTML={{ __html: adoc(chunk.value) }} />;
}
