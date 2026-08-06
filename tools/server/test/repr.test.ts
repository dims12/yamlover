// repr.ts — the pure representation axis (no I/O). The table below IS docs/language/concretes/04-yaml: every row of every vocabulary sub-table gets a case, so the doc and the code
// cannot drift apart silently.
import { describe, it, expect } from "vitest";
import { classifyScalar, collectionRepr, defaultRepr, isDefaultRepr, isFlowRepr, type ScalarRepr } from "../src/repr";

/** value + authored token → the concrete it classifies as. */
const cases: [unknown, string | null | undefined, ScalarRepr][] = [
  // --- string styles (docs/language/concretes/04-yaml) --------------------------------
  ["Rex", "Rex", "yaml/plain"],
  ["Rex", "'Rex'", "yaml/single"],
  ["a\tb", '"a\\tb"', "yaml/double"],
  ["line\n", "|\n  line", "yaml/literal"],
  ["line ", ">\n  line", "yaml/folded"],
  // --- null notations --------------------------------------------
  [null, "~", "yaml/tilde"],
  [null, "null", "yaml/null"],
  [null, "Null", "yaml/null"],
  [null, "NULL", "yaml/null"],
  [null, "", "yaml/empty"],
  // --- boolean notations -----------------------------------------
  [true, "true", "yaml/bool"],
  [false, "False", "yaml/bool"],
  [true, "TRUE", "yaml/bool"],
  [true, "yes", "yaml/bool11"],
  [false, "no", "yaml/bool11"],
  [true, "on", "yaml/bool11"],
  [false, "off", "yaml/bool11"],
  // --- integer notations — all 255 -------------------------------
  [255, "255", "yaml/dec"],
  [255, "0xff", "yaml/hex"],
  [255, "0xFF", "yaml/hex"],
  [255, "0o377", "yaml/oct"],
  // NOT octal: the core schema reads a leading zero as decimal (377, not 255), and docs/language/concretes/04-yaml keeps leading zeros in `raw` rather than giving them a concrete of their own
  [377, "0377", "yaml/dec"],
  [255, "0b11111111", "yaml/bin"],
  [-255, "-0xff", "yaml/hex"], // a sign never changes the base
  // --- float notations -------------------------------------------
  [3.14, "3.14", "yaml/float"],
  [6.022e23, "6.022e23", "yaml/exp"],
  [1, "1.0", "yaml/float"], // the VALUE is the integer 1 — only the token says it is a float
  [Infinity, ".inf", "yaml/inf"],
  [-Infinity, "-.inf", "yaml/inf"],
  [NaN, ".nan", "yaml/nan"],
];

describe("classifyScalar — the docs/language/concretes vocabulary, row by row", () => {
  for (const [value, raw, want] of cases) {
    it(`${JSON.stringify(raw)} (${String(value)}) → ${want}`, () => {
      expect(classifyScalar(value, raw).repr).toBe(want);
    });
  }
});

describe("block qualifiers — chomping and the indent indicator, in either order", () => {
  const q = (raw: string) => classifyScalar("x", raw).block;
  it("clip is the default and is NOT recorded", () => {
    expect(q("|\n  x")).toBeUndefined();
    expect(q(">\n  x")).toBeUndefined();
  });
  it("records strip and keep", () => {
    expect(q("|-\n  x")).toEqual({ chomp: "strip" });
    expect(q("|+\n  x")).toEqual({ chomp: "keep" });
    expect(q(">-\n  x")).toEqual({ chomp: "strip" });
  });
  it("records an explicit indent, with chomping in either order", () => {
    expect(q("|2\n  x")).toEqual({ indent: 2 });
    expect(q("|2-\n  x")).toEqual({ chomp: "strip", indent: 2 });
    expect(q(">-2\n  x")).toEqual({ chomp: "strip", indent: 2 });
  });
  it("keeps the style itself alongside the qualifiers", () => {
    expect(classifyScalar("x", "|+2\n  x")).toEqual({ repr: "yaml/literal", block: { chomp: "keep", indent: 2 } });
  });
});

describe("defaultRepr — what an absent `raw` means", () => {
  it("is the canonical spelling per value type", () => {
    expect(defaultRepr("Rex")).toBe("yaml/plain");
    expect(defaultRepr(null)).toBe("yaml/null");
    expect(defaultRepr(true)).toBe("yaml/bool");
    expect(defaultRepr(255)).toBe("yaml/dec");
    expect(defaultRepr(3.14)).toBe("yaml/float");
    expect(defaultRepr(Infinity)).toBe("yaml/inf");
    expect(defaultRepr(NaN)).toBe("yaml/nan");
  });

  it("an absent raw classifies as the default — the wire omits exactly these", () => {
    // the wire carries `raw` only when it differs from the canonical rendering (scalarRawToken),
    // so "no raw" and "the default repr" have to be the same statement
    for (const v of ["Rex", null, true, false, 255, -3.5, 3.14]) {
      expect(classifyScalar(v).repr, String(v)).toBe(defaultRepr(v));
      expect(classifyScalar(v, undefined).repr, String(v)).toBe(defaultRepr(v));
    }
  });

  it("a raw EQUAL to the canonical spelling classifies as the default too", () => {
    expect(classifyScalar(255, "255").repr).toBe(defaultRepr(255));
    expect(classifyScalar(true, "true").repr).toBe(defaultRepr(true));
    expect(classifyScalar(null, "null").repr).toBe(defaultRepr(null));
  });

  it("isDefaultRepr gates what is worth sending", () => {
    expect(isDefaultRepr("yaml/dec", 255)).toBe(true);
    expect(isDefaultRepr("yaml/hex", 255)).toBe(false);
    expect(isDefaultRepr("yaml/plain", "Rex")).toBe(true);
    expect(isDefaultRepr("yaml/single", "Rex")).toBe(false);
    expect(isDefaultRepr("yaml/block")).toBe(true); // the collection default
    expect(isDefaultRepr("yaml/flow")).toBe(false);
  });
});

describe("collectionRepr — the collection half of the axis", () => {
  it("an AUTHORED flow bit wins in any language", () => {
    expect(collectionRepr("flow", "yamlover")).toBe("yaml/flow");
    expect(collectionRepr("flow", "yaml")).toBe("yaml/flow");
    expect(collectionRepr("flow", null)).toBe("yaml/flow");
  });

  it("block is the default for a block-structured language", () => {
    for (const c of ["yamlover", "yaml", "file/yamlover", "file/yaml", "dir/.yo", null, undefined]) {
      expect(collectionRepr(undefined, c), String(c)).toBe("yaml/block");
    }
  });

  it("a json-family document is flow END TO END — no per-node marker needed", () => {
    // which is why the parser must NOT set the bit in json5p: the language already says it
    for (const c of ["json", "json5", "json5p", "file/json", "file/json5p"]) {
      expect(collectionRepr(undefined, c), c).toBe("yaml/flow");
    }
  });

  it("isFlowRepr narrows", () => {
    expect(isFlowRepr("yaml/flow")).toBe(true);
    expect(isFlowRepr("yaml/block")).toBe(false);
    expect(isFlowRepr(undefined)).toBe(false);
    expect(isFlowRepr(null)).toBe(false);
  });
});
