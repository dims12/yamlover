// @vitest-environment jsdom
// Width layering + a markdown node rendering through App (regression: the README.md white screen
// was the DEV server serving the package README for the /README.md route — fixed in bin/yamlover.js).
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yamlover:settings.yamlover" }),
  fetchInfo: vi.fn().mockResolvedValue({ root: "ex" }),
  fetchTree: vi.fn().mockResolvedValue({
    path: ":",
    label: "root",
    type: "object",
    format: null,
    concrete: "dir",
    hasChildren: true,
    children: [{ path: ":README.md", label: "README.md", type: "string", format: "text/markdown", concrete: "file/yaml", hasChildren: false, children: [] }],
  }),
  fetchNode: vi.fn().mockResolvedValue({
    path: ":README.md",
    type: "string",
    format: "text/markdown",
    valueType: "string",
    hasKeyed: false,
    hasOrdinal: false,
    concrete: "file/yaml",
    documentPath: ":README.md",
    title: null,
    description: null,
    value: "# yamlover examples\n\nSome *markdown* body.\n",
    comments: {},
    relations: { "..": { $yamloverRef: { text: "..", path: ":" } } },
  }),
  fetchSchema: vi.fn().mockResolvedValue({ type: "string" }),
  fetchAnnotations: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  previewSource: vi.fn(),
  editText: vi.fn(),
}));

import { App } from "../../src/client/App";

describe("repro: README.md (markdown node) white screen", () => {
  it("renders the markdown page without crashing", async () => {
    window.history.replaceState({}, "", "/README.md");
    localStorage.setItem(
      "yamlover.settings",
      "# Browser settings\n!!<*yamlover:$defs:config>\n\nwidth: 124\n",
    );
    render(<App />);
    expect(await screen.findByText("yamlover examples")).toBeTruthy();
  });
});

import { markupWidthCh } from "../../src/client/renderers/markup";

describe("repro: ?width=200 layer", () => {
  it("URL width beats the browser settings doc", () => {
    localStorage.setItem("yamlover.settings", "!!<*yamlover:$defs:config>\n\nwidth: 124\n");
    window.history.replaceState({}, "", "/68-math-chapter?format=chapter&width=200");
    expect(markupWidthCh()).toBe(200);
  });
});
