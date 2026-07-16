// @vitest-environment jsdom
// The TABLE renderer (TABLE.md): grid from omni entries, header/caption, merged cells
// (colSpan/rowSpan) from resolved relative-index pointer cells, nested tables, marklower cells.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { TableView, buildTableGrid, computeSpans } from "../../src/client/renderers/table";
import { getRenderer } from "../../src/client/renderers/registry";
import type { NodeJson } from "../../src/client/api";
import * as api from "../../src/client/api";
import { EditingContext } from "../../src/client/renderers/editing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The projection shapes engine-api emits (see chapter.test.tsx for the $yamloverMixed pattern):
// a keyed entry consumes a position; a resolved pointer cell is a $yamloverRef whose `path` is
// the ORIGIN cell's path (the engine resolves merge chains transitively).
const mixed = (entries: { key: string | null; value: unknown }[]) => ({ $yamloverMixed: { kind: "omni", entries } });
const ref = (path: string | null, text = "→") => ({ $yamloverRef: { text, path } });

const tableNode = (value: unknown): NodeJson => ({
  path: ":t",
  type: "variant",
  format: "x-yamlover-table",
  concrete: null,
  title: null,
  description: null,
  value,
});

// the examples/74 shape: title + header (colspan) + a rowspan + a nested-table cell
const fixture = mixed([
  { key: "title", value: "Who does what" },
  { key: "header", value: ["Name", "Class", ref(":t:header[1]")] },
  { key: null, value: ["Whiskers", "mammal", "**manager**"] },
  { key: null, value: ["Rex", ref(":t[2][1]"), "security"] },
  { key: null, value: ["Bubbles", "fish", mixed([
    { key: "header", value: ["duty", "shift"] },
    { key: null, value: ["decoration", "always"] },
  ])] },
]);

describe("table renderer", () => {
  it("is selected for x-yamlover-table and offers an inline chunk form", () => {
    const r = getRenderer(tableNode(fixture));
    expect(r?.name).toBe("table");
    expect(r?.depth).toBeNull(); // the grid needs the whole subtree
    expect(r?.renderChunk).toBeTypeOf("function");
  });

  it("renders the title, the header as <th>, and body cells", () => {
    const { container } = render(<TableView node={tableNode(fixture)} onNavigate={() => {}} />);
    expect(container.querySelector("h1.chapter-title")?.textContent).toBe("Who does what");
    const outer = container.querySelector("table")!; // the nested table has its own thead
    const heads = [...outer.querySelectorAll(":scope > thead th")].map((e) => e.textContent);
    expect(heads).toEqual(["Name", "Class"]); // the third header cell merged into "Class"
    expect(container.querySelector("tbody td")?.textContent).toBe("Whiskers");
  });

  it("gives the origin colSpan/rowSpan and emits nothing for merged members", () => {
    const { container } = render(<TableView node={tableNode(fixture)} onNavigate={() => {}} />);
    const classTh = [...container.querySelectorAll("thead th")].find((e) => e.textContent === "Class")!;
    expect(classTh.getAttribute("colspan")).toBe("2");
    const mammal = [...container.querySelectorAll("tbody td")].find((e) => e.textContent === "mammal")!;
    expect(mammal.getAttribute("rowspan")).toBe("2");
    // the Rex row has only 2 cells left (its middle cell merged upward)
    const rexRow = [...container.querySelectorAll("tbody tr")][1];
    expect(rexRow.querySelectorAll("td").length).toBe(2);
  });

  it("renders marklower inside cells (bold)", () => {
    const { container } = render(<TableView node={tableNode(fixture)} onNavigate={() => {}} />);
    expect([...container.querySelectorAll("tbody td strong")].map((e) => e.textContent)).toContain("manager");
  });

  it("renders a nested-table cell as an inline table with its own caption-less header", () => {
    const { container } = render(<TableView node={tableNode(fixture)} onNavigate={() => {}} />);
    const nested = container.querySelector("tbody td table");
    expect(nested).not.toBeNull();
    const nestedHeads = [...nested!.querySelectorAll("th")].map((e) => e.textContent);
    expect(nestedHeads).toEqual(["duty", "shift"]);
  });

  it("a chapter cell (stamped x-yamlover-chapter) keeps prose AND its nested table", () => {
    // a cell mixing prose and a table is a TAGGED chapter (TABLE.md §Cells); the engine stamps
    // the mixed marker's `format`, which is what routes it away from the nested-table branch
    const innerTable = { $yamloverMixed: { kind: "omni", format: "x-yamlover-table", entries: [
      { key: null, value: ["duty", "always"] },
    ] } };
    const chapterCell = { $yamloverMixed: { kind: "omni", format: "x-yamlover-chapter", entries: [
      { key: null, value: "above the **table**" },
      { key: null, value: innerTable },
      { key: null, value: "below it" },
    ] } };
    const value = mixed([{ key: null, value: ["plain", chapterCell] }]);
    const { container } = render(<TableView node={tableNode(value)} onNavigate={() => {}} />);

    const td = [...container.querySelectorAll("tbody > tr > td")][1];
    expect(td.querySelector(".yl-cell-chapter")).not.toBeNull();
    expect(td.textContent).toContain("above the table");
    expect(td.textContent).toContain("below it");
    expect(td.querySelector(".yl-cell-chapter strong")?.textContent).toBe("table"); // prose is marklower
    const inner = td.querySelector("table")!;
    expect([...inner.querySelectorAll("td")].map((e) => e.textContent)).toEqual(["duty", "always"]);
  });

  it("a 3-wide colspan chain merges into one origin", () => {
    const grid = buildTableGrid(
      mixed([{ key: null, value: ["Origin", ref(":t[0][0]"), ref(":t[0][0]")] }]),
      ":t",
    );
    const spans = computeSpans(grid);
    expect(spans[0][0]).toEqual({ colSpan: 3, rowSpan: 1 });
    expect(spans[0][1]).toBeNull();
    expect(spans[0][2]).toBeNull();
  });

  it("a pointer to a NON-adjacent cell is not a merge — it renders as a link", () => {
    // origin at [0][0], pointer at [1][1]: origin+member bbox is 2x2 but only 2 cells → unmerged
    const value = mixed([
      { key: null, value: ["shared", "b"] },
      { key: null, value: ["c", ref(":t[0][0]", "shared")] },
    ]);
    const { container } = render(<TableView node={tableNode(value)} onNavigate={() => {}} />);
    const tds = [...container.querySelectorAll("tbody td")];
    expect(tds.length).toBe(4); // nothing merged
    expect(tds[3].querySelector("a")?.textContent).toBe("shared");
  });

  it("a merge crossing the header/body boundary renders unmerged", () => {
    const value = mixed([
      { key: "header", value: ["a", "b"] },
      { key: null, value: [ref(":t:header[0]"), "y"] }, // rowspan up INTO the header
    ]);
    const { container } = render(<TableView node={tableNode(value)} onNavigate={() => {}} />);
    expect(container.querySelectorAll("thead th").length).toBe(2);
    expect(container.querySelectorAll("tbody td").length).toBe(2); // pointer cell still there
  });

  it("a dangling pointer cell is inert text", () => {
    const value = mixed([{ key: null, value: [ref(null, "[.-1]"), "x"] }]);
    const { container } = render(<TableView node={tableNode(value)} onNavigate={() => {}} />);
    const td = container.querySelector("tbody td")!;
    expect(td.querySelector("a")).toBeNull();
    expect(td.textContent).toBe("[.-1]");
  });

  it("pads short rows and reports longer rows as an inconsistency", () => {
    const value = mixed([
      { key: null, value: ["a", "b", "c"] },
      { key: null, value: ["short"] },
      { key: null, value: ["1", "2", "3", "EXTRA"] },
    ]);
    const { container } = render(<TableView node={tableNode(value)} onNavigate={() => {}} />);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[1].querySelectorAll("td").length).toBe(3); // padded
    expect(container.querySelector(".yl-table-notice")?.textContent).toContain("1 cell");
  });

  it("unlocked: a prose cell mounts an editor and posts a debounced emplace at [r][c]", async () => {
    vi.useFakeTimers();
    const edit = vi.spyOn(api, "editChunks").mockResolvedValue({ ok: true });
    const { container } = render(
      <EditingContext.Provider value={{ unlocked: true }}>
        <TableView node={tableNode(fixture)} onNavigate={() => {}} />
      </EditingContext.Provider>,
    );
    const cell = container.querySelector("tbody td .chapter-prose.editable") as HTMLElement;
    expect(cell).not.toBeNull();
    cell.textContent = "Tom";
    fireEvent.input(cell);
    vi.advanceTimersByTime(600);
    expect(edit).toHaveBeenCalledWith([{ path: ":t[2][0]", op: "emplace", yamlover: "|-\n  Tom" }]);
    vi.useRealTimers();
  });

  it("unlocked: a pointer cell stays read-only (the merge ORIGIN, being content, edits)", () => {
    // a dangling pointer cell renders inert even unlocked; the prose cell beside it edits
    const value = mixed([{ key: null, value: [ref(null, "[.-1]"), "x"] }]);
    const { container } = render(
      <EditingContext.Provider value={{ unlocked: true }}>
        <TableView node={tableNode(value)} onNavigate={() => {}} />
      </EditingContext.Provider>,
    );
    const tds = [...container.querySelectorAll("tbody td")];
    expect(tds[0].querySelector(".editable")).toBeNull();
    expect(tds[1].querySelector(".editable")).not.toBeNull();
  });
});
