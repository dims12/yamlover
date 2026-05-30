import { describe, it, expect } from "vitest";
import { segsToStr, strToSegs, type Seg } from "../src/server/yamlover";

describe("path encoding (segsToStr / strToSegs)", () => {
  it("renders keys and array indices", () => {
    expect(segsToStr([])).toBe("/");
    expect(segsToStr(["a", "b"])).toBe("/a/b");
    expect(segsToStr([0])).toBe("[0]");
    expect(segsToStr(["x", 0, "y"])).toBe("/x[0]/y");
  });

  it("percent-encodes structural chars inside a key", () => {
    expect(segsToStr(["@vitejs/plugin-react"])).toBe("/%40vitejs%2Fplugin-react");
  });

  it("parses encoded paths back to segments", () => {
    expect(strToSegs("/%40vitejs%2Fplugin-react")).toEqual(["@vitejs/plugin-react"]);
    expect(strToSegs("/x[0]/y")).toEqual(["x", 0, "y"]);
    expect(strToSegs("/")).toEqual([]);
  });

  it("round-trips keys with slashes, brackets, percents and indices", () => {
    const cases: Seg[][] = [["a/b", 2, "c"], ["[weird]"], ["%x"], ["a", 0, "b/c", 3]];
    for (const segs of cases) expect(strToSegs(segsToStr(segs))).toEqual(segs);
  });

  it("decodes malformed percent-escapes without throwing", () => {
    expect(strToSegs("/%zz")).toEqual(["%zz"]);
  });
});
