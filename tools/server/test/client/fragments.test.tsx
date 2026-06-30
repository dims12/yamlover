// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { fragmentGroups } from "../../src/client/Fragments";
import { Annotation } from "../../src/client/api";

const tag = (path: string, name: string) => ({ path, name, color: null });

describe("fragmentGroups", () => {
  it("groups annotations by fragmentSlug, one row per fragment, gathering tags", () => {
    const anns: Annotation[] = [
      { fragmentSlug: "f1", selector: { type: "text", exact: "hello" }, tag: tag(":t:a", "a") },
      { fragmentSlug: "f1", selector: { type: "text", exact: "hello" }, tag: tag(":t:b", "b") },
      { fragmentSlug: "f2", selector: { type: "rect" }, imageUrl: "/api/blob?x", tag: tag(":t:a", "a") },
    ];
    const groups = fragmentGroups(anns);
    expect(groups.map((g) => g.slug)).toEqual(["f1", "f2"]);
    expect(groups[0].tags.map((t) => t.path)).toEqual([":t:a", ":t:b"]); // both tags, in order
    expect(groups[0].selector?.exact).toBe("hello");
    expect(groups[1].imageUrl).toBe("/api/blob?x");
  });

  it("skips whole-node annotations (no fragmentSlug) and dedupes a repeated tag", () => {
    const anns: Annotation[] = [
      { tag: tag(":t:whole", "whole") }, // whole-node → belongs to the toolbar, not here
      { fragmentSlug: "f1", selector: { type: "text", exact: "x" }, tag: tag(":t:a", "a") },
      { fragmentSlug: "f1", selector: { type: "text", exact: "x" }, tag: tag(":t:a", "a") }, // dup tag
    ];
    const groups = fragmentGroups(anns);
    expect(groups).toHaveLength(1);
    expect(groups[0].tags).toHaveLength(1);
  });
});
