import { NodeJson } from "../api";
import { asLink, Link } from "../render";

/**
 * The renderer for an `x-yamlover-chapter` array: a chapter shown as a readable
 * page rather than a YAML list. The page leads with the chapter's own `title`
 * (heading) and `description` (subtitle), then each element of the chapter:
 *
 *   - a prose string  → rendered as a paragraph, or
 *   - a subchapter     → rendered as a heading whose text is the subchapter's
 *                        title, hyperlinked to that nested chapter.
 *
 * The chapter's value arrives one level deep (see `toPlain`), where every child
 * is a link marker: a subchapter is a *container* link carrying its `title` and
 * `path`, while a prose block is a *scalar* link carrying its text as `value`.
 * (Were the prose ever inline as a raw string, it is handled too.)
 */
export function ChapterView({
  node,
  onNavigate,
}: {
  node: NodeJson;
  onNavigate: (path: string) => void;
}) {
  const items = Array.isArray(node.value) ? node.value : [];
  return (
    <div className="chapter">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      {items.map((item, i) => {
        const link = asLink(item);
        // a subchapter (a nested container) → a heading linking to that chapter
        if (link && (link.kind === "object" || link.kind === "array")) {
          return (
            <h2 className="chapter-link" key={i}>
              <a
                className="descend"
                href={link.path}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(link.path);
                }}
              >
                {chapterTitle(link)}
              </a>
            </h2>
          );
        }
        // prose → a paragraph: the text is a scalar link's `value`, or inline
        const text = link ? String(link.value ?? "") : String(item);
        return (
          <p className="chapter-prose" key={i}>
            {text}
          </p>
        );
      })}
    </div>
  );
}

/** A subchapter link's label: its schema title, else a generic fallback. */
function chapterTitle(link: Link): string {
  return link.title ?? "(untitled chapter)";
}
