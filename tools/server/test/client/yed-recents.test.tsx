// @vitest-environment jsdom
// THE SERVER SIDE of the yed recents bag: `treeRecents` (the per-project lists spelled for
// the asking cell — the `&` face gets the MEMBERSHIP form, positions filtered) and
// `recordRefCommit` (a committed reference edit resolved back to its target and filed), on
// top of `resolveSpelledPath` — spellPointer's inverse.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { readRecents, recordRecent, forgetRecent, projectOntos } = vi.hoisted(() => ({
  readRecents: vi.fn(),
  recordRecent: vi.fn(),
  forgetRecent: vi.fn(),
  projectOntos: vi.fn(),
}));
vi.mock("../../src/client/recents", () => ({ readRecents, recordRecent, forgetRecent }));
vi.mock("../../src/client/ontos", () => ({ projectOntos }));

import { treeRecents, recordRefCommit } from "../../src/client/renderers/yed-cells";
import { resolveSpelledPath } from "../../src/client/pointer-spell";
import { parseSource, type Document } from "../../../yed/src/state";
import type { RecentsQuery } from "../../../yed/src/complete";
import type { RefCommit } from "../../../yed/src/apply";

beforeEach(() => {
  readRecents.mockReset().mockResolvedValue([]);
  recordRecent.mockReset();
  forgetRecent.mockReset();
  projectOntos.mockReset().mockResolvedValue([]);
});

const doc = (): Document => parseSource("a:\n  b: 1\n");

describe("resolveSpelledPath — spellPointer's inverse", () => {
  it("resolves each scope against its base", () => {
    expect(resolveSpelledPath("b", ":a", ":")).toBe(":a:b");        // current scope at the holder
    expect(resolveSpelledPath("..: x", ":a:b", ":")).toBe(":a:x");  // parent base + key
    expect(resolveSpelledPath(": x: y", ":a", ":base")).toBe(":base:x:y"); // document base
    expect(resolveSpelledPath(":: proj: x", ":a", ":")).toBe(":proj:x");   // link authority = root child
  });
  it("names no node for appends, relindexes, mid-edit text, or a climb past the root", () => {
    expect(resolveSpelledPath(":: a: -", ":", ":")).toBeNull();
    expect(resolveSpelledPath("..[.-1]", ":a:b", ":")).toBeNull();
    expect(resolveSpelledPath("", ":", ":")).toBeNull();
    expect(resolveSpelledPath("..: x", ":", ":")).toBeNull();
  });
});

describe("treeRecents — the bag spelled for the asking cell", () => {
  const q = (over: Partial<RecentsQuery>): RecentsQuery =>
    ({ anchor: false, ladder: 2, path: [], doc: doc(), host: { base: ":", doc: ":" }, ...over });

  it("spells reference recents under the typed ladder, the full path as the detail", async () => {
    readRecents.mockResolvedValue([{ path: ":ontos:workflow:ready", name: "ready", color: null }]);
    const rows = await treeRecents(q({ anchor: false }));
    expect(readRecents).toHaveBeenCalledWith("references");
    expect(rows).toEqual([{ raw: ":: ontos: workflow: ready", label: "ready", detail: ": ontos: workflow: ready", key: ":ontos:workflow:ready" }]);
    expect(projectOntos).not.toHaveBeenCalled(); // a reference has no vocabulary — any node is fair game
  });

  it("the `&` face reads the bookmarks list, drops position-bearing paths, offers the membership `-`", async () => {
    readRecents.mockResolvedValue([
      { path: ":ontos:tag", name: "tag", color: null },
      { path: ":pets:1", name: "1", color: null }, // a position claim — makeAnchor refuses it
    ]);
    const rows = await treeRecents(q({ anchor: true }));
    expect(readRecents).toHaveBeenCalledWith("bookmarks");
    expect(rows).toEqual([{ raw: ":: ontos: tag: -", label: "tag", detail: ": ontos: tag", key: ":ontos:tag" }]);
  });

  it("the `&` face falls back to the project VOCABULARY — an empty bag still suggests the tags", async () => {
    readRecents.mockResolvedValue([]);
    projectOntos.mockResolvedValue([{ path: ":ontos:workflow", name: "workflow", color: null }]);
    const rows = await treeRecents(q({ anchor: true }));
    expect(rows).toEqual([{ raw: ":: ontos: workflow: -", label: "workflow", detail: ": ontos: workflow", key: ":ontos:workflow" }]);
  });

  it("a remembered tag is never DOUBLED by the vocabulary behind it", async () => {
    readRecents.mockResolvedValue([{ path: ":ontos:tag", name: "tag", color: null }]);
    projectOntos.mockResolvedValue([{ path: "::ontos:tag", name: "tag", color: null }]); // the same node, scope-spelled
    const rows = await treeRecents(q({ anchor: true }));
    expect(rows.map((r) => r.key)).toEqual([":ontos:tag"]);
  });
});

describe("recordRefCommit — a landed edit filed among the recents", () => {
  const host = { base: ":", doc: ":" };
  const commit = (over: Partial<RefCommit>): RefCommit =>
    ({ anchor: false, raw: ":: ontos: tag", holder: [], doc: doc(), ...over });

  it("files a pointer commit under `references` with the resolved target", () => {
    recordRefCommit(commit({ raw: ":: ontos: workflow: ready" }), host);
    expect(recordRecent).toHaveBeenCalledWith("references", { path: ":ontos:workflow:ready", name: "ready", color: null });
  });

  it("files a bookmark commit under `bookmarks`, the membership `-` stripped — the TARGET is remembered", () => {
    recordRefCommit(commit({ anchor: true, raw: ":: ontos: tag: -" }), host);
    expect(recordRecent).toHaveBeenCalledWith("bookmarks", { path: ":ontos:tag", name: "tag", color: null });
  });

  it("resolves a relative raw at the holder (the same addressing law the hints use)", () => {
    // holder [0] = `:a` in the doc — `b` typed bare resolves to `:a:b`
    recordRefCommit(commit({ raw: "b", holder: [0] }), host);
    expect(recordRecent).toHaveBeenCalledWith("references", { path: ":a:b", name: "b", color: null });
  });

  it("skips what it cannot resolve — never a throw, never a gate", () => {
    recordRefCommit(commit({ raw: "..[.-1]" }), host); // relindex — no single node
    recordRefCommit(commit({ raw: "" }), host);
    recordRefCommit(commit({ raw: "b", holder: [99] }), host); // a stale address — serverPathOf throws inside
    expect(recordRecent).not.toHaveBeenCalled();
  });
});
