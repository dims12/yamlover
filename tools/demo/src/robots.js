// The ORIGIN's crawl policy.
//
// It lives here rather than in the yamlover server because of where crawlers look: only
// `https://host/robots.txt` is ever read. The always-on sites are mounted under prefixes
// (`/docs`, `/examples`), so the `robots.txt` each of them serves sits at `/docs/robots.txt` and
// governs nobody. This front door is the only place that can speak for the origin — including
// declaring sitemaps that live under those prefixes, which the protocol allows precisely so a
// site assembled from several apps can still publish one policy.

/** The origin's robots.txt.
 *
 *  `sites` is the list of mounted always-on instances: `{ basePath }` each, in the order they
 *  should be declared. A disabled site contributes nothing — pointing a crawler at a sitemap
 *  that 404s is worse than staying quiet. */
export function robotsTxt(origin, sites) {
  const lines = [
    "# The always-on sites are single-page apps: their text is fetched from /api/content while",
    "# the page renders. Do NOT disallow /api/ — a crawler denied it indexes blank pages.",
    "User-agent: *",
    "Allow: /",
    "",
    "# Visitor demos are private, disposable instances handed out by email. Nothing here is",
    "# meant to be found in a search result, and they are deleted after a few days.",
    "Disallow: /demo/",
    "",
  ];
  for (const { basePath } of sites) lines.push(`Sitemap: ${origin}${basePath}/sitemap.xml`);
  lines.push("");
  return lines.join("\n");
}

/** The public origin a request arrived at, honouring the proxy headers — TLS terminates in front
 *  of this process, so the socket would report `http` for every request that was really `https`. */
export function originOf(req) {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "https";
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
  return `${proto}://${host}`;
}
