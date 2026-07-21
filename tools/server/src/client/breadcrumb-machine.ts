// The breadcrumb's EXPLICIT edit-state machine. The human-readable state DIAGRAM lives
// at the repo root in QUERY_EDITOR.yamlover (the YAMLOVER_EDITOR.yamlover format: states
// as omni entries, transitions keyed by key press) — this file is the executable reducer
// it compiles to, and breadcrumb-machine.test.ts runs the table. Keep the two in sync.
//
// The breadcrumb is a permanent row of SMART CELLS (yamlover-editor style): one cell per
// query portion, always click-to-edit, `:` a real editable boundary (typing `:` splits the
// cell at the caret, Backspace at a cell's start / Delete at its end merges neighbours).
// The machine is PURE: `reduce(state, event, currentPath) -> [state, effects]`. The React
// component performs the effects (fetches, focus, navigation) and feeds results back as
// events (CANDIDATES_ARRIVED / MATCHES_ARRIVED), each carrying the seq it answers — the
// reducer drops stale arrivals.
//
// HOST MODES (MachineCtx.mode — the same machine drives every query-cell surface)
//   browse    The breadcrumb: select = navigate; a committed query keeps a `filtered`
//             browsing state; the ladder is fixed at the document scope (1).
//   pick      A selection host (the yamlover editor's reference cell, the tag picker):
//             select = commit ONE node path (or null = no match — the host decides);
//             never enters `filtered`; the scope ladder (0 bare / 1 `:` / 2 `::` /
//             3 `:::`) is the user's — SCOPE climbs/descends it, and a TOC click puts
//             the picked node's spelling INTO the cells (editing continues).
//
// STATES
//   idle      No cell focused. Cells render `currentPath`'s portions (static-looking,
//             click-to-edit). TOC unfiltered, normal selection.
//   editing   A cell is focused (`active`, live text `activeText`). TOC selection is
//             SUPPRESSED and the TOC is FILTERED live by the joined query (matches + all
//             ancestors, expanded). The dropdown offers the context's real children +
//             operators; `dropdown.hi` starts -1 — free typing always wins (pointer-hints
//             doctrine: hints are never validators).
//   filtered  A committed query: cells kept, TOC stays filtered, a TOC element selected
//             (the post-Enter / post-click browsing state). Any cell click re-enters
//             editing; Escape or navigating to a non-match returns to idle.
//
// EVENTS (component → machine)
//   FOCUS_CELL{index?, caret?}   click/arrow into cell `index` (undefined = the append
//                                cell). `caret` set only for programmatic moves — the
//                                machine then emits a focusCell effect.
//   SET_ACTIVE_TEXT{text}        the focused cell's live text changed
//   SPLIT_CELL{before, after}    `:` typed at the caret — the cell splits
//   MERGE_PREV / MERGE_NEXT      Backspace at cell start / Delete at cell end
//   DROPDOWN_MOVE{dir} / DROPDOWN_SET{index} / PICK{index}
//   ENTER / ESCAPE / BLUR
//   TOC_CLICK{path}              a TOC row clicked while the machine is not idle
//   NAVIGATED{path}              navigation happened outside the breadcrumb (popstate, links)
//   EVICTED                      another host claimed the TOC filter session
//   CANDIDATES_ARRIVED{seq, items} / MATCHES_ARRIVED{seq, ok, paths, truncated}
//
// TRANSITIONS (I=idle, E=editing, F=filtered) — the authoritative table:
//   I/F + FOCUS_CELL          → E   portions from currentPath (I) or kept query (F);
//                                   effects: [focusCell?] fetchCandidates fetchMatches
//   E + SET_ACTIVE_TEXT       → E   matchesFresh=false; fetchCandidates fetchMatches
//   E + SPLIT_CELL            → E   cell splits, caret to start of the new cell; refetch
//   E + MERGE_PREV/NEXT       → E   cells merge, caret at the junction; refetch
//   E + OPEN_INDEX            → E   `[` in an EMPTY cell: the empty cell folds into the
//                                   previous portion which gains a projected `[]`, caret
//                                   inside — `pets` + `:` + `[` spells `pets[|]`, never
//                                   the non-canonical `pets: [1]`; refetch
//   E + CANDIDATES_ARRIVED    → E   seq-guarded; dropdown={open, items, hi:-1}
//   E + MATCHES_ARRIVED ok    → E   seq-guarded; matches kept fresh — UNLESS pendingEnter
//                                   and non-empty: → F + select(first) + focusToc
//   E + MATCHES_ARRIVED !ok   → E   queryError=true, keep last good matches (no flicker)
//   E + DROPDOWN_MOVE/SET     → E   hi cycles (from -1); SET on hover
//   E + PICK                  → E   cell text = insert, TAIL KEPT (it just re-filters);
//                                   picking in the last cell appends a fresh cell; refetch
//   E + ENTER, hi>=0          ≡ PICK(hi)
//   E + Tab (component-level) ≡ PICK(hi < 0 ? 0 : hi) while the dropdown has items — the
//                                   ACCEPT key; Enter keeps its free-typed meaning
//   E + ENTER, matches fresh  → F   select(paths[0]) focusToc — or no-op when 0 matches
//   E + ENTER, matches stale  → E   pendingEnter=true; fetchMatches(immediate)
//   E + ESCAPE, dropdown open → E   dropdown closes
//   E + ESCAPE/BLUR           → I   cells re-derive from currentPath; TOC unfiltered
//   E/F + TOC_CLICK, match    → F   query kept; select(path) focusToc
//   E/F + TOC_CLICK, no match → I   breadcrumb regresses to the plain path; select(path)
//   E/F + EVICTED             → I   the TOC filter session went to another host
//   F + ESCAPE                → I
//   F + NAVIGATED, no match   → I   (a chevron-loaded real child was opened)
//
// PICK-MODE DIVERGENCES (ctx.mode === "pick"; everything else as above, F unreachable):
//   E + SCOPE{dir}            → E   ladder climbs/descends (clamped 0–3); refetch
//   E + TOC_CLICK             → E   cells := ctx.spell(path) in the current scope, caret
//                                   at the last cell's end; refetch — a click never commits
//   E + ENTER, matches fresh  → I   select(paths[0] ?? null) — the query REDUCES to a path;
//                                   null = no match (host: verbatim pointer / create-on-miss)
//   E + MATCHES_ARRIVED ok, pendingEnter → I  same reduction on arrival
//
// INVARIANTS
//   fullQuery = joinPortions(portions with portions[active] := activeText) — the single
//   source of truth for both the filter query and the dropdown context. Effects carry the
//   seq they were emitted with; an arrival with any other seq is dropped.

import { joinPortionsScoped, portionsFromPath, type Candidate, type Ladder } from "./query-complete";

/** The HOST CONTEXT the pure reducer runs against — what kind of editor this machine
 *  drives and how its cells relate to the outside world. Passed to every `reduce` call
 *  (hosts keep it fresh via refs), never stored in the state.
 *    browse — the breadcrumb: committing keeps a `filtered` browsing state, select
 *             means navigate, the ladder is fixed at the document scope.
 *    pick   — a selection host (reference cell / tag picker): committing reduces the
 *             query to ONE node path and returns to idle; the ladder is the user's. */
export interface MachineCtx {
  mode: "browse" | "pick";
  /** The scope ladder editing (re)opens with (browse: 1 — the document root cell). */
  ladder: Ladder;
  /** The cells shown when idle and the base for entering editing. */
  idlePortions: () => string[];
  /** pick mode: spell a picked node path as cells in the given scope (the machine passes
   *  its CURRENT editing ladder). */
  spell?: (path: string, ladder: Ladder) => { ladder: Ladder; portions: string[] };
}

/** The breadcrumb's ctx — the browse host over the current path. */
export function browseCtx(currentPath: string): MachineCtx {
  return { mode: "browse", ladder: 1, idlePortions: () => portionsFromPath(currentPath) };
}

export interface Dropdown {
  open: boolean;
  items: Candidate[];
  hi: number; // -1 = nothing armed: Enter commits the typed text, not a hint
}

export interface Matches {
  paths: string[]; // client paths in evaluator walk order — paths[0] is "the first match"
  truncated: boolean;
}

export type BcState =
  | { mode: "idle" }
  | {
      mode: "editing";
      ladder: Ladder; // the scope the cells spell under (browse: always 1)
      portions: string[]; // every cell's committed text (the active one may lag activeText)
      active: number;
      activeText: string;
      dropdown: Dropdown;
      matches: Matches | null; // last GOOD result (display); null until first arrival
      matchesFresh: boolean; // matches answer the CURRENT fullQuery (seq-verified)
      queryError: boolean; // last filter fetch rejected (malformed mid-edit) — tint only
      pendingEnter: boolean; // Enter arrived while matches were stale/in flight
      seq: { cand: number; match: number };
    }
  | { mode: "filtered"; portions: string[]; matches: Matches };

export type CaretPos = "start" | "end" | number; // number = character offset

export type BcEvent =
  | { type: "FOCUS_CELL"; index?: number; caret?: CaretPos }
  | { type: "SET_ACTIVE_TEXT"; text: string }
  | { type: "SPLIT_CELL"; before: string; after: string }
  | { type: "MERGE_PREV" }
  | { type: "MERGE_NEXT" }
  | { type: "OPEN_INDEX" } // `[` typed in an EMPTY cell — the index belongs to the previous portion
  | { type: "CANDIDATES_ARRIVED"; seq: number; items: Candidate[] }
  | { type: "MATCHES_ARRIVED"; seq: number; ok: boolean; paths: string[]; truncated: boolean }
  | { type: "DROPDOWN_MOVE"; dir: 1 | -1 }
  | { type: "DROPDOWN_SET"; index: number }
  | { type: "PICK"; index: number }
  | { type: "ENTER" }
  | { type: "ESCAPE" }
  | { type: "BLUR" }
  | { type: "EVICTED" } // another host claimed the TOC filter session — abandon the edit
  | { type: "SCOPE"; dir: 1 | -1 } // pick mode: escalate/de-escalate the scope ladder
  | { type: "TOC_CLICK"; path: string }
  | { type: "NAVIGATED"; path: string };

export type Effect =
  | { type: "focusCell"; index: number; caret: CaretPos }
  | { type: "focusToc" }
  // browse: navigate to `path` (never null). pick: commit the chosen node — null means
  // "no match for the typed query"; the host decides (verbatim pointer / create-on-miss).
  // Pick selects also carry the editing ladder and the full typed query at commit time.
  | { type: "select"; path: string | null; ladder?: Ladder; query?: string }
  | { type: "fetchCandidates"; contextQuery: string; prefix: string; seq: number }
  | { type: "fetchMatches"; query: string; seq: number; immediate?: boolean };

type Editing = Extract<BcState, { mode: "editing" }>;

const CLOSED: Dropdown = { open: false, items: [], hi: -1 };

/** The cells with the active one's LIVE text in place. */
function cellsOf(s: Editing): string[] {
  const out = [...s.portions];
  out[s.active] = s.activeText;
  return out;
}

/** The full query the cells currently spell (under the editing scope ladder). */
export function fullQueryOf(s: Editing): string {
  return joinPortionsScoped(cellsOf(s), s.ladder);
}

/** The two refetch effects every query-changing edit emits (seq pre-bumped in `next`). */
function refetch(next: Editing): Effect[] {
  return [
    { type: "fetchCandidates", contextQuery: joinPortionsScoped(next.portions.slice(0, next.active), next.ladder), prefix: next.activeText, seq: next.seq.cand },
    { type: "fetchMatches", query: fullQueryOf(next), seq: next.seq.match },
  ];
}

function enterEditing(ladder: Ladder, portions: string[], active: number, activeText: string, seq: { cand: number; match: number }): Editing {
  return {
    mode: "editing",
    ladder,
    portions,
    active,
    activeText,
    dropdown: CLOSED,
    matches: null,
    matchesFresh: false,
    queryError: false,
    pendingEnter: false,
    seq: { cand: seq.cand + 1, match: seq.match + 1 },
  };
}

/** Commit the pending click/Enter selection: portions with activeText folded in. */
function committed(s: Editing): string[] {
  return cellsOf(s);
}

export function reduce(state: BcState, e: BcEvent, ctx: MachineCtx): [BcState, Effect[]] {
  // ---- entering the editor (from idle or filtered) -------------------------
  if ((state.mode === "idle" || state.mode === "filtered") && e.type === "FOCUS_CELL") {
    const base = state.mode === "idle" ? ctx.idlePortions() : [...state.portions];
    const seq = { cand: 0, match: 0 };
    let portions: string[];
    let active: number;
    if (e.index === undefined || e.index >= base.length) {
      // the append cell — an already-empty trailing cell is REUSED, never doubled
      portions = base[base.length - 1] === "" ? [...base] : [...base, ""];
      active = portions.length - 1;
    } else {
      portions = base;
      active = Math.max(0, e.index);
    }
    const next = enterEditing(ctx.ladder, portions, active, portions[active], seq);
    const fx: Effect[] = e.caret !== undefined ? [{ type: "focusCell", index: active, caret: e.caret }] : [];
    return [next, [...fx, ...refetch(next)]];
  }

  if (state.mode === "idle") return [state, e.type === "TOC_CLICK" ? [{ type: "select", path: e.path }] : []];

  // ---- filtered (committed query, browsing) --------------------------------
  if (state.mode === "filtered") {
    switch (e.type) {
      case "TOC_CLICK": {
        if (state.matches.paths.includes(e.path)) return [state, [{ type: "select", path: e.path }, { type: "focusToc" }]];
        return [{ mode: "idle" }, [{ type: "select", path: e.path }]];
      }
      case "ESCAPE":
      case "EVICTED":
        return [{ mode: "idle" }, []];
      case "NAVIGATED":
        return state.matches.paths.includes(e.path) ? [state, []] : [{ mode: "idle" }, []];
      default:
        return [state, []];
    }
  }

  // ---- editing -------------------------------------------------------------
  const s = state as Editing;
  switch (e.type) {
    case "FOCUS_CELL": {
      // moving between cells inside the editor: commit the leaving cell's text
      const portions = cellsOf(s);
      let active: number;
      if (e.index === undefined || e.index >= portions.length) {
        if (portions[portions.length - 1] !== "") portions.push("");
        active = portions.length - 1;
      } else {
        active = Math.max(0, e.index);
      }
      if (active === s.active && portions.length === s.portions.length) return [s, []];
      const next: Editing = { ...s, portions, active, activeText: portions[active], dropdown: CLOSED, seq: { cand: s.seq.cand + 1, match: s.seq.match } };
      const fx: Effect[] = e.caret !== undefined ? [{ type: "focusCell", index: active, caret: e.caret }] : [];
      return [next, [...fx, { type: "fetchCandidates", contextQuery: joinPortionsScoped(next.portions.slice(0, active), next.ladder), prefix: next.activeText, seq: next.seq.cand }]];
    }
    case "SET_ACTIVE_TEXT": {
      const next: Editing = { ...s, activeText: e.text, queryError: false, matchesFresh: false, seq: { cand: s.seq.cand + 1, match: s.seq.match + 1 } };
      return [next, refetch(next)];
    }
    case "SPLIT_CELL": {
      const portions = cellsOf(s);
      portions[s.active] = e.before;
      portions.splice(s.active + 1, 0, e.after);
      const active = s.active + 1;
      const next: Editing = { ...s, portions, active, activeText: e.after, dropdown: CLOSED, matchesFresh: false, seq: { cand: s.seq.cand + 1, match: s.seq.match + 1 } };
      return [next, [{ type: "focusCell", index: active, caret: "start" }, ...refetch(next)]];
    }
    case "MERGE_PREV": {
      if (s.active === 0) return [s, []];
      const portions = cellsOf(s);
      const junction = portions[s.active - 1].length;
      const merged = portions[s.active - 1] + portions[s.active];
      portions.splice(s.active - 1, 2, merged);
      const active = s.active - 1;
      const next: Editing = { ...s, portions, active, activeText: merged, dropdown: CLOSED, matchesFresh: false, seq: { cand: s.seq.cand + 1, match: s.seq.match + 1 } };
      return [next, [{ type: "focusCell", index: active, caret: junction }, ...refetch(next)]];
    }
    case "OPEN_INDEX": {
      if (s.active === 0 || s.activeText !== "") return [s, []];
      const portions = cellsOf(s);
      const merged = portions[s.active - 1] + "[]";
      const caret = merged.length - 1; // inside the projected brackets
      portions.splice(s.active - 1, 2, merged);
      const active = s.active - 1;
      const next: Editing = { ...s, portions, active, activeText: merged, dropdown: CLOSED, matchesFresh: false, seq: { cand: s.seq.cand + 1, match: s.seq.match + 1 } };
      return [next, [{ type: "focusCell", index: active, caret }, ...refetch(next)]];
    }
    case "SCOPE": {
      // pick mode only: `:` in the empty first cell climbs the ladder, Backspace at the
      // first cell's start steps back down. Browse hosts have a fixed document scope.
      if (ctx.mode !== "pick") return [s, []];
      const ladder = Math.min(3, Math.max(0, s.ladder + e.dir)) as Ladder;
      if (ladder === s.ladder) return [s, []];
      const next: Editing = { ...s, ladder, dropdown: CLOSED, matchesFresh: false, seq: { cand: s.seq.cand + 1, match: s.seq.match + 1 } };
      return [next, refetch(next)];
    }
    case "MERGE_NEXT": {
      if (s.active >= s.portions.length - 1) return [s, []];
      const portions = cellsOf(s);
      const junction = portions[s.active].length;
      const merged = portions[s.active] + portions[s.active + 1];
      portions.splice(s.active, 2, merged);
      const next: Editing = { ...s, portions, activeText: merged, dropdown: CLOSED, matchesFresh: false, seq: { cand: s.seq.cand + 1, match: s.seq.match + 1 } };
      return [next, [{ type: "focusCell", index: s.active, caret: junction }, ...refetch(next)]];
    }
    case "CANDIDATES_ARRIVED": {
      if (e.seq !== s.seq.cand) return [s, []];
      return [{ ...s, dropdown: { open: e.items.length > 0, items: e.items, hi: -1 } }, []];
    }
    case "MATCHES_ARRIVED": {
      if (e.seq !== s.seq.match) return [s, []];
      if (!e.ok) {
        if (s.pendingEnter && ctx.mode === "pick") {
          // the evaluator rejected the text (or the fetch failed) — the SERVER is only a
          // hint source. Hand the typed query to the host: a parseable POINTER (e.g. a
          // relindex link the query grammar refuses) still commits verbatim.
          return [{ mode: "idle" }, [{ type: "select", path: null, ladder: s.ladder, query: fullQueryOf(s) }]];
        }
        return [{ ...s, queryError: true, pendingEnter: false }, []];
      }
      const matches: Matches = { paths: e.paths, truncated: e.truncated };
      if (s.pendingEnter && ctx.mode === "pick") {
        // a pending pick commits on arrival: the first match, or null (host decides)
        return [{ mode: "idle" }, [{ type: "select", path: e.paths[0] ?? null, ladder: s.ladder, query: fullQueryOf(s) }]];
      }
      if (s.pendingEnter && e.paths.length > 0) {
        return [{ mode: "filtered", portions: committed(s), matches }, [{ type: "select", path: e.paths[0] }, { type: "focusToc" }]];
      }
      return [{ ...s, matches, matchesFresh: true, queryError: false, pendingEnter: false }, []];
    }
    case "DROPDOWN_MOVE": {
      const { items } = s.dropdown;
      if (!s.dropdown.open || !items.length) return [s, []];
      const hi = s.dropdown.hi < 0 ? (e.dir === 1 ? 0 : items.length - 1) : (s.dropdown.hi + e.dir + items.length) % items.length;
      return [{ ...s, dropdown: { ...s.dropdown, hi } }, []];
    }
    case "DROPDOWN_SET":
      return [{ ...s, dropdown: { ...s.dropdown, hi: e.index } }, []];
    case "PICK": {
      const item = s.dropdown.items[e.index];
      if (!item) return [s, []];
      const portions = [...s.portions];
      portions[s.active] = item.insert;
      let active = s.active;
      let activeText = item.insert;
      if (s.active === portions.length - 1) {
        portions.push(""); // picking in the last cell: continue the path in a fresh cell
        active++;
        activeText = "";
      }
      const next: Editing = { ...s, portions, active, activeText, dropdown: CLOSED, matchesFresh: false, seq: { cand: s.seq.cand + 1, match: s.seq.match + 1 } };
      return [next, [{ type: "focusCell", index: active, caret: "end" }, ...refetch(next)]];
    }
    case "ENTER": {
      if (s.dropdown.open && s.dropdown.hi >= 0) return reduce(s, { type: "PICK", index: s.dropdown.hi }, ctx);
      if (s.matchesFresh && s.matches) {
        if (ctx.mode === "pick") {
          // pick: the query REDUCES to one node — the first match, or null (host decides:
          // a free-typed parseable pointer commits verbatim; the tag host creates-on-miss)
          return [{ mode: "idle" }, [{ type: "select", path: s.matches.paths[0] ?? null, ladder: s.ladder, query: fullQueryOf(s) }]];
        }
        if (s.matches.paths.length === 0) return [s, []]; // nothing to select; the tint says why
        return [{ mode: "filtered", portions: committed(s), matches: s.matches }, [{ type: "select", path: s.matches.paths[0] }, { type: "focusToc" }]];
      }
      const next: Editing = { ...s, pendingEnter: true, seq: { cand: s.seq.cand, match: s.seq.match + 1 } };
      return [next, [{ type: "fetchMatches", query: fullQueryOf(next), seq: next.seq.match, immediate: true }]];
    }
    case "ESCAPE": {
      if (s.dropdown.open) return [{ ...s, dropdown: CLOSED }, []];
      return [{ mode: "idle" }, []];
    }
    case "BLUR":
    case "EVICTED":
      return [{ mode: "idle" }, []];
    case "TOC_CLICK": {
      if (ctx.mode === "pick") {
        // pick: the clicked node's path lands IN THE CELLS (spelled in the host's scope)
        // and editing continues — Enter commits, a click never does.
        const sp = ctx.spell?.(e.path, s.ladder);
        if (!sp) return [s, []];
        const portions = sp.portions.length ? [...sp.portions] : [""];
        const active = portions.length - 1;
        const next: Editing = {
          ...s,
          ladder: sp.ladder,
          portions,
          active,
          activeText: portions[active],
          dropdown: CLOSED,
          matchesFresh: false,
          seq: { cand: s.seq.cand + 1, match: s.seq.match + 1 },
        };
        return [next, [{ type: "focusCell", index: active, caret: "end" }, ...refetch(next)]];
      }
      if (s.matches && s.matches.paths.includes(e.path)) {
        return [{ mode: "filtered", portions: committed(s), matches: s.matches }, [{ type: "select", path: e.path }, { type: "focusToc" }]];
      }
      return [{ mode: "idle" }, [{ type: "select", path: e.path }]];
    }
    case "NAVIGATED":
      return [{ mode: "idle" }, []];
    default:
      return [s, []];
  }
}
