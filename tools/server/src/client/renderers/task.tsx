import { useEffect, useState } from "react";
import { NodeJson, fetchAnnotations } from "../api";
import { touchesYamlover, useDiffBump } from "../live";
import { asLink } from "../render";
import { resolveTagColor } from "./tag";
import { tagFields } from "./tag";
import { ChapterView } from "./chapter";
import { isState, stateDetail, moveState, WorkflowState } from "./workflow";

export const TASK_FORMAT = "x-yamlover-task";

const scalarField = (value: unknown, key: string): string | null => {
  const raw = tagFields(value).find(([k]) => k === key)?.[1];
  const v = asLink(raw)?.value ?? raw; // a keyed scalar projects as a depth-0 link marker — unwrap it
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
};

interface CurrentState extends WorkflowState {
  nextStates: WorkflowState[]; // resolved successors (label + color), for the advance control
}

/**
 * The TASK / TICKET renderer (TICKETS.md §1): a planning STRIP — the current workflow state (with
 * one-click "advance to" buttons for its `next` states), plus priority / assignee / due / estimate
 * chips — above the task's body, which is a CHAPTER (title + chunks + subtask children) rendered by
 * reusing {@link ChapterView}. Changing state reuses the annotation write path (advisory; SSE
 * refreshes the strip via live.ts useDiffBump).
 */
export function TaskView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  const diffBump = useDiffBump(touchesYamlover);
  const [state, setState] = useState<CurrentState | null>(null);

  const priority = scalarField(node.value, "priority");
  const assignee = scalarField(node.value, "assignee");
  const due = scalarField(node.value, "due");
  const estimate = scalarField(node.value, "estimate");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // the task's current state = its first annotation whose tag is a workflow state
      const anns = await fetchAnnotations(node.path).catch(() => []);
      let found: CurrentState | null = null;
      for (const a of anns) {
        const p = a.tag?.path;
        if (!p || !(await isState(p))) continue;
        const st = await stateDetail(p);
        const nextStates = await Promise.all(st.next.map((np) => stateDetail(np)));
        found = { ...st, nextStates };
        break;
      }
      if (!cancelled) setState(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [node.path, diffBump]);

  const advance = async (to: string) => {
    if (state) await moveState(node.path, state.path, to).catch(() => {});
  };

  return (
    <div className="task">
      <div className="task-strip">
        {state && (
          <span className="task-state" style={{ background: resolveTagColor({ name: state.label, color: state.color }) }}>
            {state.label}
          </span>
        )}
        {state?.nextStates.map((ns) => (
          <button
            key={ns.path}
            className="task-advance"
            style={{ borderColor: resolveTagColor({ name: ns.label, color: ns.color }) }}
            onClick={() => advance(ns.path)}
            title={`Move to ${ns.label}`}
          >
            → {ns.label}
          </button>
        ))}
        {priority && <span className={"board-chip prio-" + priority}>{priority}</span>}
        {assignee && <span className="board-chip board-assignee">@{assignee}</span>}
        {due && <span className="board-chip board-due">{due.slice(0, 10)}</span>}
        {estimate && <span className="board-chip board-estimate">{estimate}</span>}
      </div>
      <ChapterView node={node} onNavigate={onNavigate} />
    </div>
  );
}
