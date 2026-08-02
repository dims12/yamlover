// yed-sync — the IR tree diff → per-node /api/edit ops. Pure; documents come from parseSource,
// so each case is two readable yamlover texts and the ops between them.
import { describe, it, expect } from "vitest";
import { diffToOps } from "../src/client/renderers/yed-sync";
import { emptyDoc, parseSource } from "../../yed/src/state";

const diff = (prev: string, next: string) =>
  diffToOps(":doc", parseSource(prev), next === "" ? emptyDoc() : parseSource(next));

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
    expect(d.ops).toEqual([{ path: ":doc:1", op: "insert", yamlover: "9", key: "z" }]);
  });

  it("a keyless MIDDLE insert is ONE insert (head/tail trim), not a rewrite", () => {
    const d = diff("- one\n- three\n", "- one\n- two\n- three\n");
    expect(d.ops).toEqual([{ path: ":doc:1", op: "insert", yamlover: "two" }]);
  });

  it("multiple removals go LAST-FIRST so earlier addresses stay valid", () => {
    const d = diff("- a\n- b\n- c\n- d\n", "- a\n- d\n");
    expect(d.ops).toEqual([
      { path: ":doc:2", op: "remove" },
      { path: ":doc:1", op: "remove" },
    ]);
  });

  it("a PURE KEY RENAME is a rekey, not remove+insert", () => {
    const d = diff("key1: value1\nb: 2\n", "key2: value1\nb: 2\n");
    expect(d.ops).toEqual([]);
    expect(d.renames).toEqual([{ path: ":doc:key1", key: "key2" }]);
  });

  it("an INSERTED SUBTREE rides one insert with its serialized body", () => {
    const d = diff("a: 1\n", "a: 1\nkids:\n  - x\n  - y\n");
    expect(d.ops).toEqual([{ path: ":doc:1", op: "insert", yamlover: "- x\n- y", key: "kids" }]);
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

  it("a FLOW-rooted document emptied is the explicit root CLEAR (`emplace \"\"`)", () => {
    // the reported cycle: a JSON hierarchy unwound to nothing used to no-op silently — the
    // TOC kept the old tree and every later op mis-addressed the stale document
    const d = diff("{a: 1, b: [2, 3]}\n", "");
    expect(d.ops).toEqual([{ path: ":doc", op: "emplace", yamlover: "" }]);
    expect(d.fallback).toBe(false);
  });

  it("a BLOCK-rooted document emptied is targeted removes, last-first", () => {
    const d = diff("a: 1\nb: 2\n", "");
    expect(d.ops).toEqual([
      { path: ":doc:b", op: "remove" },
      { path: ":doc:a", op: "remove" },
    ]);
  });

  it("the inexpressible falls back to ONE whole-node emplace — the shrink-only ledger", () => {
    // moving an EXISTING self line to another row has no surgical op
    const d = diff("5\n- one\n", "- one\n5\n");
    expect(d.fallback).toBe(true);
    expect(d.ops).toEqual([{ path: ":doc", op: "emplace", yamlover: "- one\n5" }]);
  });
});

describe("diffToOps — tags and kind conversions (the chapter projection's verbs)", () => {
  it("a RETAG alone is one meta-only emplace", () => {
    const d = diff("a: !!<*yamlover: $defs: bullets>\n  - x\n", "a: !!<*yamlover: $defs: numbered>\n  - x\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", meta: "*yamlover: $defs: numbered" }]);
  });

  it("a tag DROP is `meta: null` — normal chapter is untagged", () => {
    const d = diff("a: !!<*yamlover: $defs: bullets>\n  - x\n", "a:\n  - x\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", meta: null }]);
  });

  it("a tag change LEADS the batch when content changes too", () => {
    const d = diff("a: !!<*yamlover: $defs: bullets>\n  - x\n", "a: !!<*yamlover: $defs: numbered>\n  - y\n");
    expect(d.ops).toEqual([
      { path: ":doc:a", op: "emplace", meta: "*yamlover: $defs: numbered" },
      { path: ":doc:a:0", op: "emplace", yamlover: "y" },
    ]);
  });

  it("LEAF → CONTAINER is one `replace` with the tag riding `meta` (the leaf promoteFormat)", () => {
    const d = diff("a: prose\n", "a: !!<*yamlover: $defs: bullets>\n  - prose\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "replace", yamlover: "- prose", meta: "*yamlover: $defs: bullets" }]);
  });

  it("CONTAINER → LEAF is one `replace` (facets drop with the structure)", () => {
    const d = diff("a: !!<*yamlover: $defs: bullets>\n  - one\n  - two\n", "a: prose\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "replace", yamlover: "prose" }]);
  });

  it("the OMNI↔mapping edge stays SURGICAL — not a conversion", () => {
    // demoting the self line (T-demote): drop it via '""', the entries stay untouched
    const d = diff("a:\n  Title\n  - p\n", "a:\n  - p\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: '""' }]);
  });

  it("an INSERTED subtree carries its inner tags inline in the payload", () => {
    const d = diff("a: 1\n", "a: 1\nkids: !!<*yamlover: $defs: bullets>\n  - x\n");
    expect(d.ops).toEqual([{ path: ":doc:1", op: "insert", yamlover: "!!<*yamlover: $defs: bullets>\n- x", key: "kids" }]);
  });

  it("a LEAF growing entries (scalar → omni) re-emplaces the WHOLE omni — never a descent into a scalar", () => {
    // the freshly wrapped title's first body commit in a FILE-concrete chapter (the legacy
    // commitSpine omniPending rule): the server holds a scalar entry at [1]
    const d = diff("- a\n- fresh\n", "- a\n- fresh\n  - ''\n");
    expect(d.ops).toEqual([{ path: ":doc:1", op: "emplace", yamlover: "fresh\n- ''" }]);
  });

  it("a STAMPED (tagless) format's drop still emits the meta-null emplace", () => {
    // the wire stamps `meta.derivedFormat` with no authored `!!<…>` in the model — the chapter's
    // "¶" must still drop the tag the FILE carries (the legacy forced-drop rule)
    const prev = parseSource("a:\n  - x\n");
    const next = parseSource("a:\n  - x\n");
    const node = (prev.root as { entries: { value: { meta?: object } }[] }).entries[0].value;
    node.meta = { ...(node.meta ?? {}), derivedFormat: "x-yamlover-bullets" };
    const d = diffToOps(":doc", prev, next);
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", meta: null }]);
  });
});

describe("diffToOps — identity marks (!!set / & anchors) and the emptied island", () => {
  it("an ANCHOR change re-emplaces the whole node — the payload carries the anchor line", () => {
    const d = diff("a: 1\n", "a: 1\n  &: p: q\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: "1\n&: p: q" }]);
  });

  it("an anchor REMOVAL is visible too — the payload without the line", () => {
    const d = diff("a: 1\n  &: p: q\n", "a: 1\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: "1" }]);
  });

  it("a whole-subtree rewrite of a node CONTAINING !!set keeps !!set in the payload", () => {
    // the inner set node rides the inserted subtree's payload text
    const d = diff("a: 1\n", "a: 1\nkids:\n  s: !!set\n    - x\n");
    expect(d.ops).toEqual([{ path: ":doc:1", op: "insert", yamlover: "s: !!set\n  - x", key: "kids" }]);
  });

  it("EMPTYING a tagged island emits entry removals only — never a meta:null tag delete", () => {
    // the editor's Backspace-to-empty keeps identity meta (keepIdentityMeta); the diff must
    // see an unchanged tag and remove only the entries
    const prev = parseSource("!!yo\na: 1\nb: 2\n");
    const emptied = parseSource("!!yo\na: 1\nb: 2\n");
    (emptied.root as { entries?: unknown[] }).entries = [];
    const d = diffToOps(":doc", prev, emptied);
    expect(d.ops).toEqual([
      { path: ":doc:b", op: "remove" },
      { path: ":doc:a", op: "remove" },
    ]);
  });
});
