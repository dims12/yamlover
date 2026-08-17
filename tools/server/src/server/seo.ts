// What crawlers get: the page inventory (`/sitemap.xml`), the crawl policy (`/robots.txt`), and
// the per-page `<head>` the SPA shell would otherwise never carry.
//
// The shell is one static file served at every route (bin/yamlover.js), so without this module
// every page of a 200-chapter book is `<title>yamlover</title>` and an empty `<div id="root">`.
// Google renders JS and would eventually see the real titles the client sets; nothing else does —
// not link unfurls, not the crawlers that feed answer engines. Injecting the head server-side is
// what makes a page legible to a reader who never runs the bundle.
//
// Everything here is PURE apart from `collectPages`, which reads one indexed query. No filesystem:
// `buildTree` would have been the obvious enumerator and is exactly the wrong one — its
// `concreteOf` stats every node, turning a whole-book walk into thousands of syscalls.

import { segsOfPath, segToken } from "../../../parser/ts/src/pathseg.ts";

/** A chapter and a task both ARE pages — a task's body is a chapter (chapter-model.ts). The
 *  format is stamped on the chapter CONTAINER, so this is a row-level test.
 *
 *  Not `type === "scalar"`: a titled chapter is an omni node carrying its title as a self-value
 *  AND its contents as entries, so `scalar` there means "has a self-value", not "is a leaf" — and
 *  an UNTITLED chapter is a `mapping`. Reading it as leafness would drop half the book. */
export function isChapter(format: string | null | undefined): boolean {
  return format === "x-yamlover-chapter" || format === "x-yamlover-task";
}

/** The `contain`-spine slice of Store this module reads — narrow on purpose, so the enumeration
 *  is testable against a literal instead of a live SQLite index. */
export interface TocSource {
  toc(path?: string, depth?: number): TocRow[];
}
export interface TocRow {
  path: string;
  format: string | null;
  children: TocRow[];
}

/** A node's title/description/format, looked up by store path (engine-api's `titleOf` /
 *  `descriptionOf` / the raw row). `format` is needed for the ROOT, whose own row `toc` does not
 *  return — and whether the root is a chapter is what decides where the book begins. */
export interface PageMeta {
  title(storePath: string): string | null;
  description(storePath: string): string | null;
  format(storePath: string): string | null;
}

export interface Page {
  /** the store path (`:language:vs-yaml`) */
  path: string;
  /** the URL tail the client routes on, percent-encoded and `/`-joined; "" for the root */
  slash: string;
  title: string | null;
  description: string | null;
}

/** A store path as the SLASH transport spelling the browser uses — the same conversion
 *  `urlOfPath` makes on the client, and the inverse of the server's `slashToSegs`. */
export function slashOfStorePath(p: string): string {
  return segsOfPath(p)
    .map((s) => encodeURIComponent(segToken(s)))
    .join("/");
}

/** The sitemap protocol's hard ceiling: 50 000 URLs (and 50 MB) per file. A book that big needs a
 *  sitemap INDEX, not a bigger sitemap — so stop at the limit and say so rather than emit a file
 *  every crawler rejects whole. */
export const SITEMAP_MAX_URLS = 50_000;

/** The pages worth offering a crawler: the root, then the CHAPTER SPINE beneath it, in book order.
 *
 *  Chapters only — deliberately. Every scalar in a yamlover tree is addressable, so "every node"
 *  would be a sitemap of hundreds of thousands of `:pets:0:name` leaves, each a fragment of a page
 *  rather than a page. A tree with no chapters (a plain data directory, the examples showcase)
 *  yields just the root, which is the honest answer: it has one page.
 *
 *  THE SPINE, not every chapter-shaped node anywhere. `x-yamlover-chapter` is a SHAPE — a node
 *  with a self-value and keyed entries — and things that are plainly not pages wear it: a table
 *  header cell with a `width:` attribute is stored as one, so a flat "collect every chapter"
 *  sweep of this book turned 200 real pages into 411, half of them cells inside a table inside a
 *  chapter. Descending only through chapters is also exactly how the TOC expands a chapter
 *  (buildTree shows subchapter children and stops), so the sitemap and the navigation agree.
 *
 *  Before the first chapter, though, descend through anything: a tree served from above the book
 *  (the repo root, with `docs/` inside it) still has to find where the book starts. */
export function collectPages(s: TocSource, meta: PageMeta, max = SITEMAP_MAX_URLS): { pages: Page[]; truncated: boolean } {
  const pages: Page[] = [];
  const page = (path: string): Page => ({
    path,
    slash: slashOfStorePath(path),
    title: meta.title(path),
    description: meta.description(path),
  });
  pages.push(page(":"));
  let truncated = false;
  // `toc` is ONE recursive CTE over the contain edges and already prunes hidden subtrees (the
  // `.yo` overlay), so the whole book arrives in a single query, pre-filtered.
  const walk = (rows: TocRow[], inBook: boolean): void => {
    for (const r of rows) {
      if (pages.length >= max) {
        truncated = true;
        return;
      }
      const chapter = isChapter(r.format);
      if (chapter) pages.push(page(r.path));
      if (chapter || !inBook) walk(r.children, inBook || chapter);
    }
  };
  walk(s.toc(":"), isChapter(meta.format(":")));
  return { pages, truncated };
}

const XML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (t: string): string => t.replace(/[&<>"']/g, (c) => XML_ESC[c]);

/** Absolute URL for a page: `<origin><basePath>/<slash>`. Absolute because the sitemap protocol
 *  requires it — a relative `<loc>` is not merely discouraged, it is rejected. */
export function pageUrl(origin: string, basePath: string, slash: string): string {
  return `${origin}${basePath}/${slash}`.replace(/\/+$/, "/");
}

export function sitemapXml(origin: string, basePath: string, pages: Page[], truncated = false): string {
  const urls = pages
    .map((p) => `  <url><loc>${xml(pageUrl(origin, basePath, p.slash))}</loc></url>`)
    .join("\n");
  const note = truncated
    ? `\n  <!-- truncated at ${SITEMAP_MAX_URLS} URLs, the sitemap protocol's per-file limit -->`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}${note}\n</urlset>\n`;
}

/** The crawl policy for a yamlover served at the ORIGIN ROOT.
 *
 *  Under `--base-path` this file is reachable but inert: crawlers read `/robots.txt` and nothing
 *  else, so a `/docs/robots.txt` governs nobody. The deployment that mounts sites under prefixes
 *  has to serve the origin's own robots.txt itself (tools/demo) and name these sitemaps there.
 *
 *  `/api/` is NOT disallowed, and that is the whole point of the comment baked into the output:
 *  the page text arrives over `/api/content`, so a crawler blocked from it renders every page
 *  empty. Blocking it is the single most tempting and most destructive line anyone could add. */
export function robotsTxt(sitemapUrl: string): string {
  return [
    "# Do NOT disallow /api/ — this is a single-page app and its text is fetched from",
    "# /api/content at render time. A crawler denied that endpoint indexes blank pages.",
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${sitemapUrl}`,
    "",
  ].join("\n");
}

const HTML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const attr = (t: string): string => t.replace(/[&<>"]/g, (c) => HTML_ESC[c]);

/** How much of a description survives into a meta tag. Search engines show ~155-160 characters;
 *  past that is weight with no effect. */
const DESC_MAX = 300;

/** The browser-tab title for a page: `<title> - <where it sits>`.
 *
 *  This reproduces, exactly, what the client sets once it renders (NodeView's document.title
 *  effect): the node's own title — else its bare name, else the site — then the site label
 *  followed by the node's ANCESTORS, the node itself omitted because it would repeat the name.
 *
 *  Exactly, not approximately. The served head and the rendered head describe the same page to
 *  the same crawler, moments apart; a title that changes under rendering is a discrepancy a
 *  search engine has every reason to distrust. `tokens` is the page's path segments, decoded. */
export function pageTitle(title: string | null, tokens: string[], siteName: string): string {
  const own = title?.trim() || tokens[tokens.length - 1] || siteName;
  if (tokens.length === 0) return own; // the root IS the site — ` - <site>` would just repeat it
  return `${own} - ${siteName}${tokens.slice(0, -1).map((t) => `: ${t}`).join("")}`;
}

/** The `<head>` tags for one page, as a string ready to splice into the shell. `title` is the
 *  finished tab title ({@link pageTitle}). */
export function headTags(opts: { title: string; description: string | null; canonical: string; siteName: string }): string {
  const full = opts.title;
  const desc = opts.description?.trim().replace(/\s+/g, " ").slice(0, DESC_MAX);
  const tags = [
    `<title>${attr(full)}</title>`,
    `<link rel="canonical" href="${attr(opts.canonical)}">`,
    `<meta property="og:title" content="${attr(full)}">`,
    `<meta property="og:url" content="${attr(opts.canonical)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${attr(opts.siteName)}">`,
  ];
  if (desc) {
    tags.splice(1, 0, `<meta name="description" content="${attr(desc)}">`);
    tags.push(`<meta property="og:description" content="${attr(desc)}">`);
  }
  return tags.join("");
}
