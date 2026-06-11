import { TaskInfo } from "./api";

/** The topbar's long-running-task indicator: one chip per task (label, counts, a slim
 *  progress bar — percent when the total is known, an indeterminate sweep otherwise).
 *  Finished tasks linger briefly (App prunes them) so completion is visible; a failed
 *  task shows red with its error in the tooltip. */
export function TaskStrip({ tasks }: { tasks: TaskInfo[] }) {
  if (!tasks.length) return null;
  return (
    <div className="task-strip">
      {tasks.map((t) => {
        const { done, total, message } = t.progress;
        const pct = t.state === "done" ? 100 : total ? Math.min(100, Math.floor((done / total) * 100)) : null;
        const counts = total ? `${done}/${total}` : t.state === "running" && done > 0 ? String(done) : "";
        return (
          <span key={t.id} className={`task-chip ${t.state}`} title={t.error ?? message ?? t.label}>
            <span className="task-label">
              {t.label}
              {counts && <span className="task-counts"> {counts}</span>}
              {t.state === "error" && " — failed"}
            </span>
            <span className="task-bar">
              {pct !== null ? (
                <span className="task-bar-fill" style={{ width: `${pct}%` }} />
              ) : (
                <span className="task-bar-fill indeterminate" />
              )}
            </span>
          </span>
        );
      })}
    </div>
  );
}
