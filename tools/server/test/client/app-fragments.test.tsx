// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// Regression: the RHS fragments-pane COLLAPSE TOGGLE appears whenever the current node has a
// fragment annotation (it is gated on `fragGroups.length > 0`). A whole-node tag (no fragmentSlug)
// must NOT bring it up — only fragments do.
vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yamlover:settings.yamlover" }),
  saveLastTag: vi.fn().mockResolvedValue({ ok: true }),
  fetchInfo: vi.fn().mockResolvedValue({ root: "root" }),
  fetchTree: vi.fn().mockResolvedValue({ path: ":", label: "root", type: "object", format: null, concrete: null, hasChildren: false, children: [] }),
  fetchNode: vi.fn().mockResolvedValue({ path: ":", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} }),
  fetchSchema: vi.fn().mockResolvedValue({ type: "object" }),
  fetchTasks: vi.fn().mockResolvedValue([]),
  createObject: vi.fn(),
  fetchAnnotations: vi.fn().mockResolvedValue([
    { tag: { path: ":tags:green", name: "green", color: "#0f0" }, selector: { type: "text", exact: "x" }, fragmentSlug: "frag1" },
  ]),
}));
import { App } from "../../src/client/App";

afterEach(cleanup);

describe("RHS fragments pane collapse toggle", () => {
  it("appears when the node has fragments and toggles the pane", async () => {
    render(<App />);
    // the toggle shows (aria-label 'Hide fragments' while expanded)
    const toggle = await screen.findByLabelText("Hide fragments");
    expect(toggle).toBeTruthy();
    // it lives in the RIGHT-pinned group (so it is always at the far right, next to the pane, even
    // when the task strip is absent — the disappearance was the toggle stranded mid-header).
    expect(toggle.closest(".topbar-right")).not.toBeNull();
    // the fragments pane is present
    await waitFor(() => expect(document.querySelector(".pane.right, .fragments, aside.right")).toBeTruthy());
    // collapsing flips the label to 'Show fragments' (the button stays — it does NOT disappear)
    fireEvent.click(toggle);
    expect(await screen.findByLabelText("Show fragments")).toBeTruthy();
  });
});
