import { useEffect, useState } from "react";
import { NodeJson, blobUrl } from "../api";

const XLINK = "http://www.w3.org/1999/xlink";
// Characters illegal in XML 1.0 (control codes other than tab/newline/cr). FB2
// generators frequently leave these in; strict parsing rejects them, so drop.
// Built from an escaped string to keep literal control bytes out of the source.
const BAD_XML = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "g");

/** Decode the file's bytes using the encoding named in its XML declaration —
 *  FB2 is frequently windows-1251 (Cyrillic), not UTF-8 — then strip the stray
 *  control characters that would otherwise fail strict XML parsing. */
function decodeXml(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 256));
  const enc = (head.match(/encoding=["']([^"']+)["']/i)?.[1] || "utf-8").toLowerCase();
  let text: string;
  try {
    text = new TextDecoder(enc).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  return text.replace(BAD_XML, "");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Recursively turn an FB2 body element into HTML. `images` maps a `<binary>`
 *  id to a data URL. Switches on `localName`, so the FB2 namespace is ignored. */
function toHtml(node: Node, images: Map<string, string>): string {
  if (node.nodeType === 3) return esc(node.textContent || ""); // text
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const kids = () => Array.from(el.childNodes).map((n) => toHtml(n, images)).join("");
  switch (el.localName) {
    case "section": return `<section class="fb2-section">${kids()}</section>`;
    case "title": return `<div class="fb2-title">${kids()}</div>`;
    case "subtitle": return `<p class="fb2-subtitle">${kids()}</p>`;
    case "p": return `<p>${kids()}</p>`;
    case "empty-line": return "<br/>";
    case "emphasis": return `<em>${kids()}</em>`;
    case "strong": return `<strong>${kids()}</strong>`;
    case "strikethrough": return `<s>${kids()}</s>`;
    case "sub": return `<sub>${kids()}</sub>`;
    case "sup": return `<sup>${kids()}</sup>`;
    case "code": return `<code>${kids()}</code>`;
    case "epigraph":
    case "cite": return `<blockquote class="fb2-cite">${kids()}</blockquote>`;
    case "text-author": return `<p class="fb2-text-author">${kids()}</p>`;
    case "poem": return `<div class="fb2-poem">${kids()}</div>`;
    case "stanza": return `<div class="fb2-stanza">${kids()}</div>`;
    case "v": return `<div class="fb2-v">${kids()}</div>`;
    case "a": return `<span class="fb2-a">${kids()}</span>`; // FB2 links are intra-doc
    case "image": {
      const href =
        el.getAttributeNS(XLINK, "href") || el.getAttribute("l:href") || el.getAttribute("href") || "";
      const src = images.get(href.replace(/^#/, ""));
      return src ? `<img class="fb2-img" src="${src}" alt=""/>` : "";
    }
    case "title-info":
    case "description":
    case "binary":
      return ""; // metadata / payload, not body prose
    default: return kids();
  }
}

interface Book {
  title?: string;
  author?: string;
  cover?: string;
  html: string;
}

/**
 * Renderer for an `application/x-fictionbook+xml` (`.fb2`) ebook. The file is
 * served as bytes; here we decode it (honoring its declared encoding), parse the
 * FictionBook XML, and present the book — cover, title, author, then the body
 * with its sections/paragraphs/poems and embedded images inlined.
 */
export function Fb2View({ node }: { node: NodeJson }) {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBook(null);
    setError(null);
    fetch(blobUrl(node.path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled) return;
        const doc = new DOMParser().parseFromString(decodeXml(buf), "application/xml");
        const perr = doc.getElementsByTagName("parsererror")[0];
        if (perr) throw new Error(perr.textContent?.trim().split("\n")[0] || "invalid FB2 XML");

        const images = new Map<string, string>();
        for (const b of Array.from(doc.getElementsByTagNameNS("*", "binary"))) {
          const id = b.getAttribute("id");
          if (id) {
            const ct = b.getAttribute("content-type") || "image/jpeg";
            images.set(id, `data:${ct};base64,${(b.textContent || "").replace(/\s+/g, "")}`);
          }
        }

        const ti = doc.getElementsByTagNameNS("*", "title-info")[0] as Element | undefined;
        const at = (e: Element | undefined, name: string) =>
          e?.getElementsByTagNameNS("*", name)[0]?.textContent?.trim() || "";
        const title = at(ti, "book-title") || undefined;
        const author =
          ti &&
          Array.from(ti.getElementsByTagNameNS("*", "author"))
            .map((a) =>
              [at(a, "first-name"), at(a, "middle-name"), at(a, "last-name")]
                .filter(Boolean)
                .join(" ") || at(a, "nickname"),
            )
            .filter(Boolean)
            .join(", ");
        const coverImg = ti?.getElementsByTagNameNS("*", "coverpage")[0]?.getElementsByTagNameNS("*", "image")[0];
        const coverId = (
          coverImg?.getAttributeNS(XLINK, "href") || coverImg?.getAttribute("l:href") || ""
        ).replace(/^#/, "");

        const bodies = Array.from(doc.getElementsByTagNameNS("*", "body"));
        const main = bodies.find((b) => b.getAttribute("name") !== "notes") || bodies[0];
        const html = main ? Array.from(main.childNodes).map((n) => toHtml(n, images)).join("") : "";

        setBook({ title, author: author || undefined, cover: coverId ? images.get(coverId) : undefined, html });
      })
      .catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
    };
  }, [node.path]);

  if (error) return <div className="error">fb2: {error}</div>;
  if (!book) return <div className="loading">loading FB2…</div>;
  return (
    <div className="text fb2">
      {book.cover && <img className="fb2-cover" src={book.cover} alt="" />}
      {book.title && <h1 className="chapter-title">{book.title}</h1>}
      {book.author && <p className="chapter-subtitle">{book.author}</p>}
      <div className="markup fb2-body" dangerouslySetInnerHTML={{ __html: book.html }} />
    </div>
  );
}
