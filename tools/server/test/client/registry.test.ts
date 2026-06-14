import { describe, it, expect } from "vitest";
import { getRenderer, rendererFor, rendererName, tocView } from "../../src/client/renderers/registry";
import type { NodeJson, TreeNode } from "../../src/client/api";

// Dispatch keys on TYPE FACETS (TYPES.md §9): the scalar self-value's type, the node's format,
// and whether it owns keyed/ordinal elements. A matcher tolerates what it doesn't test — so a
// node that gained `yamlover-annotations` keys (an omni node, hasKeyed:true) still routes by format.

const node = (over: Partial<NodeJson>): NodeJson => ({
  path: ":",
  type: "object",
  format: null,
  valueType: null,
  hasKeyed: false,
  hasOrdinal: false,
  concrete: null,
  title: null,
  description: null,
  value: {},
  ...over,
});

const tnode = (over: Partial<TreeNode>): TreeNode => ({
  path: ":",
  label: "x",
  type: "string",
  format: null,
  valueType: null,
  hasKeyed: false,
  hasOrdinal: false,
  concrete: null,
  hasChildren: false,
  children: [],
  ...over,
});

describe("renderer registry (facet predicates)", () => {
  it("selects a renderer by format", () => {
    expect(getRenderer(node({ format: "x-yamlover-chapter" }))?.name).toBe("chapter");
    expect(getRenderer(node({ valueType: "string", format: "text/markdown", value: "hi" }))?.name).toBe("markdown");
  });

  it("claims PlantUML / LaTeX source (a string) and offers an inline (chunk) form", () => {
    const uml = getRenderer(node({ valueType: "string", format: "text/x-plantuml" }));
    expect(uml?.name).toBe("plantuml");
    expect(uml?.renderChunk).toBeTypeOf("function");
    const tex = getRenderer(node({ valueType: "string", format: "text/x-latex" }));
    expect(tex?.name).toBe("latex");
    expect(tex?.renderChunk).toBeTypeOf("function");
  });

  it("every file-backed renderer offers a chunk form (any format can be a chapter chunk)", () => {
    const formats = [
      "text/html", "application/pdf", "application/x-fictionbook+xml", "application/epub+zip",
      "image/vnd.djvu", "image/vnd.adobe.photoshop", "image/tiff", "image/heic", "image/png",
    ];
    for (const f of formats)
      expect(getRenderer(node({ valueType: "binary", format: f }))?.renderChunk, `${f} needs renderChunk`).toBeTypeOf("function");
  });

  it("claims file-backed binaries by their inferred format", () => {
    expect(getRenderer(node({ valueType: "binary", format: "image/png" }))?.name).toBe("image");
    expect(getRenderer(node({ valueType: "binary", format: "image/vnd.djvu" }))?.name).toBe("djvu");
    expect(getRenderer(node({ valueType: "binary", format: "image/vnd.adobe.photoshop" }))?.name).toBe("psd");
    expect(getRenderer(node({ valueType: "binary", format: "image/tiff" }))?.name).toBe("tiff");
    expect(rendererName({ valueType: "binary", format: "image/vnd.adobe.photoshop" })).toBe("psd");
  });

  it("returns null when no renderer claims the facets (default tabbed view)", () => {
    expect(getRenderer(node({ type: "array", format: null, hasOrdinal: true, value: [] }))).toBeNull();
    expect(getRenderer(node({ type: "object", format: null, hasKeyed: true }))).toBeNull();
  });

  it("falls back to the explorer for a node stored as a filesystem directory", () => {
    expect(getRenderer(node({ concrete: "dir" }))?.name).toBe("explorer");
    expect(getRenderer(node({ concrete: "yamlover" }))?.name).toBe("explorer");
    expect(rendererName({ format: null }, "dir")).toBe("explorer");
    // other concretes don't
    expect(getRenderer(node({ concrete: "yaml-schema/instantiate" }))).toBeNull();
  });

  it("a format renderer wins over the dir concrete (a dir-backed chapter stays a chapter)", () => {
    expect(getRenderer(node({ format: "x-yamlover-chapter", concrete: "yamlover" }))?.name).toBe("chapter");
    expect(rendererName({ format: "x-yamlover-chapter" }, "yamlover")).toBe("chapter");
  });

  it("claims tags (every projection shape) for the explorer — the format alone identifies them", () => {
    for (const valueType of [null, "string"])
      for (const hasKeyed of [false, true])
        expect(getRenderer(node({ valueType, hasKeyed, format: "x-yamlover-tag" }))?.name).toBe("explorer");
  });

  it("claims a bare, format-less string as marklower (the default prose format)", () => {
    expect(getRenderer(node({ valueType: "string", format: null, value: "x" }))?.name).toBe("marklower");
    expect(rendererName({ valueType: "string", format: null })).toBe("marklower");
    expect(rendererName({ valueType: "string", format: "text/marklower" })).toBe("marklower");
  });

  it("exposes the renderer name as the representation key", () => {
    expect(rendererName({ format: "x-yamlover-chapter" })).toBe("chapter");
    expect(rendererName({ valueType: "string", format: "text/markdown" })).toBe("markdown");
    expect(rendererName({ type: "array", format: null, hasOrdinal: true })).toBeNull();
  });

  // The whole point (TYPES.md §9): tagging a node turns it OMNI (hasKeyed:true), and the matcher
  // must tolerate the extra keyed facet — render exactly as before the annotation.
  describe("tolerance — an annotated (omni) node still routes by its value facet", () => {
    it("a tagged markdown chunk → markdown", () => {
      expect(getRenderer(node({ valueType: "string", format: "text/markdown", hasKeyed: true }))?.name).toBe("markdown");
      expect(rendererFor({ valueType: "string", format: "text/markdown", hasKeyed: true })?.name).toBe("markdown");
    });
    it("a tagged bare-string (format-less) chunk → marklower", () => {
      expect(getRenderer(node({ valueType: "string", format: null, hasKeyed: true }))?.name).toBe("marklower");
    });
    it("a tagged PDF (omni-blob) → pdf", () => {
      expect(getRenderer(node({ valueType: "binary", format: "application/pdf", hasKeyed: true }))?.name).toBe("pdf");
    });
    it("a tagged chapter → chapter", () => {
      expect(getRenderer(node({ format: "x-yamlover-chapter", hasKeyed: true }))?.name).toBe("chapter");
    });
  });

  it("a chapter's TOC view unwraps `children` (subchapters direct) and hides `chunks`", () => {
    const chapter = tnode({
      path: ":",
      type: "object",
      format: "x-yamlover-chapter",
      hasChildren: true,
      children: [
        tnode({ path: ":chunks", type: "array", hasChildren: true, children: [tnode({ path: ":chunks[0]" })] }),
        tnode({
          path: ":children",
          type: "array",
          hasChildren: true,
          children: [
            tnode({ path: ":children[0]", label: "Dogs", type: "object", format: "x-yamlover-chapter", hasChildren: true }),
            tnode({ path: ":children[1]", label: "Cats", type: "object", format: "x-yamlover-chapter", hasChildren: true }),
          ],
        }),
      ],
    });
    const view = tocView(chapter);
    expect(view.children.map((c) => c.label)).toEqual(["Dogs", "Cats"]); // no chunks, no wrapper rows
    expect(view.expandable).toBe(true);
    expect(view.loaded).toBe(true);
    expect(view.loadDepth).toBe(3);
  });

  it("a chapter with a (loaded) empty `children` wrapper is NOT expandable — no chevron", () => {
    const chapter = tnode({
      path: ":children[2]",
      label: "Fish",
      type: "object",
      format: "x-yamlover-chapter",
      hasChildren: true,
      children: [
        tnode({ path: ":children[2]:chunks", type: "array", hasChildren: true }),
        tnode({ path: ":children[2]:children", type: "array", hasChildren: false, children: [] }),
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
        tnode({ path: ":chunks", type: "array", hasChildren: true }),
        tnode({ path: ":children", type: "array", hasChildren: true, children: [] }),
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
    expect(loaded.loadDepth).toBeUndefined();

    const unloaded = tocView(tnode({ type: "object", hasChildren: true, children: [] }));
    expect(unloaded.expandable).toBe(true);
    expect(unloaded.loaded).toBe(false);
  });
});
