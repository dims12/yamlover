import { NodeJson, blobUrl } from "../api";
import { displayPath } from "../paths";

/**
 * Renderer for a file-backed HTML document (`<iframe>`), pointing at the server's `/api/blob`
 * endpoint, which streams the file's raw bytes with its inferred Content-Type — so there is no
 * base64 round-trip through the JSON API. (Images live in `imagemap.tsx`: a pan/zoom viewer.)
 */
export function HtmlView({ node }: { node: NodeJson }) {
  // sandboxed: same-origin so the page's own CSS/images (served from /api/blob)
  // load, but no scripts run — a saved web page renders without taking over.
  return (
    <iframe
      className="filehtml"
      src={blobUrl(node.path)}
      sandbox="allow-same-origin"
      title={node.title ?? displayPath(node.path)}
    />
  );
}
