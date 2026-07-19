// The projectional editor's persistence: an OP-LOG. Every model mutation (model.ts) returns the
// surgical `/api/edit` ops that mirror it; they are appended here in mutation order and flushed
// as one coalesced batch. The server applies a batch strictly in order, re-scanning the source
// after each op — so an op emitted earlier with then-current addresses stays correct at its turn,
// and ops emitted after a mutation use the post-mutation model addresses. (This is the invariant
// chapter-model's shadow array maintains by diffing; emission-at-mutation-time gets it for free.)

import { useCallback, useEffect, useRef } from "react";
import { editChunks, type Edit } from "../../api";

export interface OpQueue {
  pending: Edit[];
}

/** Append `edits`, coalescing the common typing case: a VALUE emplace at the same path as the
 *  immediately preceding pending value-emplace replaces it (keep-last). Only the adjacent last op
 *  coalesces — never across a structural op — so order is preserved by construction. Meta-carrying
 *  emplaces never coalesce with value ones (they change a different facet). */
export function enqueue(q: OpQueue, edits: Edit[]): void {
  for (const e of edits) {
    const last = q.pending[q.pending.length - 1];
    const coalescable =
      last !== undefined &&
      e.op === "emplace" && last.op === "emplace" && last.path === e.path &&
      e.meta === undefined && last.meta === undefined &&
      e.yamlover !== undefined && last.yamlover !== undefined;
    if (coalescable) q.pending[q.pending.length - 1] = e;
    else q.pending.push(e);
  }
}

/** Flush the queue to the server in the background: debounced 500ms after the last `version` bump,
 *  serialized (one batch in flight), coalesced (ops arriving mid-flight go out with the next one).
 *  On success the sent prefix is dropped; on failure the queue is KEPT (alert once, retried on the
 *  next change or flush). Returns `flush` for lock/unmount. */
export function useOpSync(queue: { current: OpQueue }, version: number): () => Promise<void> {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef(false);
  const dirty = useRef(false);

  const run = useCallback(async () => {
    if (running.current) { dirty.current = true; return; }
    const batch = queue.current.pending.slice();
    if (!batch.length) return;
    running.current = true;
    try {
      await editChunks(batch);
      queue.current.pending.splice(0, batch.length); // ops that arrived mid-flight stay queued
    } catch (e) {
      window.alert("edit sync failed: " + (e as Error).message); // queue kept → retried
    } finally {
      running.current = false;
      if (dirty.current) { dirty.current = false; void run(); }
    }
  }, [queue]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), 500);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [version, run]);

  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    return run();
  }, [run]);
}
