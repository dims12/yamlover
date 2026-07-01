// Shared workflow helpers for the task + board renderers (TICKETS.md §2). A workflow is a tag
// whose contained sub-tags are its STATES; a task's current state is the one annotation pointing
// into them; `next:` ref edges are the advisory transitions. Changing state = drop the old state
// annotation + add the new — both reuse the existing /api/annotate write path (and announce over
// SSE, so every open board/task refreshes via live.ts useDiffBump).
//
// Projection note: a `*` pointer to a STATE (a container) arrives as a `$yamloverLink` marker
// (you navigate to it), NOT a `$yamloverRef` — so targets are read with `asLink`. A state's `next`
// is a single link, or (read at depth ≥ 2) a JS array of links.
import { fetchNode, fetchAnnotations, annotate, deleteAnnotation } from "../api";
import { asLink } from "../render";
import { TAG_FORMAT, tagLabel, tagFields, explicitColor } from "./tag";

const REF_KEY = "$yamloverRef";
export const WORKFLOW_FORMAT = "x-yamlover-workflow";

export interface WorkflowState {
  path: string;
  label: string;
  color: string | null;
  next: string[]; // successor-state paths (advisory transitions)
  initial?: boolean; // the workflow's start state (the board treats it as the backlog/intake)
}

/** The target path of a pointer VALUE — projected as a `$yamloverLink` (a navigable container, the
 *  common case here) or, defensively, a `$yamloverRef` (a bare rel). */
export function targetPath(v: unknown): string | null {
  const link = asLink(v);
  if (link) return link.path;
  const r = (v as { [REF_KEY]?: { path?: unknown } } | null | undefined)?.[REF_KEY];
  return r && typeof r.path === "string" ? r.path : null;
}

/** Successor-state paths from a state node's `next` field (the node read at depth ≥ 2): a single
 *  link, or an array of links. */
function nextPaths(stateValue: unknown): string[] {
  const raw = tagFields(stateValue).find(([k]) => k === "next")?.[1];
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(targetPath).filter((p): p is string => p != null);
  const one = targetPath(raw);
  return one ? [one] : [];
}

/** The ordered STATES of a workflow tag (its contained sub-tags), each with display color and its
 *  advisory `next` transitions. Skips the `initial` ref (it duplicates a state) and de-dupes. One
 *  fetch for the workflow, one per state (depth 2, to expand a multi-target `next` array). */
export async function fetchWorkflowStates(workflowPath: string): Promise<WorkflowState[]> {
  const wf = await fetchNode(workflowPath, 1);
  const initialPath = targetPath(tagFields(wf.value).find(([k]) => k === "initial")?.[1]);
  const seen = new Set<string>();
  const states: WorkflowState[] = [];
  for (const [key, val] of tagFields(wf.value)) {
    if (key === "initial" || key === "color") continue; // not states: the start-state ref / a workflow color
    const link = asLink(val);
    if (!link || link.format !== TAG_FORMAT || seen.has(link.path)) continue;
    seen.add(link.path);
    states.push({ path: link.path, label: tagLabel(link.path, link.title), color: link.color ?? null, next: [], initial: link.path === initialPath });
  }
  await Promise.all(
    states.map(async (st) => {
      try {
        st.next = nextPaths((await fetchNode(st.path, 2)).value);
      } catch {
        /* transitions are advisory — a miss just means no highlighted targets */
      }
    }),
  );
  return states;
}

/** Read a task's current state directly from its already-fetched value (its `yamlover-annotations`
 *  elements, projected as link markers / `{tag}` objects), matched against `statePaths`. */
export function stateInValue(taskValue: unknown, statePaths: Set<string>): string | null {
  const ann = tagFields(taskValue).find(([k]) => k === "yamlover-annotations")?.[1];
  const items = Array.isArray(ann) ? ann : [];
  for (const el of items) {
    const p = targetPath(el) ?? targetPath(tagFields(el).find(([k]) => k === "tag")?.[1]);
    if (p && statePaths.has(p)) return p;
  }
  return null;
}

/** Move a task between states: drop the old state annotation, add the new. Advisory — any target
 *  is allowed; a no-op when already there. Writes announce over SSE (callers refresh on the bump). */
export async function moveState(taskPath: string, fromPath: string | null, toPath: string): Promise<void> {
  if (fromPath === toPath) return;
  if (fromPath) await deleteAnnotation(taskPath, fromPath);
  await annotate({ target: taskPath, tag: toPath });
}

/** Whether the tag at `tagPath` is a workflow STATE — i.e. its containing node is a workflow. */
export async function isState(tagPath: string): Promise<boolean> {
  const i = tagPath.lastIndexOf(":");
  if (i <= 0) return false;
  try {
    return (await fetchNode(tagPath.slice(0, i), 0)).format === WORKFLOW_FORMAT;
  } catch {
    return false;
  }
}

/** A state's display color + its `next` transitions, for the task advance control (depth 2 so a
 *  multi-target `next` array is expanded). */
export async function stateDetail(statePath: string): Promise<WorkflowState> {
  const sn = await fetchNode(statePath, 2);
  return { path: statePath, label: tagLabel(statePath, sn.title), color: explicitColor(sn.value), next: nextPaths(sn.value) };
}

/** The task's current state among its annotations (the first whose tag is a workflow state). */
export async function currentStateOf(taskPath: string): Promise<string | null> {
  for (const a of await fetchAnnotations(taskPath)) {
    const p = a.tag?.path;
    if (p && (await isState(p))) return p;
  }
  return null;
}
