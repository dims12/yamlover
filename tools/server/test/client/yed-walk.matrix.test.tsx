// @vitest-environment jsdom
// WALK × CONTEXTS — THE WALK LAW: arrows cross every cell, in both directions, and the walk ends
// at the document's LAST position (the gap past the final closer) — reported broken: "with right
// button I can reach only the pre-last ellipsis".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
const { editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(), fetchNode: vi.fn(), fetchAnnotations: vi.fn().mockResolvedValue([]),
  queryTree: vi.fn(), queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter,
}));
import { mountKit, walk } from "./yed-kit";

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset();
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock"));
});
afterEach(cleanup);

/** The cells a walk MUST visit: every key and every token (gaps are positions the walk may pass
 *  through; content cells are what a person needs to reach to edit). */
const contentCells = (kit: { cells(): HTMLElement[] }) =>
  kit.cells().filter((c) => (c.textContent ?? "") !== "");

describe("the walk", () => {
  it("right crosses every content cell of a one-line token", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("{{name: 12, m: 2}");
    const cells = contentCells(kit);
    const visited = walk(kit, cells[0], "right");
    for (const c of cells) expect(visited, `unreached cell: "${c.textContent}"`).toContain(c);
  });

  it("left crosses them all the way back", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("{{name: 12, m: 2}");
    const cells = contentCells(kit);
    const visited = walk(kit, cells[cells.length - 1], "left");
    for (const c of cells) expect(visited, `unreached cell: "${c.textContent}"`).toContain(c);
  });

  // (The reported unreachable last gap: the after-cell swallowed the arrows it did not handle.
  // Stage B's GapCell falls through to universal navigation, so the walk reaches the end.)
  it("the walk ends at the document's LAST position", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("[{{key: 12}, {{key: 13}]");
    const cells = contentCells(kit);
    const visited = walk(kit, cells[0], "right");
    const last = kit.cells()[kit.cells().length - 1]; // the gap past the outer `]`
    expect(visited, "the last position is unreachable").toContain(last);
  });

  it("a SPREAD document walks end to end too", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("[1{Enter}2");
    const cells = contentCells(kit);
    const visited = walk(kit, cells[0], "right");
    for (const c of cells) expect(visited, `unreached cell: "${c.textContent}"`).toContain(c);
  });

  it("keys inside a token are reachable and editable cells", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("{{name: 12}");
    const key = kit.cells().find((c) => c.textContent === "name");
    expect(key, "the key must be a cell, not a static span").toBeTruthy();
  });
});
