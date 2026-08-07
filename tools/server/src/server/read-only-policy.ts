/** READ-ONLY MODE policy (`--read-only`): which requests a content-read-only server answers.
 *
 *  The rule is an ALLOWLIST over methods, not a denylist of today's write routes: the read
 *  routes carry no method guard (a `POST /api/tree` works), and a denylist would silently
 *  admit the next write endpoint someone adds. GET/HEAD always pass — the one GET that can
 *  write, `/api/thumb`, is degraded at its handler (serve a pre-existing sidecar, 415 a miss)
 *  rather than blocked, so already-generated icons keep working.
 *
 *  "Content read-only" means the served tree's USER DATA never changes. The server still
 *  maintains its own housekeeping (`.yo/index.db`, settings materialization), so `/api/reindex`
 *  stays allowed — its one source-rewriting side channel (move relinking) is suppressed by the
 *  same flag inside `reconcile`.
 */

/** POSTs that mutate nothing in the served tree. `/api/preview` renders a caller-supplied
 *  source through a throwaway in-memory store; `/api/edit-text` transforms a caller-supplied
 *  string and returns it (the localStorage-backed browser-settings page persists it itself). */
export const SAFE_POSTS: ReadonlySet<string> = new Set(["/api/preview", "/api/edit-text", "/api/reindex"]);

/** Would a read-only server answer this request at all? */
export function allowedInReadOnly(method: string | undefined, pathname: string): boolean {
  const m = (method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  return SAFE_POSTS.has(pathname);
}

/** The one rejection body every blocked route answers with (HTTP 403). The client's fetch
 *  wrappers throw `Error(body.error)`, so a write that slips past the disabled UI surfaces
 *  as "…: server is read-only" without any client-side special-casing. */
export const READ_ONLY_ERROR = { error: "server is read-only", readOnly: true } as const;
