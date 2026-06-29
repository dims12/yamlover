import { useEffect, useState, MouseEvent } from "react";
import { Seg, strToSegs, segsToStr } from "../paths";

/**
 * The rendered-HTML body for the markdown/asciidoc page views, plus the control that sets its
 * line-wrap measure. The **reading width is a URL parameter** — `?width=<ch>`, alongside
 * `?format=` — so a particular width is a shareable link (the CSV renderer keeps its options in
 * the query the same way). Default 72ch. The control lives in the tab bar next to the renderer
 * button (see NodeView), not in the body. Chapter *chunks* render plain `.markup`, unaffected.
 */

/** A URL that is already absolute and must be left untouched: it carries a scheme
 *  (`http:`, `data:`, `mailto:`…), is protocol-relative (`//host`), is server-root
 *  (`/x`), or is a bare fragment (`#sec`). Everything else is a path *relative to the
 *  document file*, the way a `src`/`href` is written in a repo. (Shared by the `<img>`
 *  rewrite in text.tsx and the `<a>` rewrite here.) */
export const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Resolve a relative URL as written in a Markdown/AsciiDoc file (`images/x.png`,
 *  `../a/b.md`) against the DIRECTORY of the document it appears in (`anchorPath` =
 *  the file's JSON-space path), the way GitHub resolves a relative link. Returns the
 *  resolved JSON-space segments, or null for absolute/scheme/fragment URLs or when
 *  there is no anchor to resolve against. */
export function relativeDocSegs(url: string, anchorPath?: string): Seg[] | null {
  if (!anchorPath) return null;
  const u = url.trim();
  if (!u || ABSOLUTE_URL.test(u)) return null;
  const path = u.split(/[?#]/, 1)[0]; // drop any ?query / #fragment before resolving
  const segs: Seg[] = strToSegs(anchorPath).slice(0, -1); // the file's directory
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(safeDecode(part));
  }
  return segs;
}

/** Rewrite every relative `<a href>` in rendered Markdown/AsciiDoc to the **in-app
 *  JSON-space path** of the node it targets — anchored at the document file, GitHub
 *  style, the same resolution the `<img>` rewrite uses — and tag it `data-navpath`
 *  so {@link markupClick} turns the click into in-app (SPA) navigation instead of a
 *  full page load. Absolute, scheme, server-root, and `#fragment` links are left
 *  untouched (external links open normally; heading `§`/fragment links keep scrolling).
 *  Done on the parsed DOM, not by string surgery. */
export function rewriteRelativeLinks(html: string, anchorPath?: string): string {
  if (!anchorPath || !html.includes("<a")) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const a of tpl.content.querySelectorAll("a[href]")) {
    const segs = relativeDocSegs(a.getAttribute("href") || "", anchorPath);
    if (!segs) continue;
    const path = segsToStr(segs);
    a.setAttribute("href", path);
    a.setAttribute("data-navpath", path);
  }
  return tpl.innerHTML;
}

/** A click handler for a rendered-HTML body: when an in-app link (one carrying a
 *  `data-navpath` from {@link rewriteRelativeLinks}) is clicked, navigate within the
 *  app rather than reloading the page. External / fragment links — and modified
 *  (new-tab / middle / ctrl / meta) clicks — fall through to the browser. */
export function markupClick(onNavigate?: (path: string) => void) {
  return (e: MouseEvent) => {
    if (!onNavigate || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest?.("a[data-navpath]");
    if (!a) return;
    e.preventDefault();
    onNavigate(a.getAttribute("data-navpath")!);
  };
}

const DEFAULT_WIDTH_CH = 72;
const MIN_CH = 20;
const MAX_CH = 400;
const params = () => new URLSearchParams(window.location.search);

/** The reading width in `ch` from the URL's `?width=`, or the default (out-of-range ignored). */
export function markupWidthCh(): number {
  const w = Number(params().get("width"));
  return Number.isFinite(w) && w >= MIN_CH && w <= MAX_CH ? w : DEFAULT_WIDTH_CH;
}

function writeWidth(ch: number): void {
  const q = params();
  if (ch === DEFAULT_WIDTH_CH) q.delete("width");
  else q.set("width", String(ch));
  const qs = q.toString();
  window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
}

/** The markdown/asciidoc body at the URL-configured reading width. In-app links
 *  (those carrying `data-navpath`) navigate via `onNavigate` instead of reloading. */
export function Markup({ html, onNavigate }: { html: string; onNavigate?: (path: string) => void }) {
  return (
    <div
      className="markup"
      style={{ maxWidth: `${markupWidthCh()}ch` }}
      onClick={markupClick(onNavigate)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * The width control beside the markdown/asciidoc renderer button (in the tab bar). It accepts
 * ANY input — a valid measure (20–400 ch) is applied to the URL and `rerender()` re-wraps the
 * body; an impossible/half-typed value is simply left unapplied and the field turns red (no
 * editing is blocked). No visible label: the hover title reads "width, ch".
 */
export function MarkupWidthControl({ rerender }: { rerender: () => void }) {
  const urlWidth = markupWidthCh();
  const [text, setText] = useState(String(urlWidth));
  useEffect(() => setText(String(urlWidth)), [urlWidth]); // resync when the URL changes (nav / apply)
  const n = Number(text);
  const valid = text.trim() !== "" && Number.isInteger(n) && n >= MIN_CH && n <= MAX_CH;
  return (
    <input
      className={"markup-width" + (valid ? "" : " invalid")}
      type="text"
      inputMode="numeric"
      title="width, ch"
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        const num = Number(v);
        if (v.trim() !== "" && Number.isInteger(num) && num >= MIN_CH && num <= MAX_CH) {
          writeWidth(num);
          rerender();
        }
      }}
    />
  );
}
