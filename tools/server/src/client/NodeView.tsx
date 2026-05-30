import { useEffect, useState } from "react";
import { fetchNode, fetchSchema, NodeJson } from "./api";
import { getRenderer } from "./renderers/registry";
import { Render } from "./render";

// yaml-schema (ours) is the default; yaml/json are the data, json-schema the
// standard JSON Schema. Each is one level deep with nested containers as links.
export type Format = "yaml-schema" | "yaml" | "json" | "json-schema";
export const FORMATS: Format[] = ["yaml-schema", "yaml", "json", "json-schema"];
export const DEFAULT_FORMAT: Format = "yaml-schema";

const isSchema = (f: Format) => f.includes("schema");
const syntaxOf = (f: Format): "yaml" | "json" => (f.startsWith("json") ? "json" : "yaml");

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
    if (isSchema(format)) {
      fetchSchema(path).then(setSchema).catch((e) => setError(e.message));
    } else if (node.type === "binary") {
      fetchNode(path, undefined, { binary: true }).then((n) => setBin(n.value)).catch((e) => setError(e.message));
    }
  }, [format, path, node]);

  if (error) return <div className="error">{error}</div>;
  if (!node) return <div className="loading">…</div>;

  const renderer = getRenderer(node);

  let content: unknown;
  let ready: boolean;
  if (isSchema(format)) {
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
          {FORMATS.map((f) => (
            <button key={f} className={"tab" + (format === f ? " active" : "")} onClick={() => onFormat(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {node.description && <p className="nodedesc">{node.description}</p>}

      {renderer && !isSchema(format) ? (
        renderer.render(node, onNavigate)
      ) : (
        <pre className="code">
          {ready ? <Render value={content} syntax={syntaxOf(format)} onNavigate={onNavigate} /> : "…"}
        </pre>
      )}
    </div>
  );
}
