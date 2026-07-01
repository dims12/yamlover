// The single HTML → marklower reverse serializer, shared by the clipboard paste path
// (paste-html.ts) and the unlocked WYSIWYG chunk editor (renderers/marklower.tsx). Keeping ONE
// serializer means paste and edit agree on the markup they emit (bold→**, em→*, code→`…`,
// strike→~~, link→[t](target)).

// Elements whose content never contributes text.
const SKIP = new Set(["script", "style", "noscript", "template", "iframe", "head", "title"]);

/** One inline node → marklower. An element carrying `data-src` is an ATOMIC token the editor
 *  rendered from marklower (math `$$…$$`, `` `code` ``, or a `[label](target)` link): its source is
 *  returned verbatim, so a round-trip through the editor never re-parses (and never corrupts) it.
 *  Everything else maps by tag; unknown inline tags pass their children through. */
export function inlineMd(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? "";
  if (!(n instanceof Element)) return "";
  const src = n.getAttribute("data-src");
  if (src != null) return src; // an atomic token — verbatim marklower source
  const tag = n.tagName.toLowerCase();
  if (SKIP.has(tag)) return "";
  if (tag === "br") return "\n";
  const inner = Array.from(n.childNodes).map(inlineMd).join("");
  if (tag === "a") {
    const href = n.getAttribute("href") ?? "";
    const t = inner.trim();
    return /^https?:\/\//.test(href) && t ? `[${t}](${href})` : inner;
  }
  if (tag === "strong" || tag === "b") return inner.trim() ? `**${inner.trim()}**` : "";
  if (tag === "em" || tag === "i") return inner.trim() ? `*${inner.trim()}*` : "";
  if (tag === "code") return inner.trim() ? "`" + inner.trim() + "`" : "";
  if (tag === "del" || tag === "s" || tag === "strike") return inner.trim() ? `~~${inner.trim()}~~` : "";
  return inner;
}

/** A contentEditable subtree → marklower text. A chunk is inline-only markup, but the browser
 *  wraps visual line breaks in `<div>`/`<p>` (and stray `<br>`s), so block children start fresh
 *  lines; inline content is delegated to {@link inlineMd}. Leading/trailing blank lines are
 *  trimmed so an editor's incidental wrapper markup doesn't grow the source. */
export function domToMarklower(root: Node): string {
  const parts: string[] = [];
  const walk = (el: Node): void => {
    for (const n of Array.from(el.childNodes)) {
      if (n instanceof HTMLElement && (n.tagName === "DIV" || n.tagName === "P")) {
        parts.push("\n");
        walk(n);
      } else {
        parts.push(inlineMd(n));
      }
    }
  };
  walk(root);
  return parts.join("").replace(/^\n+/, "").replace(/\n+$/, "");
}
