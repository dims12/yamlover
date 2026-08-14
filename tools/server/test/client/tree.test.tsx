// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { Tree } from "../../src/client/Tree";
import { clearPresence, publishCurrentFragment, publishPresence, publishVisibleIds } from "../../src/client/toc-presence";
import type { TreeNode } from "../../src/client/api";

afterEach(() => {
  cleanup();
  clearPresence();
});

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

  it("selecting a row calls onSelect with its path and the click event", () => {
    const onSelect = vi.fn();
    render(<Tree node={tree} current=":" onSelect={onSelect} onLoadChildren={noop} />);
    fireEvent.click(screen.getByText("a"));
    expect(onSelect).toHaveBeenCalledWith(":a", expect.anything());
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

  // ---- TOC presence (toc-presence.ts): the shaded merged set + the reading-line row ------- //

  it("presence shades the merged rows and the base row; others stay plain", () => {
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} />);
    act(() => publishPresence(":", new Map([[":a", "/a"]])));
    expect(screen.getByText("a").closest(".tree-row")?.className).toContain("merged");
    expect(screen.getByText("root").closest(".tree-row")?.className).toContain("merged"); // the base
    expect(screen.getByText("c").closest(".tree-row")?.className).not.toContain("merged");
  });

  it("the fragment-current row shades differently and its collapsed ancestors spring open", () => {
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} />);
    expect(screen.queryByText("b")).toBeNull(); // `:a` starts collapsed
    act(() => {
      publishPresence(":", new Map([[":a", "/a"], [":a:b", "/a/b"]]));
      publishCurrentFragment("/a/b");
    });
    // the reading line reached `:a:b` — its branch opened by itself (the follow-scroll choice)
    const bRow = screen.getByText("b").closest(".tree-row") as HTMLElement;
    expect(bRow.className).toContain("frag-current");
    expect(screen.getByText("a").closest(".tree-row")?.className).not.toContain("frag-current");
  });

  it("a fragment DEEPER than any row shades the nearest ancestor row that has one", () => {
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} />);
    act(() => {
      // the reading line names `:c:x` — `:c` has no loaded children, so its row carries it
      publishPresence(":", new Map([[":c", "/c"], [":c:x", "/c/x"]]));
      publishCurrentFragment("/c/x");
    });
    expect(screen.getByText("c").closest(".tree-row")?.className).toContain("frag-current");
    expect(screen.getByText("root").closest(".tree-row")?.className).not.toContain("frag-current");
  });

  it("the hand-me-down shade never lands on the BASE row (a row-less pointer member)", () => {
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} />);
    act(() => {
      // `:topDog` has an anchor (a pointer row on the page) but no TOC row — before the guard
      // its shade fell to the root row, the yellow jumping to the top on every crossing
      publishPresence(":", new Map([[":a", "/a"], [":topDog", "/topDog"]]));
      publishCurrentFragment("/topDog");
    });
    expect(screen.getByText("root").closest(".tree-row")?.className).not.toContain("frag-current");
    expect(screen.getByText("a").closest(".tree-row")?.className).not.toContain("frag-current");
  });

  it("the on-screen band shades LITERALLY the rows whose own line is in the viewport", () => {
    render(<Tree node={tree} current=":" onSelect={() => {}} onLoadChildren={noop} />);
    act(() => {
      publishPresence(":", new Map([[":a", "/a"], [":a:b", "/a/b"], [":c", "/c"]]));
      publishVisibleIds(["/a/b", "/nonexistent"]); // only b's anchor is inside the viewport
    });
    act(() => { fireEvent.click(screen.getAllByRole("button", { name: "expand" })[0]); });
    // b alone: NOT its ancestors — shading an off-screen ancestor above unshaded siblings is
    // the "split yellow" report; the band stays one contiguous run of literally-visible rows
    expect(screen.getByText("b").closest(".tree-row")?.className).toContain("in-view");
    expect(screen.getByText("a").closest(".tree-row")?.className).not.toContain("in-view");
    expect(screen.getByText("root").closest(".tree-row")?.className).not.toContain("in-view");
    expect(screen.getByText("c").closest(".tree-row")?.className).not.toContain("in-view");
    act(() => publishVisibleIds(["/c"])); // the band moves with the scroll
    expect(screen.getByText("b").closest(".tree-row")?.className).not.toContain("in-view");
    expect(screen.getByText("c").closest(".tree-row")?.className).toContain("in-view");
  });
});
