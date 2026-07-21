// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { Tree } from "../../src/client/Tree";
import type { TreeNode } from "../../src/client/api";

afterEach(cleanup);

const tree: TreeNode = {
  path: ":",
  label: "root",
  type: "object",
  format: null,
  concrete: null,
  hasChildren: true,
  children: [
    {
      path: ":a",
      label: "a",
      type: "object",
      format: null,
      concrete: null,
      hasChildren: true,
      children: [{ path: ":a:b", label: "b", type: "string", format: null, concrete: null, hasChildren: false, children: [] }],
    },
    { path: ":c", label: "c", type: "object", format: null, concrete: null, hasChildren: true, children: [] }, // unloaded
  ],
};

const noop = async () => {};

describe("Tree", () => {
  it("lists nodes (incl. revealed descendants) and highlights the selection", () => {
    render(<Tree node={tree} current=":a:b" onSelect={() => {}} onLoadChildren={noop} />);
    expect(screen.getByText("a")).toBeTruthy();
    const bRow = screen.getByText("b").closest(".tree-row");
    expect(bRow?.className).toContain("selected");
  });

  it("a branch starts collapsed even when its children are already loaded", () => {
    // `:a` has `:a:b` loaded (e.g. a multi-level expand fetch), but nothing on the
    // selection path — it must NOT spring open by itself.
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} />);
    expect(screen.getByText("a")).toBeTruthy(); // the root row itself is open
    expect(screen.queryByText("b")).toBeNull();
  });

  it("expanding a loaded branch shows its children without refetching", () => {
    const onLoad = vi.fn().mockResolvedValue(undefined);
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={onLoad} />);
    const aRow = screen.getByText("a").closest(".tree-row") as HTMLElement;
    fireEvent.click(within(aRow).getByRole("button"));
    expect(screen.getByText("b")).toBeTruthy();
    expect(onLoad).not.toHaveBeenCalled(); // children were already loaded
  });

  it("selecting a row calls onSelect with its path", () => {
    const onSelect = vi.fn();
    render(<Tree node={tree} current=":" onSelect={onSelect} onLoadChildren={noop} />);
    fireEvent.click(screen.getByText("a"));
    expect(onSelect).toHaveBeenCalledWith(":a");
  });

  it("lazily loads an unloaded branch when its chevron is clicked", () => {
    const onLoad = vi.fn().mockResolvedValue(undefined);
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={onLoad} />);
    const cRow = screen.getByText("c").closest(".tree-row") as HTMLElement;
    fireEvent.click(within(cRow).getByRole("button"));
    expect(onLoad).toHaveBeenCalledWith(":c", undefined); // a plain node: default depth (one level)
  });

  it("initialOpen={false} keeps even the depth-0 root collapsed (a TOC-search result row)", () => {
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} initialOpen={false} />);
    expect(screen.getByText("root")).toBeTruthy(); // the row itself renders
    expect(screen.queryByText("a")).toBeNull(); // …but does not spring open
  });

  it("renders leaves without a toggle", () => {
    render(<Tree node={tree} current=":a:b" onSelect={() => {}} onLoadChildren={noop} />);
    const bRow = screen.getByText("b").closest(".tree-row") as HTMLElement;
    expect(within(bRow).queryByRole("button")).toBeNull();
  });

  it("filterMode: a pruned tree arrives expanded down to the matches, match rows marked", () => {
    // the pruned shape: root → a → a:b (the match); `c` was pruned away server-side
    const pruned: TreeNode = {
      ...tree,
      children: [
        {
          ...tree.children[0],
          children: [{ ...tree.children[0].children[0], match: true }],
        },
      ],
    };
    render(<Tree node={pruned} current="" onSelect={() => {}} onLoadChildren={noop} filterMode />);
    // every ancestor with pruned children starts OPEN — b is visible without any clicks
    const bRow = screen.getByText("b").closest(".tree-row") as HTMLElement;
    expect(bRow.className).toContain("match");
    expect(screen.getByText("a").closest(".tree-row")?.className).not.toContain("match");
    expect(bRow.className).not.toContain("selected"); // current="" suppresses selection
  });
});
