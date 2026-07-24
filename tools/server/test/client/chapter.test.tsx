// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// A chapter page fetches each inlined subchapter itself (subchapter.tsx), so `fetchNode` is the
// seam every depth/inlining test drives. (hoisted so the mock exists before vi.mock's factory runs)
const { fetchNode } = vi.hoisted(() => ({ fetchNode: vi.fn() }));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchNode }));

import { ChapterView } from "../../src/client/renderers/chapter";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);
beforeEach(() => {
  fetchNode.mockReset().mockReturnValue(new Promise(() => {})); // never settles unless a test says so
  window.history.replaceState({}, "", "/"); // the depth budget rides `?depth=`
});

// A chapter (CHAPTER.md): title/description are keyed; the body is the mixed marker's KEYLESS
// entries — scalar chunk link markers (text in `value`) and object subchapter markers (with a
// `title`). Title is entry 0, so the body elements sit at store slots [1], [2], [3].
const chapter: NodeJson = {
  path: ":",
  type: "variant",
  format: "x-yamlover-chapter",
  concrete: "dir/yamlover",
  title: "The Handbook",
  description: "A friendly guide",
  value: {
    $yamloverMixed: {
      kind: "mix",
      entries: [
        { key: "title", value: "The Handbook" },
        { key: "description", value: "A friendly guide" },
        { key: null, value: { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: ":[1]", value: "Welcome to the handbook." } } },
        { key: null, value: { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: ":[2]", value: "Read on." } } },
        { key: null, value: { $yamloverLink: { kind: "object", type: "object", format: "x-yamlover-chapter", path: ":[3]", title: "Installation", count: 2 } } },
      ],
    },
  },
};

describe("ChapterView", () => {
  it("leads with the chapter's title (heading) and description (subtitle)", () => {
    render(<ChapterView node={chapter} onNavigate={vi.fn()} />);

    const title = screen.getByText("The Handbook");
    expect(title.tagName).toBe("H1");
    const subtitle = screen.getByText("A friendly guide");
    expect(subtitle.tagName).toBe("P");
    expect(subtitle.className).toContain("chapter-subtitle");
  });

  it("flattens each chunk into the page with a §N fragment-anchor link to its in-page location", () => {
    const onNav = vi.fn();
    render(<ChapterView node={chapter} onNavigate={onNav} />);

    const prose = screen.getByText("Welcome to the handbook.");
    expect(prose.tagName).toBe("P"); // a chunk is delegated to the text renderer → paragraph

    // §N is an in-page fragment anchor mirroring the chunk's positional store path (`#[1]`)
    const idx0 = screen.getByText("§0") as HTMLAnchorElement;
    expect(idx0.getAttribute("href")).toBe("#[1]");
    expect((screen.getByText("§1") as HTMLAnchorElement).getAttribute("href")).toBe("#[2]");
    // the chunk element carries the matching id, so `<chapter>#[2]` scrolls to it
    expect(document.getElementById("[2]")).not.toBeNull();
    // clicking the in-page anchor does not trigger app navigation
    fireEvent.click(idx0);
    expect(onNav).not.toHaveBeenCalled();
  });

  it("routes a non-prose chunk to the renderer for its (type, format)", async () => {
    // a chapter whose body interleaves Markdown, an image, and a PlantUML diagram
    const mixed: NodeJson = {
      ...chapter,
      value: {
        $yamloverMixed: {
          kind: "mix",
          entries: [
            { key: "title", value: "The Handbook" },
            { key: null, value: { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: ":[1]", value: "Intro." } } },
            { key: null, value: { $yamloverLink: { kind: "binary", type: "binary", format: "image/png", path: ":[2]", size: 1234 } } },
            { key: null, value: { $yamloverLink: { kind: "scalar", type: "string", format: "text/x-plantuml", path: ":[3]", value: "@startuml\nA -> B\n@enduml" } } },
          ],
        },
      },
    };
    const { container } = render(<ChapterView node={mixed} onNavigate={vi.fn()} />);

    expect(screen.getByText("Intro.").tagName).toBe("P"); // markdown → markdown renderer
    // the image chunk routes to the (lazily loaded) image renderer — a plain STATIC <img> (no
    // pan/zoom widget inline), wrapped in a click-to-open anchor, its src the blob endpoint
    await waitFor(() => expect(container.querySelector("img.chunk-image")).not.toBeNull());
    const imgChunk = container.querySelector("img.chunk-image")!;
    expect(imgChunk.getAttribute("src")).toContain("/api/blob?path=");
    expect(imgChunk.closest("a.chunk-open")).not.toBeNull(); // clicking opens it on its own page
    // the diagram chunk is a separate <img> pointing at a PlantUML server, not the blob endpoint
    const uml = [...container.querySelectorAll("img")].find((i) => /\/plantuml\/svg\//.test(i.getAttribute("src") ?? ""));
    expect(uml).toBeDefined();
  });

  it("routes a tagged LIST body element to the list renderer (fetched by path)", async () => {
    fetchNode.mockResolvedValue({
      path: ":[1]",
      type: "variant",
      format: "x-yamlover-bullets",
      concrete: null,
      title: null,
      description: null,
      value: { $yamloverMixed: { kind: "array", format: "x-yamlover-bullets", entries: [
        { key: null, value: "first point" },
        { key: null, value: "second point" },
      ] } },
    } as NodeJson);
    const withList: NodeJson = {
      ...chapter,
      value: {
        $yamloverMixed: {
          kind: "mix",
          entries: [
            { key: null, value: { $yamloverLink: { kind: "array", type: "variant", format: "x-yamlover-bullets", path: ":[1]", count: 2 } } },
          ],
        },
      },
    };
    const { container } = render(<ChapterView node={withList} onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("ul.yl-list-bullets")).not.toBeNull());
    expect([...container.querySelectorAll("ul.yl-list-bullets li")].map((e) => e.textContent)).toEqual([
      "first point",
      "second point",
    ]);
  });

  // At `?depth=1` a subchapter is a navigable heading link — the shape this page had before
  // subchapters were laid out in place. (Inlining, the default, is covered further down.)
  it("renders a subchapter as a title hyperlink at depth 1", () => {
    window.history.replaceState({}, "", "/?depth=1");
    const onNav = vi.fn();
    render(<ChapterView node={chapter} onNavigate={onNav} />);

    const link = screen.getByText("Installation"); // subchapter by its title
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe(":[3]");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":[3]");
  });

  it("renders title, description, subchapters and chunks in SOURCE order — heading not hoisted, text after a subchapter", () => {
    window.history.replaceState({}, "", "/?depth=1"); // subchapters as links, so the flow is one flat list
    // author order: an intro chunk, THEN the title, a subchapter, then a closing chunk
    const flowed: NodeJson = {
      ...chapter,
      value: {
        $yamloverMixed: {
          kind: "mix",
          entries: [
            { key: null, value: { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: ":[0]", value: "Intro before the title." } } },
            { key: "title", value: "Mid-Flow Title" },
            { key: null, value: { $yamloverLink: { kind: "object", type: "object", format: "x-yamlover-chapter", path: ":[2]", title: "A Section", count: 1 } } },
            { key: null, value: { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: ":[3]", value: "Closing after the section." } } },
          ],
        },
      },
    };
    const { container } = render(<ChapterView node={flowed} onNavigate={vi.fn()} />);
    // the DOM order of the rendered blocks matches the source flow
    const blocks = [...container.querySelectorAll("h1.chapter-title, .chapter-title a.descend, .chunk-body p")];
    expect(blocks.map((b) => b.textContent)).toEqual([
      "Intro before the title.", // a chunk FIRST — the title is not hoisted above it
      "Mid-Flow Title", // the title, mid-flow (h1)
      "A Section", // the subchapter link, in place
      "Closing after the section.", // base-level text AFTER the subchapter
    ]);
  });

  // A chunk's format is `text/marklower` (CHAPTER.md `$defs/chunk`), but a BARE inline scalar
  // reaches the client with nothing stamped on it — `chunkOf` supplies it. Without that, prose in a
  // chapter would fall through to the plain-paragraph fallback and lose its markup.
  it("renders a bare inline chunk as marklower prose, not as plain text", () => {
    const node = {
      path: ":doc", documentPath: ":doc", type: "mixed", format: "x-yamlover-chapter", concrete: "file/yamlover",
      value: { $yamloverMixed: { kind: "mix", entries: [{ key: null, value: "plain **bold** prose" }] } },
    } as unknown as NodeJson;
    const { container } = render(<ChapterView node={node} onNavigate={vi.fn()} />);
    expect(container.querySelector(".chunk-body strong")?.textContent).toBe("bold");
  });

  // An ANNOTATED chunk is an omni node — tag applications keyed over the prose. At the chapter's own
  // fetch depth (1) it arrives as a `$yamloverLink` and `chunkOf` reads `link.value`; INLINE (any
  // deeper fetch) it arrives as the marker itself, which stringifies to "[object Object]" unless it
  // is peeled. Both shapes must render the prose.
  it("renders an ANNOTATED chunk as its prose, not as the overlay marker", () => {
    const annotated = {
      $yamloverMixed: { kind: "omni", entries: [{ key: "yamlover-annotations", value: [] }], value: "a **bold** chunk" },
    };
    const node = {
      path: ":doc", documentPath: ":doc", type: "mixed", format: "x-yamlover-chapter", concrete: "file/yamlover",
      value: { $yamloverMixed: { kind: "mix", entries: [{ key: null, value: annotated }] } },
    } as unknown as NodeJson;
    const { container } = render(<ChapterView node={node} onNavigate={vi.fn()} />);
    const body = container.querySelector(".chunk-body")!;
    expect(body.textContent).not.toContain("[object Object]");
    expect(body.textContent).toBe("a bold chunk");
    expect(body.querySelector("strong")?.textContent).toBe("bold");
  });
});

// A plain folder reached through the OFFERED chapter tab has no body yet. Locked, it reads as a
// blank page — no note, no chrome — so a reader is not lectured about a folder they merely opened.
describe("ChapterView — an empty node (a folder written as a chapter)", () => {
  const emptyFolder = {
    path: ":", type: "object", format: null, valueType: null, concrete: "dir", title: null, description: null, value: {},
  } as unknown as NodeJson;

  it("locked: renders blank, with no empty-state note", () => {
    const { container } = render(<ChapterView node={emptyFolder} onNavigate={vi.fn()} />);
    expect(container.querySelector(".chapter-empty")).toBeNull();
    expect(container.querySelector(".chapter")?.textContent?.trim()).toBe("");
  });
});

// Subchapters lay out IN PLACE (subchapter.tsx): a chapter page reads as one whole document rather
// than a table of links. A subchapter that is its OWN document (`- *: dogs`) is fetched per level —
// the projection never inlines a `*` reference at any single fetch depth.
describe("ChapterView — inline subchapters", () => {
  /** A chapter whose body is one prose chunk then one subchapter LINK marker at `:[2]`. */
  const withSub = (subPath: string): NodeJson => ({
    path: ":", type: "variant", format: "x-yamlover-chapter", concrete: "dir/yamlover",
    documentPath: ":", title: "Book", description: null,
    value: {
      $yamloverMixed: {
        kind: "omni", value: "Book", selfAt: 0,
        entries: [
          { key: null, value: { $yamloverLink: { kind: "scalar", type: "string", format: "text/marklower", path: ":[0]", value: "Opening." } } },
          { key: null, value: { $yamloverLink: { kind: "object", type: "object", format: "x-yamlover-chapter", path: subPath, title: "Dogs" } } },
        ],
      },
    },
  } as unknown as NodeJson);

  /** What the fetch of a subchapter returns: its own title + one chunk. */
  const subNode = (path: string, title: string, chunk: string, deeper?: unknown) => ({
    path, documentPath: path, type: "variant", format: "x-yamlover-chapter", concrete: "dir/yamlover",
    title, description: null,
    value: {
      $yamloverMixed: {
        kind: "omni", value: title, selfAt: 0,
        entries: [
          { key: null, value: { $yamloverLink: { kind: "scalar", type: "string", format: "text/marklower", path: `${path}[0]`, value: chunk } } },
          ...(deeper ? [{ key: null, value: deeper }] : []),
        ],
      },
    },
  });

  afterEach(() => { window.history.replaceState({}, "", "/"); });

  it("fetches the subchapter at depth 1 and lays its body out under an H2", async () => {
    fetchNode.mockResolvedValue(subNode(":dogs", "Dogs", "Dogs are good."));
    const { container } = render(<ChapterView node={withSub(":dogs")} onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("section.chapter-sub")).toBeTruthy());
    expect(fetchNode).toHaveBeenCalledWith(":dogs", 1);
    const sub = container.querySelector("section.chapter-sub")!;
    expect(sub.querySelector("h2.chapter-title")?.textContent).toBe("Dogs");
    expect(sub.textContent).toContain("Dogs are good.");
    expect(container.querySelector("a.descend")).toBeNull(); // laid out, not linked
  });

  it("anchors an inlined subchapter and its chunks by RENDER SLOT, and restarts §N", async () => {
    fetchNode.mockResolvedValue(subNode(":dogs", "Dogs", "Dogs are good."));
    const { container } = render(<ChapterView node={withSub(":dogs")} onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("section.chapter-sub")).toBeTruthy());
    // the subchapter sits at body index 1 of the page → its heading anchors at `[1]`
    expect(container.querySelector("h2.chapter-title")?.id).toBe("[1]");
    // its chunk is `[1][0]` — a slot chain, because `:dogs` is not under the page root `:`… but
    // the page root IS `:`, an ancestor of everything, so the path branch wins and gives `/dogs[0]`
    expect(document.getElementById("/dogs[0]")).not.toBeNull();
    // §N restarts inside the subchapter: the page's own chunk is §0 and so is the subchapter's
    const indices = Array.from(container.querySelectorAll(".chunk-index")).map((a) => a.textContent);
    expect(indices).toEqual(["§0", "§0"]);
  });

  it("?depth=1 keeps today's link — no fetch at all, SAME heading face (the depth-styling rule)", () => {
    window.history.replaceState({}, "", "/?depth=1");
    const { container } = render(<ChapterView node={withSub(":dogs")} onNavigate={vi.fn()} />);
    expect(fetchNode).not.toHaveBeenCalled();
    const link = container.querySelector("h2.chapter-title a.descend")!;
    expect(link.textContent).toBe("Dogs");
    expect(container.querySelector("h2.chapter-title")?.id).toBe("[1]"); // the anchor still resolves
  });

  it("?depth=2 inlines one level and leaves the next as a link", async () => {
    window.history.replaceState({}, "", "/?depth=2");
    const deeper = { $yamloverLink: { kind: "object", type: "object", format: "x-yamlover-chapter", path: ":dogs:puppies", title: "Puppies" } };
    fetchNode.mockResolvedValue(subNode(":dogs", "Dogs", "Dogs are good.", deeper));
    const { container } = render(<ChapterView node={withSub(":dogs")} onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("section.chapter-sub")).toBeTruthy());
    expect(container.querySelector("h2.chapter-title")?.textContent).toBe("Dogs"); // level 1 inlined
    const deep = container.querySelector("h3.chapter-title a.descend")!; // level 2 is a link, one rank down
    expect(deep.textContent).toBe("Puppies");
    expect(fetchNode).toHaveBeenCalledTimes(1); // and never fetched
  });

  it("shows the heading link immediately while the body is loading", () => {
    fetchNode.mockReturnValue(new Promise(() => {})); // never settles
    const { container } = render(<ChapterView node={withSub(":dogs")} onNavigate={vi.fn()} />);
    const head = container.querySelector("h2.chapter-title")!;
    expect(head.querySelector("a.descend")?.textContent).toBe("Dogs");
    expect(head.id).toBe("[1]"); // the anchor exists before the body lands
    expect(head.querySelector(".chapter-link-note")?.textContent?.trim()).toBe("…");
  });

  it("a failed load degrades to a navigable link with the reason", async () => {
    fetchNode.mockRejectedValue(new Error("boom"));
    const onNav = vi.fn();
    const { container } = render(<ChapterView node={withSub(":dogs")} onNavigate={onNav} />);
    await waitFor(() => expect(container.querySelector(".chapter-link-note")?.textContent).toContain("boom"));
    fireEvent.click(container.querySelector("a.descend")!);
    expect(onNav).toHaveBeenCalledWith(":dogs"); // still navigable
  });

  it("a POINTER CYCLE stops the recursion instead of fetching forever", () => {
    // the subchapter points back at the page root — an unguarded `.inf` budget would loop
    const { container } = render(<ChapterView node={withSub(":")} onNavigate={vi.fn()} />);
    expect(fetchNode).not.toHaveBeenCalled();
    expect(container.querySelector(".chapter-link-note")?.textContent).toContain("↻");
  });

  it("an INLINE subchapter (a container in the chapter's own source) needs no fetch", async () => {
    const inlineSub = {
      $yamloverMixed: {
        kind: "omni", value: "Cats", selfAt: 0,
        entries: [{ key: null, value: "Cats are fine." }],
      },
    };
    const node = {
      path: ":", type: "variant", format: "x-yamlover-chapter", concrete: "dir/yamlover", documentPath: ":",
      title: "Book", description: null,
      value: { $yamloverMixed: { kind: "omni", value: "Book", selfAt: 0, entries: [{ key: null, value: inlineSub }] } },
    } as unknown as NodeJson;
    const { container } = render(<ChapterView node={node} onNavigate={vi.fn()} />);
    expect(fetchNode).not.toHaveBeenCalled();
    const sub = container.querySelector("section.chapter-sub")!;
    expect(sub.querySelector("h2.chapter-title")?.textContent).toBe("Cats");
    expect(sub.textContent).toContain("Cats are fine.");
  });
});

// Once subchapters are laid out in place, a right-click may land INSIDE one — creating there must
// target that subchapter, not the page root.
describe("ChapterView — creating inside an inlined subchapter", () => {
  it("the context menu targets the nearest enclosing chapter", async () => {
    const page = {
      path: ":", type: "variant", format: "x-yamlover-chapter", concrete: "dir/yamlover", documentPath: ":",
      title: "Book", description: null,
      value: { $yamloverMixed: { kind: "omni", value: "Book", selfAt: 0, entries: [
        { key: null, value: { $yamloverLink: { kind: "object", type: "object", format: "x-yamlover-chapter", path: ":dogs", title: "Dogs" } } },
      ] } },
    } as unknown as NodeJson;
    fetchNode.mockResolvedValue({
      path: ":dogs", documentPath: ":dogs", type: "variant", format: "x-yamlover-chapter", concrete: "dir/yamlover",
      title: "Dogs", description: null,
      value: { $yamloverMixed: { kind: "omni", value: "Dogs", selfAt: 0, entries: [] } },
    });
    const { container } = render(<ChapterView node={page} onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("section.chapter-sub")).toBeTruthy());
    const sub = container.querySelector("section.chapter-sub")!;
    expect(sub.getAttribute("data-chapter-path")).toBe(":dogs"); // the create target the menu reads
  });
});
