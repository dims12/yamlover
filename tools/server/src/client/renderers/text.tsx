import { marked } from "marked";
import { NodeJson } from "../api";
import { Chunk } from "./registry";

/**
 * The renderer for a `string`/`text/markdown` node: prose shown as rendered
 * Markdown rather than a quoted scalar. It serves in two contexts via the one
 * (type, format) routing key:
 *
 *   - as a full RHS page (`render`) — a standalone prose node (e.g. a `.md`
 *     file, read as a string by the server), and
 *   - inline (`renderChunk`) — a single chunk embedded in another renderer's
 *     page, e.g. one paragraph of a chapter.
 *
 * Markdown is parsed with `marked`; the value is whatever string the node holds,
 * so the same renderer covers an inline `const` chunk and a whole `.md` file.
 */
function md(value: unknown): string {
  return marked.parse(String(value ?? ""), { async: false }) as string;
}

export function TextView({ node }: { node: NodeJson }) {
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <div className="markup" dangerouslySetInnerHTML={{ __html: md(node.value) }} />
    </div>
  );
}

/** A prose chunk embedded inline: just the rendered Markdown (the chapter
 *  supplies the surrounding number + anchor). */
export function TextChunk({ chunk }: { chunk: Chunk }) {
  return <div className="markup" dangerouslySetInnerHTML={{ __html: md(chunk.value) }} />;
}
