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
import { cellText, mountKit, walk } from "./yed-kit";

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset();
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock"));
});
afterEach(cleanup);

/** The TEXTS a walk MUST visit: every key and every token (gaps are positions the walk may
 *  pass through; content is what a person needs to reach to edit). Element identity cannot
 *  anchor this — yed re-renders replace elements — so the law runs over cell TEXTS. */
const contentTexts = (kit: { cells(): HTMLElement[] }) =>
  kit.cells().map(cellText).filter((t) => t !== "" && t !== "▏");

describe("the walk", () => {
  it("right crosses every content cell of a one-line token", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("{{name: 12, m: 2}");
    const texts = contentTexts(kit);
    const visited = walk(kit, kit.cells()[0], "right");
    for (const t of texts) expect(visited, `unreached cell: "${t}"`).toContain(t);
  });

  it("left crosses them all the way back", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("{{name: 12, m: 2}");
    const texts = contentTexts(kit);
    const cells = kit.cells();
    const visited = walk(kit, cells[cells.length - 1], "left");
    for (const t of texts) expect(visited, `unreached cell: "${t}"`).toContain(t);
  });

  // (The reported unreachable last gap: the after-cell swallowed the arrows it did not handle.
  // yed's GapCell falls through to universal navigation, so the walk reaches the end.)
  it("the walk ends at the document's LAST position", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("[{{key: 12}, {{key: 13}]");
    walk(kit, kit.cells()[0], "right");
    // the walk's resting place IS the last position: the gap past the outer `]`
    expect(kit.cursor()).toContain('"after"');
    expect(kit.cursor()).toContain('"path":[]');
  });

  it("a SPREAD document walks end to end too", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("[1{Enter}2]"); // committed — walking away from an open hole abandons its text BY LAW
    const texts = contentTexts(kit);
    const visited = walk(kit, kit.cells()[0], "right");
    for (const t of texts) expect(visited, `unreached cell: "${t}"`).toContain(t);
  });

  it("keys inside a token are reachable and editable cells", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("{{name: 12}");
    const key = kit.cells().map(cellText).find((t) => t === "name");
    expect(key, "the key must be a cell, not a static span").toBeTruthy();
  });
});
