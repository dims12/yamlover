// THE TOC RE-PLUG over the PURE portion cells (MINITODO 029's parked half). While a reference
// is being entered - the cursor's RefEntry, hole or pick - the mount claims the shared TOC
// filter session (toc-filter-session.tsx), feeds it the live joined query over
// `GET /api/query?shape=filter`, and a TOC row click spells the picked path INTO the cells
// (pointer-spell, the typed scope ladder honored). The pick INSERTS, never commits - the
// grammar's Enter stays the single commit point, exactly like a dropdown hint.
//
// THE SEAM IS HOST-SIDE ONLY: the pure editor stays TOC-blind. Everything here rides public
// surfaces - EditorState in, the pure refFromRaw/refRawOf helpers, setState out. With no
// session in context (bare tests, mounts outside App) the hook is inert; with the wire down
// the last good filter stands (the TOC advises like a hint, never gates typing). Eviction
// (another host claimed the TOC) only unplugs the panel - the reference edit stands.

import { useEffect, useRef } from "react";
import type { EditorState, Path } from "../../../../yed/src/state";
import { refFromRaw, refRawOf } from "../../../../yed/src/apply";
import type { Ladder } from "../../../../yed/src/grammar/portions";
import { queryFilter } from "../api";
import { spellPointer } from "../pointer-spell";
import { useTocFilter, type TocFilterHandle } from "../toc-filter-session";
import { serverPathOf } from "./yed-sync";

const FILTER_DEBOUNCE_MS = 150;

/** The reference edit the cursor currently carries - null when no portion cells are up. */
function refEditOf(state: EditorState | null): { holderPath: Path; ladder: Ladder; query: string } | null {
  if (!state) return null;
  const c = state.cursor;
  if ((c.at !== "hole" && c.at !== "pick") || c.ref === undefined) return null;
  return {
    holderPath: c.at === "pick" ? c.path.slice(0, -1) : c.path, // the pointer's holding container
    ladder: c.ref.ladder,
    query: refRawOf(c),
  };
}

/** Plug the TOC filter session onto a yed mount's reference entry. `hostOf` supplies the
 *  mount's wire addresses at pick time (the same base/doc EditorView's `host` prop carries),
 *  so the spelled portions and the ops can never disagree. */
export function useTocRefPick({ state, stateRef, apply, hostOf }: {
  state: EditorState | null;
  stateRef: { readonly current: EditorState | null };
  apply: (next: EditorState) => void;
  hostOf: () => { base: string; doc: string };
}): void {
  const session = useTocFilter(); // null outside App - the hook is inert
  const handleRef = useRef<TocFilterHandle | null>(null);
  const filterTimer = useRef<ReturnType<typeof setTimeout>>();
  const filterSeq = useRef(0);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const hostOfRef = useRef(hostOf);
  hostOfRef.current = hostOf;

  const edit = refEditOf(state);
  const editing = edit !== null;

  // SESSION LIFECYCLE - the query-cells pattern (a handleRef guard, not effect cleanup: the
  // session object is recreated on every App render, and a cleanup-based claim would churn).
  // Claim on the ref edit's entry, release on its commit/abandon.
  useEffect(() => {
    if (editing && session !== null && handleRef.current === null) {
      handleRef.current = session.begin({
        onPick: (picked) => {
          const st = stateRef.current;
          const e = refEditOf(st);
          if (st === null || e === null) return;
          const c = st.cursor;
          if (c.at !== "hole" && c.at !== "pick") return; // refEditOf already guaranteed this
          const host = hostOfRef.current();
          const holder = serverPathOf(host.base, st.doc, e.holderPath);
          const raw = spellPointer(picked, holder, e.ladder, host.doc);
          // the picked path lands IN THE CELLS (caret on the last) - inserted, not committed
          applyRef.current({ ...st, cursor: { ...c, ...refFromRaw(raw), caret: "end" }, refused: false });
        },
        onEvicted: () => { handleRef.current = null; },
      });
    }
    if (!editing && handleRef.current !== null) {
      handleRef.current.end();
      handleRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, session]);

  // THE FILTER FEED - the live joined query prunes the TOC (debounced; seq-guarded so a slow
  // answer never overwrites a fresher one; a failure keeps the last good tree - never a gate).
  // Evaluated AT THE HOLDER, the same addressing law treeHints uses.
  useEffect(() => {
    if (!editing) return;
    clearTimeout(filterTimer.current);
    const seq = ++filterSeq.current;
    const st = stateRef.current;
    const e = refEditOf(st);
    if (st === null || e === null || handleRef.current === null) return;
    if (e.query.trim() === "" || /^:{1,3}$/.test(e.query.trim())) {
      handleRef.current.set(null); // nothing typed yet - the normal TOC stands
      return;
    }
    filterTimer.current = setTimeout(() => {
      const holder = serverPathOf(hostOfRef.current().base, st.doc, e.holderPath);
      queryFilter(e.query, holder).then(
        (r) => {
          if (seq === filterSeq.current) handleRef.current?.set({ root: r.root, truncated: r.truncated });
        },
        () => { /* wire down / mid-edit query - the last good filter stands */ },
      );
    }, FILTER_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, edit?.query, edit?.ladder]);

  // unmount: pending timers die with the mount; an owned session releases
  useEffect(() => () => {
    clearTimeout(filterTimer.current);
    handleRef.current?.end();
    handleRef.current = null;
  }, []);
}
