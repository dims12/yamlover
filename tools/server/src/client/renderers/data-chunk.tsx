import { useEffect, useState } from "react";
import { NodeJson, fetchNode } from "../api";
import { Render, asLink } from "../render";

/**
 * A `!!yo` DATA ISLAND in a chapter body: the node opted out of the enclosing (chapter)
 * schema, so the GENERIC yamlover renderer draws it — the read-only data view embedded in
 * the page (the first embedding of {@link Render} outside the data view itself).
 *
 * A chapter fetches at depth 1, so the island normally arrives as a link marker and its
 * whole subtree is fetched by path — the TableChunk pattern; a marker already inlined by a
 * deeper fetch renders in place, no request. `anchors` stays off: the island's fragment ids
 * would collide with the chapter's own chunk anchors (the relations panel does the same).
 */
export function DataChunk({
  item,
  documentPath,
  onNavigate,
}: {
  item: unknown;
  documentPath?: string;
  onNavigate: (path: string) => void;
}) {
  const link = asLink(item);
  const path = link?.path ?? null;
  const [node, setNode] = useState<NodeJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (path == null) return;
    let cancelled = false;
    setNode(null);
    setError(null);
    fetchNode(path, null)
      .then((n) => !cancelled && setNode(n))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (link == null) {
    // already inlined by a deeper fetch — the marker itself is the value to draw
    return (
      <pre className="code chapter-data">
        <Render value={item} syntax="yaml" onNavigate={onNavigate} documentPath={documentPath ?? ":"} nodePath={documentPath ?? ":"} anchors={false} />
      </pre>
    );
  }
  if (error) return <p className="chapter-prose chapter-data-error">data island failed to load: {error}</p>;
  if (!node) return <p className="chapter-prose">…</p>;
  return (
    <pre className="code chapter-data">
      <Render
        value={node.value}
        comments={node.comments ?? undefined}
        syntax="yaml"
        onNavigate={onNavigate}
        documentPath={node.documentPath ?? path ?? ":"}
        nodePath={path ?? ":"}
        anchors={false}
      />
    </pre>
  );
}
