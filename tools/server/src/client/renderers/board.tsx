import { useEffect, useRef, useState } from "react";
import { NodeJson, fetchNode, TagRef, saveBoardLanes } from "../api";
import { memberItems } from "./explorer";
import { touchesYamlover, useDiffBump } from "../live";
import { resolveTagColor, tagFields, tagStyle } from "./tag";
import { displayPath } from "../paths";
import { fetchWorkflowStates, WorkflowState, stateDetail, moveState, targetPath } from "./workflow";
import { AnnotationMenu } from "./annotate";
import { TagTip } from "./tagtip";

export const BOARD_FORMAT = "x-yamlover-board";
const CONTAINER_TAGISH = new Set(["x-yamlover-tag", "x-yamlover-workflow", "x-yamlover-board"]);

/** Whether a directory should default to (and offer) the BOARD view: it carries the board schema,
 *  or an overlay board config (a `workflow:` seed or an explicit `lanes:` list). */
export function isBoardNode(node: NodeJson): boolean {
  if (node.format === BOARD_FORMAT) return true;
  return tagFields(node.value).some(([k]) => k === "workflow" || k === "lanes");
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

/** One lane: either a single tag (shown in the lane header) or several SUBLANES — one tag each,
 *  stacked vertically, each tag shown only in its sublane head. */
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

/** The explicit `lanes:` config (lanes × tag paths), or null when the board only seeds from a
 *  `workflow:`. `lanes` projects as an array of arrays of tag links. */
function explicitLanes(node: NodeJson): string[][] | null {
  const raw = tagFields(node.value).find(([k]) => k === "lanes")?.[1];
  if (!Array.isArray(raw)) return null;
  return raw.map((lane) => (Array.isArray(lane) ? lane.map(targetPath).filter((p): p is string => !!p) : []));
}

// Keys the board owns as config / taxonomy / graft — never cards.
const BOARD_CONFIG_KEYS = new Set(["workflow", "lanes", "yamlover", "tags"]);

/** The directory's CARD members — content entities, not the board's own config / taxonomy / graft.
 *  Drawn from the SHARED projection ({@link memberItems}) so a board lists the same members the
 *  icon/details views do, minus the board's config keys and any nested tag/workflow/board link. */
export function cardMemberPaths(node: NodeJson): string[] {
  return memberItems(node)
    .filter((it) => it.link && !BOARD_CONFIG_KEYS.has(it.key))
    .filter((it) => !(it.link!.format && CONTAINER_TAGISH.has(it.link!.format)))
    .map((it) => it.link!.path);
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
 * The BOARD view (TICKETS.md §3) — a tag-lane layout over a directory, now one of the explorer's
 * view modes. Lanes come from the board overlay's explicit `lanes:` (each lane a single tag or a
 * list of sublane tags) or, absent that, are seeded from a `workflow:` (flowing states each a
 * lane, terminal states merged into one lane of sublanes). A plain lane shows its tag in the
 * header; sublanes are added explicitly (the header's ＋) and each shows its tag only in its own
 * head — per-tag drop zones stacked vertically (persisted via `POST /api/board`). Dragging a card
 * between lanes/sublanes re-tags it (move: drop the source tag, add the target — advisory).
 * Cancelled-like tags are struck through. Right-click a card → the shared tagging menu.
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
        // `lanes:` config needs a DEEPER fetch (board → lanes → tags), where members instead
        // expand inline, so the two are read from different depths.
        const wfPath = workflowPathOf(node);
        const hasLanes = tagFields(node.value).some(([k]) => k === "lanes");
        const explicit = hasLanes ? explicitLanes(await fetchNode(node.path, 3)) : null;
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

  // The current lanes as a plain `lanes` config (materializing a workflow seed on first edit).
  const currentLanes = (): string[][] => lanes.map((l) => l.tags.map((t) => t.path));
  const persist = (ls: string[][]) => { saveBoardLanes(node.path, ls).catch((e) => setError(String((e as Error)?.message || e))); };
  const addTagToLane = (laneI: number, tagPath: string) => { const ls = currentLanes(); if (!ls[laneI]) ls[laneI] = []; if (!ls[laneI].includes(tagPath)) ls[laneI].push(tagPath); persist(ls); };
  const removeTagFromLane = (laneI: number, tagPath: string) => { const ls = currentLanes().map((l, i) => (i === laneI ? l.filter((t) => t !== tagPath) : l)); persist(ls); };
  const addLane = () => persist([...currentLanes(), []]);
  const removeLane = (laneI: number) => persist(currentLanes().filter((_, i) => i !== laneI));

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
                {lane.tags.length === 1 && (
                  <TagTip tag={{ path: lane.tags[0].path, name: lane.tags[0].label, color: lane.tags[0].color }}>
                    <button
                      type="button"
                      className="tagtag on"
                      style={tagStyle(resolveTagColor({ name: lane.tags[0].label, color: lane.tags[0].color }))}
                      onClick={() => removeTagFromLane(laneI, lane.tags[0].path)}
                    >
                      <span className="tt-label">{lane.tags[0].label}</span>
                    </button>
                  </TagTip>
                )}
                <button className="board-lane-add" title={lane.tags.length === 0 ? "set this lane's tag" : "add a sublane"} onClick={(e) => setPicker({ lane: laneI, x: e.clientX, y: e.clientY })}>＋</button>
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
                        <span className="board-group-dot" style={tagStyle(color)} />
                        <span className="board-group-title">{t.label}</span>
                        <span className="board-col-count">{groupCards.length}</span>
                        <button className="board-group-del" title="remove this sublane" onClick={() => removeTagFromLane(laneI, t.path)}>✕</button>
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
          title={displayPath(node.path)}
        />
      )}
    </div>
  );
}
