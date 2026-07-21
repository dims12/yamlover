// The SHARED QUERY-CELL EDITOR KIT — extracted from the breadcrumb so every query-typing
// surface is the same machinery: the breadcrumb (browse mode), the yamlover editor's
// in-place reference cell and the tag picker (pick mode). One machine (breadcrumb-machine),
// one candidate provider shape (query-complete), one cell row + dropdown (here), one TOC
// filter owner (toc-filter-session).
//
// Cell mechanics follow the yamlover editor's EditableCell patterns (uncontrolled
// contentEditable, machine-driven rewrites applied only alongside a focus request,
// dropdown mousedown prevented so a click never blurs the cell first) and reuse
// caret.ts verbatim. The human-readable state table lives in QUERY_EDITOR.yamlover.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchTree, queryFilter, TreeNode } from "./api";
import { BcEvent, BcState, CaretPos, Effect, MachineCtx, reduce } from "./breadcrumb-machine";
import { Candidate, CandidateProvider, Ladder } from "./query-complete";
import { replaceChildren } from "./tree-model";
import { TocFilterHandle, TocFilterSession } from "./toc-filter-session";
import { TreeRow } from "./TreeRow";
import { caretAtEnd, caretAtStart, focusEnd, focusStart, placeCaret } from "./renderers/caret";

const CANDIDATE_DEBOUNCE_MS = 150;
const FILTER_DEBOUNCE_MS = 250;
const BLUR_GRACE_MS = 150; // a TOC mousedown blurs the cell before its click lands — wait for it

/** What a query-cell host exposes: machine state + dispatch, the filter tree (for hosts
 *  that render it themselves — the breadcrumb API kept this shape), and the internals the
 *  QueryCells component needs. */
export interface QueryCellHost {
  state: BcState;
  dispatch: (e: BcEvent) => void;
  /** The pruned filter tree (matches + ancestors) — null until a filter result arrived. */
  filterTree: TreeNode | null;
  truncated: boolean;
  /** Chevron loads of REAL children inside the filter tree. */
  filterLoadChildren: (path: string, levels?: number) => Promise<void>;
  _focusReq: React.MutableRefObject<{ index: number; caret: CaretPos } | null>;
  _blurTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
}

export interface QueryCellHostOpts {
  /** The machine context, read fresh on every dispatch (hosts keep it live via closures). */
  ctx: () => MachineCtx;
  /** Candidate source for the dropdown (see treeCandidateProvider). */
  provider: CandidateProvider;
  /** The machine's `select` effect — browse: navigate (never null); pick: commit the
   *  chosen path, null = the typed query matched nothing (host decides what commits).
   *  Pick selects carry the editing ladder + the full typed query at commit time. */
  onSelect: (path: string | null, meta?: { ladder: Ladder; query: string }) => void;
  /** The shared TOC filter session; null/undefined = keep the filter tree host-local. */
  session?: TocFilterSession | null;
}

/** The machine host + effects runner (debounces, seq guards, blur grace, focus requests,
 *  TOC-filter session lifecycle). Generalized from the breadcrumb's useBreadcrumb. */
export function useQueryCellHost(opts: QueryCellHostOpts): QueryCellHost {
  const [state, setState] = useState<BcState>({ mode: "idle" });
  const stateRef = useRef(state);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Host-local filter state — the fallback when no session is provided (bare tests, hosts
  // that render their own filtered tree). With a session, results go to the handle instead.
  const [localFilter, setLocalFilter] = useState<{ root: TreeNode; truncated: boolean } | null>(null);
  const handleRef = useRef<TocFilterHandle | null>(null);

  const candTimer = useRef<ReturnType<typeof setTimeout>>();
  const matchTimer = useRef<ReturnType<typeof setTimeout>>();
  const latestMatchSeq = useRef(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>();
  // focus requests are applied by the QueryCells component's layout effect
  const focusReq = useRef<{ index: number; caret: CaretPos } | null>(null);

  const dispatch = useCallback((e: BcEvent) => {
    if (e.type !== "BLUR") clearTimeout(blurTimer.current); // a real event pre-empts a pending blur
    const [next, effects] = reduce(stateRef.current, e, optsRef.current.ctx());
    stateRef.current = next;
    setState(next);
    for (const fx of effects) run(fx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const setFilterResult = (f: { root: TreeNode; truncated: boolean } | null) => {
    if (handleRef.current) handleRef.current.set(f);
    else setLocalFilter(f);
  };

  const run = (fx: Effect): void => {
    switch (fx.type) {
      case "focusCell":
        focusReq.current = { index: fx.index, caret: fx.caret };
        break;
      case "focusToc":
        break; // the select effect focuses the RHS (selectFromToc) — nothing extra needed
      case "select":
        optsRef.current.onSelect(fx.path, fx.ladder !== undefined ? { ladder: fx.ladder, query: fx.query ?? "" } : undefined);
        break;
      case "fetchCandidates": {
        clearTimeout(candTimer.current);
        candTimer.current = setTimeout(() => {
          optsRef.current.provider(fx.contextQuery, fx.prefix).then(
            (items: Candidate[]) => dispatch({ type: "CANDIDATES_ARRIVED", seq: fx.seq, items }),
            () => dispatch({ type: "CANDIDATES_ARRIVED", seq: fx.seq, items: [] }),
          );
        }, CANDIDATE_DEBOUNCE_MS);
        break;
      }
      case "fetchMatches": {
        clearTimeout(matchTimer.current);
        latestMatchSeq.current = fx.seq;
        matchTimer.current = setTimeout(() => {
          queryFilter(fx.query).then(
            (r) => {
              if (fx.seq === latestMatchSeq.current) {
                setFilterResult({ root: r.root, truncated: r.truncated }); // last good stays on a later failure
              }
              dispatch({ type: "MATCHES_ARRIVED", seq: fx.seq, ok: true, paths: r.matches, truncated: r.truncated });
            },
            () => dispatch({ type: "MATCHES_ARRIVED", seq: fx.seq, ok: false, paths: [], truncated: false }),
          );
        }, fx.immediate ? 0 : FILTER_DEBOUNCE_MS);
        break;
      }
    }
  };

  // TOC filter session lifecycle: claim it while editing/filtered, release on idle.
  const session = opts.session ?? null;
  useEffect(() => {
    if (state.mode !== "idle" && session && !handleRef.current) {
      handleRef.current = session.begin({
        onPick: (path) => dispatchRef.current({ type: "TOC_CLICK", path }),
        onEvicted: () => {
          handleRef.current = null;
          dispatchRef.current({ type: "EVICTED" });
        },
      });
    }
    if (state.mode === "idle" && handleRef.current) {
      handleRef.current.end();
      handleRef.current = null;
    }
  }, [state.mode, session]);

  // leaving the editor (idle) drops the pruned tree — the untouched normal TOC returns
  useEffect(() => {
    if (state.mode === "idle") setLocalFilter(null);
  }, [state.mode]);
  useEffect(
    () => () => {
      clearTimeout(candTimer.current);
      clearTimeout(matchTimer.current);
      clearTimeout(blurTimer.current);
      handleRef.current?.end();
      handleRef.current = null;
    },
    [],
  );

  const localLoadChildren = useCallback(async (path: string, levels = 1) => {
    const sub = await fetchTree(path, levels);
    setLocalFilter((t) => (t ? { ...t, root: replaceChildren(t.root, path, sub.children) } : t));
  }, []);

  const filter = session ? session.filter : localFilter;
  const host = {
    state,
    dispatch,
    filterTree: filter?.root ?? null,
    truncated: filter?.truncated ?? false,
    filterLoadChildren: session ? session.loadChildren : localLoadChildren,
  } as QueryCellHost;
  host._focusReq = focusReq;
  host._blurTimer = blurTimer;
  return host;
}

/** Character offset of the collapsed caret inside `el` (0 when none). */
function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return el.textContent?.length ?? 0;
  const r = document.createRange();
  r.selectNodeContents(el);
  const c = sel.getRangeAt(0);
  if (!el.contains(c.startContainer)) return el.textContent?.length ?? 0;
  r.setEnd(c.startContainer, c.startOffset);
  return r.toString().length;
}

export interface QueryCellsProps {
  host: QueryCellHost;
  /** The cells to render while the machine is idle (the host's committed spelling). */
  idlePortions: string[];
  /** Render the scope opener before the FIRST cell (the breadcrumb — a root label sits to
   *  its left). Pick hosts without it render their own scope chip instead. */
  leadingSep?: boolean;
  /** The ladder the IDLE cells spell under (default 1 — the document scope). While editing,
   *  the machine's live ladder wins. */
  idleLadder?: Ladder;
  /** Render the trailing append affordance (default true). A host that needs other chrome
   *  after the cells (the breadcrumb's ✕) renders its own tail via {@link QueryCellsTail}. */
  tail?: boolean;
  /** PICK hosts: `:` in the empty first cell escalates the scope ladder, Backspace at the
   *  first cell's start de-escalates (SCOPE events — browse machines ignore them). */
  scopeKeys?: boolean;
  /** Backspace in the ONLY, EMPTY cell at the ladder's floor (bare scope) — the host
   *  dismantles its own affordance (the pointer cell's `*`). */
  onEmptyBackspace?: () => void;
  /** The empty typing cell's placeholder (default "…"). */
  placeholder?: string;
  className?: string;
}

/** The append affordance: clicking the empty area after the last cell opens the append
 *  cell. Split out so hosts can place it after their own trailing chrome. */
export function QueryCellsTail({ dispatch }: { dispatch: (e: BcEvent) => void }) {
  return (
    <span
      className="crumbs-tail"
      onMouseDown={(e) => {
        e.preventDefault(); // keep the click from blurring an active cell first
        dispatch({ type: "FOCUS_CELL", caret: "end" });
      }}
    />
  );
}

/**
 * The cell row: one contentEditable cell per query portion, `:` a real editable boundary
 * (typing `:` splits at the caret, Backspace/Delete at the edges merge), `[`/`]` bracket
 * projection, the candidate dropdown under the active cell. All behavior is the machine's —
 * this component renders state and forwards key events.
 */
export function QueryCells({ host, idlePortions, leadingSep, idleLadder = 1, tail = true, scopeKeys, onEmptyBackspace, placeholder = "…", className }: QueryCellsProps) {
  const { state, dispatch } = host;
  const rootRef = useRef<HTMLSpanElement>(null);
  const cellMap = useRef(new Map<number, HTMLElement>());

  // The cells to render: the machine's while editing/filtered, the host's when idle.
  const portions = state.mode === "idle" ? idlePortions : state.portions;
  const active = state.mode === "editing" ? state.active : -1;
  const dropdown = state.mode === "editing" ? state.dropdown : null;
  const queryError = state.mode === "editing" && state.queryError;
  // A cell's LIVE text: the machine's activeText for the cell being typed in (state.portions
  // lags it by design), the committed portion otherwise.
  const liveText = (i: number) => (i === active && state.mode === "editing" ? state.activeText : portions[i] ?? "");
  // The leading opener spells the LADDER (`:` / `::` / `:::`; bare = none) — a browse host is
  // always the document scope, a pick host's climbs with SCOPE. An index-headed FIRST cell is
  // an index ON THE ROOT (`: [0]`), so its opener is not drawn and the breadcrumb spells `root[0]`.
  const ladder = state.mode === "editing" ? state.ladder : idleLadder;
  const opener = [null, ":", "::", ":::"][ladder];
  const hideSep = (i: number) => (i === 0 ? !leadingSep || opener === null || liveText(0).startsWith("[") : false);

  // Apply a machine-driven focus request: rewrite the cell's text (machine rewrites always
  // ride a focus request — the editor.tsx pattern) and place the caret.
  useLayoutEffect(() => {
    const req = host._focusReq.current;
    if (!req) return;
    host._focusReq.current = null;
    const el = cellMap.current.get(req.index);
    if (!el) return;
    const want = portions[req.index] ?? "";
    if (el.textContent !== want) el.textContent = want;
    if (req.caret === "start") focusStart(el);
    else if (req.caret === "end") focusEnd(el);
    else placeCaret(el, req.caret);
  });

  // Leaving the editor (Escape/blur/commit): drop DOM focus from the abandoned cell and
  // resync every cell's text — the active cell blocks the ref-callback resync while focused.
  const prevMode = useRef(state.mode);
  useLayoutEffect(() => {
    if (prevMode.current === "editing" && state.mode !== "editing") {
      for (const el of cellMap.current.values()) if (el === document.activeElement) el.blur();
      cellMap.current.forEach((el, i) => {
        const want = portions[i] ?? "";
        if (el.textContent !== want) el.textContent = want;
      });
    }
    prevMode.current = state.mode;
  });

  // Rewrite the active cell's text directly (bracket projection) — the DOM is the edit
  // buffer, so the caret is placed by hand and the machine just learns the new text.
  const rewriteCell = (el: HTMLElement, text: string, caret: number) => {
    el.textContent = text;
    placeCaret(el, caret);
    dispatch({ type: "SET_ACTIVE_TEXT", text });
  };

  const onCellKeyDown = (index: number, e: React.KeyboardEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const text = el.textContent ?? "";
    if (e.key === ":") {
      e.preventDefault();
      if (scopeKeys && index === 0 && text === "") {
        dispatch({ type: "SCOPE", dir: 1 }); // the empty first cell: `:` climbs the ladder
        return;
      }
      const at = caretOffset(el);
      dispatch({ type: "SPLIT_CELL", before: text.slice(0, at), after: text.slice(at) });
      return;
    }
    if (e.key === "[") {
      e.preventDefault();
      if (text === "" && index > 0) {
        // an index continues the PREVIOUS portion — `pets` `:` `[` spells `pets[|]`
        dispatch({ type: "OPEN_INDEX" });
        return;
      }
      // project the pair, caret in between — like the editor's flow_seq `[`
      const at = caretOffset(el);
      rewriteCell(el, text.slice(0, at) + "[]" + text.slice(at), at + 1);
      return;
    }
    if (e.key === "]") {
      const at = caretOffset(el);
      if (text[at] === "]") {
        e.preventDefault(); // jump OVER the projected closer instead of doubling it
        placeCaret(el, at + 1);
        return;
      }
      return; // no projected closer here — the character types literally (hints, not validators)
    }
    if (e.key === "Backspace") {
      const at = caretOffset(el);
      if (at > 0 && text[at - 1] === "[" && text[at] === "]") {
        e.preventDefault(); // deleting the opener dismantles the empty projected pair
        rewriteCell(el, text.slice(0, at - 1) + text.slice(at + 1), at - 1);
        return;
      }
    }
    if (e.key === "Backspace" && caretAtStart(el) && index > 0) {
      e.preventDefault();
      dispatch({ type: "MERGE_PREV" });
      return;
    }
    if (scopeKeys && e.key === "Backspace" && caretAtStart(el) && index === 0) {
      e.preventDefault();
      const ladder = state.mode === "editing" ? state.ladder : 0;
      if (ladder > 0) dispatch({ type: "SCOPE", dir: -1 }); // step the ladder down
      else if (text === "" && portions.length <= 1) onEmptyBackspace?.(); // the floor: the host dismantles
      return;
    }
    if (e.key === "Delete" && caretAtEnd(el) && index < portions.length - 1) {
      e.preventDefault();
      dispatch({ type: "MERGE_NEXT" });
      return;
    }
    if (e.key === "ArrowLeft" && caretAtStart(el) && index > 0) {
      e.preventDefault();
      dispatch({ type: "FOCUS_CELL", index: index - 1, caret: "end" });
      return;
    }
    if (e.key === "ArrowRight" && caretAtEnd(el) && index < portions.length - 1) {
      e.preventDefault();
      dispatch({ type: "FOCUS_CELL", index: index + 1, caret: "start" });
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && dropdown?.open) {
      e.preventDefault();
      e.stopPropagation();
      dispatch({ type: "DROPDOWN_MOVE", dir: e.key === "ArrowDown" ? 1 : -1 });
      return;
    }
    if (e.key === "Tab" && dropdown?.open && dropdown.items.length > 0) {
      e.preventDefault();
      e.stopPropagation(); // the pointer cell's wrapper would indent on a bubbled Tab
      // Tab is the ACCEPT key: the armed candidate, else the FIRST one — Enter stays the
      // free-typed commit (hints are never validators), so completion needs its own key
      dispatch({ type: "PICK", index: dropdown.hi >= 0 ? dropdown.hi : 0 });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      dispatch({ type: "ENTER" });
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dispatch({ type: "ESCAPE" });
    }
  };

  const onRootBlur = (e: React.FocusEvent) => {
    if (state.mode !== "editing") return;
    if (e.relatedTarget && rootRef.current?.contains(e.relatedTarget as Node)) return; // moved between cells
    // Grace period: a TOC row's mousedown blurs the cell BEFORE its click dispatches
    // TOC_CLICK; any real event within the grace window pre-empts the pending BLUR.
    clearTimeout(host._blurTimer.current);
    host._blurTimer.current = setTimeout(() => dispatch({ type: "BLUR" }), BLUR_GRACE_MS);
  };

  return (
    <span className={"qcells" + (className ? " " + className : "")} ref={rootRef} onBlur={onRootBlur}>
      {portions.map((p, i) => (
        <span key={i} className="crumb-slot">
          {!hideSep(i) && <span className="crumb-sep">{i === 0 ? opener : ":"}</span>}
          <span
            ref={(el) => {
              if (el) {
                cellMap.current.set(i, el);
                // seed / resync the uncontrolled cell whenever it is not being typed in
                if (document.activeElement !== el && el.textContent !== p) el.textContent = p;
              } else {
                cellMap.current.delete(i);
              }
            }}
            className={"crumb crumb-cell editable" + (queryError && i === active ? " edit-error" : "")}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            data-placeholder={placeholder}
            onFocus={() => {
              if (state.mode !== "editing" || state.active !== i) dispatch({ type: "FOCUS_CELL", index: i });
            }}
            onInput={(e) => dispatch({ type: "SET_ACTIVE_TEXT", text: e.currentTarget.textContent ?? "" })}
            onKeyDown={(e) => onCellKeyDown(i, e)}
          />
          {i === active && dropdown?.open && <PortalDropdown anchor={() => cellMap.current.get(i) ?? null} dropdown={dropdown} dispatch={dispatch} />}
        </span>
      ))}
      {tail && <QueryCellsTail dispatch={dispatch} />}
    </span>
  );
}

/** The dropdown PORTALED to the body at fixed coordinates under the active cell — an
 *  ancestor's overflow box (the annotate popup, a scrolling pane) must never clip the
 *  candidates. Flips upward when the viewport below the cell is too short. */
function PortalDropdown({ anchor, dropdown, dispatch }: { anchor: () => HTMLElement | null; dropdown: { items: Candidate[]; hi: number }; dispatch: (e: BcEvent) => void }) {
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const measure = useCallback(() => {
    const el = anchorRef.current();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 240 && r.top > below;
    const left = Math.max(0, Math.min(r.left, window.innerWidth - 268));
    const next: React.CSSProperties = up ? { left, bottom: window.innerHeight - r.top } : { left, top: r.bottom };
    setPos((p) => (p && p.left === next.left && p.top === next.top && p.bottom === next.bottom ? p : next));
  }, []);
  useLayoutEffect(measure); // every render — typing widens the cell under the caret
  useEffect(() => {
    window.addEventListener("scroll", measure, true); // panes/popups scrolling under the dropdown
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);
  if (!pos) return null;
  return createPortal(<CandidateDropdown dropdown={dropdown} dispatch={dispatch} style={pos} />, document.body);
}

/** The candidate dropdown: the context's real children as true TOC rows + operator hints. */
export function CandidateDropdown({ dropdown, dispatch, style }: { dropdown: { items: Candidate[]; hi: number }; dispatch: (e: BcEvent) => void; style?: React.CSSProperties }) {
  return (
    // mousedown prevented: a click must never blur the cell before it lands (pointer-hints doctrine)
    <div className="crumb-dd" role="listbox" style={style} onMouseDown={(e) => e.preventDefault()}>
      {dropdown.items.map((c, i) =>
        c.kind === "key" ? (
          <div key={"k:" + c.insert} onMouseEnter={() => dispatch({ type: "DROPDOWN_SET", index: i })}>
            <TreeRow
              node={c.node}
              depth={0}
              chevron="none"
              highlighted={i === dropdown.hi}
              onSelect={() => dispatch({ type: "PICK", index: i })}
              rowRef={(el) => {
                if (el && i === dropdown.hi) el.scrollIntoView?.({ block: "nearest" });
              }}
            />
          </div>
        ) : (
          <div
            key={"o:" + c.insert}
            role="option"
            aria-selected={i === dropdown.hi}
            className={"tree-row" + (i === dropdown.hi ? " hi" : "")}
            style={{ paddingLeft: 4 }}
            onMouseEnter={() => dispatch({ type: "DROPDOWN_SET", index: i })}
            onClick={() => dispatch({ type: "PICK", index: i })}
          >
            <span className="icon opicon" aria-hidden="true">∗</span>
            <span className="tree-label">{c.insert}</span>
            <span className="tree-row-detail">{c.detail}</span>
          </div>
        ),
      )}
    </div>
  );
}
