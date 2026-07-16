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

  it("renders leaves without a toggle", () => {
    render(<Tree node={tree} current=":a:b" onSelect={() => {}} onLoadChildren={noop} />);
    const bRow = screen.getByText("b").closest(".tree-row") as HTMLElement;
    expect(within(bRow).queryByRole("button")).toBeNull();
  });
});
