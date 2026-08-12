// yed-sync — the IR tree diff → per-node /api/edit ops. Pure; documents come from parseSource,
// so each case is two readable yamlover texts and the ops between them.
import { describe, it, expect } from "vitest";
import { diffToOps, serverPathOf } from "../src/client/renderers/yed-sync";
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

describe("diffToOps — comment carriage is INVISIBLE to the sync", () => {
  it("a comment-only difference emits NOTHING", () => {
    // the same doc, one side carrying loaded comment meta (parseSource retains comments)
    const bare = parseSource("a: 1\nb: 2\n");
    const commented = parseSource("# banner\n\na: 1\t# note\n\n# about b\nb: 2\n");
    const d = diffToOps(":doc", bare, commented);
    expect(d.ops).toEqual([]);
    expect(d.renames).toEqual([]);
  });

  it("a payload crossing a commented region is byte-equal to the comment-free twin", () => {
    // a real edit next to comments: the subtree payload must not carry `#` lines (display-only)
    const prev = parseSource("kids:\n  # about x\n  x: 1\n  y: 2\n");
    const next = parseSource("kids:\n  # about x\n  x: 1\n  y: 2\n");
    // retype y's value through the commented tree
    ((next.root as { entries: { value: { entries: { value: { value: unknown; raw?: string } }[] } }[] }).entries[0].value.entries[1].value) = { kind: "scalar", value: 9, raw: "9" } as never;
    const d = diffToOps(":doc", prev, next);
    expect(d.ops).toEqual([{ path: ":doc:kids:y", op: "emplace", yamlover: "9" }]);
  });

  it("a FLOW container whose entries carry comment meta still emits the flow payload", () => {
    const prev = parseSource("a: [1, 2]\n");
    const next = parseSource("a: [1, 9]\n");
    // simulate loaded comment meta INSIDE the flow token (the flowTextOrNull refusal trap)
    const flowNode = (next.root as { entries: { value: { entries: { meta?: unknown }[]; meta?: Record<string, unknown> } }[] }).entries[0].value;
    flowNode.entries[0].meta = { comments: [{ text: "x", span: { uri: "<t>", start: 0, end: 0 }, placement: "leading", style: "line" }] };
    flowNode.meta = { ...(flowNode.meta ?? {}), comments: [{ text: "tail", span: { uri: "<t>", start: 0, end: 0 }, placement: "leading", style: "line" }] };
    const d = diffToOps(":doc", prev, next);
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: "[1, 9]" }]);
  });

  it("a BLOCK scalar body edit is one emplace whose payload keeps the authored header", () => {
    const d = diff("k: |\n  line one\n  line two\nm: 1\n", "k: |\n  line one\n  line 2!\nm: 1\n");
    expect(d.ops).toEqual([{ path: ":doc:k", op: "emplace", yamlover: "|\n  line one\n  line 2!" }]);
    const folded = diff("k: >\n  fold\n  these\n", "k: >\n  fold\n  those\n");
    expect(folded.ops).toEqual([{ path: ":doc:k", op: "emplace", yamlover: ">\n  fold\n  those" }]);
  });
});

describe("diffToOps — pointer payloads respell COMPACT (the isPointerValue wire gate)", () => {
  // the server routes single-line `*\S*` payloads around the document parser; a SPACED raw
  // (the sidecar's canonical `: pets: 1`) would fail that gate and 400 as a document parse
  it("a SPACED authored pointer emplaces compact", () => {
    const d = diff("a: 1\n", "a: *: pets: 1\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: "*:pets:1" }]);
  });

  it("a pointer INSERT rides compact too", () => {
    const d = diff("a: 1\n", "a: 1\nb: *pets: 1\n");
    expect(d.ops).toEqual([{ path: ":doc:1", op: "insert", yamlover: "*pets:1", key: "b" }]);
  });

  it("a ladder-0 relative pointer keeps its `..` steps, compact", () => {
    const d = diff("a: *x\n", "a: *..: x\n");
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: "*..:x" }]);
  });

  it("a raw-only DANGLING pointer that cannot parse passes verbatim", () => {
    // the yed-load catch branch keeps an unparsable spelling as {kind:"pointer", raw} —
    // the wire gets it verbatim (the same failure surface the legacy barePointer had)
    const prev = parseSource("a: *x\n");
    const next = parseSource("a: *x\n");
    (next.root as { entries: { value: unknown }[] }).entries[0].value = { kind: "pointer", raw: "::" } as never;
    const d = diffToOps(":doc", prev, next);
    expect(d.ops).toEqual([{ path: ":doc:a", op: "emplace", yamlover: "*::" }]);
  });
});

describe("serverPathOf — the cell's wire address matches the ops' addressing law", () => {
  it("keyed entries address by key, keyless by absolute index", () => {
    const doc = parseSource("a:\n  b: 1\nlist:\n  - x\n  - y\n");
    expect(serverPathOf(":doc", doc, [])).toBe(":doc");
    expect(serverPathOf(":doc", doc, [0, 0])).toBe(":doc:a:b");
    expect(serverPathOf(":doc", doc, [1, 1])).toBe(":doc:list:1");
  });

  it("an anchored positional member addresses by its derived anchor key", () => {
    const doc = parseSource("- x\n- y\n");
    (doc.root as { entries: { meta?: object }[] }).entries[1].meta = { anchorKey: "why" };
    expect(serverPathOf(":doc", doc, [1])).toBe(":doc:why");
  });

  it("throws outside the document — a caller bug, never a silent mis-address", () => {
    const doc = parseSource("a: 1\n");
    expect(() => serverPathOf(":doc", doc, [5])).toThrow();
  });

  it("a positional address counts only FLUSHED rows — temporary siblings are invisible to the wire", () => {
    const doc = parseSource("- x\n- y\n");
    const entries = (doc.root as { entries: { meta?: object }[] }).entries;
    entries.splice(1, 0, { ...(entries[0] as object), meta: { temporary: "ordinal" } } as never);
    // local rows: [x, TEMP, y] — y's wire ordinal is still 1
    expect(serverPathOf(":doc", doc, [2])).toBe(":doc:1");
  });
});

describe("the TEMPORARY gate (template-cells) — a provisional row never reaches the wire", () => {
  const markTemp = (doc: ReturnType<typeof parseSource>, idx: number, flag: true | "ordinal" = true) => {
    const entries = (doc.root as { entries: { meta?: object; value?: unknown }[] }).entries;
    entries[idx].meta = { ...(entries[idx].meta ?? {}), temporary: flag };
    entries[idx].value = { kind: "scalar", value: null };
    return doc;
  };

  it("a temporary entry in NEXT produces zero ops (the mid-typing flush is silent)", () => {
    const prev = parseSource("a: 1\n");
    const next = markTemp(parseSource("a: 1\nb: 2\n"), 1);
    const d = diffToOps(":doc", prev, next);
    expect(d.ops).toEqual([]);
    expect(d.fallback).toBe(false);
  });

  it("a temporary entry in PREV diffs as the plain insert its commit always was", () => {
    // the row was withheld while provisional; its value commit cleared the flag — the diff
    // sees exactly the insert the old flow produced (never a null-valued splice)
    const prev = markTemp(parseSource("a: 1\nb: 2\n"), 1);
    const next = parseSource("a: 1\nb: 2\n");
    const d = diffToOps(":doc", prev, next);
    expect(d.ops).toEqual([{ path: ":doc:1", op: "insert", yamlover: "2", key: "b" }]);
  });

  it("an ordinal temporary (`- `) is withheld the same way", () => {
    const prev = parseSource("- x\n");
    const next = markTemp(parseSource("- x\n- y\n"), 1, "ordinal");
    expect(diffToOps(":doc", prev, next).ops).toEqual([]);
  });
});
