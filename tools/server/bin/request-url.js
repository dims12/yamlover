// The request TARGET → URL step, pulled out of the server so it can be tested without a socket.
//
// `new URL(target, "http://localhost")` is not safe on an untrusted request target. A target
// that begins with `//` is PROTOCOL-RELATIVE: `//:meta` parses as authority `:meta`, whose port
// is not a number, and the constructor THROWS. Thrown from inside the request listener, that is
// not a 400 — it is an unhandled exception, and the process exits. `GET //anything` was a
// one-request kill for any yamlover server, `npx yamlover` and the desktop app included.
//
// Such targets are not hypothetical: in-tree links used to render their canonical colon path
// straight into the href, so a crawler joining `dir + "/" + href` by hand asks for exactly
// `/docs//:meta` — which is how this was found, in the hosted docs instance's analytics.

/** The request target as a URL rooted at a dummy origin, or `null` when it cannot be one.
 *  A leading `//` is pinned to the origin so it stays a PATH; anything else still
 *  unparseable (an absolute-form target with a bad host, `*`, …) is the caller's 400. */
export function targetUrl(target) {
  const t = target ?? "";
  try {
    return new URL(t.startsWith("//") ? "http://localhost" + t : t, "http://localhost");
  } catch {
    return null;
  }
}

/** The target with `basePath` stripped (`--base-path`), as `{ url, rest }` — `rest` being the
 *  rewritten request target (path + query) for downstream handlers, which stay oblivious to the
 *  prefix. `null` when the target is outside the prefix (the caller's 404) or unparseable.
 *  With no base path the target is returned as it stands. */
export function stripBase(url, basePath) {
  if (!basePath) return { url, rest: url.pathname + url.search };
  const p = url.pathname;
  if (p !== basePath && !p.startsWith(basePath + "/")) return null;
  const rest = (p.slice(basePath.length) || "/") + url.search;
  const stripped = targetUrl(rest); // `/docs//:meta` leaves `//:meta` — the same trap again
  return stripped && { url: stripped, rest };
}
