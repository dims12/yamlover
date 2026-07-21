// The breadcrumb state machine's transition table, executed. Pure reducer — no React, no
// mocks needed beyond plain data. Each block mirrors a section of the table in the file
// header of breadcrumb-machine.ts.
import { describe, it, expect } from "vitest";
import { BcEvent, BcState, Effect, MachineCtx, browseCtx, fullQueryOf, reduce as reduceCtx } from "../../src/client/breadcrumb-machine";
import type { Candidate, Ladder } from "../../src/client/query-complete";

// The table below predates the MachineCtx generalization — every case here exercises the
// breadcrumb's BROWSE mode, so the old `currentPath` third arg shims to browseCtx.
const reduce = (s: BcState, e: BcEvent, path: string): [BcState, Effect[]] => reduceCtx(s, e, browseCtx(path));

const IDLE: BcState = { mode: "idle" };

/** Run a sequence of events from idle, returning the final state and ALL effects. */
function run(events: BcEvent[], currentPath = ":team:alice"): [BcState, Effect[]] {
  let s: BcState = IDLE;
  const fx: Effect[] = [];
  for (const e of events) {
    const [next, effects] = reduce(s, e, currentPath);
    s = next;
    fx.push(...effects);
  }
  return [s, fx];
}

const key = (label: string, insert = label): Candidate => ({
  kind: "key",
  insert,
  node: { path: ":" + label, label, type: "object", format: null, concrete: null, hasChildren: false, children: [] },
});

/** The current match seq of an editing state (to answer its fetchMatches). */
const mseq = (s: BcState) => (s.mode === "editing" ? s.seq.match : -1);
const cseq = (s: BcState) => (s.mode === "editing" ? s.seq.cand : -1);
const arrive = (s: BcState, paths: string[], ok = true): BcEvent => ({ type: "MATCHES_ARRIVED", seq: mseq(s), ok, paths, truncated: false });

describe("entering the editor", () => {
  it("FOCUS_CELL from idle derives cells from the current path; append cell when no index", () => {
    const [s, fx] = run([{ type: "FOCUS_CELL" }]);
    expect(s.mode).toBe("editing");
    if (s.mode !== "editing") return;
    expect(s.portions).toEqual(["team", "alice", ""]); // + the append cell
    expect(s.active).toBe(2);
    expect(s.dropdown.hi).toBe(-1); // free typing wins until an explicit arm
    // both fetches fired: candidates for the append context, matches for the full query
    expect(fx.map((f) => f.type)).toEqual(["fetchCandidates", "fetchMatches"]);
    expect((fx[0] as any).contextQuery).toBe(": team: alice"); // the cells left of the active one, scope-spelled
    expect((fx[1] as any).query).toBe(": team: alice");
  });

  it("FOCUS_CELL with an index edits that cell; numeric segments fold (`pets[0]`)", () => {
    const [s] = run([{ type: "FOCUS_CELL", index: 0 }], ":pets[0]:name");
    if (s.mode !== "editing") throw new Error("not editing");
    expect(s.portions).toEqual(["pets[0]", "name"]);
    expect(s.activeText).toBe("pets[0]");
  });

  it("programmatic FOCUS_CELL (caret given) also emits focusCell", () => {
    const [, fx] = run([{ type: "FOCUS_CELL", index: 0, caret: "start" }]);
    expect(fx[0]).toEqual({ type: "focusCell", index: 0, caret: "start" });
  });
});

describe("text editing: split / merge / typing", () => {
  it("SET_ACTIVE_TEXT refetches candidates and matches with bumped seqs", () => {
    let [s] = run([{ type: "FOCUS_CELL" }]);
    const [next, fx] = reduce(s, { type: "SET_ACTIVE_TEXT", text: "pe" }, ":");
    if (next.mode !== "editing") throw new Error();
    expect(next.activeText).toBe("pe");
    expect(next.matchesFresh).toBe(false);
    expect(fx.find((f) => f.type === "fetchMatches")).toMatchObject({ query: ": team: alice: pe", seq: next.seq.match });
    expect(fx.find((f) => f.type === "fetchCandidates")).toMatchObject({ prefix: "pe", seq: next.seq.cand });
  });

  it("SPLIT_CELL (typed ':') splits the cell, caret to the new cell's start", () => {
    const [s0] = run([{ type: "FOCUS_CELL", index: 0 }], ":teamalice");
    const [s, fx] = reduce(s0, { type: "SPLIT_CELL", before: "team", after: "alice" }, ":teamalice");
    if (s.mode !== "editing") throw new Error();
    expect(s.portions).toEqual(["team", "alice"]);
    expect(s.active).toBe(1);
    expect(s.activeText).toBe("alice");
    expect(fx[0]).toEqual({ type: "focusCell", index: 1, caret: "start" });
    expect(fullQueryOf(s)).toBe(": team: alice");
  });

  it("MERGE_PREV (Backspace at cell start) deletes the ':' — cells join, caret at the junction", () => {
    const [s0] = run([{ type: "FOCUS_CELL", index: 1 }]);
    const [s, fx] = reduce(s0, { type: "MERGE_PREV" }, ":team:alice");
    if (s.mode !== "editing") throw new Error();
    expect(s.portions).toEqual(["teamalice"]);
    expect(s.active).toBe(0);
    expect(fx[0]).toEqual({ type: "focusCell", index: 0, caret: 4 }); // after "team"
  });

  it("MERGE_NEXT (Delete at cell end) joins with the next cell", () => {
    const [s0] = run([{ type: "FOCUS_CELL", index: 0 }]);
    const [s, fx] = reduce(s0, { type: "MERGE_NEXT" }, ":team:alice");
    if (s.mode !== "editing") throw new Error();
    expect(s.portions).toEqual(["teamalice"]);
    expect(fx[0]).toEqual({ type: "focusCell", index: 0, caret: 4 });
  });

  it("OPEN_INDEX ('[' in an empty cell) folds into the PREVIOUS portion with the pair projected", () => {
    // `pets` `:` `[` must spell `pets[|]`, never the non-canonical `pets: [1]`
    const [s0] = run([{ type: "FOCUS_CELL" }], ":pets"); // the append cell after "pets"
    const [s, fx] = reduce(s0, { type: "OPEN_INDEX" }, ":pets");
    if (s.mode !== "editing") throw new Error();
    expect(s.portions).toEqual(["pets[]"]);
    expect(s.active).toBe(0);
    expect(fx[0]).toEqual({ type: "focusCell", index: 0, caret: 5 }); // inside the brackets
    expect(fullQueryOf(s)).toBe(": pets[]");
  });

  it("OPEN_INDEX is a no-op in the first cell or a non-empty cell", () => {
    const [first] = run([{ type: "FOCUS_CELL", index: 0 }], ":pets");
    expect(reduce(first, { type: "OPEN_INDEX" }, ":pets")[0]).toBe(first);
    let [typed] = run([{ type: "FOCUS_CELL" }], ":pets");
    [typed] = reduce(typed, { type: "SET_ACTIVE_TEXT", text: "x" }, ":pets");
    expect(reduce(typed, { type: "OPEN_INDEX" }, ":pets")[0]).toBe(typed);
  });

  it("MERGE_PREV at the first cell / MERGE_NEXT at the last are no-ops", () => {
    const [s0] = run([{ type: "FOCUS_CELL", index: 0 }]);
    expect(reduce(s0, { type: "MERGE_PREV" }, ":team:alice")[0]).toBe(s0);
    const [s1] = run([{ type: "FOCUS_CELL" }]); // append cell = last
    expect(reduce(s1, { type: "MERGE_NEXT" }, ":team:alice")[0]).toBe(s1);
  });
});

describe("dropdown", () => {
  const openDropdown = (): BcState => {
    let [s] = run([{ type: "FOCUS_CELL" }]);
    [s] = reduce(s, { type: "CANDIDATES_ARRIVED", seq: cseq(s), items: [key("alice"), key("bob")] }, ":");
    return s;
  };

  it("CANDIDATES_ARRIVED opens with hi=-1; stale seq dropped", () => {
    const s = openDropdown();
    if (s.mode !== "editing") throw new Error();
    expect(s.dropdown).toMatchObject({ open: true, hi: -1 });
    const [same] = reduce(s, { type: "CANDIDATES_ARRIVED", seq: 999, items: [] }, ":");
    expect(same).toBe(s);
  });

  it("DROPDOWN_MOVE arms from -1 (down→first, up→last) and wraps", () => {
    let s = openDropdown();
    [s] = reduce(s, { type: "DROPDOWN_MOVE", dir: 1 }, ":");
    if (s.mode !== "editing") throw new Error();
    expect(s.dropdown.hi).toBe(0);
    [s] = reduce(s, { type: "DROPDOWN_MOVE", dir: -1 }, ":");
    if (s.mode !== "editing") throw new Error();
    expect(s.dropdown.hi).toBe(1); // wrapped
  });

  it("PICK replaces only the active cell, KEEPS the tail, appends a cell at the end", () => {
    // pick in a MIDDLE cell: tail kept
    let [s] = run([{ type: "FOCUS_CELL", index: 0 }]);
    [s] = reduce(s, { type: "CANDIDATES_ARRIVED", seq: cseq(s), items: [key("pets")] }, ":team:alice");
    const [mid] = reduce(s, { type: "PICK", index: 0 }, ":team:alice");
    if (mid.mode !== "editing") throw new Error();
    expect(mid.portions).toEqual(["pets", "alice"]); // tail "alice" KEPT
    // pick in the LAST cell: a fresh append cell follows
    let [t] = run([{ type: "FOCUS_CELL" }]);
    [t] = reduce(t, { type: "CANDIDATES_ARRIVED", seq: cseq(t), items: [key("age")] }, ":team:alice");
    const [last] = reduce(t, { type: "PICK", index: 0 }, ":team:alice");
    if (last.mode !== "editing") throw new Error();
    expect(last.portions).toEqual(["team", "alice", "age", ""]);
    expect(last.active).toBe(3);
  });

  it("ENTER with an armed hint ≡ PICK(hi)", () => {
    let s = openDropdown();
    [s] = reduce(s, { type: "DROPDOWN_MOVE", dir: 1 }, ":");
    const [next] = reduce(s, { type: "ENTER" }, ":team:alice");
    if (next.mode !== "editing") throw new Error();
    expect(next.portions).toContain("alice");
  });

  it("ESCAPE closes the dropdown first, exits to idle second", () => {
    const s = openDropdown();
    const [closed] = reduce(s, { type: "ESCAPE" }, ":");
    if (closed.mode !== "editing") throw new Error();
    expect(closed.dropdown.open).toBe(false);
    const [out] = reduce(closed, { type: "ESCAPE" }, ":");
    expect(out.mode).toBe("idle");
  });
});

describe("commit: ENTER and TOC_CLICK", () => {
  it("ENTER with fresh matches selects the FIRST match and enters filtered", () => {
    let [s] = run([{ type: "FOCUS_CELL" }]);
    [s] = reduce(s, { type: "SET_ACTIVE_TEXT", text: "a" }, ":");
    [s] = reduce(s, arrive(s, [":team:alice:age", ":team:alice"]), ":");
    const [f, fx] = reduce(s, { type: "ENTER" }, ":");
    expect(f.mode).toBe("filtered");
    expect(fx).toEqual([{ type: "select", path: ":team:alice:age" }, { type: "focusToc" }]);
  });

  it("ENTER with zero fresh matches is a no-op (stay editing)", () => {
    let [s] = run([{ type: "FOCUS_CELL" }]);
    [s] = reduce(s, arrive(s, []), ":");
    const [same] = reduce(s, { type: "ENTER" }, ":");
    expect(same.mode).toBe("editing");
  });

  it("ENTER with stale matches sets pendingEnter + immediate fetch; arrival commits", () => {
    let [s] = run([{ type: "FOCUS_CELL" }]);
    [s] = reduce(s, { type: "SET_ACTIVE_TEXT", text: "x" }, ":"); // matches now stale (none arrived)
    const [pending, fx] = reduce(s, { type: "ENTER" }, ":");
    if (pending.mode !== "editing") throw new Error();
    expect(pending.pendingEnter).toBe(true);
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ type: "fetchMatches", immediate: true });
    const [f, fx2] = reduce(pending, arrive(pending, [":x"]), ":");
    expect(f.mode).toBe("filtered");
    expect(fx2[0]).toEqual({ type: "select", path: ":x" });
  });

  it("a failed (malformed) filter fetch keeps last good matches and only tints", () => {
    let [s] = run([{ type: "FOCUS_CELL" }]);
    [s] = reduce(s, arrive(s, [":a"]), ":");
    [s] = reduce(s, { type: "SET_ACTIVE_TEXT", text: "!!<" }, ":");
    const [err] = reduce(s, arrive(s, [], false), ":");
    if (err.mode !== "editing") throw new Error();
    expect(err.queryError).toBe(true);
    expect(err.matches?.paths).toEqual([":a"]); // last good kept — no flicker
  });

  it("TOC_CLICK on a MATCH keeps the query (filtered); on a non-match regresses to idle", () => {
    let [s] = run([{ type: "FOCUS_CELL" }]);
    [s] = reduce(s, arrive(s, [":team:alice"]), ":");
    const [f, fx] = reduce(s, { type: "TOC_CLICK", path: ":team:alice" }, ":");
    expect(f.mode).toBe("filtered");
    expect(fx).toEqual([{ type: "select", path: ":team:alice" }, { type: "focusToc" }]);
    // non-match (an expanded ancestor row): regress to the plain path
    const [i, fx2] = reduce(s, { type: "TOC_CLICK", path: ":team" }, ":");
    expect(i.mode).toBe("idle");
    expect(fx2).toEqual([{ type: "select", path: ":team" }]);
  });

  it("BLUR exits to idle; stale MATCHES_ARRIVED is dropped", () => {
    let [s] = run([{ type: "FOCUS_CELL" }]);
    const stale = mseq(s);
    [s] = reduce(s, { type: "SET_ACTIVE_TEXT", text: "x" }, ":"); // bumps seq
    const [same] = reduce(s, { type: "MATCHES_ARRIVED", seq: stale, ok: true, paths: [":old"], truncated: false }, ":");
    if (same.mode !== "editing") throw new Error();
    expect(same.matches).toBeNull();
    expect(reduce(s, { type: "BLUR" }, ":")[0].mode).toBe("idle");
  });
});

describe("pick mode (the reference cell / tag picker host)", () => {
  const pickCtx = (spell?: MachineCtx["spell"], ladder: Ladder = 0): MachineCtx => ({
    mode: "pick",
    ladder,
    idlePortions: () => ["pets[0]", "name"], // seeded from an existing pointer raw
    spell,
  });

  const enterPick = (ctx: MachineCtx): BcState => reduceCtx(IDLE, { type: "FOCUS_CELL", index: 0 }, ctx)[0];

  it("SCOPE climbs and clamps the ladder, refetching under the new opener; browse ignores it", () => {
    const ctx = pickCtx();
    let s = enterPick(ctx);
    if (s.mode !== "editing") throw new Error();
    expect(fullQueryOf(s)).toBe("pets[0]: name"); // ladder 0: bare current-scope query
    let fx: Effect[];
    [s, fx] = reduceCtx(s, { type: "SCOPE", dir: 1 }, ctx);
    if (s.mode !== "editing") throw new Error();
    expect(s.ladder).toBe(1);
    expect(fullQueryOf(s)).toBe(": pets[0]: name");
    expect(fx.map((f) => f.type)).toEqual(["fetchCandidates", "fetchMatches"]);
    [s] = reduceCtx(s, { type: "SCOPE", dir: 1 }, ctx);
    [s] = reduceCtx(s, { type: "SCOPE", dir: 1 }, ctx);
    const [clamped] = reduceCtx(s, { type: "SCOPE", dir: 1 }, ctx);
    expect(clamped).toBe(s); // 3 is the top rung
    // stepping back down to bare
    let d = s;
    for (const _ of [1, 2, 3]) [d] = reduceCtx(d, { type: "SCOPE", dir: -1 }, ctx);
    if (d.mode !== "editing") throw new Error();
    expect(d.ladder).toBe(0);
    expect(reduceCtx(d, { type: "SCOPE", dir: -1 }, ctx)[0]).toBe(d); // bare is the floor
    // browse machines never move their ladder
    const b = reduce(IDLE, { type: "FOCUS_CELL" } as BcEvent, ":team:alice")[0];
    expect(reduceCtx(b, { type: "SCOPE", dir: 1 }, browseCtx(":team:alice"))[0]).toBe(b);
  });

  it("TOC_CLICK inserts the picked node's spelling and STAYS editing (a click never commits)", () => {
    const ctx = pickCtx((path) => ({ ladder: 0, portions: ["..", "bob", "age"] }));
    let s = enterPick(ctx);
    const [next, fx] = reduceCtx(s, { type: "TOC_CLICK", path: ":team:bob:age" }, ctx);
    if (next.mode !== "editing") throw new Error();
    expect(next.portions).toEqual(["..", "bob", "age"]);
    expect(next.active).toBe(2);
    expect(next.activeText).toBe("age");
    expect(next.matchesFresh).toBe(false);
    expect(fx[0]).toEqual({ type: "focusCell", index: 2, caret: "end" });
    expect(fx.slice(1).map((f) => f.type)).toEqual(["fetchCandidates", "fetchMatches"]);
    expect((fx[2] as any).query).toBe("..: bob: age");
  });

  it("ENTER with fresh matches reduces to the FIRST match and returns to idle — never filtered", () => {
    const ctx = pickCtx();
    let s = enterPick(ctx);
    [s] = reduceCtx(s, { type: "MATCHES_ARRIVED", seq: mseq(s), ok: true, paths: [":pets[0]:name", ":x"], truncated: false }, ctx);
    const [done, fx] = reduceCtx(s, { type: "ENTER" }, ctx);
    expect(done.mode).toBe("idle");
    // the select carries the commit context: the ladder and the full typed query
    expect(fx).toEqual([{ type: "select", path: ":pets[0]:name", ladder: 0, query: "pets[0]: name" }]);
  });

  it("ENTER with zero fresh matches selects null (the host decides: verbatim pointer / create)", () => {
    const ctx = pickCtx();
    let s = enterPick(ctx);
    [s] = reduceCtx(s, { type: "MATCHES_ARRIVED", seq: mseq(s), ok: true, paths: [], truncated: false }, ctx);
    const [done, fx] = reduceCtx(s, { type: "ENTER" }, ctx);
    expect(done.mode).toBe("idle");
    expect(fx).toEqual([{ type: "select", path: null, ladder: 0, query: "pets[0]: name" }]);
  });

  it("a pending Enter commits on arrival — first match or null, straight to idle", () => {
    const ctx = pickCtx();
    let s = enterPick(ctx);
    [s] = reduceCtx(s, { type: "SET_ACTIVE_TEXT", text: "zoe" }, ctx); // matches stale
    let fx: Effect[];
    [s, fx] = reduceCtx(s, { type: "ENTER" }, ctx);
    if (s.mode !== "editing") throw new Error();
    expect(s.pendingEnter).toBe(true);
    expect(fx[0]).toMatchObject({ type: "fetchMatches", immediate: true });
    const [done, fx2] = reduceCtx(s, { type: "MATCHES_ARRIVED", seq: mseq(s), ok: true, paths: [], truncated: false }, ctx);
    expect(done.mode).toBe("idle");
    expect(fx2).toEqual([{ type: "select", path: null, ladder: 0, query: "zoe: name" }]);
  });

  it("a FAILED match fetch on a pending pick still hands the typed query to the host (hints are never validators)", () => {
    const ctx = pickCtx();
    let s = enterPick(ctx);
    [s] = reduceCtx(s, { type: "SET_ACTIVE_TEXT", text: "..[.-1]" }, ctx); // a relindex LINK — the query grammar refuses it
    [s] = reduceCtx(s, { type: "ENTER" }, ctx);
    const [done, fx] = reduceCtx(s, { type: "MATCHES_ARRIVED", seq: mseq(s), ok: false, paths: [], truncated: false }, ctx);
    expect(done.mode).toBe("idle");
    expect(fx).toEqual([{ type: "select", path: null, ladder: 0, query: "..[.-1]: name" }]);
  });

  it("EVICTED abandons the edit from editing (and from filtered in browse mode)", () => {
    const ctx = pickCtx();
    const s = enterPick(ctx);
    expect(reduceCtx(s, { type: "EVICTED" }, ctx)[0].mode).toBe("idle");
  });

  it("entering via the tail REUSES an already-empty trailing cell — never doubles it", () => {
    // the tag popup's seed ends in an empty cell; a tail click (FOCUS_CELL, no index) must
    // land IN it, not append a second confusing empty cell after it
    const ctx: MachineCtx = { mode: "pick", ladder: 1, idlePortions: () => ["...", ""] };
    const [s] = reduceCtx(IDLE, { type: "FOCUS_CELL" }, ctx);
    if (s.mode !== "editing") throw new Error();
    expect(s.portions).toEqual(["...", ""]);
    expect(s.active).toBe(1);
  });
});

describe("filtered state", () => {
  const toFiltered = (): BcState => {
    let [s] = run([{ type: "FOCUS_CELL" }]);
    [s] = reduce(s, arrive(s, [":team:alice", ":team:bob"]), ":");
    return reduce(s, { type: "ENTER" }, ":")[0];
  };

  it("cell click re-enters editing with the QUERY cells (not the path)", () => {
    const f = toFiltered();
    const [e] = reduce(f, { type: "FOCUS_CELL", index: 0 }, ":team:alice");
    if (e.mode !== "editing") throw new Error();
    expect(e.portions[0]).toBe("team"); // kept from the query
  });

  it("TOC_CLICK match stays filtered; ESCAPE and non-match NAVIGATED return to idle", () => {
    const f = toFiltered();
    expect(reduce(f, { type: "TOC_CLICK", path: ":team:bob" }, ":")[0].mode).toBe("filtered");
    expect(reduce(f, { type: "ESCAPE" }, ":")[0].mode).toBe("idle");
    expect(reduce(f, { type: "NAVIGATED", path: ":team:bob" }, ":")[0].mode).toBe("filtered");
    expect(reduce(f, { type: "NAVIGATED", path: ":elsewhere" }, ":")[0].mode).toBe("idle");
  });
});
