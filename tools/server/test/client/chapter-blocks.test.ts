import { describe, it, expect } from "vitest";
import { buildModel, type MNode } from "../../src/client/renderers/yamlover-editor/model";
import {
  commitProse, joinProse, promoteFormat, proseScalar, splitProse, tabEdits,
} from "../../src/client/renderers/chapter-editor/blocks";
import type { NodeJson } from "../../src/client/api";

// A chapter model, built from the wire projection exactly as the editor host builds it.
const mixed = (o: Record<string, unknown>) => ({ $yamloverMixed: { kind: "mix", entries: [], ...o } });
const tagged = (format: string, entries: unknown[]) => mixed({ kind: "array", format, entries: entries.map((value) => ({ key: null, value })) });

function chapterModel(body: unknown[], rootTag = "!!<*yamlover: $defs: chapter>"): MNode {
  const node: NodeJson = {
    path: ":doc", type: "object", concrete: "dir/yamlover", title: null, description: null,
    value: mixed({ kind: "omni", value: "T", selfAt: 0, format: "x-yamlover-chapter", entries: body.map((value) => ({ key: null, value })) }),
    comments: { "": { tag: rootTag } },
  } as unknown as NodeJson;
  return buildModel(node);
}

const entryAt = (root: MNode, ...ix: number[]): string => {
  let node = root, id = "";
  for (const i of ix) { id = node.entries[i].id; node = node.entries[i].node; }
  return id;
};
const nodeAt = (root: MNode, ...ix: number[]): MNode => ix.reduce((n, i) => n.entries[i].node, root);

describe("proseScalar — representation", () => {
  it("keeps a one-line bare text bare", () => {
    expect(proseScalar("hello world")).toEqual({ src: "hello world", value: "hello world" });
  });
  it("blocks a multi-line text", () => {
    const s = proseScalar("one\ntwo");
    expect(s.block).toBe(true);
    expect(s.value).toBe("one\ntwo");
    expect(s.src.startsWith("|")).toBe(true);
  });
  it("QUOTES a one-liner that would reparse as structure (a block reads badly for one line)", () => {
    const s = proseScalar("key: value"); // a bare `key: value` is a mapping, not prose
    expect(s.block).toBeUndefined();
    expect(s.src).toBe('"key: value"');
    expect(s.value).toBe("key: value");
  });
});

describe("commitProse", () => {
  it("emplaces a paragraph's new text at its own path, keeping it bare", () => {
    const root = chapterModel(["alpha", "beta"]);
    const edits = commitProse(":doc", root, nodeAt(root, 0).id, "ALPHA");
    expect(edits).toEqual([{ path: ":doc[0]", op: "emplace", yamlover: "ALPHA" }]);
  });
});

describe("splitProse — Enter makes a sibling", () => {
  it("the head stays, the tail becomes a new committed sibling after it", () => {
    const root = chapterModel(["hello world", "next"]);
    const out = splitProse(":doc", root, entryAt(root, 0), "hello", "world")!;
    expect(out.edits).toEqual([
      { path: ":doc[0]", op: "emplace", yamlover: "hello" },
      { path: ":doc[1]", op: "insert", yamlover: "world" },
    ]);
    // the model now has three body entries, the caret on the new one
    expect(root.entries.map((e) => String(e.node.scalar?.value))).toEqual(["hello", "world", "next"]);
    expect(out.focusId).toBe(root.entries[1].node.id);
  });
});

describe("joinProse — Backspace/Delete merges paragraphs", () => {
  const editable = (n: MNode) => n.kind === "scalar";

  it("Backspace at the start pulls the paragraph into the previous, caret at the junction", () => {
    const root = chapterModel(["hello", "world"]);
    const out = joinProse(":doc", root, entryAt(root, 1), "prev", editable)!;
    expect(out.edits).toEqual([
      { path: ":doc[1]", op: "remove" },
      { path: ":doc[0]", op: "emplace", yamlover: "helloworld" },
    ]);
    expect(out.caret).toBe(5); // where "hello" ended
    expect(out.focusId).toBe(root.entries[0].node.id);
    expect(root.entries).toHaveLength(1);
  });

  it("Delete at the end pulls in the next", () => {
    const root = chapterModel(["hello", "world"]);
    const out = joinProse(":doc", root, entryAt(root, 0), "next", editable)!;
    expect(out.edits[0]).toEqual({ path: ":doc[1]", op: "remove" });
    expect(out.edits[1]).toEqual({ path: ":doc[0]", op: "emplace", yamlover: "helloworld" });
  });

  it("refuses to merge across a non-editable block", () => {
    const root = chapterModel(["prose", tagged("x-yamlover-table", [])]);
    expect(joinProse(":doc", root, entryAt(root, 1), "prev", editable)).toBeNull();
  });
});

describe("tabEdits — the dispatch", () => {
  it("in a chapter, Tab indents and Shift-Tab dedents", () => {
    const root = chapterModel(["a", "b"]);
    const tab = tabEdits(":doc", root, entryAt(root, 1), false);
    expect(tab.intent.kind).toBe("indent");
    // b became a's child — a is now an omni container
    expect(nodeAt(root, 0).kind).toBe("container");
    expect(String(nodeAt(root, 0).selfValue?.value)).toBe("a");
  });

  it("in a table, Tab is a caret move to the next cell — no ops", () => {
    const root = chapterModel([tagged("x-yamlover-table", [tagged("", ["c0", "c1"])])]);
    // the row is an untagged container; build it via a plain nested array instead
    const table = chapterModel([
      { $yamloverMixed: { kind: "mix", format: "x-yamlover-table", entries: [
        { key: null, value: { $yamloverMixed: { kind: "array", entries: [{ key: null, value: "c0" }, { key: null, value: "c1" }] } } },
      ] } },
    ]);
    const firstCell = entryAt(table, 0, 0, 0);
    const tab = tabEdits(":doc", table, firstCell, false);
    expect(tab.intent).toEqual({ kind: "cell", entryId: entryAt(table, 0, 0, 1) });
    expect(tab.edits).toEqual([]);
    void root;
  });

  it("at the last cell of the last row, Tab appends a row", () => {
    const table = chapterModel([
      { $yamloverMixed: { kind: "mix", format: "x-yamlover-table", entries: [
        { key: null, value: { $yamloverMixed: { kind: "array", entries: [{ key: null, value: "c0" }, { key: null, value: "c1" }] } } },
      ] } },
    ]);
    const lastCell = entryAt(table, 0, 0, 1);
    const tab = tabEdits(":doc", table, lastCell, false);
    expect(tab.intent.kind).toBe("appendRow");
    expect(tab.edits).toHaveLength(1);
    expect(tab.edits[0].op).toBe("insert");
    expect(tab.edits[0].path).toBe(":doc[0][1]"); // the new row at row index 1 of the table
    expect(tab.edits[0].yamlover).toContain('- ""'); // two empty cells
  });
});

describe("promoteFormat", () => {
  it("a leaf → bullets is a REPLACE wrapping the prose as the one item", () => {
    const root = chapterModel(["shopping"]);
    const edits = promoteFormat(":doc", root, nodeAt(root, 0).id, "bullets", "*yamlover: $defs: chapter");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ path: ":doc[0]", op: "replace", meta: "*yamlover: $defs: bullets" });
    expect(edits[0].yamlover).toContain("shopping");
    expect(nodeAt(root, 0).kind).toBe("container"); // the model reflects it
  });

  it("a container → numbered is a meta-only emplace", () => {
    const root = chapterModel([tagged("x-yamlover-bullets", ["one", "two"])]);
    const edits = promoteFormat(":doc", root, nodeAt(root, 0).id, "numbered", "*yamlover: $defs: chapter");
    expect(edits).toEqual([{ path: ":doc[0]", op: "emplace", meta: "*yamlover: $defs: numbered" }]);
  });

  it("→ chapter DROPS the tag (untagged ≡ a subchapter), even from a stamped-only format", () => {
    // a stamped tagged format with no `!!<…>` in the sidecar still has a tag ON DISK to drop
    const root = chapterModel([tagged("x-yamlover-bullets", ["one"])]);
    const edits = promoteFormat(":doc", root, nodeAt(root, 0).id, "chapter", "*yamlover: $defs: chapter");
    expect(edits).toEqual([{ path: ":doc[0]", op: "emplace", meta: null }]);
  });

  it("the tag inherits the document's own scope spelling", () => {
    const root = chapterModel([tagged("x-yamlover-bullets", ["one"])], "!!<*:: yamlover: $defs: chapter>");
    const edits = promoteFormat(":doc", root, nodeAt(root, 0).id, "table", "*:: yamlover: $defs: chapter");
    expect(edits[0].meta).toBe("*:: yamlover: $defs: table");
  });
});
