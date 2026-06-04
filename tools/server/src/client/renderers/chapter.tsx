import { NodeJson } from "../api";
import { asLink, Link } from "../render";
import { Chunk, rendererFor } from "./registry";

/**
 * The renderer for an `object`/`x-yamlover-chapter`: a chapter shown as a readable
 * page. A chapter is a heading (`title`/`description`) plus two arrays:
 *
 *   - `chunks`   — the body, rendered as numbered blocks. Each chunk is delegated
 *                  to the renderer for its own (type, format), so a chapter is not
 *                  prose-only: a `text/markdown` chunk routes to the text renderer,
 *                  a `text/x-plantuml` chunk to the diagram renderer, and any
 *                  file-backed binary (image, html, pdf, fb2, epub, psd, tiff, …)
 *                  to its own renderer via `renderChunk` — each prefixed with its
 *                  zero-based index, hyperlinked to the chunk's own node (the same
 *                  numbering an array view shows). See 16-all-formats-chunks.
 *   - `children` — the subchapters, rendered as heading links to each nested
 *                  chapter (and surfaced in the TOC; see `chapterTocView`).
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
  return (
    <div className="chapter">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}

      {chunks.map((item, i) => (
        <ChunkBlock key={i} index={i} item={item} documentPath={node.documentPath} onNavigate={onNavigate} />
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

/** One numbered chunk: its zero-based index (a link to the chunk's own node) and
 *  the chunk rendered by the renderer for its (type, format) — falling back to a
 *  plain paragraph when none claims it (or the chunk is a bare inline value). */
function ChunkBlock({
  index,
  item,
  documentPath,
  onNavigate,
}: {
  index: number;
  item: unknown;
  documentPath?: string;
  onNavigate: (path: string) => void;
}) {
  const link = asLink(item);
  const chunk: Chunk = {
    value: link ? link.value : item,
    path: link?.path ?? "",
    type: link?.type ?? "string",
    format: link?.format ?? null,
    documentPath, // carried so a marklower chunk's `/…` link resolves to its document
  };
  const renderer = rendererFor(chunk.type, chunk.format);
  const body = renderer?.renderChunk
    ? renderer.renderChunk(chunk, onNavigate)
    : <p className="chapter-prose">{String(chunk.value ?? "")}</p>;
  return (
    <div className="chunk">
      {chunk.path ? (
        <a
          className="chunk-index"
          href={chunk.path}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(chunk.path);
          }}
        >
          §{index}
        </a>
      ) : (
        <span className="chunk-index">§{index}</span>
      )}
      <div className="chunk-body">{body}</div>
    </div>
  );
}

/** A subchapter link's label: its schema title, else a generic fallback. */
function chapterTitle(link: Link | null): string {
  return link?.title ?? "(untitled chapter)";
}
