import { NodeJson } from "../api";
import { Chunk } from "./registry";

/**
 * The renderer for a `string`/`text/markdown` node: prose shown as a paragraph
 * rather than a quoted scalar. It serves in two contexts via the one (type,
 * format) routing key:
 *
 *   - as a full RHS page (`render`) — a standalone prose node, and
 *   - inline (`renderChunk`) — a single chunk embedded in another renderer's
 *     page, e.g. one paragraph of a chapter.
 *
 * (Markdown is rendered verbatim for now — plain prose reads correctly as-is;
 * parsing inline markup is a later step, and lands here without touching callers.)
 */
export function TextView({ node }: { node: NodeJson }) {
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <p className="chapter-prose">{String(node.value ?? "")}</p>
    </div>
  );
}

/** A prose chunk embedded inline: just the paragraph (the chapter supplies the
 *  surrounding number + anchor). */
export function TextChunk({ chunk }: { chunk: Chunk }) {
  return <p className="chapter-prose">{String(chunk.value ?? "")}</p>;
}
