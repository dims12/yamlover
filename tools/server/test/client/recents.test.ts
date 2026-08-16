// @vitest-environment jsdom
// PER-PROJECT RECENTS (src/client/recents.ts) — the storage discipline behind the tag
// picker's chips and the yamlover editor's `&`/`*` bag: keys carry the PROJECT identity
// (settings.uri → root label → "local"), lists are newest-first, canonPath-deduped, capped,
// root- and palette-refusing; pruning drops entries whose node 404s and writes back.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { fetchConfig, fetchInfo, fetchNode } = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchInfo: vi.fn(),
  fetchNode: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchConfig,
  fetchInfo,
  fetchNode,
}));

import { MAX_RECENTS, readRecents, recordRecent, pruneRecents, _resetRecentsCacheForTests } from "../../src/client/recents";

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  _resetRecentsCacheForTests();
  fetchConfig.mockReset().mockRejectedValue(new Error("no config"));
  fetchInfo.mockReset().mockRejectedValue(new Error("no info"));
  fetchNode.mockReset().mockRejectedValue(new Error("no node"));
});

describe("the project key", () => {
  it("keys by settings.uri when configured", async () => {
    fetchConfig.mockResolvedValue({ source: "", settings: { uri: "https://ex/proj", exports: [] }, path: ":.yo:settings.yo" });
    recordRecent("bookmarks", { path: ":ontos:a", name: "a", color: null });
    await settle();
    expect(JSON.parse(localStorage.getItem("yo-recents:bookmarks:" + encodeURIComponent("https://ex/proj"))!))
      .toEqual([{ path: ":ontos:a", name: "a", color: null }]);
  });

  it("falls back to the served root label without a uri", async () => {
    fetchConfig.mockResolvedValue({ source: "", settings: { exports: [] }, path: ":.yo:settings.yo" });
    fetchInfo.mockResolvedValue({ root: "examples" });
    recordRecent("references", { path: ":a:b", name: "b", color: null });
    await settle();
    expect(localStorage.getItem("yo-recents:references:examples")).not.toBeNull();
  });

  it('falls back to "local" when neither wire answers', async () => {
    recordRecent("bookmarks", { path: ":ontos:a", name: "a", color: null });
    await settle();
    expect(localStorage.getItem("yo-recents:bookmarks:local")).not.toBeNull();
  });
});

describe("the list discipline", () => {
  it("newest first, deduped on the canonical path, capped at MAX_RECENTS", async () => {
    for (let i = 0; i < MAX_RECENTS + 3; i++) {
      recordRecent("bookmarks", { path: `:ontos:t${i}`, name: `t${i}`, color: null });
      await settle();
    }
    recordRecent("bookmarks", { path: "::ontos:t5", name: "t5", color: null }); // scope-spelled dup
    await settle();
    const list = await readRecents("bookmarks");
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0].path).toBe("::ontos:t5"); // moved to the head, old spelling dropped
    expect(list.filter((t) => t.name === "t5")).toHaveLength(1);
  });

  it("refuses the root and (for bookmarks) the color palette", async () => {
    recordRecent("bookmarks", { path: ":", name: ":", color: null });
    recordRecent("bookmarks", { path: "::yamlover:ontos:colors:sky", name: "sky", color: "#89dceb" });
    recordRecent("references", { path: "::yamlover:ontos:colors:sky", name: "sky", color: "#89dceb" });
    await settle();
    expect(await readRecents("bookmarks")).toEqual([]);
    // a reference to a palette node is legitimate — only the bookmarks bag refuses it
    expect((await readRecents("references")).map((t) => t.name)).toEqual(["sky"]);
  });

  it("the two bags are independent lists", async () => {
    recordRecent("bookmarks", { path: ":ontos:a", name: "a", color: null });
    await settle();
    expect(await readRecents("references")).toEqual([]);
  });
});

describe("pruning", () => {
  it("drops entries whose node is gone and writes the survivors back", async () => {
    localStorage.setItem("yo-recents:bookmarks:local", JSON.stringify([
      { path: ":ontos:alive", name: "alive", color: null },
      { path: ":ontos:dead", name: "dead", color: null },
    ]));
    fetchNode.mockImplementation(async (p: string) => {
      if (p === ":ontos:alive") return { path: p, value: {} };
      throw new Error("no such node");
    });
    const live = await pruneRecents("bookmarks");
    expect(live.map((t) => t.name)).toEqual(["alive"]);
    expect(JSON.parse(localStorage.getItem("yo-recents:bookmarks:local")!)).toEqual([
      { path: ":ontos:alive", name: "alive", color: null },
    ]);
  });
});
