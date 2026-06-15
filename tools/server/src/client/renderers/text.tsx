import { marked } from "marked";
import { NodeJson, blobUrl } from "../api";
import { scalarValue } from "../render";
import { Chunk } from "./registry";
import { anchorizeHeadings, useHashScroll } from "./headings";
import { Markup } from "./markup";
import { Seg, segsToStr, strToSegs } from "../paths";

/** A URL that is already absolute and must be left untouched: it carries a scheme
 *  (`http:`, `data:`, `mailto:`…), is protocol-relative (`//host`), is server-root
 *  (`/x` — the served root, GitHub-style), or is a bare fragment (`#sec`). Everything
 *  else is a path *relative to the document file*, like a `src` written in the repo. */
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Resolve a relative URL as written in a Markdown file — `images/x.jpg`, `../a/b.png`
 *  — against the DIRECTORY of the document it appears in (`anchorPath` = the file's
 *  JSON-space path), the way GitHub resolves relative links, and point it at the raw
 *  bytes via `/api/blob`. Returns null for absolute/scheme/fragment URLs (left as-is)
 *  or when there is no anchor to resolve against. */
function relativeBlobUrl(url: string, anchorPath?: string): string | null {
  if (!anchorPath) return null;
  const u = url.trim();
  if (!u || ABSOLUTE_URL.test(u)) return null;
  const path = u.split(/[?#]/, 1)[0]; // drop any ?query / #fragment before resolving
  const segs: Seg[] = strToSegs(anchorPath).slice(0, -1); // the file's directory
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(safeDecode(part));
  }
  return blobUrl(segsToStr(segs));
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
  return rewriteRelativeImages(html, anchorPath);
}

export function TextView({ node }: { node: NodeJson }) {
  useHashScroll(node);
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <Markup html={md(scalarValue(node.value), node.path)} />
    </div>
  );
}

/** A prose chunk embedded inline: just the rendered Markdown (the chapter
 *  supplies the surrounding number + anchor). */
export function TextChunk({ chunk }: { chunk: Chunk }) {
  return <div className="markup" dangerouslySetInnerHTML={{ __html: md(chunk.value, chunk.documentPath) }} />;
}
