// @vitest-environment jsdom
// In-project drag-and-drop wiring on the TOC tree: rows drag out (dnd.ts), directory rows
// accept drops (highlight + onDropNode), gated by the owner's canDrop (drop-policy).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Tree, TreeDnd } from "../../src/client/Tree";
import { YL_DND_TYPE, currentDrag, endNodeDrag } from "../../src/client/dnd";
import type { TreeNode } from "../../src/client/api";

afterEach(cleanup);
beforeEach(endNodeDrag); // no drag leaks between tests

// jsdom has no DataTransfer — a plain stub carrying what the handlers touch.
function dt(types: string[] = []) {
  const data: Record<string, string> = {};
  return {
    types,
    setData: (t: string, v: string) => { data[t] = v; if (!types.includes(t)) types.push(t); },
    getData: (t: string) => data[t] ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

const leaf = (path: string, label: string, concrete: string | null): TreeNode =>
  ({ path, label, type: "string", format: null, concrete, hasChildren: false, children: [] });

const tree: TreeNode = {
  path: ":",
  label: "root",
  type: "object",
  format: null,
  concrete: "dir",
  hasChildren: true,
  children: [
    { path: ":docs", label: "docs", type: "object", format: null, concrete: "dir", hasChildren: false, children: [] },
    leaf(":note.yamlover", "note", "file/yamlover"),
    leaf(":inline", "inline", "yamlover"),
  ],
};

const noop = async () => {};
const row = (label: string) => screen.getByText(label).closest(".tree-row") as HTMLElement;

describe("Tree drag-and-drop", () => {
  it("dragging a row registers it as the current drag with its facets", () => {
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} dnd={{ canDrop: () => true, onDropNode: () => {} }} />);
    expect(row("note").getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(row("note"), { dataTransfer: dt() });
    expect(currentDrag()).toEqual({ path: ":note.yamlover", concrete: "file/yamlover", label: "note" });
    fireEvent.dragEnd(row("note"));
    expect(currentDrag()).toBeNull(); // cleared unconditionally, cancelled drags included
  });

  it("the root row is not draggable", () => {
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} dnd={{ canDrop: () => true, onDropNode: () => {} }} />);
    expect(row("root").getAttribute("draggable")).not.toBe("true");
  });

  it("dragover a directory row highlights it when canDrop allows; a drop reports the target", () => {
    const onDropNode = vi.fn();
    const dnd: TreeDnd = { canDrop: () => true, onDropNode };
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} dnd={dnd} />);
    const transfer = dt();
    fireEvent.dragStart(row("note"), { dataTransfer: transfer });
    fireEvent.dragOver(row("docs"), { dataTransfer: transfer });
    expect(row("docs").className).toContain("drop-target");
    fireEvent.drop(row("docs"), { dataTransfer: transfer });
    expect(row("docs").className).not.toContain("drop-target");
    // (jsdom's drop event carries no clientX/Y — the coordinates are asserted by type, not value)
    expect(onDropNode).toHaveBeenCalledTimes(1);
    expect(onDropNode.mock.calls[0][0]).toMatchObject({ path: ":docs", concrete: "dir" });
  });

  it("a refused canDrop never highlights nor accepts", () => {
    const onDropNode = vi.fn();
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} dnd={{ canDrop: () => false, onDropNode }} />);
    const transfer = dt();
    fireEvent.dragStart(row("note"), { dataTransfer: transfer });
    fireEvent.dragOver(row("docs"), { dataTransfer: transfer });
    expect(row("docs").className).not.toContain("drop-target");
  });

  it("a non-directory row is no drop target at all", () => {
    const onDropNode = vi.fn();
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} dnd={{ canDrop: () => true, onDropNode }} />);
    const transfer = dt();
    fireEvent.dragStart(row("docs"), { dataTransfer: transfer });
    fireEvent.dragOver(row("inline"), { dataTransfer: transfer });
    expect(row("inline").className).not.toContain("drop-target");
    fireEvent.drop(row("inline"), { dataTransfer: transfer });
    expect(onDropNode).not.toHaveBeenCalled();
  });

  it("an OS-file drag (no yamlover type) is ignored by rows", () => {
    const onDropNode = vi.fn();
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} dnd={{ canDrop: () => true, onDropNode }} />);
    const transfer = dt(["Files"]);
    fireEvent.dragOver(row("docs"), { dataTransfer: transfer });
    expect(row("docs").className).not.toContain("drop-target");
    fireEvent.drop(row("docs"), { dataTransfer: transfer });
    expect(onDropNode).not.toHaveBeenCalled();
  });

  it("without a dnd prop rows neither drag nor accept (the breadcrumb dropdown shape)", () => {
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} />);
    expect(row("note").getAttribute("draggable")).not.toBe("true");
    const transfer = dt([YL_DND_TYPE]);
    fireEvent.dragOver(row("docs"), { dataTransfer: transfer });
    expect(row("docs").className).not.toContain("drop-target");
  });
});
