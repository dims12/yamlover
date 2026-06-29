import { marked } from "marked";
import { NodeJson, blobUrl } from "../api";
import { scalarValue } from "../render";
import { Chunk } from "./registry";
import { anchorizeHeadings, useHashScroll } from "./headings";
import { Markup, markupClick, relativeDocSegs, rewriteRelativeLinks } from "./markup";
import { segsToStr } from "../paths";

/** Resolve a relative URL as written in a Markdown file — `images/x.jpg`, `../a/b.png`
 *  — against the DIRECTORY of the document it appears in (GitHub-style; see
 *  {@link relativeDocSegs}) and point it at the raw bytes via `/api/blob`. Returns null
 *  for absolute/scheme/fragment URLs (left as-is) or when there is no anchor. */
function relativeBlobUrl(url: string, anchorPath?: string): string | null {
  const segs = relativeDocSegs(url, anchorPath);
  return segs ? blobUrl(segsToStr(segs)) : null;
}

/** Rewrite every relative `<img src>` in rendered Markdown to a `/api/blob` URL
 *  anchored at the document file, so images referenced the GitHub way (relative to
 *  the file) load. Done on the parsed DOM, not by string surgery. */
function rewriteRelativeImages(html: string, anchorPath?: string): string {
  if (!anchorPath || !html.includes("<img")) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const img of tpl.content.querySelectorAll("img[src]")) {
    const blob = relativeBlobUrl(img.getAttribute("src") || "", anchorPath);
    if (blob) img.setAttribute("src", blob);
  }
  return tpl.innerHTML;
}

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
 * so the same renderer covers an inline `const` chunk and a whole `.md` file. Each
 * heading is then given an id and a `§` anchor link (see {@link anchorizeHeadings})
 * so a section is addressable as `<page>#<slug>`.
 */
function md(value: unknown, anchorPath?: string): string {
  const html = anchorizeHeadings(marked.parse(String(value ?? ""), { async: false }) as string);
  return rewriteRelativeLinks(rewriteRelativeImages(html, anchorPath), anchorPath);
}

export function TextView({ node, onNavigate }: { node: NodeJson; onNavigate?: (path: string) => void }) {
  useHashScroll(node);
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <Markup html={md(scalarValue(node.value), node.path)} onNavigate={onNavigate} />
    </div>
  );
}

/** A prose chunk embedded inline: just the rendered Markdown (the chapter
 *  supplies the surrounding number + anchor). Relative links navigate in-app. */
export function TextChunk({ chunk, onNavigate }: { chunk: Chunk; onNavigate?: (path: string) => void }) {
  return (
    <div className="markup" onClick={markupClick(onNavigate)} dangerouslySetInnerHTML={{ __html: md(chunk.value, chunk.documentPath) }} />
  );
}
