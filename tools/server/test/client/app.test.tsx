// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yamlover:settings.yamlover" }),
  saveLastTag: vi.fn().mockResolvedValue({ ok: true }),
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
    concrete: "yamlover",
    title: null,
    description: null,
    value: {},
  }),
  fetchSchema: vi.fn().mockResolvedValue({ type: "object" }),
  fetchAnnotations: vi.fn().mockResolvedValue([]), // header badges hop via /api/annotations
  fetchTasks: vi.fn().mockResolvedValue([]), // long-running server tasks (TaskStrip)
}));
import { App } from "../../src/client/App";

afterEach(cleanup);

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
});
