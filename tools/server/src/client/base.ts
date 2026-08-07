// The URL prefix this SPA is served under — set by `yamlover --base-path` and
// injected into index.html at serve time as `window.__BASE__` (see bin/yamlover.js).
// Empty string when served at the document root (the normal case), so `api(p) === p`
// and nothing changes for a plain `npx yamlover`.

declare global {
  interface Window {
    __BASE__?: string;
    __READONLY__?: boolean;
  }
}

export const BASE: string = (typeof window !== "undefined" && window.__BASE__) || "";

// The server's read-only posture (`yamlover --read-only`), injected the same way as __BASE__.
// Synchronous and pre-render, so no edit affordance ever flashes; the backend 403s every
// mutating route regardless — this flag only keeps the UI honest about it. The function form
// re-reads the global (policy modules call it per decision; tests stub the global), the
// constant is the stamped-at-load value for render-time gating.
export const isReadOnly = (): boolean => typeof window !== "undefined" && window.__READONLY__ === true;
export const READ_ONLY: boolean = isReadOnly();

/** Prefix an absolute server path (e.g. "/api/info", "/api/blob?…") with the base path. */
export const api = (path: string): string => BASE + path;
