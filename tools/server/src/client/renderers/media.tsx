import { NodeJson, blobUrl } from "../api";
import { Chunk } from "./registry";

/**
 * Renderers for file-backed binary nodes that the browser shows natively: an
 * image (`<img>`) and an HTML document (`<iframe>`). Both point at the server's
 * `/api/blob` endpoint, which streams the file's raw bytes with its inferred
 * Content-Type — so there is no base64 round-trip through the JSON API.
 */
export function ImageView({ node }: { node: NodeJson }) {
  return (
    <div className="filemedia">
      <img className="fileimage" src={blobUrl(node.path)} alt={node.title ?? node.path} />
    </div>
  );
}

/** An image embedded inline in another page (e.g. a chapter chunk): the same
 *  `/api/blob` bytes, addressed by the chunk's own node path. */
export function ImageChunk({ chunk }: { chunk: Chunk }) {
  return (
    <div className="filemedia">
      <img className="fileimage" src={blobUrl(chunk.path)} alt={chunk.path} />
    </div>
  );
}

export function HtmlView({ node }: { node: NodeJson }) {
  // sandboxed: same-origin so the page's own CSS/images (served from /api/blob)
  // load, but no scripts run — a saved web page renders without taking over.
  return (
    <iframe
      className="filehtml"
      src={blobUrl(node.path)}
      sandbox="allow-same-origin"
      title={node.title ?? node.path}
    />
  );
}
