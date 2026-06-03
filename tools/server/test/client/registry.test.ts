import { describe, it, expect } from "vitest";
import { getRenderer, rendererName, tocView } from "../../src/client/renderers/registry";
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
    expect(getRenderer(node({ type: "object", format: "x-yamlover-chapter" }))?.name).toBe("chapter");
    expect(getRenderer(node({ type: "string", format: "text/markdown", value: "hi" }))?.name).toBe("text");
  });

  it("claims file-backed binaries by their inferred format", () => {
    expect(getRenderer(node({ type: "binary", format: "image/png" }))?.name).toBe("image");
    expect(getRenderer(node({ type: "binary", format: "image/vnd.djvu" }))?.name).toBe("djvu");
    expect(getRenderer(node({ type: "binary", format: "image/vnd.adobe.photoshop" }))?.name).toBe("psd");
    expect(rendererName("binary", "image/vnd.adobe.photoshop")).toBe("psd");
  });

  it("returns null when no renderer claims the tuple (default tabbed view)", () => {
    expect(getRenderer(node({ type: "array", format: null, value: [] }))).toBeNull();
    expect(getRenderer(node({ type: "object", format: null }))).toBeNull();
    expect(getRenderer(node({ type: "string", format: null, value: "x" }))).toBeNull(); // a bare string is not hijacked
  });

  it("exposes the renderer name as the representation key", () => {
    expect(rendererName("object", "x-yamlover-chapter")).toBe("chapter");
    expect(rendererName("string", "text/markdown")).toBe("text");
    expect(rendererName("array", null)).toBeNull();
  });

  it("a chapter's TOC view unwraps `children` (subchapters direct) and hides `chunks`", () => {
    const chapter = tnode({
      path: "/",
      type: "object",
      format: "x-yamlover-chapter",
      hasChildren: true,
      children: [
        tnode({ path: "/chunks", type: "array", hasChildren: true, children: [tnode({ path: "/chunks[0]" })] }),
        tnode({
          path: "/children",
          type: "array",
          hasChildren: true,
          children: [
            tnode({ path: "/children[0]", label: "Dogs", type: "object", format: "x-yamlover-chapter", hasChildren: true }),
            tnode({ path: "/children[1]", label: "Cats", type: "object", format: "x-yamlover-chapter", hasChildren: true }),
          ],
        }),
      ],
    });
    const view = tocView(chapter);
    expect(view.children.map((c) => c.label)).toEqual(["Dogs", "Cats"]); // no chunks, no wrapper rows
    expect(view.expandable).toBe(true);
    expect(view.loaded).toBe(true);
  });

  it("a chapter whose subchapters aren't loaded yet is expandable but not loaded", () => {
    const chapter = tnode({
      type: "object",
      format: "x-yamlover-chapter",
      hasChildren: true,
      children: [
        tnode({ path: "/chunks", type: "array", hasChildren: true }),
        tnode({ path: "/children", type: "array", hasChildren: true, children: [] }), // boundary
      ],
    });
    const view = tocView(chapter);
    expect(view.children).toEqual([]);
    expect(view.expandable).toBe(true);
    expect(view.loaded).toBe(false);
  });

  it("defaults to a node's own children, lazily loaded, when no renderer claims it", () => {
    const kids = [tnode({ label: "a" }), tnode({ label: "b" })];
    const loaded = tocView(tnode({ type: "object", hasChildren: true, children: kids }));
    expect(loaded.children).toEqual(kids);
    expect(loaded.expandable).toBe(true);
    expect(loaded.loaded).toBe(true);

    const unloaded = tocView(tnode({ type: "object", hasChildren: true, children: [] }));
    expect(unloaded.expandable).toBe(true); // hint says expandable
    expect(unloaded.loaded).toBe(false); // children fetched on expand
  });
});
