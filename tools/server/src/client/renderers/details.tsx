import { useEffect, useState } from "react";
import type { ExplorerItem } from "./explorer";
import { Annotation, fetchAnnotations } from "../api";
import { typeIcon } from "../icons";
import { displayPath } from "../paths";
import { isColorTagPath, resolveTagColor, TagSwatch } from "./tag";
import { touchesYamlover, useDiffBump } from "../live";

// A member's KIND label: a friendly tail of its format (`application/pdf` → `pdf`,
// `x-yamlover-task` → `task`, `text/markdown` → `markdown`), else its directory concrete or type.
function kindLabel(it: ExplorerItem): string {
  const l = it.link;
  if (!l) return "scalar";
  if (l.format) return l.format.replace(/^x-yamlover-/, "").replace(/^.*\//, "");
  if (l.concrete === "dir" || l.concrete === "yamlover") return "folder";
  return l.type ?? l.kind ?? "";
}

// A member's SIZE/COUNT column: a container shows its member count, a blob its byte size.
function sizeLabel(it: ExplorerItem): string {
  const l = it.link;
  if (!l) return "";
  if (typeof l.count === "number") return `${l.count} item${l.count === 1 ? "" : "s"}`;
  if (typeof l.size === "number") {
    const u = ["B", "KB", "MB", "GB"];
    let n = l.size, i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${i === 0 ? n : n.toFixed(1)} ${u[i]}`;
  }
  return "";
}

/**
 * The DETAILS view — a Windows-Explorer-style columnar table of a directory's members: Name (icon +
 * title), Kind, Tags, and Size. The Tags column reads each member's applied tags (one
 * `fetchAnnotations` per member, refreshed on any `.yamlover` write via `useDiffBump`) so a backlog
 * can be browsed and triaged. Rows navigate on click and raise the tagging menu on right-click
 * (the same `openContextMenu` the grid uses). Column set is provisional — to be refined.
 */
export function DetailsView({
  members,
  onNavigate,
  openContextMenu,
}: {
  members: ExplorerItem[];
  onNavigate: (path: string) => void;
  openContextMenu?: (path: string, x: number, y: number) => void;
}) {
  const diffBump = useDiffBump(touchesYamlover);
  const [tagsByPath, setTagsByPath] = useState<Record<string, Annotation[]>>({});

  const paths = members.map((m) => m.link?.path).filter((p): p is string => !!p);
  const pathsKey = paths.join("|");
  useEffect(() => {
    let cancelled = false;
    Promise.all(paths.map((p) => fetchAnnotations(p).then((a) => [p, a] as const).catch(() => [p, []] as const))).then((pairs) => {
      if (!cancelled) setTagsByPath(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey, diffBump]);

  return (
    <div className="detailsview">
      <table className="details">
        <thead>
          <tr>
            <th className="details-name">Name</th>
            <th className="details-kind">Kind</th>
            <th className="details-tags">Tags</th>
            <th className="details-size">Size</th>
          </tr>
        </thead>
        <tbody>
          {members.map((it, i) => {
            const l = it.link;
            if (!l) return null;
            const g = typeIcon(l.type ?? l.kind, l.format ?? null, l.concrete);
            const name = l.title ?? it.key;
            const tags = tagsByPath[l.path] ?? [];
            return (
              <tr
                key={`${l.path}#${i}`}
                className="details-row"
                onClick={() => onNavigate(l.path)}
                onContextMenu={openContextMenu ? (e) => { e.preventDefault(); openContextMenu(l.path, e.clientX, e.clientY); } : undefined}
                title={displayPath(l.path)}
              >
                <td className="details-name">
                  <span className={"details-icon " + g.cls} title={g.title}>{g.glyph}</span>
                  <span className="details-label">{name}</span>
                </td>
                <td className="details-kind">{kindLabel(it)}</td>
                <td className="details-tags">
                  {tags.map((a, j) => {
                    if (!a.tag) return null;
                    const color = resolveTagColor({ name: a.tag.name, color: a.tag.color });
                    return isColorTagPath(a.tag.path) ? (
                      <TagSwatch key={j} color={color} title={a.tag.name} />
                    ) : (
                      <span key={j} className="tagtag" style={{ background: color }}>
                        {a.tag.name}
                      </span>
                    );
                  })}
                </td>
                <td className="details-size">{sizeLabel(it)}</td>
              </tr>
            );
          })}
          {members.length === 0 && (
            <tr>
              <td className="details-empty" colSpan={4}>empty</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
