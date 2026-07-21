// The EDITABLE BREADCRUMB — the topbar's locator AND query editor in one: a permanent row
// of smart cells (yamlover-editor style), one per query portion. Clicking any cell (or the
// empty tail) places the caret and starts editing; the TOC filters live; the dropdown
// offers the context's REAL children as true TOC rows (TreeRow) plus query operators.
//
// The machinery is the SHARED query-cell kit (query-cells.tsx) in BROWSE mode — this file
// is only the breadcrumb chrome: the nav shell, the root label, F4, the ✕ clear button.
// The state table lives in QUERY_EDITOR.yamlover; the reducer in breadcrumb-machine.ts.

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

  // F4 focuses the append cell from anywhere (skipping inputs, like App's key handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F4") return;
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
      {rootLabel && <span className="crumb crumb-root">{rootLabel}</span>}
      <QueryCells host={api} idlePortions={portionsFromPath(current)} leadingSep tail={false} className="crumbs-cells" />
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
