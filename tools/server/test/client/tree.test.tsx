// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { Tree } from "../../src/client/Tree";
import type { TreeNode } from "../../src/client/api";

afterEach(cleanup);

const tree: TreeNode = {
  path: "/",
  label: "root",
  type: "object",
  format: null,
  hasChildren: true,
  children: [
    {
      path: "/a",
      label: "a",
      type: "object",
      format: null,
      hasChildren: true,
      children: [{ path: "/a/b", label: "b", type: "string", format: null, hasChildren: false, children: [] }],
    },
    { path: "/c", label: "c", type: "object", format: null, hasChildren: true, children: [] }, // unloaded
  ],
};

const noop = async () => {};

describe("Tree", () => {
  it("lists nodes (incl. revealed descendants) and highlights the selection", () => {
    render(<Tree node={tree} current="/a/b" onSelect={() => {}} onLoadChildren={noop} />);
    expect(screen.getByText("a")).toBeTruthy();
    const bRow = screen.getByText("b").closest(".tree-row");
    expect(bRow?.className).toContain("selected");
  });

  it("selecting a row calls onSelect with its path", () => {
    const onSelect = vi.fn();
    render(<Tree node={tree} current="/" onSelect={onSelect} onLoadChildren={noop} />);
    fireEvent.click(screen.getByText("a"));
    expect(onSelect).toHaveBeenCalledWith("/a");
  });

  it("lazily loads an unloaded branch when its chevron is clicked", () => {
    const onLoad = vi.fn().mockResolvedValue(undefined);
    render(<Tree node={tree} current="/" onSelect={() => {}} onLoadChildren={onLoad} />);
    const cRow = screen.getByText("c").closest(".tree-row") as HTMLElement;
    fireEvent.click(within(cRow).getByRole("button"));
    expect(onLoad).toHaveBeenCalledWith("/c");
  });

  it("renders leaves without a toggle", () => {
    render(<Tree node={tree} current="/a/b" onSelect={() => {}} onLoadChildren={noop} />);
    const bRow = screen.getByText("b").closest(".tree-row") as HTMLElement;
    expect(within(bRow).queryByRole("button")).toBeNull();
  });
});
