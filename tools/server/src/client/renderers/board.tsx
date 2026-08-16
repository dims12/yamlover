import { useEffect, useRef, useState } from "react";
import { planBoardMove } from "../../drop-policy";
import { moveDeltas, type CompartmentAt, type BoardStructure } from "../../board-model";
import { NodeJson, TagRef, BoardCard, BoardCompartmentView, BoardResolved, boardMove, boardReconcile, fetchBoard, saveBoardStructure } from "../api";
import { READ_ONLY } from "../base";
import { useDropConfirm } from "../DropConfirm";
import { touchesYamlover, useDiffBump } from "../live";
import { resolveTagColor, tagFields, tagStyle } from "./tag";
import { displayPath } from "../paths";
import { AnnotationMenu, rememberTag, withinQueryDropdown, withinTocPane } from "./annotate";
import { TagTip } from "./tagtip";

export const BOARD_FORMAT = "x-yamlover-board";

/** Whether a directory should default to (and offer) the BOARD view: it carries the board schema,
 *  or an overlay board config (a `workflow:` seed or an explicit `lanes:` list). */
export function isBoardNode(node: NodeJson): boolean {
  if (node.format === BOARD_FORMAT) return true;
  return tagFields(node.value).some(([k]) => k === "workflow" || k === "lanes");
}

// Tags whose cards read as "did not complete" — struck through. A naming heuristic for now.
const NEGATIVE_TERMINAL = new Set(["cancelled", "canceled", "rejected", "wontfix", "won't-fix", "dropped", "declined", "abandoned", "duplicate", "invalid"]);
const isNegative = (label: string) => NEGATIVE_TERMINAL.has(label.toLowerCase());

/** The client's half of the persistable structure: the resolved lanes stripped back to paths. */
function structureOf(lanes: BoardCompartmentView[][]): BoardStructure {
  return lanes.map((lane) =>
    lane.map((c) => ({
      tags: c.tags.map((t) => t.path),
      items: c.items.map((it) => ({ path: it.path, ...(it.key !== undefined ? { key: it.key } : {}) })),
    })),
  );
}

/** The card for `task` wherever it currently shows (a compartment or the backlog). */
function cardOf(board: BoardResolved, task: string): BoardCard | undefined {
  for (const lane of board.lanes) for (const c of lane) { const hit = c.items.find((it) => it.path === task); if (hit) return hit; }
  return board.backlog.find((it) => it.path === task);
}

/**
 * The TAG BOARD view (TICKETS.md §3) — lanes of tagged COMPARTMENTS over a directory/object,
 * one of the explorer's view modes. The structure lives in the board's `yo: lanes:` member
 * (board-model.ts is the pure policy; a legacy `workflow:`/`lanes:` board displays from a seed
 * and materializes on the first write). Opening the view runs the silent structure RECONCILE
 * (structure follows tags — never the other way); dragging a card between compartments (or
 * to/from the BACKLOG below — the members no compartment references) is the ONLY retagging
 * verb, confirmed through the shared drop popup with its tag deltas spelled out. Compartment
 * tags are edited in place (chip click removes, ＋ opens the shared picker) — a tag-list edit
 * reconciles, it never retags. Right-click a card → the shared tagging menu.
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
  const [board, setBoard] = useState<BoardResolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ task: string; from: CompartmentAt } | null>(null);
  const [over, setOver] = useState<string | null>(null); // "lane:comp" | "backlog"
  const [picker, setPicker] = useState<{ lane: number; comp: number; x: number; y: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const dropConfirm = useDropConfirm(); // the unified drop confirmation popup (drop-policy.ts)
  const lanesRef = useRef<HTMLDivElement>(null);
  const [panning, setPanning] = useState(false);

  // GRAB-PAN the lane row (the image/map idiom): with many lanes the pane overflows
  // horizontally — dragging its background scrolls it, no need to find the scrollbar. Cards,
  // chips, and buttons keep their own gestures: the pan only takes the pane's empty ground.
  const onPanDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(".board-card, button, a, input, .tagtag")) return;
    const el = lanesRef.current;
    if (!el) return;
    e.preventDefault(); // no text selection while panning
    const start = { x: e.clientX, left: el.scrollLeft };
    setPanning(true);
    const move = (ev: MouseEvent) => { el.scrollLeft = start.left - (ev.clientX - start.x); };
    const up = () => {
      setPanning(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const fail = (e: unknown) => setError(String((e as Error)?.message || e));

  // View-open: the silent structure fix (a still-seeded legacy board reconciles in memory only —
  // opening a view never dirties the repo). Read-only servers just read.
  useEffect(() => {
    let cancelled = false;
    (READ_ONLY ? fetchBoard(node.path) : boardReconcile(node.path))
      .then((b) => { if (!cancelled) { setBoard(b); setError(null); } })
      .catch((e) => { if (!cancelled) fail(e); });
    return () => { cancelled = true; };
  }, [node.path]);

  // Any yamlover diff (a tag write elsewhere, another tab's move) → re-read the resolved board.
  useEffect(() => {
    if (!diffBump) return;
    let cancelled = false;
    fetchBoard(node.path)
      .then((b) => { if (!cancelled) { setBoard(b); setError(null); } })
      .catch((e) => { if (!cancelled) fail(e); });
    return () => { cancelled = true; };
  }, [node.path, diffBump]);

  const persist = (structure: BoardStructure) => {
    saveBoardStructure(node.path, structure).then(setBoard).catch(fail);
  };
  const addLane = () => { if (board) persist([...structureOf(board.lanes), [{ tags: [], items: [] }]]); };
  const removeLane = (laneI: number) => { if (board) persist(structureOf(board.lanes).filter((_, i) => i !== laneI)); };
  const addCompartment = (laneI: number) => {
    if (!board) return;
    persist(structureOf(board.lanes).map((l, i) => (i === laneI ? [...l, { tags: [], items: [] }] : l)));
  };
  const removeCompartment = (laneI: number, compI: number) => {
    if (!board) return;
    const st = structureOf(board.lanes).map((l, i) => (i === laneI ? l.filter((_, j) => j !== compI) : l));
    persist(st.filter((l) => l.length > 0)); // the last compartment takes its lane with it
  };
  const addTagToComp = (laneI: number, compI: number, tagPath: string) => {
    if (!board) return;
    const st = structureOf(board.lanes);
    const comp = st[laneI]?.[compI];
    if (!comp || comp.tags.includes(tagPath)) return;
    comp.tags.push(tagPath);
    persist(st);
  };
  const removeTagFromComp = (laneI: number, compI: number, tagPath: string) => {
    if (!board) return;
    const st = structureOf(board.lanes);
    const comp = st[laneI]?.[compI];
    if (!comp) return;
    comp.tags = comp.tags.filter((t) => t !== tagPath);
    persist(st);
  };

  // The move gesture — the board's ONLY retagging verb. The popup spells the tag deltas
  // (board-model moveDeltas, the same rule the server re-runs authoritatively).
  const onDropTo = (to: CompartmentAt, x: number, y: number) => {
    const d = drag;
    setDrag(null);
    setOver(null);
    if (!d || !board) return;
    const card = cardOf(board, d.task);
    const fromView = d.from ? board.lanes[d.from.lane]?.[d.from.comp] : null;
    const toView = to ? board.lanes[to.lane]?.[to.comp] : null;
    const deltas = moveDeltas(
      new Set(card?.tags ?? []),
      fromView ? { tags: fromView.tags.map((t) => t.path), items: [] } : null,
      toView ? { tags: toView.tags.map((t) => t.path), items: [] } : null,
    );
    const refs = [...(fromView?.tags ?? []), ...(toView?.tags ?? [])];
    const named = (paths: string[]) => paths.map((p) => ({ path: p, name: refs.find((t) => t.path === p)?.name ?? p }));
    const v = planBoardMove(
      { path: d.task, title: card?.title },
      d.from,
      to,
      { untag: named(deltas.untag), tag: named(deltas.tag) },
      toView ? toView.tags.map((t) => t.name).join(" + ") || "compartment" : null,
    );
    if (!v.allowed) return;
    dropConfirm.request(x, y, v.plan, async () => {
      setBoard(await boardMove(node.path, d.task, d.from, to));
    });
  };

  // The compartment tag picker (reuses the floating AnnotationMenu; create-on-miss mints new tags).
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current?.contains(e.target as Node)) return;
      if (withinTocPane(e.target)) return; // a TOC row click APPLIES the tag — never a close
      if (withinQueryDropdown(e.target)) return; // a candidate pick in the portaled dropdown — never a close
      setPicker(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [picker]);

  if (error) return <div className="board-error">Board error: {error}</div>;
  if (!board) return <div className="board board-loading">…</div>;

  const renderCard = (c: BoardCard, from: CompartmentAt, color: string, neg: boolean) => (
    <article
      key={c.path}
      className={"board-card" + (neg ? " board-card-negative" : "")}
      draggable={!READ_ONLY}
      onDragStart={() => setDrag({ task: c.path, from })}
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
  );

  return (
    <div className="board">
      {dropConfirm.element}
      <div className={"board-lanes" + (panning ? " board-panning" : "")} ref={lanesRef} onMouseDown={onPanDown}>
        {board.lanes.map((lane, laneI) => {
          const headTag = lane[0]?.tags[0];
          const headColor = headTag ? resolveTagColor({ name: headTag.name, color: headTag.color }) : "#6c7086";
          return (
            <div key={laneI} className="board-col-wrap">
            {/* no separate lane header — the FIRST compartment's tag row IS the lane's top
                (it carries the lane 🗑 too), so no vertical space is spent above the tags */}
            <section className="board-col" style={{ borderTopColor: headColor }}>
              <div className="board-col-body">
                {lane.map((comp, compI) => {
                  const key = `${laneI}:${compI}`;
                  const first = comp.tags[0];
                  const color = first ? resolveTagColor({ name: first.name, color: first.color }) : "#6c7086";
                  const neg = comp.tags.some((t) => isNegative(t.name));
                  return (
                    <div
                      key={key}
                      className={"board-group board-comp" + (compI > 0 ? " board-group-split" : "") + (over === key ? " board-group-over" : "")}
                      onDragOver={(e) => { if (drag) { e.preventDefault(); if (over !== key) setOver(key); } }}
                      onDrop={(e) => { e.preventDefault(); onDropTo({ lane: laneI, comp: compI }, e.clientX, e.clientY); }}
                    >
                      <div className="board-group-head board-comp-head">
                        <div className="board-col-tags">
                          {comp.tags.map((t) => (
                            <TagTip key={t.path} tag={t}>
                              <button
                                type="button"
                                className="tagtag on"
                                title="remove this tag from the compartment"
                                style={tagStyle(resolveTagColor({ name: t.name, color: t.color }))}
                                onClick={() => removeTagFromComp(laneI, compI, t.path)}
                              >
                                <span className="tt-label">{t.name}</span>
                              </button>
                            </TagTip>
                          ))}
                          {!READ_ONLY && (
                            <button
                              className="board-lane-add"
                              title={comp.tags.length === 0 ? "set this compartment's tag" : "add a tag"}
                              onClick={(e) => setPicker({ lane: laneI, comp: compI, x: e.clientX, y: e.clientY })}
                            >
                              ＋
                            </button>
                          )}
                        </div>
                        <span className="board-col-count">{comp.items.length}</span>
                        {!READ_ONLY && <button className="board-group-del" title="remove this compartment" onClick={() => removeCompartment(laneI, compI)}>✕</button>}
                        {compI === 0 && !READ_ONLY && <button className="board-lane-del" title="remove this lane" onClick={() => removeLane(laneI)}>🗑</button>}
                      </div>
                      <div className="board-group-cards">
                        {comp.items.map((c) => renderCard(c, { lane: laneI, comp: compI }, color, neg))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
            {/* the vertical twin of the trailing ＋ lane ghost: a compartment is a stacked
                sub-lane, so its adder reads "＋ lane" too — below the column, outside its box */}
            {!READ_ONLY && <button className="board-add-comp" title="add a compartment below" onClick={() => addCompartment(laneI)}>＋ lane</button>}
            </div>
          );
        })}
        {!READ_ONLY && <button className="board-add-lane" title="add a lane" onClick={addLane}>＋ lane</button>}
      </div>
      <section
        className={"board-backlog" + (over === "backlog" ? " board-group-over" : "")}
        onDragOver={(e) => { if (drag && drag.from) { e.preventDefault(); if (over !== "backlog") setOver("backlog"); } }}
        onDrop={(e) => { e.preventDefault(); onDropTo(null, e.clientX, e.clientY); }}
      >
        <header className="board-backlog-head">
          <span className="board-backlog-title">backlog</span>
          <span className="board-col-count">{board.backlog.length}</span>
        </header>
        <div className="board-backlog-cards">
          {board.backlog.map((c) => renderCard(c, null, "#6c7086", false))}
        </div>
      </section>
      {picker && (
        <AnnotationMenu
          menuRef={pickerRef}
          x={picker.x}
          y={picker.y}
          applied={[]}
          mode="create"
          onPick={(t: TagRef) => { rememberTag(t); addTagToComp(picker.lane, picker.comp, t.path); setPicker(null); }}
          onClose={() => setPicker(null)}
          title={displayPath(node.path)}
        />
      )}
    </div>
  );
}
