import { useEffect, useState } from "react";
import { unzipSync, strFromU8 } from "fflate";
import { NodeJson, blobUrl } from "../api";

const XLINK = "http://www.w3.org/1999/xlink";

/** Normalize a zip path: resolve `rel` (which may contain `..`/`.`) against the
 *  directory `baseDir`, dropping any fragment/query. */
function resolvePath(baseDir: string, rel: string): string {
  rel = decodeURIComponent(rel.split("#")[0].split("?")[0]);
  const parts = (baseDir ? baseDir.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

interface Book {
  title?: string;
  author?: string;
  cover?: string;
  html: string;
}

/**
 * Renderer for an `application/epub+zip` (`.epub`) ebook. The file is served as
 * bytes; here we unzip it, read the package document (OPF) for its metadata,
 * manifest and spine, then render the spine's XHTML documents in order — with
 * internal images rewired to object URLs and scripts/styles stripped.
 */
export function EpubView({ node }: { node: NodeJson }) {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    setBook(null);
    setError(null);

    fetch(blobUrl(node.path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled) return;
        const files = unzipSync(new Uint8Array(buf));
        const text = (p: string) => (files[p] ? strFromU8(files[p]) : "");
        const parseXml = (p: string) => new DOMParser().parseFromString(text(p), "application/xml");

        // container.xml → the OPF package document
        const opfPath = parseXml("META-INF/container.xml")
          .getElementsByTagNameNS("*", "rootfile")[0]
          ?.getAttribute("full-path");
        if (!opfPath || !files[opfPath]) throw new Error("no OPF package document");
        const opf = parseXml(opfPath);
        const opfDir = dirOf(opfPath);

        // object URL for a zip entry, memoized (and tracked for revocation)
        const cache = new Map<string, string>();
        const objUrl = (path: string, type = ""): string => {
          if (!files[path]) return "";
          const hit = cache.get(path);
          if (hit) return hit;
          const u = URL.createObjectURL(new Blob([files[path]], { type }));
          cache.set(path, u);
          urls.push(u);
          return u;
        };

        // metadata
        const title = opf.getElementsByTagNameNS("*", "title")[0]?.textContent?.trim();
        const author = Array.from(opf.getElementsByTagNameNS("*", "creator"))
          .map((c) => c.textContent?.trim())
          .filter(Boolean)
          .join(", ");

        // manifest: id → { href (zip path), type }
        const manifest = new Map<string, { path: string; type: string }>();
        for (const it of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
          const id = it.getAttribute("id");
          const href = it.getAttribute("href");
          if (id && href) manifest.set(id, { path: resolvePath(opfDir, href), type: it.getAttribute("media-type") || "" });
        }

        // cover image (EPUB2 `<meta name="cover">`)
        const coverId = Array.from(opf.getElementsByTagNameNS("*", "meta")).find(
          (m) => m.getAttribute("name") === "cover",
        )?.getAttribute("content");
        const coverItem = coverId ? manifest.get(coverId) : undefined;
        const cover = coverItem ? objUrl(coverItem.path, coverItem.type) : undefined;

        // spine: render each XHTML document in reading order
        const out: string[] = [];
        for (const ref of Array.from(opf.getElementsByTagNameNS("*", "itemref"))) {
          const item = manifest.get(ref.getAttribute("idref") || "");
          if (!item || !/html/.test(item.type) || !files[item.path]) continue;
          const docDir = dirOf(item.path);
          const dom = new DOMParser().parseFromString(strFromU8(files[item.path]), "text/html");
          const body = dom.body;
          if (!body) continue;
          body.querySelectorAll("script, style, link").forEach((e) => e.remove());
          for (const img of Array.from(body.querySelectorAll("img"))) {
            const src = img.getAttribute("src");
            const u = src ? objUrl(resolvePath(docDir, src)) : "";
            if (u) img.setAttribute("src", u);
            else img.removeAttribute("src");
          }
          for (const im of Array.from(body.querySelectorAll("image"))) {
            const href = im.getAttributeNS(XLINK, "href") || im.getAttribute("href") || im.getAttribute("xlink:href");
            const u = href ? objUrl(resolvePath(docDir, href)) : "";
            if (u) im.setAttributeNS(XLINK, "xlink:href", u);
          }
          out.push(`<section class="epub-doc">${body.innerHTML}</section>`);
        }

        if (cancelled) {
          urls.forEach(URL.revokeObjectURL);
          return;
        }
        setBook({ title, author: author || undefined, cover, html: out.join("\n") });
      })
      .catch((e) => !cancelled && setError(String((e as Error).message || e)));

    return () => {
      cancelled = true;
      urls.forEach(URL.revokeObjectURL);
    };
  }, [node.path]);

  if (error) return <div className="error">epub: {error}</div>;
  if (!book) return <div className="loading">unpacking EPUB…</div>;
  return (
    <div className="text epub">
      {book.cover && <img className="fb2-cover" src={book.cover} alt="" />}
      {book.title && <h1 className="chapter-title">{book.title}</h1>}
      {book.author && <p className="chapter-subtitle">{book.author}</p>}
      <div className="markup epub-body" dangerouslySetInnerHTML={{ __html: book.html }} />
    </div>
  );
}
