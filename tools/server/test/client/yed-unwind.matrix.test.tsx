// @vitest-environment jsdom
// UNWIND × CONTEXTS — THE LADDER LAW: from wherever the caret stands, deleting reaches the EMPTY
// document. One press, one level; no dead press; no jam (a repeated state IS the jam). The kit's
// `unwindToEmpty` walks the ladder and fails at the exact press that jams.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
const { editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(), fetchNode: vi.fn(), fetchAnnotations: vi.fn().mockResolvedValue([]),
  queryTree: vi.fn(), queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter,
}));
import { mountKit, unwindToEmpty, caretTo } from "./yed-kit";
import { CONTEXTS } from "./yed-contexts";

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset();
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock"));
});
afterEach(cleanup);

describe("unwind × contexts", () => {
  // the CONTEXT itself unwinds: enter it, then delete everything back to the empty document
  for (const ctx of CONTEXTS.filter((c) => c.prefix !== "")) {
    it(`the context unwinds to empty ${ctx.name}`, async () => {
      const kit = await mountKit(fetchNode, ctx.doc);
      kit.run(ctx.prefix);
      unwindToEmpty(kit);
    });
  }

  // content typed INSIDE a context unwinds through it
  for (const ctx of CONTEXTS) {
    it(`a typed scalar unwinds through ${ctx.name}`, async () => {
      const kit = await mountKit(fetchNode, ctx.doc);
      kit.run(ctx.prefix + "12");
      unwindToEmpty(kit);
    });
    it(`a typed pair unwinds through ${ctx.name}`, async () => {
      const kit = await mountKit(fetchNode, ctx.doc);
      kit.run(ctx.prefix + "{{a: 1");
      unwindToEmpty(kit);
    });
  }

  // THE REPORTED SCENARIO: a finished two-element document, deletion started from a GAP near the
  // end. BROKEN TODAY — the ladder reached `[{key: 12}]` and jammed. Stage C/D delist.
  it("the reported ladder: [{key: 12}, {key: 13}] deleted from the pre-last gap", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("[{{key: 12}, {{key: 13}]");
    // the caret sits past the outer `]`; the user clicked into the PRE-LAST gap (after `13`'s `}`)
    const gaps = kit.cells().filter((c) => (c.textContent ?? "") === "");
    caretTo(gaps[gaps.length - 2] ?? gaps[gaps.length - 1], "start");
    unwindToEmpty(kit);
  });

  // and the same document unwound from where typing LEFT the caret — no clicking at all
  it("the finished document unwinds from the caret's own resting place", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("[{{key: 12}, {{key: 13}]");
    unwindToEmpty(kit);
  });
});
