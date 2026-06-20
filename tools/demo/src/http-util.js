// Small request/response helpers shared by the router.

/** Read a request body as a string, rejecting once it exceeds `limit` bytes. */
export function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

/** A minimal styled status page (used for unknown/expired/at-capacity demo links). */
export function sendPage(res, status, title, message) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#1c1c1c}
h1{font-size:1.4rem;margin:0 0 .5rem}a{color:#2a6df4}p{color:#444}</style>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">← Request a demo</a></p>`);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Deliberately permissive — we send a confirmation email anyway, so the email itself
// is the real validation. Just reject the obviously-malformed.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s) => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s);

/** The client IP, honoring X-Forwarded-For (we sit behind Caddy in production). */
export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}
