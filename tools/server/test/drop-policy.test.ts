// drop-policy.ts — the pure drag-drop possibility rules (no I/O, no DOM).
import { describe, it, expect, afterEach } from "vitest";
import { planNodeMove, planFileUpload, planBoardMove, DropNode } from "../src/drop-policy";

const n = (path: string, concrete: string | null, label?: string): DropNode => ({ path, concrete, label });

describe("planNodeMove", () => {
  it("allows a file into a plain directory, composing the target path", () => {
    const v = planNodeMove(n(":a:note.yo", "file/yamlover", "note"), n(":b", "dir", "b"));
    expect(v).toMatchObject({ allowed: true, plan: { kind: "move-node", from: ":a:note.yo", to: ":b:note.yo" } });
    if (v.allowed) expect(v.plan.description).toBe('Move "note" into "b"');
  });

  it("allows a directory into a yamlover directory", () => {
    const v = planNodeMove(n(":a:sub", "dir"), n(":b", "dir/.yo"));
    expect(v).toMatchObject({ allowed: true, plan: { to: ":b:sub" } });
  });

  it("allows a binary file to move (the source may be file/binary)", () => {
    expect(planNodeMove(n(":a:img.png", "file/binary"), n(":b", "dir")).allowed).toBe(true);
  });

  it("allows dropping onto the root", () => {
    const v = planNodeMove(n(":a:note.yo", "file/yaml"), n(":", "dir", "root"));
    expect(v).toMatchObject({ allowed: true, plan: { to: ":note.yo" } });
  });

  it("keeps a percent-encoded key intact in the composed target", () => {
    const v = planNodeMove(n(":a:%40scope%2Fpkg", "file/yaml", "@scope/pkg"), n(":b", "dir"));
    expect(v).toMatchObject({ allowed: true, plan: { to: ":b:%40scope%2Fpkg" } });
  });

  it("rejects a non-directory target", () => {
    expect(planNodeMove(n(":a:x", "file/yaml"), n(":b:y", "file/yaml"))).toMatchObject({ allowed: false });
    expect(planNodeMove(n(":a:x", "file/yaml"), n(":b:img.png", "file/binary"))).toMatchObject({ allowed: false });
  });

  it("rejects an inlined source (mv is FS-level only)", () => {
    for (const c of ["yamlover", "yaml", "json", null]) {
      expect(planNodeMove(n(":a:x", c), n(":b", "dir")).allowed).toBe(false);
    }
  });

  it("rejects moving the root", () => {
    expect(planNodeMove(n(":", "dir"), n(":b", "dir")).allowed).toBe(false);
  });

  it("rejects positional segments in either path", () => {
    expect(planNodeMove(n(":a[0]:x", "file/yaml"), n(":b", "dir")).allowed).toBe(false);
    expect(planNodeMove(n(":a:x", "file/yaml"), n(":b[1]", "dir")).allowed).toBe(false);
  });

  it("rejects hidden/overlay segments in either path", () => {
    expect(planNodeMove(n(":.yo:body.yo", "file/yamlover"), n(":b", "dir")).allowed).toBe(false);
    expect(planNodeMove(n(":a:x", "file/yaml"), n(":.yo", "dir")).allowed).toBe(false);
  });

  it("rejects moving a node into itself or a descendant", () => {
    expect(planNodeMove(n(":a", "dir"), n(":a", "dir")).allowed).toBe(false);
    expect(planNodeMove(n(":a", "dir"), n(":a:sub", "dir")).allowed).toBe(false);
  });

  it("rejects the no-op drop into the current parent", () => {
    expect(planNodeMove(n(":a:x", "file/yaml"), n(":a", "dir"))).toMatchObject({ allowed: false, reason: "already there" });
    expect(planNodeMove(n(":x", "file/yaml"), n(":", "dir")).allowed).toBe(false); // root as current parent
  });
});

describe("planFileUpload", () => {
  it("rejects an empty file list", () => {
    expect(planFileUpload(n(":a", "dir"), []).allowed).toBe(false);
  });

  it("describes a single file by name", () => {
    const v = planFileUpload(n(":a", "dir", "a"), ["x.png"]);
    expect(v).toMatchObject({ allowed: true, plan: { kind: "upload-files", target: ":a", files: ["x.png"] } });
    if (v.allowed) expect(v.plan.description).toBe('Upload file onto "a": x.png');
  });

  it("counts and truncates a long file list", () => {
    const v = planFileUpload(n(":a", "dir", "a"), ["1", "2", "3", "4", "5"]);
    if (!v.allowed) throw new Error("expected allowed");
    expect(v.plan.description).toBe('Upload 5 files onto "a": 1, 2, 3, …');
  });
});

describe("planBoardMove", () => {
  const DOING = { path: ":ontos:doing", name: "doing" };
  const TODO = { path: ":ontos:todo", name: "todo" };

  it("rejects dropping into the same compartment, and backlog onto backlog", () => {
    expect(planBoardMove({ path: ":t" }, { lane: 0, comp: 1 }, { lane: 0, comp: 1 }, { untag: [], tag: [] }, "doing").allowed).toBe(false);
    expect(planBoardMove({ path: ":t" }, null, null, { untag: [], tag: [] }, null).allowed).toBe(false);
  });

  it("describes a compartment move by card title, destination label, and tag deltas", () => {
    const v = planBoardMove({ path: ":t", title: "Fix login" }, { lane: 0, comp: 0 }, { lane: 1, comp: 0 }, { untag: [TODO], tag: [DOING] }, "doing");
    expect(v).toMatchObject({
      allowed: true,
      plan: { kind: "board-move", task: ":t", from: { lane: 0, comp: 0 }, to: { lane: 1, comp: 0 }, untag: [":ontos:todo"], tag: [":ontos:doing"] },
    });
    if (v.allowed) expect(v.plan.description).toBe('Move "Fix login" to "doing" (+doing, −todo)');
  });

  it('describes a move to "other" (out of the lanes) with only removals', () => {
    const v = planBoardMove({ path: ":t", title: "Fix login" }, { lane: 0, comp: 0 }, null, { untag: [TODO], tag: [] }, null);
    expect(v).toMatchObject({ allowed: true, plan: { kind: "board-move", to: null, untag: [":ontos:todo"], tag: [] } });
    if (v.allowed) expect(v.plan.description).toBe('Move "Fix login" to "other" (−todo)');
  });

  it("refuses a drop into a TAGLESS compartment (no-tagless-tickets: it would bounce right out)", () => {
    const v = planBoardMove({ path: ":t", title: "Pin" }, null, { lane: 0, comp: 0 }, { untag: [], tag: [] }, "compartment", true);
    expect(v).toEqual({ allowed: false, reason: "the compartment has no tags yet — set one first" });
  });

  it("a deltaless move into a tagged compartment the chapter already matches says so plainly", () => {
    const v = planBoardMove({ path: ":t", title: "Pin" }, null, { lane: 0, comp: 0 }, { untag: [], tag: [] }, "doing");
    if (!v.allowed) throw new Error("expected allowed");
    expect(v.plan.description).toBe('Move "Pin" to "doing"');
  });
});

describe("read-only server (window.__READONLY__)", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("every planner refuses with the read-only reason", () => {
    (globalThis as { window?: unknown }).window = { __READONLY__: true };
    expect(planNodeMove(n(":a:note.yo", "file/yamlover"), n(":b", "dir"))).toEqual({ allowed: false, reason: "server is read-only" });
    expect(planFileUpload(n(":a", "dir"), ["x.png"])).toEqual({ allowed: false, reason: "server is read-only" });
    expect(planBoardMove({ path: ":t" }, null, { lane: 0, comp: 0 }, { untag: [], tag: [] }, "doing")).toEqual({ allowed: false, reason: "server is read-only" });
  });

  it("an explicit false flag changes nothing", () => {
    (globalThis as { window?: unknown }).window = { __READONLY__: false };
    expect(planNodeMove(n(":a:note.yo", "file/yamlover"), n(":b", "dir")).allowed).toBe(true);
  });
});
