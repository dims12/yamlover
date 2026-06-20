// The URL prefix this SPA is served under — set by `yamlover --base-path` and
// injected into index.html at serve time as `window.__BASE__` (see bin/yamlover.js).
// Empty string when served at the document root (the normal case), so `api(p) === p`
// and nothing changes for a plain `npx yamlover`.

declare global {
  interface Window {
    __BASE__?: string;
  }
}

export const BASE: string = (typeof window !== "undefined" && window.__BASE__) || "";

/** Prefix an absolute server path (e.g. "/api/info", "/api/blob?…") with the base path. */
export const api = (path: string): string => BASE + path;
