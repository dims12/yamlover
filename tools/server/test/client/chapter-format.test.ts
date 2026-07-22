import { describe, it, expect } from "vitest";
import { buildModel } from "../../src/client/renderers/yamlover-editor/model";
import type { MNode } from "../../src/client/renderers/yamlover-editor/model";
import {
  enclosingFormat, formatFromMetaTag, formatOfNode, schemaNameOfTag, tagFor,
} from "../../src/client/renderers/chapter-editor/format";
import { formatTarget, isTableCell, resolveTab } from "../../src/client/renderers/chapter-editor/tab";
import type { NodeJson } from "../../src/client/api";

// ---------------------------------------------------------------------------------------------
// Fixtures: a model is built from the wire projection, so these are the shapes the server sends.
// ---------------------------------------------------------------------------------------------

const mixed = (o: Record<string, unknown>) => ({ $yamloverMixed: { kind: "mix", entries: [], ...o } });
/** A container body element carrying a stamped format (what a tagged table/list arrives as). */
const tagged = (format: string, entries: unknown[]) => mixed({ kind: "array", format, entries: entries.map((value) => ({ key: null, value })) });
/** An untagged container body element — a subchapter, or a table row. */
const plain = (entries: unknown[]) => mixed({ kind: "array", entries: entries.map((value) => ({ key: null, value })) });

/** A chapter document whose body is `body`, with an optional root `!!<…>` tag in the sidecar. */
function doc(body: unknown[], rootTag = "!!<*yamlover: $defs: chapter>"): NodeJson {
  return {
    path: ":doc", type: "object", concrete: "dir/yamlover", title: null, description: null,
    value: mixed({ kind: "omni", value: "T", selfAt: 0, format: "x-yamlover-chapter", entries: body.map((value) => ({ key: null, value })) }),
    comments: { "": { tag: rootTag } },
  } as unknown as NodeJson;
}

/** The entry id at `path` (a chain of entry indices) under `root`. */
function entryAt(root: MNode, ...indices: number[]): string {
  let node = root;
  let id = "";
  for (const i of indices) { const e = node.entries[i]; id = e.id; node = e.node; }
  return id;
}
const nodeAt = (root: MNode, ...indices: number[]): MNode => indices.reduce((n, i) => n.entries[i].node, root);

describe("schemaNameOfTag / formatFromMetaTag — every spelling the corpus uses", () => {
  it("reads the `$defs` name from colon, ladder, and slash forms", () => {
    expect(schemaNameOfTag("*yamlover: $defs: table")).toBe("table");
    expect(schemaNameOfTag("*:: yamlover: $defs: bullets")).toBe("bullets");
    expect(schemaNameOfTag("*yamlover/$defs/numbered")).toBe("numbered");
  });

  it("is null for a tag that names no `$defs`", () => {
    expect(schemaNameOfTag("format: text/x-latex")).toBeNull();
    expect(schemaNameOfTag(null)).toBeNull();
    expect(schemaNameOfTag(undefined)).toBeNull();
  });

  it("renders the format the server would derive", () => {
    expect(formatFromMetaTag("*yamlover: $defs: table")).toBe("x-yamlover-table");
    expect(formatFromMetaTag("format: text/x-latex")).toBeNull();
  });
});

describe("formatOfNode — what a block IS", () => {
  const root = buildModel(doc([
    "a paragraph",
    plain(["a subchapter chunk"]),
    tagged("x-yamlover-table", [plain(["a", "b"])]),
    tagged("x-yamlover-bullets", ["one", "two"]),
    tagged("x-yamlover-numbered", ["one"]),
  ]));

  it("a leaf is a chunk; an untagged container is a chapter", () => {
    expect(formatOfNode(nodeAt(root, 0))).toBe("chunk");
    expect(formatOfNode(nodeAt(root, 1))).toBe("chapter");
  });

  it("a tagged container is what its tag says", () => {
    expect(formatOfNode(nodeAt(root, 2))).toBe("table");
    expect(formatOfNode(nodeAt(root, 3))).toBe("bullets");
    expect(formatOfNode(nodeAt(root, 4))).toBe("numbered");
  });

  it("a task reads as a chapter — it hosts subtasks the same way", () => {
    const task = { ...nodeAt(root, 1), format: "x-yamlover-task" };
    expect(formatOfNode(task)).toBe("chapter");
  });

  it("the metaTag WINS over a stale stamped format (the user just retagged)", () => {
    const retagged: MNode = { ...nodeAt(root, 3), metaTag: "*yamlover: $defs: numbered" };
    expect(retagged.format).toBe("x-yamlover-bullets"); // the stamp still says the old thing
    expect(formatOfNode(retagged)).toBe("numbered");
  });
});

describe("enclosingFormat — what decides TAB", () => {
  //  [0] a paragraph
  //  [1] a subchapter        → [0] its own paragraph
  //  [2] a bullets list      → [0] an item, [1] an item → [0] a sub-item
  //  [3] a table             → [0] a row → [0] a cell → [0] a deep container (chapter again)
  const root = buildModel(doc([
    "a paragraph",
    plain(["nested prose"]),
    tagged("x-yamlover-bullets", ["one", plain(["sub item"])]),
    tagged("x-yamlover-table", [plain(["cell a", plain([plain(["deep"])])])]),
  ]));

  it("a top-level paragraph and a subchapter's paragraph are both in a chapter", () => {
    expect(enclosingFormat(root, entryAt(root, 0))).toBe("chapter");
    expect(enclosingFormat(root, entryAt(root, 1, 0))).toBe("chapter");
  });

  it("a list item is in its list, and a SUBLIST item is in the same kind at any depth", () => {
    expect(enclosingFormat(root, entryAt(root, 2, 0))).toBe("bullets");
    expect(enclosingFormat(root, entryAt(root, 2, 1, 0))).toBe("bullets");
  });

  it("a ROW is in the table; a CELL is in a row — the two-level rule", () => {
    expect(enclosingFormat(root, entryAt(root, 3, 0))).toBe("row");
    expect(enclosingFormat(root, entryAt(root, 3, 0, 0))).toBe("row-cell");
  });

  it("a container BELOW a cell switches back to chapter rules ($defs/table is two deep)", () => {
    expect(enclosingFormat(root, entryAt(root, 3, 0, 1, 0))).toBe("chapter");
  });

  it("an unknown entry falls back to chapter rather than throwing", () => {
    expect(enclosingFormat(root, "nope")).toBe("chapter");
  });

  // The inheritance COMPOUNDS — resolving only against the immediate parent gets level one right
  // and every level after it wrong, which is what makes this a fold over the whole chain.
  it("a sublist stays a list four levels down, and an explicit tag switches mid-chain", () => {
    const deep = buildModel(doc([
      tagged("x-yamlover-numbered", [plain([plain([plain(["deep item"])])])]),
      tagged("x-yamlover-bullets", [plain([tagged("x-yamlover-numbered", ["switched"])])]),
    ]));
    expect(enclosingFormat(deep, entryAt(deep, 0, 0, 0, 0))).toBe("numbered");
    // a tag mid-chain switches the kind from there down
    expect(enclosingFormat(deep, entryAt(deep, 1, 0, 0, 0))).toBe("numbered");
    expect(enclosingFormat(deep, entryAt(deep, 1, 0, 0))).toBe("bullets"); // still the outer list
  });

  it("a table nested inside a list still gets rows and cells", () => {
    const nested = buildModel(doc([
      tagged("x-yamlover-bullets", [plain([tagged("x-yamlover-table", [plain(["c0", "c1"])])])]),
    ]));
    expect(enclosingFormat(nested, entryAt(nested, 0, 0, 0, 0))).toBe("row");
    expect(enclosingFormat(nested, entryAt(nested, 0, 0, 0, 0, 0))).toBe("row-cell");
  });
});

describe("tagFor — a document keeps its own spelling", () => {
  it("swaps the `$defs` name, keeping the scope the document already uses", () => {
    expect(tagFor("*yamlover: $defs: chapter", "table")).toBe("*yamlover: $defs: table");
    expect(tagFor("*:: yamlover: $defs: chapter", "bullets")).toBe("*:: yamlover: $defs: bullets");
    expect(tagFor("*yamlover/$defs/chapter", "numbered")).toBe("*yamlover/$defs/numbered");
  });

  it("falls back to the project ladder when the document is untagged or tagged otherwise", () => {
    expect(tagFor(null, "table")).toBe("*:: yamlover: $defs: table");
    expect(tagFor("format: text/x-latex", "bullets")).toBe("*:: yamlover: $defs: bullets");
  });
});

describe("resolveTab — the truth table", () => {
  const root = buildModel(doc([
    "para one",                                              // [0]
    "para two",                                              // [1]
    tagged("x-yamlover-bullets", ["item one", "item two"]),  // [2]
    tagged("x-yamlover-table", [                             // [3]
      plain(["r0c0", "r0c1"]),                               //   [0]
      plain(["r1c0", "r1c1"]),                               //   [1]
    ]),
  ]));

  it("in a chapter: Tab nests into the previous block, Shift-Tab lifts out", () => {
    expect(resolveTab(root, entryAt(root, 1), false)).toEqual({ kind: "indent" });
    expect(resolveTab(root, entryAt(root, 1), true)).toEqual({ kind: "dedent" });
  });

  it("in a list: the SAME move — a sublist is an untagged container that inherits the kind", () => {
    expect(resolveTab(root, entryAt(root, 2, 1), false)).toEqual({ kind: "indent" });
    expect(resolveTab(root, entryAt(root, 2, 1), true)).toEqual({ kind: "dedent" });
  });

  it("in a table: Tab walks to the next cell of the row", () => {
    expect(resolveTab(root, entryAt(root, 3, 0, 0), false)).toEqual({ kind: "cell", entryId: entryAt(root, 3, 0, 1) });
  });

  it("at a row's END, Tab wraps to the first cell of the next row", () => {
    expect(resolveTab(root, entryAt(root, 3, 0, 1), false)).toEqual({ kind: "cell", entryId: entryAt(root, 3, 1, 0) });
  });

  it("at the LAST cell of the LAST row, Tab appends a row of the right width", () => {
    expect(resolveTab(root, entryAt(root, 3, 1, 1), false)).toEqual({
      kind: "appendRow", tableId: nodeAt(root, 3).id, columns: 2,
    });
  });

  it("Shift-Tab mirrors it: previous cell, then back to the previous row's last cell", () => {
    expect(resolveTab(root, entryAt(root, 3, 1, 1), true)).toEqual({ kind: "cell", entryId: entryAt(root, 3, 1, 0) });
    expect(resolveTab(root, entryAt(root, 3, 1, 0), true)).toEqual({ kind: "cell", entryId: entryAt(root, 3, 0, 1) });
  });

  it("Shift-Tab at the very first cell does nothing — it never un-appends a row", () => {
    expect(resolveTab(root, entryAt(root, 3, 0, 0), true)).toEqual({ kind: "nop" });
  });

  it("an unknown entry is a nop", () => {
    expect(resolveTab(root, "nope", false)).toEqual({ kind: "nop" });
  });

  it("a new row takes the HEADER's width when the table has one", () => {
    const withHeader = buildModel(doc([
      mixed({ kind: "mix", format: "x-yamlover-table", entries: [
        { key: "title", value: "A caption" },
        { key: "header", value: plain(["h0", "h1", "h2"]) },
        { key: null, value: plain(["a", "b", "c"]) },
      ] }),
    ]));
    const lastCell = entryAt(withHeader, 0, 2, 2);
    expect(resolveTab(withHeader, lastCell, false)).toMatchObject({ kind: "appendRow", columns: 3 });
  });

  it("isTableCell marks exactly where the grid walk applies", () => {
    expect(isTableCell(root, entryAt(root, 3, 0, 0))).toBe(true);
    expect(isTableCell(root, entryAt(root, 3, 0))).toBe(false); // a row, not a cell
    expect(isTableCell(root, entryAt(root, 0))).toBe(false);
  });
});

describe("formatTarget — what a format command retags", () => {
  const root = buildModel(doc([
    "para",                                                  // [0]
    tagged("x-yamlover-bullets", ["item"]),                  // [1]
    tagged("x-yamlover-table", [plain(["cell"])]),           // [2]
  ]));

  it("a paragraph retags itself", () => {
    expect(formatTarget(root, entryAt(root, 0))).toBe(nodeAt(root, 0).id);
  });

  it("a list ITEM retags the LIST — wrapping one item in its own list is nobody's intent", () => {
    expect(formatTarget(root, entryAt(root, 1, 0))).toBe(nodeAt(root, 1).id);
  });

  it("a table CELL retags the TABLE", () => {
    expect(formatTarget(root, entryAt(root, 2, 0, 0))).toBe(nodeAt(root, 2).id);
  });

  it("an unknown entry has no target", () => {
    expect(formatTarget(root, "nope")).toBeNull();
  });
});
