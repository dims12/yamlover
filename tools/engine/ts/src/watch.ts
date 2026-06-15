// Filesystem watcher — the "watched live" reconcile tier (ENGINE.md, PLAN.md 3e). Watches a
// served tree for external edits and reports debounced batches of changed paths; the caller
// (the server) answers each batch with a cheap manifest-cached `reindex`.
//
// What is filtered OUT, so the watcher never re-triggers itself or churns on noise:
//   - anything git-ignored (the caller passes the same predicate the walker uses);
//   - dotfiles/dot-dirs (the walker skips them), EXCEPT the `.yamlover/` overlay files the
//     walker DOES read — body.yamlover / meta.yamlover / settings.yamlover. The engine's own
//     `.yamlover/index.db*` writes are dotpath-filtered here, which is what breaks the
//     rebuild → event → rebuild loop.
//
// Move inference (delete+create with a matching hash) is NOT done here — the reindex diff
// reports it as removed+added, and relinking waits on the serializers (mediated tier).

import fs from 'node:fs';
import path from 'node:path';

const OVERLAY_FILES = new Set(['body.yamlover', 'meta.yamlover', 'settings.yamlover']);
// Derived-sidecar subdirs inside `.yamlover/` that ARE indexed (thumbnails/, fragments/) — their
// blobs are addressable content, so external writes there must trigger a reindex. The index db
// (`index.db*`) is deliberately NOT here: it's rewritten by every reindex, so watching it would loop.
const YAMLOVER_SIDECAR_DIRS = new Set(['thumbnails', 'fragments']);

export interface WatchOptions {
  /** Same predicate the walker got: true → the path is git-ignored, skip its events. */
  ignore?: (absPath: string) => boolean;
  /** Quiet time before a batch fires (an editor save is often several FS events). */
  debounceMs?: number;
}

/** Watch `absRoot` recursively; call `onBatch` with the root-relative paths that changed,
 *  debounced. Events arriving while `onBatch` runs are collected into the next batch (no
 *  overlap). Returns a closer. Requires fs.watch recursive support (Linux: Node ≥20). */
export function watchTree(absRoot: string, onBatch: (relPaths: string[]) => void, opts: WatchOptions = {}): () => void {
  const root = path.resolve(absRoot);
  const debounceMs = opts.debounceMs ?? 300;
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let closed = false;

  const relevant = (rel: string): boolean => {
    const segs = rel.split(path.sep);
    for (let i = 0; i < segs.length; i++) {
      if (!segs[i].startsWith('.')) continue;
      // a dot-segment is data the walker reads only when it's `.yamlover/` holding either an
      // overlay file (`.yamlover/body.yamlover`) or an indexed sidecar (`.yamlover/thumbnails/x`);
      // anything else under a dot-dir — notably `.yamlover/index.db*` — is filtered (avoids a loop).
      const rest = segs.slice(i + 1);
      const isOverlay = segs[i] === '.yamlover' && rest.length === 1 && OVERLAY_FILES.has(rest[0]);
      const isSidecar = segs[i] === '.yamlover' && rest.length >= 2 && YAMLOVER_SIDECAR_DIRS.has(rest[0]) && !rest.some((s) => s.startsWith('.'));
      if (!isOverlay && !isSidecar) return false;
      break; // consumed the rest of the path under `.yamlover`; no further dot-segment check
    }
    return !opts.ignore?.(path.join(root, rel));
  };

  const fire = (): void => {
    timer = null;
    if (running || closed || pending.size === 0) return;
    const batch = [...pending].map((p) => p.split(path.sep).join('/'));
    pending.clear();
    running = true;
    try {
      onBatch(batch);
    } finally {
      running = false;
      if (pending.size > 0) timer = setTimeout(fire, debounceMs); // events that landed mid-run
    }
  };

  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    if (closed || filename == null) return;
    const rel = String(filename);
    if (!relevant(rel)) return;
    pending.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  });

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
