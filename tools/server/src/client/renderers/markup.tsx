import { useEffect, useState, MouseEvent } from "react";
import { Seg, strToSegs, segsToStr } from "../paths";
import { browserWidthCh, projectWidthCh, setBrowserSettingKey } from "../browser-settings";

/**
 * The rendered-HTML body for the markdown/asciidoc page views, plus the control that sets its
 * line-wrap measure. The reading width resolves in four layers, most specific first:
 *   1. `?width=<ch>` URL param — a per-page override, so a particular width is a shareable link
 *      (the CSV renderer keeps its options in the query the same way);
 *   2. the BROWSER SETTINGS document (browser-settings.ts) — the per-device layer: reading width
 *      is a viewer trait (screen, eyesight), so it lives in this browser, but as an inspectable
 *      yamlover document (the topbar's second gear), not an opaque storage key;
 *   3. the PROJECT settings' `width:` (a house-style suggestion, when authored);
 *   4. the built-in 72ch fallback.
 * Setting the width writes both the browser settings document (sticky) and the URL (shareable).
 * The control lives in the tab bar next to the renderer button (see NodeView), not in the body.
 * The chapter renderer reuses the same measure — its `config` control is this one, and
 * `markupWidthCh()` caps the `.chapter` page — so a reader's chosen width carries across markdown,
 * asciidoc, and chapters alike.
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

const inRange = (w: number) => Number.isFinite(w) && w >= MIN_CH && w <= MAX_CH;

/** The reading width in `ch`: URL `?width=` override → the browser settings document → the
 *  project settings → 72 (bad values ignored at every layer). */
export function markupWidthCh(): number {
  const url = Number(params().get("width"));
  if (inRange(url)) return url;
  return browserWidthCh() ?? projectWidthCh() ?? DEFAULT_WIDTH_CH;
}

/** Apply a width: persist it into the browser settings document (the per-device layer) and
 *  mirror it to the URL for sharing. */
function writeWidth(ch: number): void {
  setBrowserSettingKey("width", String(ch)); // tolerant of blocked storage (browser-settings.ts)
  const q = params();
  // Drop the URL param once it agrees with the sticky default (which is now `ch`) — keeps URLs clean
  // while navigation still recovers the width from the browser settings document.
  q.delete("width");
  if (ch !== DEFAULT_WIDTH_CH) q.set("width", String(ch));
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
