// HTML-clipboard paste: a selection copied from a web page (Wikipedia, docs, …) arrives as
// text/html alongside the plain text. When it carries STRUCTURE the plain flavor loses —
// images, headings — it becomes a RICH paste: headings nest subchapters (by level), images
// become separate chunks (downloaded in the browser — e.g. Wikimedia sends
// `access-control-allow-origin: *`), text blocks become marklower prose. Formatted text with
// no images/headings stays a plain text paste. Used by NodeView's paste listener.

import { inlineMd } from "./marklower-serialize";

/** The client-side draft: images still by URL (downloaded later by resolveImages). */
export interface RichDraft {
  title?: string;
  chunks: Array<{ text: string } | { image: { url: string; alt: string } }>;
  children: RichDraft[];
}

/** The wire payload for POST /api/paste {rich}: images resolved to inline file bytes. */
export interface RichNode {
  title?: string;
  chunks: Array<{ text: string } | { file: { name: string; contentBase64: string } }>;
  children: RichNode[];
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "image"; url: string; alt: string }
  | { kind: "text"; text: string };

const SKIP = new Set(["script", "style", "noscript", "template", "iframe", "svg", "head", "title"]);
const BLOCKS = new Set(["p", "div", "section", "article", "main", "aside", "header", "footer", "figure", "figcaption", "ul", "ol", "table", "thead", "tbody", "tr", "dl", "dt", "dd", "nav", "form", "body", "html"]);

/** Parse an HTML clipboard fragment into a chapter draft — or null when it has no images and
 *  no headings (plain formatted text: the normal text paste serves it better). */
export function htmlToRich(html: string): RichDraft | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = mergeBullets(blocksOf(doc.body));
  if (!blocks.some((b) => b.kind !== "text")) return null;

  // headings nest by level: deeper headings open children of the nearest shallower one
  const root: RichDraft = { chunks: [], children: [] };
  const stack: Array<{ node: RichDraft; level: number }> = [{ node: root, level: 0 }];
  for (const b of blocks) {
    if (b.kind === "heading") {
      while (stack.length > 1 && stack[stack.length - 1].level >= b.level) stack.pop();
      const child: RichDraft = { title: b.text || "Untitled", chunks: [], children: [] };
      stack[stack.length - 1].node.children.push(child);
      stack.push({ node: child, level: b.level });
    } else {
      const top = stack[stack.length - 1].node;
      top.chunks.push(b.kind === "image" ? { image: { url: b.url, alt: b.alt } } : { text: b.text });
    }
  }
  return root;
}

/** Walk the fragment in document order, flushing inline text at block boundaries. */
function blocksOf(body: HTMLElement): Block[] {
  const out: Block[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{2,}/g, "\n").trim();
    buf = "";
    if (t) out.push({ kind: "text", text: t });
  };
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      buf += n.textContent ?? "";
      return;
    }
    if (!(n instanceof Element)) return;
    const tag = n.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (/^h[1-6]$/.test(tag)) {
      flush();
      // Wikipedia headings carry an "[edit]" section link — noise in a title
      out.push({ kind: "heading", level: Number(tag[1]), text: (n.textContent ?? "").replace(/\[edit\]/gi, "").trim() });
      return;
    }
    if (tag === "img") {
      flush();
      const url = imageUrl(n);
      if (url) out.push({ kind: "image", url, alt: n.getAttribute("alt") ?? "" });
      return;
    }
    if (tag === "li") {
      // one bullet per line; images inside the item still surface as their own chunks
      flush();
      n.childNodes.forEach(walk);
      const t = buf.replace(/\s+/g, " ").trim();
      buf = "";
      if (t) out.push({ kind: "text", text: "- " + t });
      return;
    }
    if (tag === "pre") {
      flush();
      const t = (n.textContent ?? "").replace(/\n+$/, "");
      if (t.trim()) out.push({ kind: "text", text: "```\n" + t + "\n```" });
      return;
    }
    if (tag === "blockquote") {
      flush();
      n.childNodes.forEach(walk);
      const t = buf.trim();
      buf = "";
      if (t) out.push({ kind: "text", text: t.split("\n").map((l) => "> " + l).join("\n") });
      return;
    }
    if (tag === "br") {
      buf += "\n";
      return;
    }
    if (tag === "td" || tag === "th") {
      n.childNodes.forEach(walk);
      buf += " ";
      return;
    }
    if (BLOCKS.has(tag)) {
      flush();
      n.childNodes.forEach(walk);
      flush();
      return;
    }
    // an inline element: render to marklower — unless an image hides inside (then descend, so
    // the image becomes its own chunk rather than vanishing into the text)
    if (!n.querySelector("img")) {
      buf += inlineMd(n);
      return;
    }
    n.childNodes.forEach(walk);
  };
  walk(body);
  flush();
  return out;
}

/** A usable image URL: absolute http(s) or data:; protocol-relative gains https:; lazy-load
 *  attributes win over a missing/placeholder src; anything relative is dropped (a clipboard
 *  fragment has no base to resolve it against). */
function imageUrl(img: Element): string | null {
  const raw = img.getAttribute("src") || img.getAttribute("data-src") || "";
  if (raw.startsWith("//")) return "https:" + raw;
  if (/^https?:\/\//.test(raw) || raw.startsWith("data:image/")) return raw;
  return null;
}

/** Consecutive single-bullet blocks (one per <li>) merge into one list chunk. */
function mergeBullets(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.kind === "text" && b.text.startsWith("- ") && prev?.kind === "text" && prev.text.startsWith("- ")) {
      prev.text += "\n" + b.text;
    } else out.push(b);
  }
  return out;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tiff", "image/avif": "avif",
};

/** Download every image of a draft (order kept) into inline file chunks; a failed fetch
 *  degrades to a marklower image link, so the reference survives even when the bytes don't. */
export async function resolveImages(draft: RichDraft): Promise<RichNode> {
  return {
    title: draft.title,
    chunks: await Promise.all(
      draft.chunks.map(async (c) => {
        if ("text" in c) return { text: c.text };
        try {
          const res = await fetch(c.image.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          return { file: { name: imageName(c.image.url, blob.type), contentBase64: await blobBase64(blob) } };
        } catch {
          return { text: `![${c.image.alt}](${c.image.url})` };
        }
      }),
    ),
    children: await Promise.all(draft.children.map(resolveImages)),
  };
}

/** A filename for a downloaded image: the URL path's basename, extension from the MIME type
 *  when the URL has none (data: URLs, extensionless CDNs). */
function imageName(url: string, mime: string): string {
  let base = "";
  try {
    base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    /* data: or malformed — synthesize below */
  }
  if (!base || url.startsWith("data:")) base = "image";
  if (!/\.[A-Za-z0-9]{2,5}$/.test(base)) base += "." + (MIME_EXT[mime] || "bin");
  return base;
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("could not read image"));
    r.readAsDataURL(blob);
  });
}

/** How many images a draft holds (for the progress toast). */
export function countImages(draft: RichDraft): number {
  return draft.chunks.filter((c) => "image" in c).length + draft.children.reduce((n, k) => n + countImages(k), 0);
}
