import { useEffect } from "react";

/**
 * Shared heading machinery for the rendered-markup formats (Markdown and AsciiDoc).
 *
 * A `.md`/`.adoc` page is a single HTML blob dumped via `dangerouslySetInnerHTML`,
 * so on its own a heading is not addressable. {@link anchorizeHeadings} gives every
 * heading a stable `id` and a small `§` link to it, mirroring the way GitHub renders
 * the same documents — so a deep link like `<page>#<slug>` lands on, and scrolls to,
 * one section. This is the prose-document counterpart of the chapter renderer's `§N`
 * chunk anchors (see `chapter.tsx`): there the locator is the chunk's path; here it
 * is the heading's slug.
 */

/** GitHub-style slug of a heading's text: lowercase, punctuation dropped, runs of
 *  whitespace collapsed to single hyphens. Unicode letters/numbers are kept. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** `base`, suffixed `-2`, `-3`, … until it is not already in `used` (which it is
 *  then added to). Empty `base` (a heading with no sluggable text) yields "". */
function uniqueId(base: string, used: Set<string>): string {
  if (!base) return "";
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/** Give every heading in a block of rendered markup an `id` and a leading `§`
 *  anchor link to it (placed first so it sits in the left gutter, like a chapter
 *  chunk's `§N` index). An id already present (Asciidoctor stamps section ids) is
 *  kept — so its anchor matches the document's own cross-references — otherwise a
 *  de-duplicated slug of the heading text is assigned. Returns the rewritten HTML.
 *  Runs in the browser/jsdom; with no `DOMParser` (or no headings) it is a no-op. */
export function anchorizeHeadings(html: string): string {
  if (typeof DOMParser === "undefined" || !html.includes("<h")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const used = new Set<string>();
  for (const h of doc.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    // slug from the text before inserting the anchor, so the `§` is not part of it
    const id = uniqueId(h.id || slugify(h.textContent ?? ""), used);
    if (!id) continue;
    h.id = id;
    const a = doc.createElement("a");
    a.className = "header-anchor";
    a.href = `#${id}`;
    a.setAttribute("aria-label", "Link to this section");
    a.textContent = "§";
    h.insertBefore(a, h.firstChild);
  }
  return doc.body.innerHTML;
}

/** Scroll to the element named by the URL hash once `dep` (the rendered node)
 *  settles. A deep link `<page>#<slug>` lands on the page, but the value is fetched
 *  async — after the browser's own one-shot scroll — so re-scroll when it arrives.
 *  The same pattern the chapter renderer uses for `#/chunks[n]`. */
export function useHashScroll(dep: unknown): void {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [dep]);
}
