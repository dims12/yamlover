// JSON-space path helpers, mirroring src/server/yamlover.ts. The browser URL
// path *is* the JSON path: `/key[0]/sub` (root → `/`), never schema space.
//
// A key may itself contain `/`, `[`, or `]` (e.g. `@vitejs/plugin-react`), so
// each key is percent-encoded (encodeURIComponent) — the structural `/` and `[]`
// then unambiguously separate segments, and the canonical string is URL-safe as
// is (no second encoding when written to the address bar).

export type Seg = string | number;

export function segsToStr(segs: Seg[]): string {
  return segs.map((s) => (typeof s === "number" ? `[${s}]` : `/${encodeURIComponent(s)}`)).join("") || "/";
}

const PATH_TOKEN = /\[\d+\]|[^/\[\]]+/g;

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

/** The current JSON path taken from the browser URL, in canonical form. The
 *  pathname is already per-key-encoded, so it is tokenized *before* decoding. */
export function pathFromUrl(): string {
  return segsToStr(strToSegs(window.location.pathname));
}

/** Whether canonical path `a` is a (strict) ancestor of `p`. Root `/` is an
 *  ancestor of everything; otherwise `p` must continue past `a` at a `/` or `[`. */
export function isAncestorPath(a: string, p: string): boolean {
  if (a === p) return false;
  if (a === "/") return true;
  return p.startsWith(a + "/") || p.startsWith(a + "[");
}

/** The current representation taken from the URL's `?format=` (or `fallback`). */
export function formatFromUrl(fallback: string): string {
  return new URLSearchParams(window.location.search).get("format") || fallback;
}

/** Write the JSON path (a canonical, URL-safe string) plus `?format=` into the
 *  URL. Path navigation pushes a history entry; switching format replaces. */
export function writeUrl(path: string, format: string, replace = false): void {
  const url = `${path || "/"}?format=${encodeURIComponent(format)}`;
  if (url === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}

/** Breadcrumb crumbs for a path. The head is the CLI ROOT (`rootLabel`); it is
 *  omitted when blank, so a default (cwd) root shows just the in-tree segments.
 *  e.g. ("/a/b", "examples") → [examples, a, b] (each decoded, linking to its path). */
export function crumbs(p: string, rootLabel: string): { label: string; path: string }[] {
  const segs = strToSegs(p);
  const out: { label: string; path: string }[] = [];
  if (rootLabel) out.push({ label: rootLabel, path: "/" });
  segs.forEach((s, i) => {
    out.push({
      label: typeof s === "number" ? `[${s}]` : s,
      path: segsToStr(segs.slice(0, i + 1)),
    });
  });
  return out;
}
