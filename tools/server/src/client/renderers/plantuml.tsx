import { deflateSync } from "fflate";
import { NodeJson } from "../api";
import { Chunk } from "./registry";

/**
 * The renderer for a `string`/`text/x-plantuml` node: PlantUML source shown as the
 * diagram it describes. Like the markdown/asciidoc renderers it works from the
 * node's string value, so it serves both a whole `.puml` file (`render`) and a
 * single inline chunk embedded in a chapter (`renderChunk`).
 *
 * PlantUML is a *language that compiles to a picture* — it can only be rendered by
 * a PlantUML server. So, exactly as every PlantUML integration does, the source is
 * deflate+encoded into a URL and handed to one as an `<img>`. The default is the
 * public server; point `VITE_PLANTUML_SERVER` at a self-hosted instance (e.g.
 * `docker run -d -p 8080:8080 plantuml/plantuml-server`) to keep diagrams off it.
 */
const PLANTUML_SERVER =
  ((import.meta as any).env?.VITE_PLANTUML_SERVER as string | undefined)?.replace(/\/+$/, "") ??
  "https://www.plantuml.com/plantuml";

// PlantUML's text transport: UTF-8 → raw DEFLATE → its own base64 variant (the
// alphabet `0-9 A-Z a-z - _`, three bytes packed into four 6-bit chars). The
// server inflates it back, so any valid DEFLATE stream is accepted — we let
// fflate compress and only reproduce PlantUML's character mapping.
function encode6bit(b: number): string {
  if (b < 10) return String.fromCharCode(48 + b);
  b -= 10;
  if (b < 26) return String.fromCharCode(65 + b);
  b -= 26;
  if (b < 26) return String.fromCharCode(97 + b);
  b -= 26;
  if (b === 0) return "-";
  if (b === 1) return "_";
  return "?";
}

function append3bytes(b1: number, b2: number, b3: number): string {
  const c1 = b1 >> 2;
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
  const c4 = b3 & 0x3f;
  return encode6bit(c1 & 0x3f) + encode6bit(c2 & 0x3f) + encode6bit(c3 & 0x3f) + encode6bit(c4 & 0x3f);
}

function encode64(data: Uint8Array): string {
  let r = "";
  for (let i = 0; i < data.length; i += 3) {
    if (i + 2 === data.length) r += append3bytes(data[i], data[i + 1], 0);
    else if (i + 1 === data.length) r += append3bytes(data[i], 0, 0);
    else r += append3bytes(data[i], data[i + 1], data[i + 2]);
  }
  return r;
}

/** The PlantUML server URL that renders `source` as an SVG diagram. */
export function plantumlUrl(source: string): string {
  const deflated = deflateSync(new TextEncoder().encode(source), { level: 9 });
  return `${PLANTUML_SERVER}/svg/${encode64(deflated)}`;
}

function Diagram({ source }: { source: string }) {
  return (
    <div className="filemedia">
      <img className="fileimage plantuml" src={plantumlUrl(source)} alt="PlantUML diagram" />
    </div>
  );
}

export function PlantumlView({ node }: { node: NodeJson }) {
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <Diagram source={String(node.value ?? "")} />
    </div>
  );
}

/** A diagram chunk embedded inline (the chapter supplies the number + anchor). */
export function PlantumlChunk({ chunk }: { chunk: Chunk }) {
  return <Diagram source={String(chunk.value ?? "")} />;
}
