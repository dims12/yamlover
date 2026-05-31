import { useEffect, useState } from "react";
import { fetchNode, fetchSchema, NodeJson } from "./api";
import { getRenderer } from "./renderers/registry";
import { Render } from "./render";

// yaml-schema (ours) is the default; yaml/json are the data, json-schema the
// standard JSON Schema. Each is one level deep with nested containers as links.
// A node with a renderer also offers a tab keyed by the renderer's *name* (e.g.
// `chapter`) — the rendered view, and that node's default representation.
export type Format = "yaml-schema" | "yaml" | "json" | "json-schema" | (string & {});
export const FORMATS: Format[] = ["yaml-schema", "yaml", "json", "json-schema"];
export const DEFAULT_FORMAT: Format = "yaml-schema";

const isStandard = (f: Format) => (FORMATS as string[]).includes(f);
const isSchema = (f: Format) => f.includes("schema");
const syntaxOf = (f: Format): "yaml" | "json" => (f.startsWith("json") ? "json" : "yaml");

/** The representation actually shown: the requested `format` if it is a standard
 *  view or this node's renderer name; otherwise the node's default (its renderer's
 *  view, else `yaml-schema`). Guards a stale renderer-name format (e.g. a
 *  hand-edited URL, or one carried onto a node with no such renderer). */
function effectiveFormat(format: Format, renderer: { name: string } | null): Format {
  if (isStandard(format)) return format;
  if (renderer && format === renderer.name) return format;
  return renderer ? renderer.name : DEFAULT_FORMAT;
}

interface Props {
  path: string;
  format: Format;
  onFormat: (f: Format) => void;
  onNavigate: (path: string) => void;
}

/** The RHS pane: one node shown in the selected representation. Every
 *  representation is one level deep; nested objects/arrays appear as
 *  `{ N keys }` / `[ M elements ]` hyperlinks you click to descend. */
export function NodeView({ path, format, onFormat, onNavigate }: Props) {
  const [node, setNode] = useState<NodeJson | null>(null); // header + data value
  const [schema, setSchema] = useState<unknown>(null);
  const [bin, setBin] = useState<unknown>(null); // base64 payload for a binary leaf
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setNode(null);
    fetchNode(path).then(setNode).catch((e) => setError(e.message));
  }, [path]);

  useEffect(() => {
    setSchema(null);
    setBin(null);
    if (!node) return;
    const r = getRenderer(node);
    const eff = effectiveFormat(format, r);
    if (r && eff === r.name) return; // the rendered view reads node.value (already fetched)
    if (isSchema(eff)) {
      fetchSchema(path).then(setSchema).catch((e) => setError(e.message));
    } else if (node.type === "binary") {
      fetchNode(path, undefined, { binary: true }).then((n) => setBin(n.value)).catch((e) => setError(e.message));
    }
  }, [format, path, node]);

  if (error) return <div className="error">{error}</div>;
  if (!node) return <div className="loading">…</div>;

  const renderer = getRenderer(node);
  // The renderer adds its own tab (its name), which is this node's default; the
  // standard representations follow.
  const tabs: Format[] = renderer ? [renderer.name, ...FORMATS] : FORMATS;
  const effective = effectiveFormat(format, renderer);
  const showRendered = renderer != null && effective === renderer.name;

  let content: unknown;
  let ready: boolean;
  if (showRendered) {
    content = node.value;
    ready = true;
  } else if (isSchema(effective)) {
    content = schema;
    ready = schema != null;
  } else if (node.type === "binary") {
    content = bin;
    ready = bin != null;
  } else {
    content = node.value;
    ready = true;
  }

  return (
    <div className="nodeview">
      <div className="nodehead">
        <div className="nodemeta">
          <span className="tag">{node.type}</span>
          {node.concrete && <span className="tag dim">{node.concrete}</span>}
        </div>
        <div className="tabs">
          {tabs.map((f) => (
            <button key={f} className={"tab" + (effective === f ? " active" : "")} onClick={() => onFormat(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* a renderer presents the node's own title/description; the default view
          shows the description here as a subtitle above the value */}
      {!showRendered && node.description && <p className="nodedesc">{node.description}</p>}

      {showRendered ? (
        renderer!.render(node, onNavigate)
      ) : (
        <pre className="code">
          {/* data views lead with the relations panel (named up-edges + `..`),
              an <hr/>, then the value; schema views embed rel inline already */}
          {!isSchema(effective) && node.relations && Object.keys(node.relations).length > 0 && (
            <>
              <Render value={node.relations} syntax={syntaxOf(effective)} onNavigate={onNavigate} />
              <hr className="reldiv" />
            </>
          )}
          {ready ? <Render value={content} syntax={syntaxOf(effective)} onNavigate={onNavigate} /> : "…"}
        </pre>
      )}
    </div>
  );
}
