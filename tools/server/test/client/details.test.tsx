// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({ fetchAnnotations: vi.fn().mockResolvedValue([]) }));

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

  it("renders a color tag as a circular swatch, a named tag as a badge", async () => {
    mAnns.mockResolvedValue([
      { tag: { path: "::yamlover:tags:colors:yellow", name: "yellow", color: "#f9e2af" } },
      { tag: { path: ":tags:done", name: "done", color: null } },
    ]);
    const { container } = render(<DetailsView members={[item(":doc.md", "text/markdown", "Doc")]} onNavigate={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tagswatch")).toBeTruthy());
    expect(container.querySelector(".tagswatch")!.getAttribute("title")).toBe("yellow"); // color tag → swatch
    expect([...container.querySelectorAll(".tagtag")].map((b) => b.textContent)).toEqual(["done"]); // named tag → badge
    mAnns.mockResolvedValue([]); // restore for other tests
  });
});
