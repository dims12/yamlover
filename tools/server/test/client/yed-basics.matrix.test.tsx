// @vitest-environment jsdom
// BASICS × CONTEXTS — the simplest edits, each replayed inside every enclosing structure
// (yed-contexts.ts). THE LAW under test: context-free behavior — typing `12` means the same
// thing at the root, under a key, on a dash, and inside any flow token. A row failing in ONE
// context and passing in the others is precisely the class of bug this matrix exists to catch.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
const { editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(), fetchNode: vi.fn(), fetchAnnotations: vi.fn().mockResolvedValue([]),
  queryTree: vi.fn(), queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter,
}));
vi.mock("../../src/client/content", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchContent: vi.fn() }));
import { mountKit } from "./yed-kit";
import { CONTEXTS } from "./yed-contexts";

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset();
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock"));
});
afterEach(cleanup);

/** A basic edit: the keys typed, and the INLINE token they read as once typed. */
const SCRIPTS: { name: string; keys: string; inline: string }[] = [
  { name: "a plain scalar", keys: "12", inline: "12" },
  { name: "a negative number", keys: "-5", inline: "-5" },
  { name: "a quoted string", keys: '"ab"', inline: '"ab"' },
  { name: "an empty map", keys: "{{}", inline: "{}" },
  { name: "an empty seq", keys: "[]", inline: "[]" },
];

describe("basics × contexts", () => {
  for (const ctx of CONTEXTS) {
    describe(ctx.name, () => {
      for (const s of SCRIPTS) {
        it(`${s.name} reads as it was typed`, async () => {
          const kit = await mountKit(fetchNode, ctx.doc);
          kit.run(ctx.prefix + s.keys);
          expect(kit.rows()).toEqual(ctx.wrapInline(s.inline));
          kit.caret(); // and the caret is alive wherever it ended up
        });
      }
    });
  }
});
