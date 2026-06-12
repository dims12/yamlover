// JSON-space path helpers. The CANONICAL client path is COLON-form (SEPARATOR.md M4):
// `:key[0]:sub`, root `:` — what the API speaks and the UI displays. The BROWSER URL
// stays SLASH-transported (`/key[0]/sub` — ruling: "the URL should be slashed, of
// course"), converted at this boundary only.
//
// A key may itself contain `:`, `/`, `[`, or `]` (e.g. `@vitejs/plugin-react`), so each
// key is percent-encoded (encodeURIComponent) — the structural separators then
// unambiguously tokenize, and the URL spelling is address-bar-safe as is.

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
  const segs: Seg[] = [];
  for (const tok of window.location.pathname.match(URL_TOKEN) || []) {
    segs.push(/^\[\d+\]$/.test(tok) ? Number(tok.slice(1, -1)) : safeDecode(tok));
  }
  return segsToStr(segs);
}

/** The slash-transport URL spelling of a canonical path (`:a[0]:b` → `/a[0]/b`). */
export function urlOfPath(path: string): string {
  const segs = strToSegs(path);
  return segs.map((s) => (typeof s === "number" ? `[${s}]` : `/${encodeURIComponent(s)}`)).join("") || "/";
}

/** A human-readable form of a canonical path: each key decoded (so a percent-encoded
 *  segment like `%D0%9F…` shows as its actual characters), colon-separated, indices as
 *  `[i]`. For display only — tooltips, labels — never for URLs or navigation. */
export function displayPath(path: string): string {
  const segs = strToSegs(path);
  if (!segs.length) return ":";
  return segs.map((s) => (typeof s === "number" ? `[${s}]` : `:${s}`)).join("");
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

/** Write the JSON path (canonical colon form, converted to the slash-transport URL)
 *  plus `?format=` into the URL. Path navigation pushes a history entry; switching
 *  format replaces. Any other query params already present are kept (e.g. a renderer's
 *  own options such as the CSV `sep`/`header`), so only `format` is overwritten here. */
export function writeUrl(path: string, format: string, replace = false): void {
  const params = new URLSearchParams(window.location.search);
  params.set("format", format);
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
