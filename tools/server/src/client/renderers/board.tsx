import { useEffect, useRef, useState } from "react";
import { NodeJson, fetchNode, TagRef, saveBoardColumns } from "../api";
import { asLink } from "../render";
import { touchesYamlover, useDiffBump } from "../live";
import { resolveTagColor, tagFields } from "./tag";
import { displayPath } from "../paths";
import { fetchWorkflowStates, WorkflowState, stateDetail, moveState, targetPath } from "./workflow";
import { AnnotationMenu } from "./annotate";

export const BOARD_FORMAT = "x-yamlover-board";
const CONTAINER_TAGISH = new Set(["x-yamlover-tag", "x-yamlover-workflow", "x-yamlover-board"]);

/** Whether a directory should default to (and offer) the BOARD view: it carries the board schema,
 *  or an overlay board config (a `workflow:` seed or an explicit `columns:` lane list). */
export function isBoardNode(node: NodeJson): boolean {
  if (node.format === BOARD_FORMAT) return true;
  return tagFields(node.value).some(([k]) => k === "workflow" || k === "columns");
}

// Tags whose cards read as "did not complete" — struck through. A naming heuristic for now.
const NEGATIVE_TERMINAL = new Set(["cancelled", "canceled", "rejected", "wontfix", "won't-fix", "dropped", "declined", "abandoned", "duplicate", "invalid"]);
const isNegative = (label: string) => NEGATIVE_TERMINAL.has(label.toLowerCase());

interface Card {
  path: string;
  title: string;
  priority: string | null;
  assignee: string | null;
  due: string | null;
  tags: string[]; // every tag this card carries (to classify into lane sub-sections)
}

/** One lane: a header carrying one or more tags; a card filed under each tag it bears (multiple
 *  tags split the lane vertically). */
interface Lane {
  tags: WorkflowState[];
}

const scalarField = (value: unknown, key: string): string | null => {
  const v = tagFields(value).find(([k]) => k === key)?.[1];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
};
const lastSeg = (p: string): string => { const i = p.lastIndexOf(":"); return i < 0 ? p : p.slice(i + 1); };

function workflowPathOf(node: NodeJson): string | null {
  return targetPath(tagFields(node.value).find(([k]) => k === "workflow")?.[1]);
}

/** The explicit `columns:` config (lanes × tag paths), or null when the board only seeds from a
 *  `workflow:`. `columns` projects as an array of arrays of tag links. */
function explicitColumns(node: NodeJson): string[][] | null {
  const raw = tagFields(node.value).find(([k]) => k === "columns")?.[1];
  if (!Array.isArray(raw)) return null;
  return raw.map((lane) => (Array.isArray(lane) ? lane.map(targetPath).filter((p): p is string => !!p) : []));
}

/** The directory's CARD members — content entities, not the board's own config / taxonomy / graft. */
function cardMemberPaths(node: NodeJson): string[] {
  const out: string[] = [];
  for (const [key, val] of tagFields(node.value)) {
    if (key === "workflow" || key === "columns" || key === "yamlover" || key === "tags") continue;
    const link = asLink(val);
    if (!link || (link.format && CONTAINER_TAGISH.has(link.format))) continue;
    out.push(link.path);
  }
  return out;
}

/** Every tag a card carries — its `yamlover-annotations` element targets (link or `{tag}` object). */
function tagsInValue(value: unknown): string[] {
  const ann = tagFields(value).find(([k]) => k === "yamlover-annotations")?.[1];
  const items = Array.isArray(ann) ? ann : [];
  const out: string[] = [];
  for (const el of items) {
    const p = targetPath(el) ?? targetPath(tagFields(el).find(([k]) => k === "tag")?.[1]);
    if (p) out.push(p);
  }
  return out;
}

/**
 * The BOARD view (TICKETS.md §3) — a tag-column layout over a directory, now one of the explorer's
 * view modes. Lanes come from the board overlay's explicit `columns:` (lanes × tags) or, absent
 * that, are seeded from a `workflow:` (flowing states each a lane, terminal states merged). Each
 * lane header is a TAG MULTI-SELECT: add/remove tags (persisted to the overlay via `POST /api/board`);
 * multiple tags split the lane vertically into per-tag drop zones. Dragging a card between
 * sub-sections re-tags it (move: drop the source tag, add the target — advisory). Cancelled-like
 * tags are struck through. Right-click a card → the shared tagging menu.
 */
export function BoardView({
  node,
  onNavigate,
  openContextMenu,
}: {
  node: NodeJson;
  onNavigate: (path: string) => void;
  openContextMenu?: (path: string, x: number, y: number) => void;
}) {
  const diffBump = useDiffBump(touchesYamlover);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ task: string; from: string | null } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ lane: number; x: number; y: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Members + the workflow ref read from the (depth-1) node — there they are link markers; the
        // `columns:` config needs a DEEPER fetch (board → lanes → tags), where members instead
        // expand inline, so the two are read from different depths.
        const wfPath = workflowPathOf(node);
        const hasColumns = tagFields(node.value).some(([k]) => k === "columns");
        const explicit = hasColumns ? explicitColumns(await fetchNode(node.path, 3)) : null;
        let built: Lane[] = [];
        if (explicit) {
          built = await Promise.all(explicit.map(async (laneTags) => ({ tags: await Promise.all(laneTags.map(stateDetail)) })));
        } else if (wfPath) {
          const states = (await fetchWorkflowStates(wfPath)).filter((s) => !s.initial);
          const flowing = states.filter((s) => s.next.length > 0);
          const terminal = states.filter((s) => s.next.length === 0);
          terminal.sort((a, b) => Number(isNegative(a.label)) - Number(isNegative(b.label)));
          built = [...flowing.map((s) => ({ tags: [s] })), ...(terminal.length ? [{ tags: terminal }] : [])];
        }
        const members = cardMemberPaths(node);
        const builtCards = await Promise.all(
          members.map(async (tp): Promise<Card> => {
            const tn = await fetchNode(tp, 2);
            return { path: tp, title: tn.title ?? lastSeg(tp), priority: scalarField(tn.value, "priority"), assignee: scalarField(tn.value, "assignee"), due: scalarField(tn.value, "due"), tags: tagsInValue(tn.value) };
          }),
        );
        if (cancelled) return;
        setLanes(built);
        setCards(builtCards);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [node.path, diffBump]);

  // The current lanes as a plain `columns` config (materializing a workflow seed on first edit).
  const currentColumns = (): string[][] => lanes.map((l) => l.tags.map((t) => t.path));
  const persist = (cols: string[][]) => { saveBoardColumns(node.path, cols).catch((e) => setError(String((e as Error)?.message || e))); };
  const addTagToLane = (laneI: number, tagPath: string) => { const cols = currentColumns(); if (!cols[laneI]) cols[laneI] = []; if (!cols[laneI].includes(tagPath)) cols[laneI].push(tagPath); persist(cols); };
  const removeTagFromLane = (laneI: number, tagPath: string) => { const cols = currentColumns().map((l, i) => (i === laneI ? l.filter((t) => t !== tagPath) : l)); persist(cols); };
  const addLane = () => persist([...currentColumns(), []]);
  const removeLane = (laneI: number) => persist(currentColumns().filter((_, i) => i !== laneI));

  const onDropTo = async (tagPath: string) => {
    const d = drag;
    setDrag(null);
    setOver(null);
    if (!d || tagPath === d.from) return;
    try {
      await moveState(d.task, d.from, tagPath);
      setCards((cs) => cs.map((c) => (c.path === d.task ? { ...c, tags: [...c.tags.filter((t) => t !== d.from), tagPath] } : c)));
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  };

  // The lane-header tag picker (reuses the floating AnnotationMenu; create-on-miss mints new tags).
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => { if (pickerRef.current?.contains(e.target as Node)) return; setPicker(null); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [picker]);

  if (error) return <div className="board-error">Board error: {error}</div>;

  return (
    <div className="board">
      {lanes.map((lane, laneI) => {
        const headColor = lane.tags[0] ? resolveTagColor({ name: lane.tags[0].label, color: lane.tags[0].color }) : "#6c7086";
        const total = lane.tags.reduce((n, t) => n + cards.filter((c) => c.tags.includes(t.path)).length, 0);
        return (
          <section key={laneI} className="board-col">
            <header className="board-col-head" style={{ borderTopColor: headColor }}>
              <div className="board-col-tags">
                {lane.tags.map((t) => (
                  <span key={t.path} className="board-lane-chip" style={{ background: resolveTagColor({ name: t.label, color: t.color }) }}>
                    {t.label}
                    <button className="board-lane-x" title={`remove ${t.label}`} onClick={() => removeTagFromLane(laneI, t.path)}>×</button>
                  </span>
                ))}
                <button className="board-lane-add" title="add a tag to this lane" onClick={(e) => setPicker({ lane: laneI, x: e.clientX, y: e.clientY })}>＋</button>
              </div>
              <span className="board-col-count">{total}</span>
              <button className="board-lane-del" title="remove this lane" onClick={() => removeLane(laneI)}>🗑</button>
            </header>
            <div className="board-col-body">
              {lane.tags.map((t, gi) => {
                const groupCards = cards.filter((c) => c.tags.includes(t.path));
                const color = resolveTagColor({ name: t.label, color: t.color });
                const neg = isNegative(t.label);
                return (
                  <div
                    key={t.path}
                    className={"board-group" + (gi > 0 ? " board-group-split" : "") + (over === t.path ? " board-group-over" : "")}
                    onDragOver={(e) => { if (drag) { e.preventDefault(); if (over !== t.path) setOver(t.path); } }}
                    onDrop={(e) => { e.preventDefault(); onDropTo(t.path); }}
                  >
                    {lane.tags.length > 1 && (
                      <div className="board-group-head">
                        <span className="board-group-dot" style={{ background: color }} />
                        <span className="board-group-title">{t.label}</span>
                        <span className="board-col-count">{groupCards.length}</span>
                      </div>
                    )}
                    <div className="board-group-cards">
                      {groupCards.map((c) => (
                        <article
                          key={c.path}
                          className={"board-card" + (neg ? " board-card-negative" : "")}
                          draggable
                          onDragStart={() => setDrag({ task: c.path, from: t.path })}
                          onDragEnd={() => { setDrag(null); setOver(null); }}
                          onClick={() => onNavigate(c.path)}
                          onContextMenu={openContextMenu ? (e) => { e.preventDefault(); openContextMenu(c.path, e.clientX, e.clientY); } : undefined}
                          title={displayPath(c.path)}
                          style={{ borderLeftColor: color }}
                        >
                          <div className="board-card-title">{c.title}</div>
                          <div className="board-card-meta">
                            {c.priority && <span className={"board-chip prio-" + c.priority}>{c.priority}</span>}
                            {c.assignee && <span className="board-chip board-assignee">@{c.assignee}</span>}
                            {c.due && <span className="board-chip board-due">{c.due.slice(0, 10)}</span>}
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      <button className="board-add-lane" title="add a lane" onClick={addLane}>＋ lane</button>
      {picker && (
        <AnnotationMenu
          menuRef={pickerRef}
          x={picker.x}
          y={picker.y}
          applied={[]}
          mode="create"
          onPick={(t: TagRef) => { addTagToLane(picker.lane, t.path); setPicker(null); }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
