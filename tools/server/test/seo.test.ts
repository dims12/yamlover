import { describe, it, expect } from "vitest";
import {
  collectPages,
  headTags,
  isChapter,
  pageUrl,
  pageTitle,
  robotsTxt,
  sitemapXml,
  slashOfStorePath,
  SITEMAP_MAX_URLS,
  type TocRow,
} from "../src/server/seo";

const chapter = (path: string, children: TocRow[] = []): TocRow => ({ path, format: "x-yamlover-chapter", children });
const plain = (path: string, children: TocRow[] = []): TocRow => ({ path, format: null, children });

/** The docs book in miniature: chapters nested under chapters, prose chunks between them, and a
 *  table whose header cells wear the chapter FORMAT without being pages. */
const BOOK: TocRow[] = [
  chapter(":language", [
    chapter(":language:vs-yaml"),
    plain(":language:0"), // a prose chunk — addressable, but not a page
    // a table inside the chapter. A header cell that carries a value AND an attribute
    // (`width: 2`) is stored with `format: x-yamlover-chapter` — the chapter SHAPE, nothing to
    // do with being a page. This is the real thing, from docs/language/logical-graph/values.
    {
      path: ":language:13",
      format: "x-yamlover-table",
      children: [chapter(":language:13:header:2"), chapter(":language:13:header:3")],
    },
  ]),
  { path: ":todo", format: "x-yamlover-task", children: [] },
];

/** A book root: it is itself a chapter, so the spine starts immediately. */
const meta = {
  title: (p: string) => (p === ":" ? "yamlover" : p === ":language" ? "The language" : null),
  description: (p: string) => (p === ":" ? "YAML with pointers" : null),
  format: (p: string) => (p === ":" ? "x-yamlover-chapter" : null),
};

describe("isChapter", () => {
  it("takes chapters and tasks — a task's body IS a chapter", () => {
    expect(isChapter("x-yamlover-chapter")).toBe(true);
    expect(isChapter("x-yamlover-task")).toBe(true);
  });

  it("rejects everything else, null and undefined included", () => {
    expect(isChapter(null)).toBe(false);
    expect(isChapter(undefined)).toBe(false);
    expect(isChapter("file/yaml")).toBe(false);
  });
});

describe("slashOfStorePath", () => {
  it("percent-encodes each token and joins with /", () => {
    expect(slashOfStorePath(":")).toBe("");
    expect(slashOfStorePath(":language:vs-yaml")).toBe("language/vs-yaml");
  });

  it("round-trips a key that CONTAINS a colon — the separator stays unambiguous", () => {
    // the whole point of the encoding: a `:` inside a key must not read as a separator, so the
    // slash form must split back into exactly the segments it came from
    const p = ":a:b\\:c";
    const back = ":" + slashOfStorePath(p).split("/").map(decodeURIComponent).join(":");
    expect(back).toBe(p);
    expect(slashOfStorePath(p).split("/")).toHaveLength(2);
  });
});

describe("collectPages", () => {
  it("emits the root plus the chapter spine, in book order", () => {
    const { pages, truncated } = collectPages({ toc: () => BOOK }, meta);
    expect(pages.map((p) => p.path)).toEqual([":", ":language", ":language:vs-yaml", ":todo"]);
    expect(truncated).toBe(false);
  });

  it("leaves out non-page nodes — a prose chunk is part of a page, not one", () => {
    const { pages } = collectPages({ toc: () => BOOK }, meta);
    expect(pages.map((p) => p.path)).not.toContain(":language:0");
  });

  // The defect this rule exists for: a flat "every chapter-formatted node" sweep of the real book
  // returned 411 pages for ~200 chapters, the surplus being table header cells.
  it("does NOT follow the chapter shape into a table's header cells", () => {
    const paths = collectPages({ toc: () => BOOK }, meta).pages.map((p) => p.path);
    expect(paths).not.toContain(":language:13:header:2");
    expect(paths).not.toContain(":language:13:header:3");
    expect(paths).not.toContain(":language:13");
  });

  it("finds a book mounted BELOW the root, when the root is not itself a chapter", () => {
    // serving the repo root, with the book in docs/ — descend until the spine starts, then
    // follow only chapters
    const tree: TocRow[] = [plain(":docs", [chapter(":docs:language", [chapter(":docs:language:vs-yaml")])])];
    const rootPlain = { ...meta, format: () => null };
    const { pages } = collectPages({ toc: () => tree }, rootPlain);
    expect(pages.map((p) => p.path)).toEqual([":", ":docs:language", ":docs:language:vs-yaml"]);
  });

  it("carries each page's slash, title and description", () => {
    const { pages } = collectPages({ toc: () => BOOK }, meta);
    expect(pages[0]).toEqual({ path: ":", slash: "", title: "yamlover", description: "YAML with pointers" });
    expect(pages[1]).toEqual({ path: ":language", slash: "language", title: "The language", description: null });
  });

  it("a tree with no chapters is one page, not zero", () => {
    const { pages } = collectPages({ toc: () => [plain(":a"), plain(":b")] }, meta);
    expect(pages.map((p) => p.path)).toEqual([":"]);
  });

  it("stops at the protocol's per-file limit and says so", () => {
    const many = Array.from({ length: 5 }, (_, i) => chapter(`:c${i}`));
    const { pages, truncated } = collectPages({ toc: () => many }, meta, 3);
    expect(pages).toHaveLength(3);
    expect(truncated).toBe(true);
    expect(SITEMAP_MAX_URLS).toBe(50_000);
  });
});

describe("pageUrl", () => {
  it("joins origin, base path and slash", () => {
    expect(pageUrl("https://h", "/docs", "language/vs-yaml")).toBe("https://h/docs/language/vs-yaml");
  });

  it("the root keeps ONE trailing slash, at the root and under a base path alike", () => {
    expect(pageUrl("https://h", "/docs", "")).toBe("https://h/docs/");
    expect(pageUrl("https://h", "", "")).toBe("https://h/");
  });
});

describe("sitemapXml", () => {
  const { pages } = collectPages({ toc: () => BOOK }, meta);

  it("lists every page as an absolute URL — a relative <loc> is rejected outright", () => {
    const xml = sitemapXml("https://yamlover.inthemoon.net", "/docs", pages);
    expect(xml).toContain("<loc>https://yamlover.inthemoon.net/docs/</loc>");
    expect(xml).toContain("<loc>https://yamlover.inthemoon.net/docs/language/vs-yaml</loc>");
    expect(xml.match(/<loc>/g)).toHaveLength(pages.length);
  });

  it("declares the sitemap namespace and the XML prolog", () => {
    const xml = sitemapXml("https://h", "", pages);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  });

  it("escapes XML metacharacters in a URL", () => {
    const xml = sitemapXml("https://h", "", [{ path: ":x", slash: "a&b", title: null, description: null }]);
    expect(xml).toContain("<loc>https://h/a&amp;b</loc>");
    expect(xml).not.toContain("<loc>https://h/a&b</loc>");
  });

  it("records a truncation in the file instead of trimming silently", () => {
    expect(sitemapXml("https://h", "", pages, true)).toContain("truncated at 50000 URLs");
  });
});

describe("robotsTxt", () => {
  it("names the sitemap and allows everything", () => {
    const txt = robotsTxt("https://h/docs/sitemap.xml");
    expect(txt).toContain("Sitemap: https://h/docs/sitemap.xml");
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Allow: /");
  });

  // THE defect this file exists to prevent. The pages' text arrives over /api/content at render
  // time, so a crawler denied that endpoint indexes an empty <div id="root"> for every URL — the
  // exact opposite of what adding a robots.txt is meant to achieve.
  it("never disallows /api/, and says why in the file itself", () => {
    const txt = robotsTxt("https://h/sitemap.xml");
    expect(txt).not.toMatch(/Disallow:\s*\/api/i);
    expect(txt).toContain("/api/content");
  });
});

// The served title must equal the one NodeView sets on render, character for character — a title
// that changes under rendering is a discrepancy a crawler has reason to distrust. These cases are
// read off NodeView.tsx's document.title effect.
describe("pageTitle", () => {
  it("names the page, then the site and the page's ANCESTORS", () => {
    expect(pageTitle("Comparison with YAML", ["language", "vs-yaml"], "yamlover")).toBe(
      "Comparison with YAML - yamlover: language",
    );
  });

  it("omits the node's own segment from the location — it would repeat the name", () => {
    expect(pageTitle("The language", ["language"], "yamlover")).toBe("The language - yamlover");
  });

  it("the root is the site — no ` - <site>` suffix repeating itself", () => {
    expect(pageTitle("yamlover", [], "yamlover")).toBe("yamlover");
    expect(pageTitle(null, [], "yamlover")).toBe("yamlover");
  });

  it("an untitled page falls back to its own bare name, not to the site", () => {
    expect(pageTitle(null, ["language", "notes"], "yamlover")).toBe("notes - yamlover: language");
    expect(pageTitle("   ", ["language", "notes"], "yamlover")).toBe("notes - yamlover: language");
  });

  it("spells a deep location as the whole ancestor chain", () => {
    expect(pageTitle("Values", ["language", "logical-graph", "values"], "yamlover")).toBe(
      "Values - yamlover: language: logical-graph",
    );
  });
});

describe("headTags", () => {
  const base = { canonical: "https://h/docs/language", siteName: "yamlover" };

  it("titles the page with the finished tab title", () => {
    const html = headTags({ ...base, title: "The language - yamlover", description: null });
    expect(html).toContain("<title>The language - yamlover</title>");
  });

  it("emits the canonical URL — the query string is already off it, so ?format= collapses here", () => {
    const html = headTags({ ...base, title: "x", description: null });
    expect(html).toContain('<link rel="canonical" href="https://h/docs/language">');
    expect(html).toContain('<meta property="og:url" content="https://h/docs/language">');
  });

  it("carries the description to both the meta tag and Open Graph", () => {
    const html = headTags({ ...base, title: "x", description: "Pointers,\n  and how they   resolve" });
    // collapsed to single spaces — a description is one line by the time it reaches a search result
    expect(html).toContain('<meta name="description" content="Pointers, and how they resolve">');
    expect(html).toContain('<meta property="og:description" content="Pointers, and how they resolve">');
  });

  it("omits the description tags entirely when there is none to give", () => {
    const html = headTags({ ...base, title: "x", description: null });
    expect(html).not.toContain('name="description"');
    expect(html).not.toContain("og:description");
  });

  it("caps a long description rather than shipping a page of prose in a meta tag", () => {
    const html = headTags({ ...base, title: "x", description: "y".repeat(500) });
    expect(html).toContain("y".repeat(300));
    expect(html).not.toContain("y".repeat(301));
  });

  it("escapes a quote or an angle bracket, so a title cannot break out of the attribute", () => {
    const html = headTags({ ...base, title: 'He said "<b>no</b>"', description: null });
    expect(html).toContain("<title>He said &quot;&lt;b&gt;no&lt;/b&gt;&quot;</title>");
    expect(html).toContain('content="He said &quot;&lt;b&gt;no&lt;/b&gt;&quot;"');
  });
});
