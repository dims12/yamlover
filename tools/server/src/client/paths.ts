// JSON-space path helpers. The CANONICAL client path is COLON-form (SEPARATOR.md M4):
// `:key[0]:sub`, root `:` — what the API speaks and the UI displays. The BROWSER URL
// stays SLASH-transported (`/key[0]/sub` — ruling: "the URL should be slashed, of
// course"), converted at this boundary only.
//
// A key may itself contain `:`, `/`, `[`, or `]` (e.g. `@vitejs/plugin-react`), so each
// key is percent-encoded (encodeURIComponent) — the structural separators then
// unambiguously tokenize, and the URL spelling is address-bar-safe as is.

import { BASE } from "./base"; // the served URL prefix (--base-path); "" at the root

export type Seg = string | number;

/** Canonical client path: `:key[0]:sub` (keys percent-encoded), root `:`. */
export function segsToStr(segs: Seg[]): string {
  return segs.map((s) => (typeof s === "number" ? `[${s}]` : `:${encodeURIComponent(s)}`)).join("") || ":";
}

const PATH_TOKEN = /\[\d+\]|[^:\[\]]+/g; // canonical (colon) form
const URL_TOKEN = /\[\d+\]|[^/\[\]]+/g; // URL (slash) transport form

export function strToSegs(str: string): Seg[] {
  const out: Seg[] = [];
  for (const tok of str.match(PATH_TOKEN) || []) {
    out.push(/^\[\d+\]$/.test(tok) ? Number(tok.slice(1, -1)) : safeDecode(tok));
  }
  return out;
}

/** Canonical key for cross-SCOPE comparison: collapse the colon scope ladder so a
 *  project ref (`::yamlover:…`), a document ref (`:yamlover:…`), and a server-echoed
 *  `:`-form path all compare equal. The ladder colons are not tokens (PATH_TOKEN), so
 *  re-emitting drops them; keys are normalized through one decode→encode pass. */
export function canonPath(p: string): string {
  return segsToStr(strToSegs(p));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The current JSON path taken from the browser URL (slash transport), in canonical
 *  COLON form. The pathname is already per-key-encoded, so it is tokenized *before*
 *  decoding — segments ride through encoded into the canonical string. */
export function pathFromUrl(): string {
  // Strip the served base prefix (--base-path) so its segments aren't read as node keys.
  let pathname = window.location.pathname;
  if (BASE && (pathname === BASE || pathname.startsWith(BASE + "/"))) pathname = pathname.slice(BASE.length) || "/";
  const segs: Seg[] = [];
  for (const tok of pathname.match(URL_TOKEN) || []) {
    segs.push(/^\[\d+\]$/.test(tok) ? Number(tok.slice(1, -1)) : safeDecode(tok));
  }
  return segsToStr(segs);
}

/** The slash-transport URL spelling of a canonical path (`:a[0]:b` → `/a[0]/b`). */
export function urlOfPath(path: string): string {
  const segs = strToSegs(path);
  const tail = segs.map((s) => (typeof s === "number" ? `[${s}]` : `/${encodeURIComponent(s)}`)).join("") || "/";
  return BASE + tail; // keep navigation under the served base prefix (--base-path)
}

/** The slash-form fragment continuation from a document `base` to a `full` path: the segments of
 *  `full` past `base`, slashed, with NO served-base prefix. A flattened/inlined node exposes its
 *  in-page location as exactly this (README "flattened child" rule), used as both its anchor `id`
 *  and its `#`-fragment — so `<doc>#/cont` lands on it. Keys are kept DECODED (matching what
 *  `useHashScroll` looks up after decoding the hash). E.g. (":book", ":book:chunks[0]") →
 *  "/chunks[0]"; ("" when `full === base`, i.e. the rendered root itself). */
export function fragmentOf(base: string, full: string): string {
  const tail = strToSegs(full).slice(strToSegs(base).length);
  return tail.map((s) => (typeof s === "number" ? `[${s}]` : `/${s}`)).join("");
}

/** A human-readable form of a canonical path: each key decoded (so a percent-encoded
 *  segment like `%D0%9F…` shows as its actual characters), colon-separated with a SPACE
 *  after each colon (matching the yamlover source spelling and the tag hover-card), indices
 *  as `[i]`. For display only — tooltips, labels — never for URLs or navigation. */
export function displayPath(path: string): string {
  const segs = strToSegs(path);
  if (!segs.length) return ":";
  return segs.map((s) => (typeof s === "number" ? `[${s}]` : `: ${s}`)).join("");
}

/** A tag's path spelled canonically for HOVER display: the scope ladder collapsed (canonPath), the
 *  common `…:tags` prefix dropped (a leading `yamlover` self-import authority and the `tags` root
 *  container), and the remaining segments joined with `": "` (a space after each colon, matching the
 *  yamlover source spelling) — e.g. `workflow: dev: ready`. Indices stay `[i]`. Falls back to the
 *  last segment when nothing remains under `tags`. */
export function tagDisplayPath(path: string): string {
  const all = strToSegs(canonPath(path));
  // Drop everything up to and including the `tags` root container — what's left is the tag's spine.
  const ti = all.indexOf("tags");
  const segs = ti >= 0 ? all.slice(ti + 1) : all;
  if (!segs.length) return all.length ? String(all[all.length - 1]) : ":";
  return segs.map((s) => (typeof s === "number" ? `[${s}]` : s)).join(": ");
}

/** A human-readable form of a path-LIKE key whose structure must survive verbatim —
 *  a relations key (`..`, `:eve`, `::a:b`), where {@link displayPath} would mangle the
 *  leading `::` or a bare `..`. Each key token is decoded in place; display only. */
export function displayKey(key: string): string {
  return key.replace(/[^:/\[\]]+/g, (tok) => safeDecode(tok));
}

/** Whether canonical path `a` is a (strict) ancestor of `p`. Root `:` is an ancestor
 *  of everything; otherwise `p` must continue past `a` at a `:` or `[`. */
export function isAncestorPath(a: string, p: string): boolean {
  if (a === p) return false;
  if (a === ":") return true;
  return p.startsWith(a + ":") || p.startsWith(a + "[");
}

/** The current representation taken from the URL's `?format=` (or `fallback`). */
export function formatFromUrl(fallback: string): string {
  return new URLSearchParams(window.location.search).get("format") || fallback;
}

/** The current page from the URL's `?page=` (1-based). 1 when absent, ≤1, or not an integer —
 *  used by paged viewers (PDF/DjVu) to restore where the reader left off. */
export function pageFromUrl(): number {
  const n = Number(new URLSearchParams(window.location.search).get("page"));
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/** Record the current page in `?page=` via replaceState — preserving every other param, and
 *  DROPPING the param at page 1 (the implicit default). This does NOT remount the renderer (only
 *  path/format/refreshSignal do), so a paged viewer can update it freely while scrolling. */
export function writePageToUrl(n: number): void {
  const params = new URLSearchParams(window.location.search);
  if (n > 1) params.set("page", String(n));
  else params.delete("page");
  const qs = params.toString();
  const url = window.location.pathname + (qs ? "?" + qs : "");
  if (url !== window.location.pathname + window.location.search) window.history.replaceState({}, "", url);
}

/** Write the JSON path (canonical colon form, converted to the slash-transport URL)
 *  plus `?format=` into the URL. Path navigation pushes a history entry; switching
 *  format replaces. Any other query params already present are kept (e.g. a renderer's
 *  own options such as the CSV `sep`/`header`), so only `format` is overwritten here. */
export function writeUrl(path: string, format: string, replace = false): void {
  const params = new URLSearchParams(window.location.search);
  params.set("format", format);
  // `?page=` is node-specific: a format switch (replace) keeps it, but navigating to another node
  // (push) must not carry the old node's page over — drop it there.
  if (!replace) params.delete("page");
  const url = `${urlOfPath(path || ":")}?${params.toString()}`;
  if (url === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}

/** Breadcrumb crumbs for a path. The head is the CLI ROOT (`rootLabel`); it is
 *  omitted when blank, so a default (cwd) root shows just the in-tree segments.
 *  e.g. (":a:b", "examples") → [examples, a, b] (each decoded, linking to its path). */
export function crumbs(p: string, rootLabel: string): { label: string; path: string }[] {
  const segs = strToSegs(p);
  const out: { label: string; path: string }[] = [];
  if (rootLabel) out.push({ label: rootLabel, path: ":" });
  segs.forEach((s, i) => {
    out.push({
      label: typeof s === "number" ? `[${s}]` : s,
      path: segsToStr(segs.slice(0, i + 1)),
    });
  });
  return out;
}
