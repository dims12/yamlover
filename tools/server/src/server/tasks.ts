// tasks.ts — the server's LONG-RUNNING TASK registry. Anything slow (the initial index, the
// background hasher, a watcher reconcile, …) registers here and reports progress; every state
// change is emitted (engine-api pushes it to the UI over the existing /api/events SSE stream
// as a `{type:"task", task}` frame) and GET /api/tasks snapshots in-flight tasks for a freshly
// loaded page. Generic on purpose: a future slow operation is just `registry.start(label)`.

export interface TaskProgress {
  done: number;
  total?: number; // absent ⇒ indeterminate (the UI shows an activity bar, not a percent)
  message?: string; // human-readable detail (current path, "writing index…", …)
}

export interface TaskInfo {
  id: string;
  label: string;
  state: "running" | "done" | "error";
  progress: TaskProgress;
  startedAt: number; // epoch ms
  finishedAt?: number;
  error?: string;
}

export interface TaskHandle {
  readonly id: string;
  /** Report progress. Throttled (state changes are not) so a per-file caller cannot flood SSE. */
  progress(done: number, total?: number, message?: string): void;
  done(): void;
  fail(err: unknown): void;
}

const PROGRESS_EMIT_MS = 150; // at most one progress frame per task per this interval
const KEEP_FINISHED_MS = 5_000; // finished tasks stay listed briefly so completion is visible

export class TaskRegistry {
  private seq = 0;
  private readonly tasks = new Map<string, TaskInfo>();
  private readonly lastEmit = new Map<string, number>();

  constructor(private readonly emit: (t: TaskInfo) => void) {}

  start(label: string): TaskHandle {
    const id = "t" + ++this.seq;
    const info: TaskInfo = { id, label, state: "running", progress: { done: 0 }, startedAt: Date.now() };
    this.tasks.set(id, info);
    this.send(info, true);
    const finish = (state: "done" | "error", error?: string): void => {
      if (info.state !== "running") return; // done/fail are one-shot
      info.state = state;
      info.finishedAt = Date.now();
      if (error !== undefined) info.error = error;
      this.send(info, true);
    };
    return {
      id,
      progress: (done, total, message) => {
        if (info.state !== "running") return;
        info.progress = { done, ...(total !== undefined && { total }), ...(message !== undefined && { message }) };
        this.send(info, false);
      },
      done: () => finish("done"),
      fail: (err) => finish("error", String((err as Error)?.message ?? err)),
    };
  }

  /** Running tasks + ones finished within the last few seconds (pruning the rest). */
  list(): TaskInfo[] {
    const now = Date.now();
    for (const [id, t] of this.tasks) {
      if (t.state !== "running" && now - (t.finishedAt ?? 0) > KEEP_FINISHED_MS) {
        this.tasks.delete(id);
        this.lastEmit.delete(id);
      }
    }
    return [...this.tasks.values()].map((t) => ({ ...t, progress: { ...t.progress } }));
  }

  private send(t: TaskInfo, always: boolean): void {
    const now = Date.now();
    if (!always && now - (this.lastEmit.get(t.id) ?? 0) < PROGRESS_EMIT_MS) return;
    this.lastEmit.set(t.id, now);
    this.emit({ ...t, progress: { ...t.progress } });
  }
}
