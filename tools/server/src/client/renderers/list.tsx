// The renderer for typographical LIST nodes (formats `x-yamlover-bullets` /
// `x-yamlover-numbered` — MARKLOWER.md §Lists): an ordinary yamlover list whose keyless
// entries are the items. An item is marklower prose, a `*` pointer (a link), or — when it
// is an untagged container — a nested sublist of the SAME kind: the list schema applies at
// any depth, until an explicit `!!<…>` tag switches (a tagged table inside an item renders
// as an inline grid).

import { useEffect, useState } from "react";
import { fetchNode, NodeJson } from "../api";
import { asLink, asMixed, asRef } from "../render";
import { childPath } from "./chapter-model";
import { MarklowerChunk } from "./marklower";
import { Grid } from "./table";
import { Chunk } from "./registry";

const MIXED_KEY = "$yamloverMixed";

export type ListKind = "bullets" | "numbered";

export const listKind = (format: string | null | undefined): ListKind =>
  format === "x-yamlover-numbered" ? "numbered" : "bullets";

function itemEntries(value: unknown): { key: string | null; value: unknown }[] {
  if (Array.isArray(value)) return value.map((v) => ({ key: null, value: v }));
  return (
    ((value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as
      | { entries?: { key: string | null; value: unknown }[] }
      | undefined)?.entries ?? []
  );
}

function ListItem({
  value,
  path,
  kind,
  documentPath,
  onNavigate,
}: {
  value: unknown;
  path: string;
  kind: ListKind;
  documentPath?: string;
  onNavigate: (path: string) => void;
}) {
  const ref = asRef(value);
  if (ref) {
    return ref.path ? (
      <a
        href="#"
        className="ref"
        onClick={(e) => {
          e.preventDefault();
          onNavigate(ref.path!);
        }}
      >
        {ref.text}
      </a>
    ) : (
      <span className="s">{ref.text}</span>
    );
  }
  const mixed = asMixed(value);
  if (mixed?.format === "x-yamlover-table") {
    // an explicitly tagged table inside a list item — an inline grid
    return <Grid value={value} path={path} documentPath={documentPath} onNavigate={onNavigate} caption />;
  }
  if (mixed || Array.isArray(value)) {
    // an untagged container item is a nested sublist of the SAME kind (any-depth rule);
    // a marker stamped with the other list format switches kind explicitly
    return (
      <ListBody
        value={value}
        path={path}
        kind={mixed?.format ? listKind(mixed.format) : kind}
        documentPath={documentPath}
        onNavigate={onNavigate}
      />
    );
  }
  const link = asLink(value);
  if (link) {
    return (
      <a
        href="#"
        className="ref"
        onClick={(e) => {
          e.preventDefault();
          onNavigate(link.path);
        }}
      >
        {link.title ?? link.path}
      </a>
    );
  }
  return (
    <MarklowerChunk
      chunk={{ value, path, type: "string", format: "text/marklower", documentPath }}
      onNavigate={onNavigate}
    />
  );
}

export function ListBody({
  value,
  path,
  kind,
  documentPath,
  onNavigate,
}: {
  value: unknown;
  path: string;
  kind: ListKind;
  documentPath?: string;
  onNavigate: (path: string) => void;
}) {
  const Tag = kind === "numbered" ? "ol" : "ul";
  return (
    <Tag className={`yl-list yl-list-${kind}`}>
      {itemEntries(value).map((e, i) => {
        if (e.key !== null) return null; // keyed fields have no list rendering
        const p = childPath(path, i);
        return (
          <li key={p} data-node-path={p}>
            <ListItem value={e.value} path={p} kind={kind} documentPath={documentPath} onNavigate={onNavigate} />
          </li>
        );
      })}
    </Tag>
  );
}

/** The full-page view. */
export function ListView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  return (
    <div className="yl-list-page">
      <ListBody value={node.value} path={node.path} kind={listKind(node.format)} documentPath={node.documentPath} onNavigate={onNavigate} />
    </div>
  );
}

/** The inline (chapter body / table cell) form. A chapter fetches at depth 1, so the list
 *  arrives as a link marker — fetch the whole subtree by path (the TableChunk precedent). */
export function ListChunk({ chunk, onNavigate }: { chunk: Chunk; onNavigate: (path: string) => void }) {
  const [node, setNode] = useState<NodeJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inline = asMixed(chunk.value) || Array.isArray(chunk.value); // already deep (a nested fetch)
  useEffect(() => {
    if (inline) return;
    let cancelled = false;
    fetchNode(chunk.path, null)
      .then((n) => !cancelled && setNode(n))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [chunk.path, inline]);

  const kind = listKind(chunk.format);
  if (inline) return <ListBody value={chunk.value} path={chunk.path} kind={kind} documentPath={chunk.documentPath} onNavigate={onNavigate} />;
  if (error) return <p className="csv-empty">list failed to load: {error}</p>;
  if (!node) return <p className="csv-empty">…</p>;
  return (
    <ListBody
      value={node.value}
      path={node.path}
      kind={listKind(node.format ?? chunk.format)}
      documentPath={node.documentPath ?? chunk.documentPath}
      onNavigate={onNavigate}
    />
  );
}
