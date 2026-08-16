// board-model.ts — the pure tag-board policy (no I/O, no DOM, no Store).
import { describe, it, expect } from "vitest";
import { BoardStructure, applyMove, compartmentAt, moveDeltas, reconcile, seedFromOldLanes, seedFromWorkflow } from "../src/board-model";

const tags = (...t: string[]): Set<string> => new Set(t);
const chapters = (entries: [string, Set<string>][]): Map<string, Set<string>> => new Map(entries);

describe("reconcile", () => {
  it("moves a superset-matching chapter into the compartment and a mismatch out", () => {
    const structure: BoardStructure = [[{ tags: [":t:ready"], items: [{ path: ":c:stale" }] }]];
    const { structure: out, changed } = reconcile(structure, chapters([
      [":c:stale", tags(":t:done")],
      [":c:fresh", tags(":t:ready", ":t:urgent")], // extra tags allowed — superset rule
    ]));
    expect(changed).toBe(true);
    expect(out[0][0].items).toEqual([{ path: ":c:fresh" }]);
  });

  it("empties a zero-tag compartment of member tickets (the no-tagless-tickets principle)", () => {
    const structure: BoardStructure = [[{ tags: [], items: [{ path: ":c:pinned" }, { path: ":elsewhere:doc" }] }]];
    const { structure: out, changed } = reconcile(structure, chapters([
      [":c:pinned", tags(":t:done")],
      [":c:other", tags()],
    ]));
    expect(changed).toBe(true);
    // the member leaves (for its tags' compartments, else the backlog); a foreign ref stays
    expect(out[0][0].items).toEqual([{ path: ":elsewhere:doc" }]);
    // …and an already-empty tagless compartment is left verbatim (idempotence)
    const again = reconcile(out, chapters([[":c:pinned", tags(":t:done")]]));
    expect(again.changed).toBe(false);
    expect(again.structure).toBe(out);
  });

  it("lists a chapter in several compartments, even in one lane", () => {
    const structure: BoardStructure = [
      [{ tags: [":t:a"], items: [] }, { tags: [":t:b"], items: [] }],
      [{ tags: [":t:a", ":t:b"], items: [] }],
    ];
    const { structure: out } = reconcile(structure, chapters([[":c:x", tags(":t:a", ":t:b")]]));
    expect(out[0][0].items).toEqual([{ path: ":c:x" }]);
    expect(out[0][1].items).toEqual([{ path: ":c:x" }]);
    expect(out[1][0].items).toEqual([{ path: ":c:x" }]);
  });

  it("collapses duplicates to the first occurrence", () => {
    const structure: BoardStructure = [[{ tags: [":t:a"], items: [{ path: ":c:x", key: "first" }, { path: ":c:x" }] }]];
    const { structure: out, changed } = reconcile(structure, chapters([[":c:x", tags(":t:a")]]));
    expect(changed).toBe(true);
    expect(out[0][0].items).toEqual([{ path: ":c:x", key: "first" }]);
  });

  it("preserves a matching item's key and manual order; appends newcomers in member order", () => {
    const structure: BoardStructure = [[{ tags: [":t:a"], items: [{ path: ":c:second", key: "why" }, { path: ":c:first" }] }]];
    const { structure: out } = reconcile(structure, chapters([
      [":c:first", tags(":t:a")],
      [":c:new1", tags(":t:a")],
      [":c:second", tags(":t:a", ":t:extra")],
      [":c:new2", tags(":t:a")],
    ]));
    expect(out[0][0].items).toEqual([
      { path: ":c:second", key: "why" },
      { path: ":c:first" },
      { path: ":c:new1" },
      { path: ":c:new2" },
    ]);
  });

  it("never touches a foreign ref (not a direct member)", () => {
    const structure: BoardStructure = [[{ tags: [":t:a"], items: [{ path: ":elsewhere:doc" }] }]];
    const { structure: out, changed } = reconcile(structure, chapters([[":c:x", tags(":t:b")]]));
    expect(changed).toBe(false);
    expect(out[0][0].items).toEqual([{ path: ":elsewhere:doc" }]);
  });

  it("is idempotent", () => {
    const structure: BoardStructure = [[{ tags: [":t:a"], items: [{ path: ":c:stale" }] }]];
    const members = chapters([[":c:stale", tags()], [":c:fresh", tags(":t:a")]]);
    const once = reconcile(structure, members);
    const twice = reconcile(once.structure, members);
    expect(twice.changed).toBe(false);
    expect(twice.structure).toBe(once.structure);
  });
});

describe("moveDeltas", () => {
  const src = { tags: [":t:ready", ":t:team"], items: [] };
  const dst = { tags: [":t:done", ":t:team"], items: [] };

  it("compartment → compartment: unshared source tags off, missing destination tags on", () => {
    const d = moveDeltas(tags(":t:ready", ":t:team", ":t:urgent"), src, dst);
    expect(d.untag).toEqual([":t:ready"]); // :t:team survives — the destination wants it too
    expect(d.tag).toEqual([":t:done"]);
  });

  it("backlog → compartment: adds only the tags the chapter lacks", () => {
    const d = moveDeltas(tags(":t:team"), null, dst);
    expect(d.untag).toEqual([]);
    expect(d.tag).toEqual([":t:done"]);
  });

  it("compartment → backlog: removes only the tags shared with the source", () => {
    const d = moveDeltas(tags(":t:ready", ":t:urgent"), src, null);
    expect(d.untag).toEqual([":t:ready"]); // :t:team not carried → nothing to remove; :t:urgent untouched
    expect(d.tag).toEqual([]);
  });

  it("backlog → backlog: no deltas", () => {
    expect(moveDeltas(tags(":t:a"), null, null)).toEqual({ untag: [], tag: [] });
  });
});

describe("applyMove", () => {
  const structure: BoardStructure = [
    [{ tags: [":t:a"], items: [{ path: ":c:x", key: "k" }, { path: ":c:y" }] }],
    [{ tags: [":t:b"], items: [{ path: ":c:x" }] }],
  ];

  it("moves one instance only, key travelling with it", () => {
    const out = applyMove(structure, ":c:x", { lane: 0, comp: 0 }, { lane: 1, comp: 0 });
    expect(out[0][0].items).toEqual([{ path: ":c:y" }]);
    expect(out[1][0].items).toEqual([{ path: ":c:x" }]); // already there — not duplicated
    const out2 = applyMove(structure, ":c:x", { lane: 0, comp: 0 }, null);
    expect(out2[0][0].items).toEqual([{ path: ":c:y" }]);
    expect(out2[1][0].items).toEqual([{ path: ":c:x" }]); // the other instance stands
  });

  it("appends to the destination from the backlog", () => {
    const out = applyMove(structure, ":c:new", null, { lane: 0, comp: 0 });
    expect(out[0][0].items).toEqual([{ path: ":c:x", key: "k" }, { path: ":c:y" }, { path: ":c:new" }]);
  });

  it("keeps the moved item's key on a compartment → compartment move", () => {
    const out = applyMove(structure, ":c:x", { lane: 0, comp: 0 }, { lane: 1, comp: 0 });
    const out2 = applyMove(out, ":c:x", { lane: 1, comp: 0 }, { lane: 0, comp: 0 });
    expect(out2[0][0].items).toEqual([{ path: ":c:y" }, { path: ":c:x" }]);
  });
});

describe("seeds", () => {
  it("seedFromWorkflow: one single-compartment lane per state, initial included", () => {
    expect(seedFromWorkflow([":w:backlog", ":w:ready"])).toEqual([
      [{ tags: [":w:backlog"], items: [] }],
      [{ tags: [":w:ready"], items: [] }],
    ]);
  });

  it("seedFromOldLanes: old sublane tags become compartments; a tagless lane one manual compartment", () => {
    expect(seedFromOldLanes([[":t:a"], [":t:b", ":t:c"], []])).toEqual([
      [{ tags: [":t:a"], items: [] }],
      [{ tags: [":t:b"], items: [] }, { tags: [":t:c"], items: [] }],
      [{ tags: [], items: [] }],
    ]);
  });
});

describe("compartmentAt", () => {
  it("resolves coordinates, null for backlog and out-of-range", () => {
    const structure: BoardStructure = [[{ tags: [":t:a"], items: [] }]];
    expect(compartmentAt(structure, { lane: 0, comp: 0 })).toBe(structure[0][0]);
    expect(compartmentAt(structure, null)).toBeNull();
    expect(compartmentAt(structure, { lane: 1, comp: 0 })).toBeNull();
  });
});
