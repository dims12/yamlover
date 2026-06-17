// live.ts — the client side of the UNIFIED change flow. Every change to the served tree —
// mediated writes (annotate, tag, paste, mv) and external edits (the FS watcher) — reaches the
// client as ONE currency: a file-level IndexDiff over /api/events, which App re-broadcasts as a
// `yamlover:diff` window event. Hooks that hold server-derived state subscribe HERE instead of
// inventing per-feature push paths; a new surface gets live refresh by adding one useDiffBump.

import { useEffect, useState } from "react";

/** A reindex/write diff as App re-broadcasts it: client JSON paths of the touched FILES
 *  (added + changed + removed + both ends of moves), with the removals also listed alone. */
export interface DiffDetail {
  paths: string[];
  removed: string[];
}

export const DIFF_EVENT = "yamlover:diff";

/** Re-broadcast a server diff to the window (App's SSE handler is the only caller). */
export function broadcastDiff(detail: DiffDetail): void {
  window.dispatchEvent(new CustomEvent(DIFF_EVENT, { detail }));
}

/** Diffs that can affect graph-derived state (annotations, tags, document bodies) — any touched
 *  `.yamlover` source. A binary-only diff (a photo import, say) passes nothing here. */
export const touchesYamlover = (d: DiffDetail): boolean => d.paths.some((p) => p.endsWith(".yamlover"));

/** A counter that bumps whenever a diff matches `match` (default: every diff) — put it in a
 *  fetch effect's dependency list and the data refetches on relevant changes. `match` must be
 *  a stable (module-level) predicate; it is deliberately not a re-subscribe dependency. */
export function useDiffBump(match: (d: DiffDetail) => boolean = () => true): number {
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const on = (e: Event) => {
      const det = (e as CustomEvent).detail as DiffDetail | undefined;
      if (det && match(det)) setBump((b) => b + 1);
    };
    window.addEventListener(DIFF_EVENT, on);
    return () => window.removeEventListener(DIFF_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return bump;
}

/** Like {@link useDiffBump}, but also carries the matching diff's touched FILE paths (client colon
 *  form). `seq` bumps per match (use it as the effect dependency); `paths` lets a surface refetch
 *  only the SUBSET of its data the diff touched, instead of everything. `match` must be stable. */
export function useDiffPaths(match: (d: DiffDetail) => boolean = () => true): { seq: number; paths: string[] } {
  const [state, setState] = useState<{ seq: number; paths: string[] }>({ seq: 0, paths: [] });
  useEffect(() => {
    const on = (e: Event) => {
      const det = (e as CustomEvent).detail as DiffDetail | undefined;
      if (det && match(det)) setState((s) => ({ seq: s.seq + 1, paths: det.paths }));
    };
    window.addEventListener(DIFF_EVENT, on);
    return () => window.removeEventListener(DIFF_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}
