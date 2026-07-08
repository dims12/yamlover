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
});
