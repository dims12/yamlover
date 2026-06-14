import { NodeJson } from "../api";
import { asLink, Link } from "../render";
import { segsToStr, strToSegs } from "../paths";
import { Chunk, rendererFor } from "./registry";
import { useHashScroll } from "./headings";

/**
 * The renderer for an `object`/`x-yamlover-chapter`: a chapter shown as a readable
 * page. This is yamlover's first instance of **partial flattening** (see the global
 * README): a deeper subtree is presented shallowly, pulling some descendants up as
 * constituent parts of *this* page rather than as nodes you navigate away to.
 *
 * A chapter is a heading (`title`/`description`) plus two arrays:
 *
 *   - `chunks`   — the body, **flattened** into this page as numbered blocks. Each
 *                  chunk is delegated to the renderer for its own (type, format), so
 *                  a chapter is not prose-only: a `text/markdown` chunk routes to the
 *                  text renderer, a `text/x-plantuml` chunk to the diagram renderer,
 *                  and any file-backed binary (image, html, pdf, fb2, epub, psd,
 *                  tiff, …) to its own renderer via `renderChunk`. A flattened chunk
 *                  exposes its location as a **fragment anchor** whose syntax is the
 *                  chunk's path continuation: chunk `[1]`, still reachable in full at
 *                  `<chapter>:chunks[1]`, is anchored here at `#:chunks[1]` (so
 *                  `<chapter>#:chunks[1]` scrolls to it). The `§N` marker is that
 *                  in-page anchor link. See 16-all-formats-chunks.
 *   - `children` — the subchapters, *not* flattened: rendered as heading links you
 *                  navigate to (and surfaced in the TOC; see `chapterTocView`).
 *
 * The value arrives two levels deep (see the chapter renderer's `depth`): the
 * arrays are present, and each element is a link marker carrying its (type,
 * format), value/title, and path.
 */
export function ChapterView({
  node,
  onNavigate,
}: {
  node: NodeJson;
  onNavigate: (path: string) => void;
}) {
  const v = (node.value ?? {}) as { chunks?: unknown; children?: unknown };
  const chunks = Array.isArray(v.chunks) ? v.chunks : [];
  const children = Array.isArray(v.children) ? v.children : [];

  // A deep link to a flattened chunk (`<chapter>#/chunks[1]`) lands on the chapter
  // page, so scroll to the anchored chunk once it has rendered (the browser's own
  // scroll fires before the async value arrives). Re-runs when the chapter changes.
  useHashScroll(node);

  return (
    <div className="chapter">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}

      {chunks.map((item, i) => (
        <ChunkBlock key={i} index={i} item={item} basePath={node.path} documentPath={node.documentPath} onNavigate={onNavigate} />
      ))}

      {children.map((item, i) => {
        const link = asLink(item);
        return (
          <h2 className="chapter-link" key={i}>
            <a
              className="descend"
              href={link?.path ?? "#"}
              onClick={(e) => {
                e.preventDefault();
                if (link) onNavigate(link.path);
              }}
            >
              {chapterTitle(link)}
            </a>
          </h2>
        );
      })}
    </div>
  );
}

/** One numbered chunk, flattened into the chapter page: its zero-based index `§N`
 *  as an in-page anchor link to the chunk's own location (the fragment mirrors the
 *  chunk's path continuation), and the chunk rendered by the renderer for its
 *  (type, format) — falling back to a plain paragraph when none claims it (or the
 *  chunk is a bare inline value with no path). */
function ChunkBlock({
  index,
  item,
  basePath,
  documentPath,
  onNavigate,
}: {
  index: number;
  item: unknown;
  basePath: string;
  documentPath?: string;
  onNavigate: (path: string) => void;
}) {
  const link = asLink(item);
  const chunk: Chunk = {
    value: link ? link.value : item,
    path: link?.path ?? "",
    type: link?.type ?? "string",
    format: link?.format ?? null,
    // the renderer-dispatch facets (TYPES.md §9): a link carries them; a bare inline chunk is a string
    valueType: link?.valueType ?? "string",
    hasKeyed: link?.hasKeyed ?? false,
    hasOrdinal: link?.hasOrdinal ?? false,
    documentPath, // carried so a marklower chunk's `/…` link resolves to its document
  };
  const renderer = rendererFor(chunk);
  const body = renderer?.renderChunk
    ? renderer.renderChunk(chunk, onNavigate)
    : <p className="chapter-prose">{String(chunk.value ?? "")}</p>;
  // The chunk's location *within this page*: its path continuation past the chapter
  // (e.g. `/chunks[1]`), used as both the element id and the `§N` anchor link. The
  // full path stays navigable; this is the flattened, in-page locator.
  const anchor = chunk.path ? pathContinuation(basePath, chunk.path) : null;
  return (
    <div className="chunk" id={anchor ?? undefined}>
      {anchor ? (
        <a className="chunk-index" href={`#${anchor}`}>
          §{index}
        </a>
      ) : (
        <span className="chunk-index">§{index}</span>
      )}
      <div className="chunk-body">{body}</div>
    </div>
  );
}

/** The path continuation from `base` to `full` — the segments of `full` past
 *  `base`, in JSON-path syntax. E.g. ("/book", "/book/chunks[1]") → "/chunks[1]".
 *  A flattened child's fragment anchor is exactly this continuation, so the anchor
 *  spelling matches the still-navigable full path. */
function pathContinuation(base: string, full: string): string {
  return segsToStr(strToSegs(full).slice(strToSegs(base).length));
}

/** A subchapter link's label: its schema title, else a generic fallback. */
function chapterTitle(link: Link | null): string {
  return link?.title ?? "(untitled chapter)";
}
