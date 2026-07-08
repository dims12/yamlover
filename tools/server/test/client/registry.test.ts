import { describe, it, expect } from "vitest";
import { getRenderer, rendererFor, rendererName, renderersFor, plaintextTab, tocView } from "../../src/client/renderers/registry";
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

  it("chapter, task, markdown, and asciidoc all expose a reading-width config control", () => {
    for (const f of ["x-yamlover-chapter", "x-yamlover-task", "text/markdown", "text/asciidoc"])
      expect(getRenderer(node({ format: f }))?.config, `${f} needs a width config`).toBeTypeOf("function");
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

  it("falls back to the explorer (large-icons representative) for a node stored as a filesystem directory", () => {
    expect(getRenderer(node({ concrete: "dir" }))?.name).toBe("large-icons");
    expect(getRenderer(node({ concrete: "dir/yamlover" }))?.name).toBe("large-icons");
    expect(rendererName({ format: null, type: "object" }, "dir")).toBe("large-icons");
    // other concretes don't
    expect(getRenderer(node({ concrete: "yaml-schema/instantiate" }))).toBeNull();
  });

  it("offers the explorer VIEW FAMILY as tabs: the four icon views for a plain dir, led by tag-board for a board", () => {
    // a plain directory: thumbnails / large icons / small icons / details (no tag board)
    expect(renderersFor(node({ concrete: "dir" })).map((r) => r.name)).toEqual([
      "thumbnails", "large-icons", "small-icons", "details",
    ]);
    // a board (by format): tag-board leads, then the icon views — and it is the navigation default
    const boardViews = renderersFor(node({ format: "x-yamlover-board", concrete: "dir/yamlover" })).map((r) => r.name);
    expect(boardViews[0]).toBe("tag-board");
    expect(boardViews).toContain("large-icons");
    expect(rendererName({ format: "x-yamlover-board" }, "dir/yamlover")).toBe("tag-board");
    // a board detected only via overlay value (workflow:/lanes:) also leads with tag-board
    expect(renderersFor(node({ concrete: "dir", value: { lanes: [] } })).map((r) => r.name)[0]).toBe("tag-board");
    // the view tabs carry human labels
    expect(renderersFor(node({ concrete: "dir" })).map((r) => r.label)).toEqual([
      "thumbnails", "large icons", "small icons", "details",
    ]);
  });

  it("a dir-backed chapter leads with its chapter view, then the directory views", () => {
    expect(renderersFor(node({ format: "x-yamlover-chapter", concrete: "dir/yamlover" })).map((r) => r.name)).toEqual([
      "chapter", "thumbnails", "large-icons", "small-icons", "details",
    ]);
  });

  it("a json/yaml CONTAINER offers the icon views too (browse members like a folder); a SCALAR does not", () => {
    // a yaml object file: icon views (thumbnails-led), like a directory
    expect(renderersFor(node({ concrete: "file/yaml", hasKeyed: true })).map((r) => r.name)).toEqual([
      "thumbnails", "large-icons", "small-icons", "details",
    ]);
    // an inline json array node likewise (ordinal members)
    expect(renderersFor(node({ concrete: "json", hasOrdinal: true })).map((r) => r.name)).toEqual([
      "thumbnails", "large-icons", "small-icons", "details",
    ]);
    // a data SCALAR (a .json holding `30`) gets NO icon tabs (they would be empty)
    expect(renderersFor(node({ concrete: "file/json", type: "integer", valueType: "integer", value: 30 }))).toEqual([]);
    // a scalar-bodied DIRECTORY (54-scalar-file-overlay) likewise — and defaults to yamlover, not the explorer
    expect(renderersFor(node({ concrete: "dir/yamlover", type: "integer", valueType: "integer", value: 30 }))).toEqual([]);
    expect(rendererName(node({ concrete: "dir/yamlover", type: "integer", value: 30 }), "dir/yamlover")).toBeNull();
  });

  it("plaintextTab: a textual node offers the raw-source tab; dirs and non-string inline nodes do not", () => {
    // file-backed data + markdown/asciidoc files → plaintext (raw bytes via /api/blob)
    expect(plaintextTab(node({ concrete: "file/yaml", hasKeyed: true }))?.name).toBe("plaintext");
    expect(plaintextTab(node({ concrete: "file/binary", format: "text/markdown" }))?.name).toBe("plaintext");
    // inline string content (no source file) → plaintext renders the value
    expect(plaintextTab(node({ concrete: "yamlover", valueType: "string", format: "text/markdown", value: "# hi" }))?.name).toBe("plaintext");
    // a directory and a non-string inline container get NONE
    expect(plaintextTab(node({ concrete: "dir" }))).toBeNull();
    expect(plaintextTab(node({ concrete: "json", hasKeyed: true, value: {} }))).toBeNull();
    // a .txt already LEADS with plaintext → no duplicate trailing tab
    expect(plaintextTab(node({ concrete: "file/binary", format: "text/plain" }))).toBeNull();
  });

  it("a format renderer wins over the dir concrete (a dir-backed chapter stays a chapter)", () => {
    expect(getRenderer(node({ format: "x-yamlover-chapter", concrete: "dir/yamlover" }))?.name).toBe("chapter");
    expect(rendererName({ format: "x-yamlover-chapter" }, "dir/yamlover")).toBe("chapter");
  });

  it("claims tags (every projection shape) for the explorer — the format alone identifies them", () => {
    for (const valueType of [null, "string"])
      for (const hasKeyed of [false, true])
        expect(getRenderer(node({ valueType, hasKeyed, format: "x-yamlover-tag" }))?.name).toBe("large-icons");
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

  it("a chapter's TOC view surfaces the subchapter-format body elements and hides prose chunks", () => {
    const chapter = tnode({
      path: ":",
      type: "variant",
      format: "x-yamlover-chapter",
      hasChildren: true,
      children: [
        // body elements are DIRECT children now: prose chunks + subchapters, interleaved
        tnode({ path: ":[1]", type: "string", format: "text/marklower" }),
        tnode({ path: ":[2]", label: "Dogs", type: "variant", format: "x-yamlover-chapter", hasChildren: true }),
        tnode({ path: ":[3]", label: "Cats", type: "variant", format: "x-yamlover-chapter", hasChildren: true }),
      ],
    });
    const view = tocView(chapter);
    expect(view.children.map((c) => c.label)).toEqual(["Dogs", "Cats"]); // only subchapters, no chunk rows
    expect(view.expandable).toBe(true);
    expect(view.loaded).toBe(true);
    expect(view.loadDepth).toBe(2);
  });

  it("a chapter with only prose chunks (no subchapters) is NOT expandable — no chevron", () => {
    const chapter = tnode({
      path: ":[2]",
      label: "Fish",
      type: "variant",
      format: "x-yamlover-chapter",
      hasChildren: true,
      children: [tnode({ path: ":[2][1]", type: "string", format: "text/marklower" })], // loaded, but no subchapters
    });
    const view = tocView(chapter);
    expect(view.expandable).toBe(false);
    expect(view.children).toEqual([]);
  });

  it("a chapter whose subchapters aren't loaded yet is expandable but not loaded", () => {
    const chapter = tnode({
      type: "variant",
      format: "x-yamlover-chapter",
      hasChildren: true,
      children: [], // not loaded yet
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
