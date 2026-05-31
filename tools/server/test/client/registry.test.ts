import { describe, it, expect } from "vitest";
import { getRenderer, rendererName, tocChildren } from "../../src/client/renderers/registry";
import type { NodeJson, TreeNode } from "../../src/client/api";

const node = (over: Partial<NodeJson>): NodeJson => ({
  path: "/",
  type: "object",
  format: null,
  concrete: null,
  title: null,
  description: null,
  value: {},
  ...over,
});

const tnode = (over: Partial<TreeNode>): TreeNode => ({
  path: "/",
  label: "x",
  type: "string",
  format: null,
  hasChildren: false,
  children: [],
  ...over,
});

describe("renderer registry (keyed on (type, format))", () => {
  it("selects a renderer by the (type, format) tuple", () => {
    const r = getRenderer(node({ type: "array", format: "x-yamlover-chapter", value: [] }));
    expect(r?.name).toBe("chapter");
  });

  it("returns null when no renderer claims the tuple (default tabbed view)", () => {
    expect(getRenderer(node({ type: "array", format: null, value: [] }))).toBeNull();
    expect(getRenderer(node({ type: "object", format: null }))).toBeNull();
    expect(getRenderer(node({ type: "string", format: "date" }))).toBeNull();
  });

  it("exposes the renderer name as the representation key", () => {
    expect(rendererName("array", "x-yamlover-chapter")).toBe("chapter");
    expect(rendererName("array", null)).toBeNull();
  });

  it("lets the chapter renderer surface only subchapters in the TOC", () => {
    const kids = [
      tnode({ path: "[0]", label: "[0]", type: "string", format: null }), // prose
      tnode({ path: "[1]", label: "Installation", type: "array", format: "x-yamlover-chapter" }),
      tnode({ path: "[2]", label: "Usage", type: "array", format: "x-yamlover-chapter" }),
    ];
    const shown = tocChildren("array", "x-yamlover-chapter", kids);
    expect(shown.map((c) => c.label)).toEqual(["Installation", "Usage"]);
  });

  it("surfaces all children when no renderer claims the tuple", () => {
    const kids = [tnode({ label: "a" }), tnode({ label: "b" })];
    expect(tocChildren("object", null, kids)).toEqual(kids);
  });
});
