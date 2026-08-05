import { describe, it, expect } from "vitest";
import { getRenderer, rendererFor, rendererName, renderersFor, rendererTabs, plaintextTab, tocView } from "../../src/client/renderers/registry";
import type { NodeJson, TreeNode } from "../../src/client/api";

// Dispatch keys on TYPE FACETS (docs/language/model/matching): the scalar self-value's type, the node's format,
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

  it("the prose/chapter family declares the shared reading-width (the right-edge bar control)", () => {
    // the width control itself moved to the bar's RIGHT edge (always rendered, disabled when
    // unused — visual stability); renderers now DECLARE consumption via wantsWidth/wantsDepth
    for (const f of ["x-yamlover-chapter", "x-yamlover-task", "text/markdown", "text/asciidoc", "text/marklower"])
      expect(getRenderer(node({ format: f }))?.wantsWidth, `${f} consumes the reading width`).toBe(true);
    for (const f of ["x-yamlover-chapter", "x-yamlover-task"])
      expect(getRenderer(node({ format: f }))?.wantsDepth, `${f} consumes the render depth`).toBe(true);
    // the chapter family keeps its OWN docked config (the format picker)
    expect(getRenderer(node({ format: "x-yamlover-chapter" }))?.config).toBeTypeOf("function");
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

  it("rendererTabs: the explorer family is ALWAYS present — enabled per eligibility (a stable bar)", () => {
    // a PDF file: its own renderer leads (the one node-specific slot), the family rides along disabled
    expect(rendererTabs(node({ concrete: "file/binary", format: "application/pdf" })).map((t) => `${t.renderer.name}:${t.enabled}`)).toEqual([
      "pdf:true", "thumbnails:false", "large-icons:false", "small-icons:false", "details:false",
    ]);
    // a directory: no primary slot of its own (its natural view IS the explorer), so the OFFERED
    // chapter fills it — a folder can be written as a chapter — and the family rides along enabled
    expect(rendererTabs(node({ concrete: "dir" })).map((t) => `${t.renderer.name}:${t.enabled}`)).toEqual([
      "chapter:true", "thumbnails:true", "large-icons:true", "small-icons:true", "details:true",
    ]);
    // a data SCALAR: no primary, the family in place but disabled (its grids would be empty)
    expect(rendererTabs(node({ concrete: "file/json", type: "integer", valueType: "integer", value: 30 })).map((t) => `${t.renderer.name}:${t.enabled}`)).toEqual([
      "thumbnails:false", "large-icons:false", "small-icons:false", "details:false",
    ]);
  });

  // An OFFER is a representation the node could ADOPT, not one it HAS. It must reach the tab bar
  // and nothing else: the moment it leaked into dispatch, every plain folder would claim to be a
  // chapter (hijacking the explorer default, the chunk renderer, and the TOC).
  it("the offered chapter tab never leaks into dispatch or into `renderersFor`", () => {
    const dir = node({ concrete: "dir" });
    expect(rendererTabs(dir)[0]).toMatchObject({ enabled: true, offered: true });
    expect(rendererTabs(dir)[0].renderer.name).toBe("chapter");
    // …but the node HAS no chapter representation
    expect(renderersFor(dir).map((r) => r.name)).toEqual(["thumbnails", "large-icons", "small-icons", "details"]);
    expect(rendererFor(dir)).toBeNull(); // chunk + TOC dispatch untouched
    expect(getRenderer(dir)!.name).toBe("large-icons"); // a folder still OPENS on its explorer
    expect(rendererName(dir, "dir")).toBe("large-icons");
  });

  it("the chapter is offered only to an UNTAGGED container directory", () => {
    const offered = (n: NodeJson) => rendererTabs(n).some((t) => t.offered && t.renderer.name === "chapter");
    expect(offered(node({ concrete: "dir" }))).toBe(true);
    expect(offered(node({ concrete: "dir/yamlover" }))).toBe(true);
    // already has a representation of its own
    expect(offered(node({ concrete: "dir", format: "x-yamlover-chapter" }))).toBe(false);
    expect(offered(node({ concrete: "dir", format: "x-yamlover-tag" }))).toBe(false);
    expect(offered(node({ concrete: "dir", format: "x-yamlover-board" }))).toBe(false);
    // not a container: a scalar-bodied directory holds a value, not prose
    expect(offered(node({ concrete: "dir/yamlover", type: "integer", valueType: "integer", value: 30 }))).toBe(false);
    // not a directory: a chapter's home is a folder or a tagged file, never a stray data file
    expect(offered(node({ concrete: "file/json" }))).toBe(false);
    expect(offered(node({ concrete: "file/yamlover" }))).toBe(false);
    expect(offered(node({ concrete: "file/binary", format: "application/pdf" }))).toBe(false);
  });

  it("plaintextTab: ENABLED wherever raw content exists; DISABLED only for bare dirs/binaries", () => {
    // file-backed data + markdown/asciidoc files → plaintext enabled (raw bytes via /api/blob)
    expect(plaintextTab(node({ concrete: "file/yaml", hasKeyed: true }))).toMatchObject({ enabled: true });
    expect(plaintextTab(node({ concrete: "file/binary", format: "text/markdown" }))).toMatchObject({ enabled: true });
    expect(plaintextTab(node({ concrete: "file/yaml", hasKeyed: true }))?.renderer.name).toBe("plaintext");
    // inline string content (no source file) → plaintext renders the value
    expect(plaintextTab(node({ concrete: "yamlover", valueType: "string", format: "text/markdown", value: "# hi" }))).toMatchObject({ enabled: true });
    // a data-language container — inline or a dir/yamlover DOCUMENT — shows its SOURCE
    // (/api/source: a directory chapter's body.yo, a re-serialized subtree deeper)
    expect(plaintextTab(node({ concrete: "json", hasKeyed: true, value: {} }))).toMatchObject({ enabled: true });
    expect(plaintextTab(node({ concrete: "dir/yamlover", format: "x-yamlover-chapter", hasKeyed: true }))).toMatchObject({ enabled: true });
    // a bare directory (no overlay — nothing textual behind it) keeps the tab IN PLACE, disabled
    expect(plaintextTab(node({ concrete: "dir" }))).toMatchObject({ enabled: false });
    expect(plaintextTab(node({ concrete: "file/binary", format: "application/pdf" }))).toMatchObject({ enabled: false });
    // a .txt already LEADS with plaintext → no duplicate trailing tab (the one true null)
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

  // Prose is asked for BY NAME. A format-less string is DATA — `name: Alice` in some object — and
  // opening it in a prose renderer was never anything but a guess (MINITODO 018). A chapter's chunk
  // carries `text/marklower` from `$defs/chunk`, and `chunkOf` stamps an inline one that arrived
  // unstamped, so prose keeps rendering as prose.
  it("claims text/marklower as prose, and leaves a bare format-less string to the data view", () => {
    expect(getRenderer(node({ valueType: "string", format: "text/marklower", value: "x" }))?.name).toBe("marklower");
    expect(rendererName({ valueType: "string", format: "text/marklower" })).toBe("marklower");
    expect(getRenderer(node({ valueType: "string", format: null, value: "x" }))).toBeNull();
    expect(rendererName({ valueType: "string", format: null })).toBeNull();
  });

  it("exposes the renderer name as the representation key", () => {
    expect(rendererName({ format: "x-yamlover-chapter" })).toBe("chapter");
    expect(rendererName({ valueType: "string", format: "text/markdown" })).toBe("markdown");
    expect(rendererName({ type: "array", format: null, hasOrdinal: true })).toBeNull();
  });

  // The whole point (docs/language/model/matching): tagging a node turns it OMNI (hasKeyed:true), and the matcher
  // must tolerate the extra keyed facet — render exactly as before the annotation.
  describe("tolerance — an annotated (omni) node still routes by its value facet", () => {
    it("a tagged markdown chunk → markdown", () => {
      expect(getRenderer(node({ valueType: "string", format: "text/markdown", hasKeyed: true }))?.name).toBe("markdown");
      expect(rendererFor({ valueType: "string", format: "text/markdown", hasKeyed: true })?.name).toBe("markdown");
    });
    // Tagging a chunk does NOT strip its format — the server keeps stamping `text/marklower` and
    // merely turns the node `variant` (verified against /api/json). Tolerance means the extra keyed
    // facet is ignored, not that a format-less string must be guessed at.
    it("a tagged marklower chunk → marklower", () => {
      expect(getRenderer(node({ valueType: "string", format: "text/marklower", hasKeyed: true }))?.name).toBe("marklower");
      expect(rendererFor({ valueType: "string", format: "text/marklower", hasKeyed: true })?.name).toBe("marklower");
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
