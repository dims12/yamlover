// The EDITABLE BREADCRUMB — the topbar's locator AND query editor in one: a permanent row
// of smart cells (projectional-editor style), one per query portion. Clicking any cell (or the
// empty tail) places the caret and starts editing; the TOC filters live; the dropdown
// offers the context's REAL children as true TOC rows (TreeRow) plus query operators.
//
// The machinery is the SHARED query-cell kit (query-cells.tsx) in BROWSE mode — this file
// is only the breadcrumb chrome: the nav shell, the root label, F4, the ✕ clear button.
// The state table lives in docs/server/query-editor; the reducer in breadcrumb-machine.ts.

import { useEffect, useRef } from "react";
import { TreeNode } from "./api";
import { BcEvent, BcState, browseCtx } from "./breadcrumb-machine";
import { portionsFromPath, treeCandidateProvider } from "./query-complete";
import { QueryCellHost, QueryCells, QueryCellsTail, useQueryCellHost } from "./query-cells";
import { TocFilterSession } from "./toc-filter-session";

/** The breadcrumb host — the shared QueryCellHost shape (App reads the filter through it
 *  when no session is wired, e.g. in tests). */
export type BreadcrumbApi = QueryCellHost;

/** The machine host + effects runner. Lives in App (the TOC needs the filter tree). */
export function useBreadcrumb(opts: { current: string; select: (path: string) => void; session?: TocFilterSession | null }): BreadcrumbApi {
  const currentRef = useRef(opts.current);
  currentRef.current = opts.current;
  const selectRef = useRef(opts.select);
  selectRef.current = opts.select;
  const provider = useRef(treeCandidateProvider(":")).current;
  return useQueryCellHost({
    ctx: () => browseCtx(currentRef.current),
    provider,
    onSelect: (p) => {
      if (p !== null) selectRef.current(p); // browse mode never selects null
    },
    session: opts.session,
  });
}

export function Breadcrumb({ current, rootLabel, api }: { current: string; rootLabel: string; api: BreadcrumbApi }) {
  const { state, dispatch } = api;

  // F4 / Ctrl-F focus the append cell from anywhere (skipping inputs, like App's key
  // handler — so the browser's own find stays reachable while actually typing text).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrlF = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "f" || e.key === "F");
      if (e.key !== "F4" && !ctrlF) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      dispatch({ type: "FOCUS_CELL", caret: "end" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  return (
    <nav className={"crumbs" + (state.mode === "editing" ? " editing" : "")}>
      {/* the ROOT crumb is a real link home: clicking it navigates to `:` — routed as a
          TOC_CLICK so every machine state does the right thing (idle navigates; an edit or
          a committed query collapses to idle first, exactly like clicking a non-match row) */}
      {rootLabel && (
        <span
          className="crumb crumb-root"
          role="link"
          tabIndex={0}
          title="Go to the project root"
          onClick={() => dispatch({ type: "TOC_CLICK", path: ":" })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              dispatch({ type: "TOC_CLICK", path: ":" });
            }
          }}
        >
          {rootLabel}
        </span>
      )}
      <QueryCells host={api} idlePortions={portionsFromPath(current)} leadingSep tail={false} className="crumbs-cells" />
      {/* the APPEND AFFORDANCE: a dim ghost slot after the last crumb says "the caret goes
          here" — idle only (an editing cell wears the ring, a filtered query the ✕).
          mousedown, not click, so it never blurs an active cell first (the tail's rule). */}
      {state.mode === "idle" && (
        <span
          className="crumbs-append"
          title="Search / go to path — Ctrl-F or F4"
          onMouseDown={(e) => {
            e.preventDefault();
            dispatch({ type: "FOCUS_CELL", caret: "end" });
          }}
        >
          ⌕
        </span>
      )}
      {/* the ✕ hugs the path's end — BEFORE the flex spacer (the tail), or it lands at the far edge */}
      {state.mode === "filtered" && (
        <button type="button" className="crumbs-clear" title="Clear the query" aria-label="Clear the query" onClick={() => dispatch({ type: "ESCAPE" })}>
          ✕
        </button>
      )}
      <QueryCellsTail dispatch={dispatch} />
    </nav>
  );
}

// Re-exports kept so existing imports (tests) stay stable during the extraction.
export type { BcEvent, BcState, TreeNode };
