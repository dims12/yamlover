import { describe, it, expect } from "vitest";
import { getRenderer, isActiveRenderer } from "../../src/client/renderers/registry";
import type { NodeJson } from "../../src/client/api";

describe("renderer registry (v1 ships none)", () => {
  it("has no active renderers, so every container stays expandable", () => {
    expect(isActiveRenderer("string", "date")).toBe(false);
    expect(isActiveRenderer("object", null)).toBe(false);
    expect(isActiveRenderer("binary", "image/png")).toBe(false);
  });

  it("getRenderer returns null (default tabbed view)", () => {
    const node: NodeJson = { path: "/", type: "object", concrete: null, title: null, description: null, value: {} };
    expect(getRenderer(node)).toBeNull();
  });
});
