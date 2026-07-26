// @vitest-environment jsdom
// FLOW × CONTEXTS — the flow-token grammar replayed inside every enclosing structure. The rows
// carry THE LAWS by name; a row tagged `it.fails` is a law the CURRENT editor breaks (today's
// reports, made executable) — the redesign stages turn them into plain `it`s, and `it.fails`
// itself fails once they pass, so the tags cannot rot.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
const { editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(), fetchNode: vi.fn(), fetchAnnotations: vi.fn().mockResolvedValue([]),
  queryTree: vi.fn(), queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter,
}));
import { mountKit } from "./yed-kit";
import { CONTEXTS, BLOCK_CONTEXTS } from "./yed-contexts";

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset();
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock"));
});
afterEach(cleanup);

describe("flow × contexts", () => {
  // LAW: every legal construct is enterable — `{key: 12}` closes cleanly, no error ring.
  // Inside a SPREAD context the token spreads too (the whole-token law), so the frame embeds its
  // K&R rows rather than the inline form.
  for (const ctx of CONTEXTS) {
    it(`a keyed pair closes cleanly ${ctx.name}`, async () => {
      const kit = await mountKit(fetchNode, ctx.doc);
      kit.run(ctx.prefix + "{{key: 12}");
      expect(kit.rows()).toEqual(ctx.wrapToken ? ctx.wrapToken(["{", "key: 12", "}"]) : ctx.wrapInline("{key: 12}"));
      expect(kit.container.querySelector(".edit-error"), "a legal construct must not ring").toBeNull();
      kit.caret();
    });
  }

  // LAW: a comma keeps the chain on one line
  for (const ctx of CONTEXTS) {
    it(`a comma chain stays inline ${ctx.name}`, async () => {
      const kit = await mountKit(fetchNode, ctx.doc);
      kit.run(ctx.prefix + "[1, 2]");
      expect(kit.rows()).toEqual(ctx.wrapToken ? ctx.wrapToken(["[", "1,", "2", "]"]) : ctx.wrapInline("[1, 2]"));
      expect(kit.container.querySelector(".edit-error")).toBeNull();
      kit.caret();
    });
  }

  // LAW: Enter puts the element on its own row (block contexts frame the rows)
  for (const ctx of BLOCK_CONTEXTS) {
    it(`Enter spreads to rows ${ctx.name}`, async () => {
      const kit = await mountKit(fetchNode, ctx.doc);
      kit.run(ctx.prefix + "[1{Enter}2]");
      expect(kit.rows()).toEqual(ctx.wrapRows(["[", "1,", "2", "]"]));
      kit.caret();
    });
  }

  // LAW: the spread belongs to the WHOLE token — Enter deep inside spreads from the outermost
  it("Enter inside a nested token spreads the whole token", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("{{p: [1{Enter}2]");
    expect(kit.rows()).toEqual(["{", "p: [", "1,", "2", "]", "}"]);
    kit.caret();
  });

  // LAW: a flow token may BE a key
  it("a closed token becomes a key with `:`", async () => {
    const kit = await mountKit(fetchNode);
    kit.run("{{{{}: 12}");
    expect(kit.rows()).toEqual(["{{}: 12}"]);
    kit.caret();
  });

  // LAW: one placeholder — `…` renders only in the hole awaiting content, never in gaps.
  // (The reported ellipsis clutter: gaps used to be empty `.editable`s, each painting `…`.
  // Stage B made gaps POSITIONS — GapCell — and the law holds everywhere.)
  for (const ctx of CONTEXTS.filter((c) => c.hosts === "flow" || c.name === "at the root")) {
    it(`at most one placeholder mid-typing ${ctx.name}`, async () => {
      const kit = await mountKit(fetchNode);
      kit.run(ctx.prefix + "{{key: 12}");
      expect(kit.placeholders().length, "gaps must not display …").toBeLessThanOrEqual(1);
    });
  }
});
