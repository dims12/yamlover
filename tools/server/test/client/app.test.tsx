// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchInfo: vi.fn().mockResolvedValue({ root: "myroot" }),
  fetchTree: vi.fn().mockResolvedValue({
    path: "/",
    label: "root",
    type: "object",
    format: null,
    concrete: null,
    hasChildren: true,
    children: [{ path: "/a", label: "a", type: "string", format: null, concrete: null, hasChildren: false, children: [] }],
  }),
  fetchNode: vi.fn().mockResolvedValue({
    path: "/",
    type: "object",
    concrete: "yamlover",
    title: null,
    description: null,
    value: {},
  }),
  fetchSchema: vi.fn().mockResolvedValue({ type: "object" }),
}));
import { App } from "../../src/client/App";

afterEach(cleanup);

describe("App", () => {
  it("shows the root label in the breadcrumb and renders the tree", async () => {
    render(<App />);
    expect(await screen.findByText("myroot")).toBeTruthy(); // breadcrumb head (from /api/info)
    expect(await screen.findByText("a")).toBeTruthy(); // TOC entry
  });
});
