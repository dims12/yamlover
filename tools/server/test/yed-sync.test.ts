// yed-sync — the IR tree diff → per-node /api/edit ops. Pure; documents come from parseSource,
// so each case is two readable yamlover texts and the ops between them.
import { describe, it, expect } from "vitest";
import { diffToOps } from "../src/client/renderers/yed-sync";
import { parseSource } from "../../yed/src/state";

const diff = (prev: string, next: string) => diffToOps(":doc", parseSource(prev), parseSource(next));

describe("diffToOps — targeted, order-safe, concrete-blind", () => {
  it("a scalar VALUE change is one emplace at its keyed path", () => {
    const d = diff("a: 1\nb: 2\n", "a: 5\nb: 2\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: "5" }]);
    expect(d.fallback).toBe(false);
  });

  it("a DEEP change addresses through the keys", () => {
    const d = diff("a:\n  b: 1\n", "a:\n  b: 9\n");
    expect(d.ops).toEqual([{ path: ":doc:a:b", op: "emplace", yamlover: "9" }]);
  });

  it("a new KEYED entry is one insert with `key` at its absolute row", () => {
    const d = diff("a: 1\n", "a: 1\nz: 9\n");
    expect(d.ops).toEqual([{ path: ":doc[1]", op: "insert", yamlover: "9", key: "z" }]);
  });

  it("a keyless MIDDLE insert is ONE insert (head/tail trim), not a rewrite", () => {
    const d = diff("- one\n- three\n", "- one\n- two\n- three\n");
    expect(d.ops).toEqual([{ path: ":doc[1]", op: "insert", yamlover: "two" }]);
  });

  it("multiple removals go LAST-FIRST so earlier addresses stay valid", () => {
    const d = diff("- a\n- b\n- c\n- d\n", "- a\n- d\n");
    expect(d.ops).toEqual([
      { path: ":doc[2]", op: "remove" },
      { path: ":doc[1]", op: "remove" },
    ]);
  });

  it("a PURE KEY RENAME is a rekey, not remove+insert", () => {
    const d = diff("key1: value1\nb: 2\n", "key2: value1\nb: 2\n");
    expect(d.ops).toEqual([]);
    expect(d.renames).toEqual([{ path: ":doc:key1", key: "key2" }]);
  });

  it("an INSERTED SUBTREE rides one insert with its serialized body", () => {
    const d = diff("a: 1\n", "a: 1\nkids:\n  - x\n  - y\n");
    expect(d.ops).toEqual([{ path: ":doc[1]", op: "insert", yamlover: "- x\n- y", key: "kids" }]);
  });

  it("a change INSIDE a flow token is ONE whole-token emplace at the token", () => {
    const d = diff("a: [1, 2]\n", "a: [1, 9]\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: "[1, 9]" }]);
  });

  it("a SPREAD toggle is a whole-token emplace whose text carries the layout", () => {
    const d = diff("a: [1, 2]\n", "a: [\n  1,\n  2\n]\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: "[\n  1,\n  2\n]" }]);
  });

  it("an OMNI self-value change emplaces at the node's OWN path", () => {
    const d = diff("5\n- one\n", "6\n- one\n");
    expect(d.ops).toEqual([{ path: ":doc", op: "emplace", yamlover: "6" }]);
  });

  it("a FRESH self value at a later row carries `at`", () => {
    const d = diff("- one\n- two\n", "- one\n- two\nscalar\n");
    expect(d.ops).toEqual([{ path: ":doc", op: "emplace", yamlover: "scalar", at: 2 }]);
  });

  it("no change, no ops", () => {
    const d = diff("a: 1\n# c\nb: 2\n", "a: 1\n# c\nb: 2\n");
    expect(d.ops).toEqual([]);
    expect(d.renames).toEqual([]);
  });

  it("the inexpressible falls back to ONE whole-node emplace — the shrink-only ledger", () => {
    // moving an EXISTING self line to another row has no surgical op
    const d = diff("5\n- one\n", "- one\n5\n");
    expect(d.fallback).toBe(true);
    expect(d.ops).toEqual([{ path: ":doc", op: "emplace", yamlover: "- one\n5" }]);
  });
});
