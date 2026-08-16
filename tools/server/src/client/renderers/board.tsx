import { useEffect, useRef, useState } from "react";
import { planBoardMove } from "../../drop-policy";
import { moveDeltas, type CompartmentAt, type BoardStructure } from "../../board-model";
import { NodeJson, TagRef, BoardCard, BoardCompartmentView, BoardResolved, annotate, blobUrl, boardMove, boardReconcile, createObject, fetchBoard, saveBoardStructure, thumbUrl } from "../api";
import { READ_ONLY } from "../base";
import { typeIcon } from "../icons";
import { defaultChildConcrete } from "../../concrete-rules";
import { useEditing } from "./editing";
import { useDropConfirm } from "../DropConfirm";
import { touchesYamlover, useDiffBump } from "../live";
import { colorsFirst, isColorTagPath, resolveTagColor, tagFields, tagStyle } from "./tag";
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

/** The card for `task` wherever it currently shows (a compartment or the "other" section). */
function cardOf(board: BoardResolved, task: string): BoardCard | undefined {
  for (const lane of board.lanes) for (const c of lane) { const hit = c.items.find((it) => it.path === task); if (hit) return hit; }
  return board.backlog.find((it) => it.path === task);
}

/** An image member's card preview (the explorer's thumbSrc rule): rasters go through the
 *  server's downscaling /api/thumb cache, an SVG serves its own bytes; null = no preview
 *  (the corner glyph is the card's only mark). */
function cardThumbSrc(c: BoardCard): string | null {
  if (!c.format || !c.format.startsWith("image/")) return null;
  if (c.format === "image/svg+xml") return blobUrl(c.path);
  return thumbUrl(c.path, 220, 150);
}

/** The card's thumbnail strip — falls back to nothing when the server can't decode (415). */
function CardThumb({ card }: { card: BoardCard }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : cardThumbSrc(card);
  if (!src) return null;
  return <img className="board-card-thumb" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** The schema a NEW card is born with: the board's own convention, read off its EXISTING
 *  cards — the majority `x-yamlover-*` format maps to its `$defs` schema (task → $defs:task,
 *  chapter → $defs:chapter). A board with no formatted cards yet defaults to a task. */
function memberSchemaOf(board: BoardResolved): string {
  const counts = new Map<string, number>();
  for (const c of [...board.lanes.flat().flatMap((x) => x.items), ...board.backlog]) {
    if (c.format && /^x-yamlover-/.test(c.format)) counts.set(c.format, (counts.get(c.format) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return `::yamlover:$defs:${top ? top.replace(/^x-yamlover-/, "") : "task"}`;
}

/** Remove-confirm popup for the board's destructive edits (a tag chip, a compartment, a
 *  lane) — the anchored DropConfirm/Fragments idiom: fixed at the click, outside-click /
 *  Escape cancel, Enter or the button confirms. */
function BoardConfirm({ x, y, text, onConfirm, onCancel }: {
  x: number;
  y: number;
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onCancel(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onConfirm, onCancel]);
  const left = Math.min(Number.isFinite(x) ? x : 0, Math.max(0, window.innerWidth - 340));
  const top = Math.min(Number.isFinite(y) ? y : 0, Math.max(0, window.innerHeight - 120));
  return (
    <div ref={ref} className="drop-confirm" role="dialog" aria-label="confirm remove" style={{ left, top }}>
      <div className="drop-confirm-text">{text}</div>
      <div className="drop-confirm-actions">
        <button autoFocus onClick={onConfirm}>Remove</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * The TAG BOARD view (TICKETS.md §3) — lanes of tagged COMPARTMENTS over a directory/object,
 * one of the explorer's view modes. The structure lives in the board's `yo: lanes:` member
 * (board-model.ts is the pure policy; a legacy `workflow:`/`lanes:` board displays from a seed
 * and materializes on the first write). Opening the view runs the silent structure RECONCILE
 * (structure follows tags — never the other way); dragging a card between compartments (or
 * to/from the BACKLOG below — the members no compartment references) is the ONLY retagging
 * verb, confirmed through the shared drop popup with its tag deltas spelled out. Compartment
 * tags are edited in place (chip click removes AFTER a confirm, ＋ opens the shared picker) —
 * a tag-list edit reconciles, it never retags; a compartment left TAGLESS holds no member
 * tickets (the no-tagless-tickets principle), so emptying its tag list releases its cards.
 * Removing a compartment or a whole lane confirms the same way. Right-click a card → the
 * shared tagging menu.
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
  const { unlock } = useEditing(); // ＋ card flows straight into editing the newborn (NodeView's door)
  const [board, setBoard] = useState<BoardResolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ task: string; from: CompartmentAt } | null>(null);
  const [laneDrag, setLaneDrag] = useState<{ lane: number; comp: number } | null>(null);
  const [over, setOver] = useState<string | null>(null); // "lane:comp" | "backlog"
  const [picker, setPicker] = useState<{ lane: number; comp: number; x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<{ x: number; y: number; text: string; run: () => void } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const dropConfirm = useDropConfirm(); // the unified drop confirmation popup (drop-policy.ts)
  const lanesRef = useRef<HTMLDivElement>(null);
  const [panning, setPanning] = useState(false);

  // GRAB-PAN the lane row (the image/map idiom): with many lanes the pane overflows
  // horizontally — dragging its background scrolls it, no need to find the scrollbar. Cards,
  // chips, and buttons keep their own gestures: the pan only takes the pane's empty ground.
  const onPanDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(".board-card, .board-comp-head, button, a, input, .tagtag")) return;
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
  const addCompartment = (laneI: number) => {
    if (!board) return;
    persist(structureOf(board.lanes).map((l, i) => (i === laneI ? [...l, { tags: [], items: [] }] : l)));
  };
  const removeCompartment = (laneI: number, compI: number) => {
    if (!board) return;
    const st = structureOf(board.lanes).map((l, i) => (i === laneI ? l.filter((_, j) => j !== compI) : l));
    persist(st.filter((l) => l.length > 0)); // the last compartment takes its lane with it
  };
  // Dragging a lane BOX (by its head) onto a column's BOTTOM ＋ lane ghost STACKS it last in
  // that column — a pure structural regroup (compartments keep their tags and cards; nothing
  // is retagged), so no popup. Its own column's ghost sends it to the bottom of that column.
  const stackLane = (from: { lane: number; comp: number }, toLane: number) => {
    setLaneDrag(null);
    setOver(null);
    if (!board) return;
    const st = structureOf(board.lanes);
    const [moved] = st[from.lane].splice(from.comp, 1);
    if (!moved) return;
    st[toLane].push(moved);
    persist(st.filter((l) => l.length > 0));
  };
  // …and onto the TRAILING ＋ lane ghost: the dragged box moves out as its own new column.
  const extractLane = (from: { lane: number; comp: number }) => {
    setLaneDrag(null);
    setOver(null);
    if (!board) return;
    const st = structureOf(board.lanes);
    const [moved] = st[from.lane].splice(from.comp, 1);
    if (!moved) return;
    st.push([moved]);
    persist(st.filter((l) => l.length > 0));
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

  // Destructive edits (a tag chip, a compartment, a lane) confirm through the anchored popup
  // first — none of them retags, but each reshapes the board, and a mis-click must not.
  const cardsWord = (n: number): string => `${n} card${n === 1 ? "" : "s"}`;
  const askRemoveTag = (laneI: number, compI: number, t: TagRef, e: React.MouseEvent) => {
    const comp = board?.lanes[laneI]?.[compI];
    if (!comp) return;
    const text =
      comp.tags.length === 1 && comp.items.length > 0
        ? `Remove "${t.name}" — the compartment's last tag? Its ${cardsWord(comp.items.length)} will leave for "other" (a tagless compartment holds none; the cards' own tags are untouched).`
        : `Remove "${t.name}" from this compartment? Cards are not retagged.`;
    setConfirm({ x: e.clientX, y: e.clientY, text, run: () => removeTagFromComp(laneI, compI, t.path) });
  };
  // ONE deletion verb — a compartment IS a (sub-)lane, so the button SAYS "lane"; a column
  // losing its last compartment disappears with it (removeCompartment's rule).
  const askRemoveCompartment = (laneI: number, compI: number, e: React.MouseEvent) => {
    const comp = board?.lanes[laneI]?.[compI];
    if (!comp) return;
    const text =
      comp.items.length > 0
        ? `Remove this lane? Its ${cardsWord(comp.items.length)} are not retagged — they return to their tags' lanes, else "other".`
        : "Remove this lane?";
    setConfirm({ x: e.clientX, y: e.clientY, text, run: () => removeCompartment(laneI, compI) });
  };

  // ＋ card: a NEW member born in the board object with the board's member schema (its existing
  // cards' majority format), tagged with the compartment's tags, then opened UNLOCKED — the
  // button flows straight into editing the newborn; the fired-off reconcile files its ref so
  // the board is right when the user returns. Never offered tagless (no-tagless-tickets).
  const addCard = async (laneI: number, compI: number) => {
    if (!board) return;
    const comp = board.lanes[laneI]?.[compI];
    if (!comp || comp.tags.length === 0) return;
    try {
      const { path: born } = await createObject(memberSchemaOf(board), node.path, defaultChildConcrete(node.concrete));
      for (const t of comp.tags) await annotate({ target: born, tag: t.path });
      void boardReconcile(node.path).catch(() => {});
      onNavigate(born);
      unlock?.();
    } catch (e) {
      fail(e);
    }
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
      new Set((card?.tags ?? []).map((t) => t.path)),
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
      toView ? toView.tags.length === 0 : false,
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

  // `hideTags` = the containing compartment's tag paths — a card repeats every OTHER tag it
  // carries at its bottom (in "other" it shows all of them), in miniature chips.
  const renderCard = (c: BoardCard, from: CompartmentAt, color: string, neg: boolean, hideTags?: ReadonlySet<string>) => (
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
      <CardThumb card={c} />
      <div className="board-card-title">
        {(() => {
          const g = typeIcon(c.type ?? "", c.format ?? null, c.concrete);
          return <span className={"board-card-icon " + g.cls} title={g.title} data-yo-chrome>{g.glyph}</span>;
        })()}
        {c.title}
      </div>
      <div className="board-card-meta">
        {c.priority && <span className={"board-chip prio-" + c.priority}>{c.priority}</span>}
        {c.assignee && <span className="board-chip board-assignee">@{c.assignee}</span>}
        {c.due && <span className="board-chip board-due">{c.due.slice(0, 10)}</span>}
        <span className="board-card-tags">
          {colorsFirst(c.tags.filter((t) => !hideTags?.has(t.path))).map((t) => {
            const tc = resolveTagColor({ name: t.name, color: t.color });
            return isColorTagPath(t.path) ? (
              <span key={t.path} className="tagswatch" style={tagStyle(tc)} title={t.name} />
            ) : (
              <span key={t.path} className="tagtag" style={tagStyle(tc)} title={t.name}>
                {t.name}
              </span>
            );
          })}
        </span>
      </div>
    </article>
  );

  return (
    <div className="board">
      {dropConfirm.element}
      {confirm && (
        <BoardConfirm
          x={confirm.x}
          y={confirm.y}
          text={confirm.text}
          onConfirm={() => { const r = confirm.run; setConfirm(null); r(); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      <div className={"board-lanes" + (panning ? " board-panning" : "")} ref={lanesRef} onMouseDown={onPanDown}>
        {board.lanes.map((lane, laneI) => {
          return (
            <div key={laneI} className="board-col-wrap">
            {/* no separate lane header — each compartment IS its own rounded lane box (colored
                top bar, tag row first), stacked; the ✕ carries the lane deletion */}
            <section className="board-col">
              <div className="board-col-body">
                {lane.map((comp, compI) => {
                  const key = `${laneI}:${compI}`;
                  const shownTags = colorsFirst(comp.tags); // the ONE display order: swatches lead
                  const first = shownTags[0];
                  const color = first ? resolveTagColor({ name: first.name, color: first.color }) : "#6c7086";
                  const neg = comp.tags.some((t) => isNegative(t.name));
                  const ownTags = new Set(comp.tags.map((t) => t.path)); // hidden on this compartment's cards
                  return (
                    <div
                      key={key}
                      className={"board-group board-comp" + (over === key ? " board-group-over" : "")}
                      // every compartment wears the SAME rounded box + colored top bar a lane does
                      style={{ borderTopColor: color }}
                      onDragOver={(e) => { if (drag) { e.preventDefault(); if (over !== key) setOver(key); } }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (laneDrag) return; // a dragged LANE lands on the ＋ lane ghosts, never on a box
                        onDropTo({ lane: laneI, comp: compI }, e.clientX, e.clientY);
                      }}
                    >
                      <div
                        className="board-group-head board-comp-head"
                        // the head is the lane's DRAG HANDLE: drop it on another column to stack
                        draggable={!READ_ONLY}
                        onDragStart={() => setLaneDrag({ lane: laneI, comp: compI })}
                        onDragEnd={() => { setLaneDrag(null); setOver(null); }}
                      >
                        <div className="board-col-tags">
                          {shownTags.map((t) => (
                            <TagTip key={t.path} tag={t}>
                              {isColorTagPath(t.path) ? (
                                // a pure color tag IS its circle — swatch, never a name badge
                                <button
                                  type="button"
                                  className="tagswatch"
                                  title={`${t.name} — remove this tag from the lane`}
                                  style={tagStyle(resolveTagColor({ name: t.name, color: t.color }))}
                                  onClick={(e) => askRemoveTag(laneI, compI, t, e)}
                                />
                              ) : (
                                <button
                                  type="button"
                                  className="tagtag on"
                                  title="remove this tag from the lane"
                                  style={tagStyle(resolveTagColor({ name: t.name, color: t.color }))}
                                  onClick={(e) => askRemoveTag(laneI, compI, t, e)}
                                >
                                  <span className="tt-label">{t.name}</span>
                                </button>
                              )}
                            </TagTip>
                          ))}
                          {!READ_ONLY && (
                            <button
                              className="board-lane-add"
                              title={comp.tags.length === 0 ? "set this lane's tag" : "add a tag"}
                              onClick={(e) => setPicker({ lane: laneI, comp: compI, x: e.clientX, y: e.clientY })}
                            >
                              {/* the WORD carries it — "＋ tag" beside the ghosts' "＋ lane" */}
                              ＋ tag
                            </button>
                          )}
                        </div>
                        <span className="board-col-count">{comp.items.length}</span>
                        {!READ_ONLY && <button className="board-group-del" title="remove this lane" onClick={(e) => askRemoveCompartment(laneI, compI, e)}>✕</button>}
                      </div>
                      <div className="board-group-cards">
                        {comp.items.map((c) => renderCard(c, { lane: laneI, comp: compI }, color, neg, ownTags))}
                        {/* born with the board's member schema, tagged with THIS compartment's
                            tags — never offered tagless (no-tagless-tickets) */}
                        {!READ_ONLY && comp.tags.length > 0 && (
                          <button className="board-add-card" title="add a new card here" onClick={() => addCard(laneI, compI)}>＋</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
            {/* the vertical twin of the trailing ＋ lane ghost: a compartment is a stacked
                sub-lane, so its adder reads "＋ lane" too — below the column, outside its box.
                It is also the DROP TARGET for a dragged lane: dropping here stacks it LAST in
                this column (the ghost marks exactly where the box will land). */}
            {!READ_ONLY && (
              <button
                className={"board-add-comp" + (over === `ac:${laneI}` ? " board-drop-over" : "")}
                title="add a compartment below"
                onDragOver={(e) => { if (laneDrag) { e.preventDefault(); if (over !== `ac:${laneI}`) setOver(`ac:${laneI}`); } }}
                onDrop={(e) => { e.preventDefault(); if (laneDrag) stackLane(laneDrag, laneI); }}
                onClick={() => addCompartment(laneI)}
              >
                ＋ lane
              </button>
            )}
            </div>
          );
        })}
        {/* …and dropping a dragged lane on the TRAILING ghost starts a new column with it */}
        {!READ_ONLY && (
          <button
            className={"board-add-lane" + (over === "al" ? " board-drop-over" : "")}
            title="add a lane"
            onDragOver={(e) => { if (laneDrag) { e.preventDefault(); if (over !== "al") setOver("al"); } }}
            onDrop={(e) => { e.preventDefault(); if (laneDrag) extractLane(laneDrag); }}
            onClick={addLane}
          >
            ＋ lane
          </button>
        )}
      </div>
      <section
        className={"board-backlog" + (over === "backlog" ? " board-group-over" : "")}
        onDragOver={(e) => { if (drag && drag.from) { e.preventDefault(); if (over !== "backlog") setOver("backlog"); } }}
        onDrop={(e) => { e.preventDefault(); onDropTo(null, e.clientX, e.clientY); }}
      >
        <header className="board-backlog-head">
          {/* "other", not "backlog" — the section holds whatever no compartment references,
              whatever the tags mean (the wire field keeps its `backlog` name) */}
          <span className="board-backlog-title">other</span>
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
