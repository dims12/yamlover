import { useEffect, useState } from "react";
import { NodeJson, blobUrl } from "../api";
// The DjVu.js library (GPL-v2), vendored as a prebuilt IIFE bundle. Loaded as a
// classic <script> so its `var DjVu = (…)()` lands on the global scope; see
// vendor/README.md for provenance and license.
import djvuScriptUrl from "../vendor/djvu.js?url";

declare global {
  interface Window {
    DjVu?: any;
  }
}

let loading: Promise<any> | null = null;
/** Inject the vendored bundle once; resolve with the global `DjVu` namespace. */
function loadDjVu(): Promise<any> {
  if (window.DjVu) return Promise.resolve(window.DjVu);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = djvuScriptUrl;
      s.onload = () => (window.DjVu ? resolve(window.DjVu) : reject(new Error("DjVu failed to load")));
      s.onerror = () => reject(new Error("could not load djvu.js"));
      document.head.appendChild(s);
    });
  }
  return loading;
}

/**
 * Renders an `image/vnd.djvu` document. The browser has no native DjVu support,
 * so we decode it client-side with DjVu.js: fetch the bytes from `/api/blob`,
 * build a `DjVu.Document`, and render each page to a PNG object-URL shown as an
 * `<img>` (cheaper than holding every page as a full-resolution canvas).
 */
export function DjvuView({ node }: { node: NodeJson }) {
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    setPages([]);
    setError(null);
    (async () => {
      const DjVu = await loadDjVu();
      const buf = await fetch(blobUrl(node.path)).then((r) => r.arrayBuffer());
      const doc = new DjVu.Document(buf);
      const count = doc.getPagesQuantity();
      const urls: string[] = [];
      for (let i = 1; i <= count && !cancelled; i++) {
        const page = await doc.getPage(i);
        const { url } = await page.createPngObjectUrl();
        urls.push(url);
        created.push(url);
      }
      if (cancelled) created.forEach(URL.revokeObjectURL);
      else setPages(urls);
    })().catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
      created.forEach(URL.revokeObjectURL);
    };
  }, [node.path]);

  if (error) return <div className="error">djvu: {error}</div>;
  if (pages.length === 0) return <div className="loading">decoding djvu…</div>;
  return (
    <div className="filedjvu">
      {pages.map((url, i) => (
        <img key={i} className="fileimage" src={url} alt={`page ${i + 1}`} />
      ))}
    </div>
  );
}
