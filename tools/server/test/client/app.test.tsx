// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yo:settings.yo" }),
  fetchInfo: vi.fn().mockResolvedValue({ root: "myroot" }),
  fetchTree: vi.fn().mockResolvedValue({
    path: ":",
    label: "root",
    type: "object",
    format: null,
    concrete: null,
    hasChildren: true,
    children: [{ path: ":a", label: "a", type: "string", format: null, concrete: null, hasChildren: false, children: [] }],
  }),
  fetchNode: vi.fn().mockResolvedValue({
    path: ":",
    type: "object",
    concrete: "dir/.yo",
    title: null,
    description: null,
    value: {},
  }),
  fetchSchema: vi.fn().mockResolvedValue({ type: "object" }),
  fetchAnnotations: vi.fn().mockResolvedValue([]), // header badges hop via /api/annotations
  fetchTasks: vi.fn().mockResolvedValue([]), // long-running server tasks (TaskStrip)
  previewSource: vi.fn().mockResolvedValue({
    // the browser-settings page (stateless /api/preview of the localStorage doc)
    path: ":",
    type: "object",
    format: "x-yamlover-config",
    concrete: "yamlover",
    documentPath: ":",
    title: null,
    description: null,
    value: { width: 72 },
    comments: {},
    relations: {},
  }),
  editText: vi.fn(),
}));
import { App } from "../../src/client/App";
import { fetchNode, fetchTree } from "../../src/client/api";
import { clearPresence, publishPresence } from "../../src/client/toc-presence";

afterEach(() => {
  cleanup();
  clearPresence();
  window.history.replaceState({}, "", "/");
});

describe("App", () => {
  it("shows the root label in the breadcrumb and renders the tree", async () => {
    render(<App />);
    expect(await screen.findByText("myroot")).toBeTruthy(); // breadcrumb head (from /api/info)
    expect(await screen.findByText("a")).toBeTruthy(); // TOC entry
  });

  it("Ctrl/Alt + Down/Up step the selection to the next/previous TOC entry", async () => {
    render(<App />);
    // the label of the currently-selected TOC row (scoped to the left pane — the
    // breadcrumb also echoes the node label, so a bare getByText would be ambiguous)
    const selected = () => document.querySelector(".left .tree-row.selected .tree-label")?.textContent;
    await screen.findByText("a");
    expect(selected()).toBe("root"); // starts on the root node ":" (default URL → ":")

    fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
    await waitFor(() => expect(selected()).toBe("a"));

    fireEvent.keyDown(document, { key: "ArrowUp", ctrlKey: true });
    await waitFor(() => expect(selected()).toBe("root"));

    // Alt is an accepted alias (Ctrl+Up/Down clashes with macOS Mission Control)
    fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(selected()).toBe("a"));
  });

  it("the settings tab's Local settings entry opens the BROWSER settings page at its virtual path, and navigating leaves it", async () => {
    render(<App />);
    await screen.findByText("myroot");
    // the actions live on the LHS settings tab — switch to it via the activity bar
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Local settings" }));
    expect(await screen.findByText("this browser")).toBeTruthy(); // the page's provenance chip
    // the page has a REAL address — `*:: .browser: settings.yo` — that survives a reload
    expect(window.location.pathname).toBe("/.browser/settings.yo");
    expect(screen.getByText("settings.yo")).toBeTruthy(); // and real breadcrumbs
    // any ordinary navigation leaves the page. Crumbs are edit cells now (they no longer
    // navigate on click) — navigate via a TOC row: back to the TOC tab, click the root row.
    fireEvent.click(screen.getByRole("button", { name: "Table of contents" }));
    fireEvent.click(within(document.querySelector(".left") as HTMLElement).getByText("root"));
    await waitFor(() => expect(document.body.textContent).not.toContain("this browser"));
    expect(window.location.pathname).toBe("/");
  });

  it("a data view's continuation link PINS the format — the target's renderer does not steal the hop; a TOC double-click opens the renderer", async () => {
    // a child that HAS a renderer (chapter) …
    vi.mocked(fetchTree).mockResolvedValue({
      path: ":",
      label: "root",
      type: "object",
      format: null,
      concrete: null,
      hasChildren: true,
      children: [{ path: ":ch", label: "ch", type: "object", format: "x-yamlover-chapter", concrete: "dir/.yo", hasChildren: false, children: [] }],
    });
    // … reached from the ROOT's yamlover data view as a depth continuation link
    vi.mocked(fetchNode).mockResolvedValue({
      path: ":",
      type: "object",
      concrete: "dir/.yo",
      title: null,
      description: null,
      value: { ch: { $yamloverLink: { kind: "object", count: 2, path: ":ch" } } },
    });
    window.history.replaceState({}, "", "/?format=yamlover");
    render(<App />);

    fireEvent.click(await screen.findByText("{ object with 2 properties }"));
    await waitFor(() => expect(window.location.pathname).toBe("/ch"));
    expect(new URLSearchParams(window.location.search).get("format")).toBe("yamlover"); // NOT chapter

    // the page's OWN row is rendered by the page (the root `#/` anchor) — a single click
    // scrolls in-page and the pinned format survives; the DOUBLE-click escape is the
    // "go to the node" navigation where the renderer wins
    const row = () => within(document.querySelector(".left") as HTMLElement).getByText("ch");
    fireEvent.click(row());
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(new URLSearchParams(window.location.search).get("format")).toBe("yamlover"); // still pinned
    fireEvent.click(row(), { detail: 2 });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("format")).toBe("chapter"));
  });

  it("a click on the page's OWN row scrolls to its top anchor (#/) — the base row is merged too", async () => {
    vi.mocked(fetchTree).mockResolvedValue({
      path: ":", label: "root", type: "object", format: null, concrete: null, hasChildren: true,
      children: [{ path: ":a", label: "a", type: "string", format: null, concrete: null, hasChildren: false, children: [] }],
    });
    render(<App />);
    await screen.findByText("a");
    // the content pane publishes its base with the ROOT anchor — what a chapter/data view stamps
    publishPresence(":", new Map([[":", "/"]]));
    fireEvent.click(within(document.querySelector(".left") as HTMLElement).getByText("root"));
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(window.location.pathname).toBe("/"); // NO navigation — the in-page scroll only
  });

  it("a click on a MERGED TOC row only scrolls in-page (the hash); a double-click navigates", async () => {
    vi.mocked(fetchTree).mockResolvedValue({
      path: ":", label: "root", type: "object", format: null, concrete: null, hasChildren: true,
      children: [{ path: ":a", label: "a", type: "string", format: null, concrete: null, hasChildren: false, children: [] }],
    });
    render(<App />);
    await screen.findByText("a");
    const label = () => within(document.querySelector(".left") as HTMLElement).getByText("a");
    // the content pane says `:a` is rendered inline (seeded AFTER the mounted view's own scan)
    publishPresence(":", new Map([[":a", "/a"]]));
    fireEvent.click(label());
    await waitFor(() => expect(window.location.hash).toBe("#/a"));
    expect(window.location.pathname).toBe("/"); // NO navigation — the in-page scroll only
    // the double-click escape: old-fashioned navigation, merged or not
    fireEvent.click(label(), { detail: 2 });
    await waitFor(() => expect(window.location.pathname).toBe("/a"));
  });

  it("a click on the PROJECT ROOT while a child file is open navigates home — not an in-page scroll", async () => {
    vi.mocked(fetchTree).mockResolvedValue({
      path: ":", label: "root", type: "object", format: null, concrete: null, hasChildren: true,
      children: [{ path: ":01-tour.json", label: "01-tour.json", type: "object", format: null, concrete: "file/json", hasChildren: true, children: [] }],
    });
    render(<App />);
    const left = () => document.querySelector(".left") as HTMLElement;
    await within(left()).findByText("01-tour.json");
    fireEvent.click(within(left()).getByText("01-tour.json"));
    await waitFor(() => expect(window.location.pathname).toBe("/01-tour.json"));
    // viewing the child file: its own anchors, the project root is only an ancestor
    publishPresence(":01-tour.json", new Map([
      [":01-tour.json", "/"],
      [":01-tour.json:name", "/name"],
    ]));
    fireEvent.click(within(left()).getByText("root"));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(window.location.hash).toBe(""); // a real navigation, not #/name
  });

  it("a click OUTSIDE the merged set navigates as before", async () => {
    vi.mocked(fetchTree).mockResolvedValue({
      path: ":", label: "root", type: "object", format: null, concrete: null, hasChildren: true,
      children: [{ path: ":a", label: "a", type: "string", format: null, concrete: null, hasChildren: false, children: [] }],
    });
    render(<App />);
    await screen.findByText("a");
    publishPresence(":", new Map()); // a merged view is up, but `:a` is not in it
    fireEvent.click(within(document.querySelector(".left") as HTMLElement).getByText("a"));
    await waitFor(() => expect(window.location.pathname).toBe("/a"));
  });
});
