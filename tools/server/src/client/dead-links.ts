// THE LINK INVARIANT's client half — the DEAD TARGET set (GET /api/dead-links, computed by
// the server's link-check with the same scanTextLinks frames navigation uses). NavLink asks
// `isDeadTarget(path)` for every resolved in-tree link and marks the dead ones `.deadlink`
// instead of rendering a live anchor into a 404. One module-level store, the format-bus
// pattern (toc-presence.ts); refreshed on mount and on every `yamlover:diff` event, so a
// move that kills (or heals) a link updates the marks with the same currency as the page.

import { useSyncExternalStore } from "react";
import { fetchDeadLinks } from "./api";
import { canonPath } from "./paths";
import { DIFF_EVENT } from "./live";

let dead = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

/** Is this RESOLVED store path a known dead link target? (canonPath-normalized.) */
export function isDeadTarget(path: string): boolean {
  return dead.has(canonPath(path));
}

/** Subscribe NavLinks to set changes — a refresh re-renders the marks in place. */
export function useDeadLinksVersion(): number {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => version,
    () => version,
  );
}

let inflight = false;
async function refresh(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const r = await fetchDeadLinks();
    const next = new Set(r.targets.map((t) => canonPath(t)));
    const same = next.size === dead.size && [...next].every((t) => dead.has(t));
    if (!same) {
      dead = next;
      version++;
      listeners.forEach((l) => l());
    }
  } catch {
    // a transient fetch failure keeps the previous set — marks degrade, never throw
  } finally {
    inflight = false;
  }
}

/** App calls this once: the initial fetch plus the diff-event refresh subscription. */
export function watchDeadLinks(): () => void {
  void refresh();
  const on = (): void => void refresh();
  window.addEventListener(DIFF_EVENT, on);
  return () => window.removeEventListener(DIFF_EVENT, on);
}
