// THE DEEP-LINK LANDING BUS — while a `#/…` fragment's anchor is still being laid out (a
// chapter page inlining its subchapters one HTTP round-trip per level), the topbar's TaskStrip
// shows how deep the landing has reached, in the same spot the server's own "reconciling"/
// "indexing" chips appear. One module-level store, the toc-presence.ts pattern: only one
// content page is mounted at a time.
//
// The metric is honest, not synthetic: the target id is the slash continuation of the node
// path from the page root, so each landed ancestor stamps a PREFIX of it as a DOM id — the
// deepest prefix already present over the total segment count IS the landing's progress.

import { useSyncExternalStore } from "react";
import type { TaskInfo } from "./api";

let state: TaskInfo | null = null;
const listeners = new Set<() => void>();
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function emit(next: TaskInfo | null): void {
  state = next;
  listeners.forEach((l) => l());
}

/** Segments of the DEEPEST already-rendered prefix anchor of `id`, over the total. A slot
 *  level that stamps no anchor of its own merely undercounts — the count stays monotonic. */
function landedDepth(id: string): { done: number; total: number } {
  const segs = id.split("/").filter(Boolean);
  for (let k = segs.length; k >= 1; k--) {
    if (document.getElementById("/" + segs.slice(0, k).join("/"))) return { done: k, total: segs.length };
  }
  return { done: 0, total: segs.length };
}

/** The reveal FAILED to find the anchor — the landing is still unfolding; publish its depth.
 *  Only path-continuation anchors (`/…`) unfold gradually; slug anchors land in one paint. */
export function noteLandingAttempt(id: string): void {
  if (!id.startsWith("/")) return;
  const { done, total } = landedDepth(id);
  const prev = state;
  if (prev?.state === "running" && prev.progress.message === id && prev.progress.done === done) return;
  clearTimeout(clearTimer);
  // a landing that stops advancing (a dead link, the inline-depth caps) must not pin the chip
  clearTimer = setTimeout(() => emit(null), 45_000);
  emit({
    id: "client:landing",
    label: "landing",
    state: "running",
    progress: { done, total, message: id },
    startedAt: prev?.progress.message === id ? prev.startedAt : Date.now(),
  });
}

/** The reveal scrolled — the landing is complete; show 100% briefly, then drop the chip. */
export function noteLandingDone(id: string): void {
  if (state === null || state.progress.message !== id) return;
  if (state.state === "done") return; // re-reveals on later loads must not re-arm the clear timer
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => emit(null), 2500);
  emit({
    ...state,
    state: "done",
    progress: { ...state.progress, done: state.progress.total ?? state.progress.done },
    finishedAt: Date.now(),
  });
}

/** The content page unmounted or the hash emptied — whatever was pending is moot. */
export function clearLanding(): void {
  clearTimeout(clearTimer);
  if (state !== null) emit(null);
}

/** App subscribes and appends the chip to the server tasks it hands the TaskStrip. */
export function useLandingProgress(): TaskInfo | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
    () => null,
  );
}

// ---------------------------------------------------------------------------- //
// THE UNFOLD CHIP — a chapter page inlining its subchapters (one fetch per node, level by
// level) shows the same task-strip visibility even WITHOUT a deep link: an in-flight counter
// around every InlineSubchapter fetch. Counts, not totals — the tree's size is unknown until
// the unfold finishes, so the bar sweeps indeterminate while the count ticks up.
// ---------------------------------------------------------------------------- //

let unfoldState: TaskInfo | null = null;
let unfoldPending = 0;
let unfoldDone = 0;
let unfoldClearTimer: ReturnType<typeof setTimeout> | undefined;
const unfoldListeners = new Set<() => void>();

function emitUnfold(next: TaskInfo | null): void {
  unfoldState = next;
  unfoldListeners.forEach((l) => l());
}

export function noteUnfoldStart(): void {
  unfoldPending++;
  clearTimeout(unfoldClearTimer);
  emitUnfold({
    id: "client:unfold",
    label: "unfolding",
    state: "running",
    progress: { done: unfoldDone },
    startedAt: unfoldState?.state === "running" ? unfoldState.startedAt : Date.now(),
  });
}

export function noteUnfoldFinish(): void {
  unfoldPending = Math.max(0, unfoldPending - 1);
  unfoldDone++;
  if (unfoldPending > 0) {
    emitUnfold(unfoldState === null ? null : { ...unfoldState, progress: { done: unfoldDone } });
    return;
  }
  // drained — show the final count briefly, then drop and reset
  emitUnfold(unfoldState === null ? null : {
    ...unfoldState,
    state: "done",
    progress: { done: unfoldDone, total: unfoldDone },
    finishedAt: Date.now(),
  });
  clearTimeout(unfoldClearTimer);
  unfoldClearTimer = setTimeout(() => { unfoldDone = 0; emitUnfold(null); }, 2000);
}

export function useUnfoldProgress(): TaskInfo | null {
  return useSyncExternalStore(
    (l) => { unfoldListeners.add(l); return () => unfoldListeners.delete(l); },
    () => unfoldState,
    () => null,
  );
}
