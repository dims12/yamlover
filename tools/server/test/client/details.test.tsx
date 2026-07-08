// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

// fetchNode backs the tag hover-card's lazy body lookup; reject → the card shows the path only.
vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yamlover:settings.yamlover" }),
  fetchAnnotations: vi.fn().mockResolvedValue([]),
  fetchNode: vi.fn().mockRejectedValue(new Error("no node")),
}));

import { DetailsView } from "../../src/client/renderers/details";
import type { ExplorerItem } from "../../src/client/renderers/explorer";
import { fetchAnnotations } from "../../src/client/api";

const mAnns = fetchAnnotations as unknown as ReturnType<typeof vi.fn>;

afterEach(cleanup);

const item = (path: string, format: string | null, title: string, extra: Record<string, unknown> = {}): ExplorerItem => ({
  key: title,
  link: { kind: "object", type: "object", path, format, title, ...extra } as ExplorerItem["link"],
});

describe("DetailsView", () => {
  it("renders the columnar table: a row per member with Name, Kind and Size", () => {
    render(
      <DetailsView
        members={[item(":task-a.yamlover", "x-yamlover-task", "Task A", { count: 3 }), item(":notes", null, "Notes", { concrete: "dir", count: 7 })]}
        onNavigate={() => {}}
      />,
    );
    // headers
    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.getByText("Kind")).toBeTruthy();
    expect(screen.getByText("Tags")).toBeTruthy();
    // a row per member, with the friendly kind + a member count
    expect(screen.getByText("Task A")).toBeTruthy();
    expect(screen.getByText("task")).toBeTruthy(); // x-yamlover-task → "task"
    expect(screen.getByText("folder")).toBeTruthy(); // a dir-concrete member → "folder"
    expect(screen.getByText("3 items")).toBeTruthy();
  });

  it("shows 'empty' when the directory has no members", () => {
    render(<DetailsView members={[]} onNavigate={() => {}} />);
    expect(screen.getByText("empty")).toBeTruthy();
  });

  it("renders uplink items as rows, but does not raise the tag menu on them (right-click is gated on !up)", () => {
    const up: ExplorerItem = { ...item(":", null, "..", { concrete: "dir", count: 3 }), key: "..", up: true };
    const menu = vi.fn();
    render(<DetailsView members={[up, item(":notes", null, "Notes", { concrete: "dir", count: 7 })]} onNavigate={() => {}} openContextMenu={menu} />);
    const rows = [...document.querySelectorAll("tr.details-row")];
    expect(rows).toHaveLength(2); // the uplink shows as a row alongside the member
    fireEvent.contextMenu(rows[0]); // the `..` uplink row
    expect(menu).not.toHaveBeenCalled();
    fireEvent.contextMenu(rows[1]); // a normal member
    expect(menu).toHaveBeenCalledWith(":notes", expect.any(Number), expect.any(Number));
  });

  it("renders a color tag as a circular swatch, a named tag as a badge", async () => {
    mAnns.mockResolvedValue([
      { tag: { path: "::yamlover:tags:colors:yellow", name: "yellow", color: "#f9e2af" } },
      { tag: { path: ":tags:done", name: "done", color: null } },
    ]);
    const { container } = render(<DetailsView members={[item(":doc.md", "text/markdown", "Doc")]} onNavigate={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tagswatch")).toBeTruthy());
    expect([...container.querySelectorAll(".tagtag")].map((b) => b.textContent)).toEqual(["done"]); // named tag → badge
    // the color tag's full path lives on the hover-card now (no native title): hover reveals it
    fireEvent.mouseEnter(container.querySelector(".tagtip-anchor")!);
    await waitFor(() => expect(document.querySelector(".tagtip-path")?.textContent).toBe("colors: yellow"));
    mAnns.mockResolvedValue([]); // restore for other tests
  });
});
