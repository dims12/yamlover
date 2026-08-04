// THE RETIRED WIRE'S CALL SHAPE — `nodeJson(h, { path, depth, binary })` replays the old
// `call(h, "/api/json", …)` ergonomics over the ONE WIRE: GET /api/content + the CLIENT
// derivation (decodeEnvelope + deriveNodeJson) — exactly what `fetchNode` runs in the
// browser, so every suite migrated onto this helper keeps asserting the projection the
// renderers actually see. `binary: "1"` replays the old byte splice via /api/blob, the way
// fetchNode's `binary` option does.
import type { IncomingMessage, ServerResponse } from "node:http";
import { callBytes, callText } from "./http";
import { decodeEnvelope } from "../src/client/content";
import { deriveNodeJson } from "../src/client/derive-node";
import { strToSegs, segsToStr } from "../src/client/paths";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

export interface NodeJsonParams {
  path: string;
  depth?: string; // the old query spelling: a number, or ".inf"
  binary?: string; // "1" → splice the base64 payload (the retired ?binary=1 contract)
  comments?: string; // accepted for call-site compatibility; comments always derive
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nodeJson(h: Handler, params: NodeJsonParams): Promise<{ status: number; json: any }> {
  // the slash spelling — fetchContent's mapping verbatim (a `:` inside a token stays encoded)
  const slash = segsToStr(strToSegs(params.path)).slice(1).split(":").join("/");
  const q: Record<string, string> = params.depth !== undefined ? { depth: params.depth } : {};
  const r = await callText(h, `/api/content${slash ? "/" + slash : ""}`, q);
  if (r.status !== 200) {
    let json: unknown = { error: r.text };
    try { json = JSON.parse(r.text); } catch { /* not JSON — keep the raw text as the error */ }
    return { status: r.status, json };
  }
  const content = decodeEnvelope(r.text);
  const depth = params.depth === undefined ? undefined : params.depth === ".inf" ? null : Number(params.depth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = deriveNodeJson(content, depth) as any;
  if (params.binary === "1") {
    const b = await callBytes(h, "/api/blob", { path: params.path });
    const payload = { format: json.format ?? null, size: b.bytes.length, base64: b.bytes.toString("base64") };
    if (json.type === "binary") json.value = { $yamloverBinary: payload };
    else {
      // a blob-backed OMNI (overlay entries on an image): bytes fill the mixed self-value slot
      const marker = (json.value as Record<string, { value?: unknown }> | null)?.$yamloverMixed;
      if (marker) marker.value = { $yamloverBinary: payload };
    }
  }
  return { status: 200, json };
}
