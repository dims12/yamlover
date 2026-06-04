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
  concrete: null,
  hasChildren: false,
  children: [],
  ...over,
});

describe("renderer registry (keyed on (type, format))", () => {
  it("selects a renderer by the (type, format) tuple", () => {
    expect(getRenderer(node({ type: "object", format: "x-yamlover-chapter" }))?.name).toBe("chapter");
    expect(getRenderer(node({ type: "string", format: "text/markdown", value: "hi" }))?.name).toBe("text");
  });

  it("claims PlantUML source (a string) and offers an inline (chunk) form", () => {
    const r = getRenderer(node({ type: "string", format: "text/x-plantuml", value: "@startuml\n@enduml" }));
    expect(r?.name).toBe("plantuml");
    expect(r?.renderChunk).toBeTypeOf("function"); // routable as a chapter chunk
  });

  it("an image renderer offers an inline (chunk) form, so it can sit in a chapter", () => {
    expect(getRenderer(node({ type: "binary", format: "image/png" }))?.renderChunk).toBeTypeOf("function");
  });

  it("every file-backed renderer offers a chunk form (so any format can be a chapter chunk)", () => {
    // the (type, format) of each binary renderer the chapter must be able to embed
    const binaries: [string, string][] = [
      ["binary", "text/html"],
      ["binary", "application/pdf"],
      ["binary", "application/x-fictionbook+xml"],
      ["binary", "application/epub+zip"],
      ["binary", "image/vnd.djvu"],
      ["binary", "image/vnd.adobe.photoshop"],
      ["binary", "image/tiff"],
      ["binary", "image/heic"],
    ];
    for (const [t, f] of binaries)
      expect(getRenderer(node({ type: t, format: f }))?.renderChunk, `${f} needs renderChunk`).toBeTypeOf("function");
  });

  it("claims file-backed binaries by their inferred format", () => {
    expect(getRenderer(node({ type: "binary", format: "image/png" }))?.name).toBe("image");
    expect(getRenderer(node({ type: "binary", format: "image/vnd.djvu" }))?.name).toBe("djvu");
    expect(getRenderer(node({ type: "binary", format: "image/vnd.adobe.photoshop" }))?.name).toBe("psd");
    expect(getRenderer(node({ type: "binary", format: "image/tiff" }))?.name).toBe("tiff");
    expect(getRenderer(node({ type: "binary", format: "image/heic" }))?.name).toBe("heic");
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
    // subchapters sit under the `children` wrapper; an expand fetches 3 levels —
    // enough to reveal them (bug 013) and to load each one's own `children` wrapper
    // so its chevron is accurate from the start (a chunks-only chapter shows none)
    expect(view.loadDepth).toBe(3);
  });

  it("a chapter with an (loaded) empty `children` wrapper is NOT expandable — no chevron", () => {
    // a chunks-only chapter: its `children` wrapper is present but holds no
    // subchapters, so it must show as a leaf rather than a misleading chevron
    const chapter = tnode({
      path: "/children[2]",
      label: "Fish",
      type: "object",
      format: "x-yamlover-chapter",
      hasChildren: true, // generic hint (it has chunks) — must NOT drive expandability
      children: [
        tnode({ path: "/children[2]/chunks", type: "array", hasChildren: true }),
        tnode({ path: "/children[2]/children", type: "array", hasChildren: false, children: [] }), // empty
      ],
    });
    const view = tocView(chapter);
    expect(view.expandable).toBe(false);
    expect(view.children).toEqual([]);
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
    expect(loaded.loadDepth).toBeUndefined(); // a plain node's expand fetches one level

    const unloaded = tocView(tnode({ type: "object", hasChildren: true, children: [] }));
    expect(unloaded.expandable).toBe(true); // hint says expandable
    expect(unloaded.loaded).toBe(false); // children fetched on expand
  });
});
