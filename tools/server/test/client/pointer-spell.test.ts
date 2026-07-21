// Path ⇄ pointer spelling for the pick hosts (pointer-spell.ts): a picked TOC path spelled
// as a pointer raw in the chosen scope, and a committed raw read back into cells + ladder.
import { describe, it, expect } from "vitest";
import { pointerCells, spellCells, spellPointer } from "../../src/client/pointer-spell";

describe("spellPointer — ladder 0 (current scope, relative to the holder)", () => {
  it("a sibling is a plain key; a descendant chains", () => {
    expect(spellPointer(":a:c", ":a", 0)).toBe("c");
    expect(spellPointer(":a:c:d", ":a", 0)).toBe("c: d");
  });

  it("climbs with .. — one per remaining holder level", () => {
    expect(spellPointer(":x", ":a", 0)).toBe("..: x");
    expect(spellPointer(":x:y", ":a:b", 0)).toBe("..: ..: x: y");
  });

  it("the shared prefix drops before climbing", () => {
    // holder :team:alice, target :team:bob:age — up ONE level (out of alice), then bob: age
    expect(spellPointer(":team:bob:age", ":team:alice", 0)).toBe("..: bob: age");
  });

  it("indices fold onto their portion; an ordinal sibling rides the climb", () => {
    expect(spellPointer(":a:b[0]", ":a", 0)).toBe("b[0]");
    expect(spellPointer(":a[3]", ":a:b", 0)).toBe("..: [3]");
  });

  it("the holder itself spells via its parent; the root falls back to the document root", () => {
    expect(spellPointer(":a:b", ":a:b", 0)).toBe("..: b");
    expect(spellPointer(":", ":", 0)).toBe(":");
  });

  it("keys are percent-DECODED from the client path, then pointer-escaped", () => {
    // `/` left the metachar set (SEPARATOR.md §3) — a decoded slashy key rides bare
    expect(spellPointer(":pkgs:%40vitejs%2Fplugin-react", ":pkgs", 0)).toBe("@vitejs/plugin-react");
    expect(spellPointer(":a:has%20space", ":a", 0)).toBe("'has space'");
  });
});

describe("spellPointer — rooted ladders", () => {
  it("ladder 1 spells the document-rooted path", () => {
    expect(spellPointer(":a:b[0]", ":whatever", 1)).toBe(": a: b[0]");
    expect(spellPointer(":", ":a", 1)).toBe(":");
  });

  it("ladder 1 is relative to the DOCUMENT root, not the served root", () => {
    // the pointer lives in the :doc document — `*: pets[1]` must reach :doc:pets[1]
    expect(spellPointer(":doc:pets[1]", ":doc", 1, ":doc")).toBe(": pets[1]");
    // a pick OUTSIDE the document cannot be `:`-spelled — escalates to the project scope
    expect(spellPointer(":other:x", ":doc", 1, ":doc")).toBe(":: other: x");
  });

  it("ladder 2 spells the project scope (first portion = the root child)", () => {
    expect(spellPointer(":tags:colors:yellow", ":", 2)).toBe(":: tags: colors: yellow");
  });

  it("ladder 2 on the root itself falls back to the document root (:: needs a portion)", () => {
    expect(spellPointer(":", ":a", 2)).toBe(":");
  });
});

describe("pointerCells — a committed raw back into cells", () => {
  it("reads every rung of the ladder", () => {
    expect(pointerCells("c")).toEqual({ ladder: 0, portions: ["c"] });
    expect(pointerCells("..: x")).toEqual({ ladder: 0, portions: ["..", "x"] });
    expect(pointerCells(": a: b[0]")).toEqual({ ladder: 1, portions: ["a", "b[0]"] });
    expect(pointerCells(":: tags: colors")).toEqual({ ladder: 2, portions: ["tags", "colors"] });
    expect(pointerCells("::: yamlover.inthemoon.net: $defs: tag")).toEqual({
      ladder: 3,
      portions: ["yamlover.inthemoon.net", "$defs", "tag"],
    });
  });

  it("indices fold onto the preceding cell, but never onto a ..", () => {
    expect(pointerCells(": pets[1]: name")).toEqual({ ladder: 1, portions: ["pets[1]", "name"] });
    expect(pointerCells("..: [3]")).toEqual({ ladder: 0, portions: ["..", "[3]"] });
  });

  it("an empty raw is an empty cell row; an unparsable raw degrades tolerantly", () => {
    expect(pointerCells("")).toEqual({ ladder: 0, portions: [] });
    // a space in a bare portion is a pointer parse error — the fallback keeps the text editable
    expect(pointerCells(": >10 x")).toEqual({ ladder: 1, portions: [">10 x"] });
  });

  it("round-trips spellPointer output", () => {
    expect(pointerCells(spellPointer(":team:bob:age", ":team:alice", 0))).toEqual({
      ladder: 0,
      portions: ["..", "bob", "age"],
    });
  });
});

describe("spellCells", () => {
  it("reduces a picked path to the machine's spell shape, re-deriving the actual ladder", () => {
    expect(spellCells(":tags:colors:yellow", ":", 2)).toEqual({ ladder: 2, portions: ["tags", "colors", "yellow"] });
    expect(spellCells(":a:c", ":a", 0)).toEqual({ ladder: 0, portions: ["c"] });
    // the root has no `::` spelling — the returned ladder says what was actually spelled
    expect(spellCells(":", ":a", 2)).toEqual({ ladder: 1, portions: [] });
  });
});
