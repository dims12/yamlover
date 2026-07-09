// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ChapterView } from "../../src/client/renderers/chapter";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);

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

  it("renders a subchapter as a title hyperlink", () => {
    const onNav = vi.fn();
    render(<ChapterView node={chapter} onNavigate={onNav} />);

    const link = screen.getByText("Installation"); // subchapter by its title
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe(":[3]");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":[3]");
  });

  it("renders title, description, subchapters and chunks in SOURCE order — heading not hoisted, text after a subchapter", () => {
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
    const blocks = [...container.querySelectorAll("h1.chapter-title, .chapter-link a, .chunk-body p")];
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
