/**
 * Renderer for a stored mail message (`message/rfc822` — a `.eml` file).
 *
 * It exists so the ARCHIVE NEED NOT DUPLICATE THE BODY. `mail2yamlover` used to write a
 * decoded `body.html` beside every `message.eml` purely so something could render it, which
 * meant an html-only newsletter landed as two copies of the same 19 KB. With this, the `.eml`
 * is the single copy and the renderer decodes it on the way to the screen.
 *
 * SAFETY. A mail archive is hostile content by nature. The HTML body renders inside an iframe
 * with an EMPTY sandbox — no scripts, and an opaque origin, so it cannot reach this page or
 * the `/api/*` surface behind it — and with a `default-src 'none'` CSP injected into the
 * document, so the tracking pixels that fill twenty-year-old spam cannot phone home. Inline
 * images that travel with the message (`cid:`) are resolved from its own parts into data URLs,
 * so a real newsletter still looks like one without a single network request leaving the page.
 */
import { useEffect, useMemo, useState } from "react";
import { NodeJson, blobUrl } from "../api";
import { displayPath } from "../paths";
import {
  MimePart,
  attachmentsOf,
  decodeWords,
  headerOf,
  parseEml,
  partText,
  pickBody,
  walkParts,
} from "./mime";

/** The headers a reader wants first; everything else hides behind the toggle. */
const PRIMARY = ["From", "To", "Cc", "Date", "Subject"];

/** Blocks every network fetch the body might attempt; `data:` is how inline images arrive. */
const BODY_CSP =
  "<meta http-equiv=\"Content-Security-Policy\" " +
  "content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function dataUrl(part: MimePart): string {
  let bin = "";
  for (const b of part.body) bin += String.fromCharCode(b);
  return `data:${part.contentType};base64,${btoa(bin)}`;
}

/** Resolve `cid:` references against the message's own parts, so inline images show without
 *  a network request. A `cid:` with no matching part is left alone and the CSP stops it. */
function inlineCids(html: string, root: MimePart): string {
  const byId = new Map<string, MimePart>();
  for (const p of walkParts(root)) {
    const id = headerOf(p.headers, "content-id");
    if (id) byId.set(id.replace(/^<|>$/g, ""), p);
  }
  if (byId.size === 0) return html;
  return html.replace(/(["'(])cid:([^"')\s]+)/gi, (all, open: string, id: string) => {
    const part = byId.get(id);
    return part ? `${open}${dataUrl(part)}` : all;
  });
}

export function EmlView({ node }: { node: NodeJson }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allHeaders, setAllHeaders] = useState(false);

  useEffect(() => {
    let live = true;
    setBytes(null);
    setError(null);
    fetch(blobUrl(node.path))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => live && setBytes(new Uint8Array(b)))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [node.path]);

  const msg = useMemo(() => (bytes ? parseEml(bytes) : null), [bytes]);
  const body = useMemo(() => (msg ? pickBody(msg) : null), [msg]);
  const attachments = useMemo(() => (msg && body ? attachmentsOf(msg, body) : []), [msg, body]);

  if (error) return <div className="eml-error">could not read the message: {error}</div>;
  if (!msg || !body) return <div className="loading">…</div>;

  const shown = allHeaders
    ? msg.headers
    : msg.headers.filter(([k]) => PRIMARY.some((p) => p.toLowerCase() === k.toLowerCase()));

  const srcdoc =
    body.html !== null
      ? BODY_CSP + inlineCids(partText(body.html), msg)
      : null;

  return (
    <div className="eml">
      <table className="eml-headers">
        <tbody>
          {shown.map(([k, v], i) => (
            <tr key={`${k}-${i}`}>
              <th>{k}</th>
              <td>{decodeWords(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="eml-toggle" onClick={() => setAllHeaders(!allHeaders)}>
        {allHeaders ? "fewer headers" : `all ${msg.headers.length} headers`}
      </button>

      {srcdoc !== null ? (
        // empty sandbox: no scripts, opaque origin — the body cannot reach this page
        <iframe
          className="eml-body"
          sandbox=""
          srcDoc={srcdoc}
          title={`${displayPath(node.path)} — body`}
        />
      ) : body.text !== null ? (
        <pre className="eml-body-text">{partText(body.text)}</pre>
      ) : (
        <div className="eml-empty">this message has no text body</div>
      )}

      {attachments.length > 0 && (
        <ul className="eml-attachments">
          {attachments.map((a, i) => (
            <li key={i}>
              <a href={dataUrl(a)} download={a.filename ?? `attachment-${i + 1}`}>
                {a.filename ?? `attachment ${i + 1}`}
              </a>{" "}
              <span className="eml-att-meta">
                {a.contentType} · {humanSize(a.body.length)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The same view inline in a chapter body. */
export function EmlChunk({ node }: { node: NodeJson }) {
  return <EmlView node={node} />;
}
