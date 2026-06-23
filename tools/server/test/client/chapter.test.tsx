// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ChapterView } from "../../src/client/renderers/chapter";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);

// A chapter two levels deep: `chunks` are scalar link markers (text/markdown,
// text in `value`); `children` are object link markers carrying their `title`.
const chapter: NodeJson = {
  path: ":",
  type: "object",
  format: "x-yamlover-chapter",
  concrete: "dir/yamlover",
  title: "The Handbook",
  description: "A friendly guide",
  value: {
    chunks: [
      { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: ":chunks[0]", value: "Welcome to the handbook." } },
      { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: ":chunks[1]", value: "Read on." } },
    ],
    children: [
      { $yamloverLink: { kind: "object", type: "object", format: "x-yamlover-chapter", path: ":children[0]", title: "Installation", count: 2 } },
    ],
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

    // §N is an in-page fragment anchor whose syntax mirrors the chunk's SLASH path
    // continuation (README "flattened child" rule: `#/chunks[0]`), not a full-navigation link
    const idx0 = screen.getByText("§0") as HTMLAnchorElement;
    expect(idx0.getAttribute("href")).toBe("#/chunks[0]");
    expect((screen.getByText("§1") as HTMLAnchorElement).getAttribute("href")).toBe("#/chunks[1]");
    // the chunk element carries the matching id, so `<chapter>#/chunks[1]` scrolls to it
    expect(document.getElementById("/chunks[1]")).not.toBeNull();
    // clicking the in-page anchor does not trigger app navigation
    fireEvent.click(idx0);
    expect(onNav).not.toHaveBeenCalled();
  });

  it("routes a non-prose chunk to the renderer for its (type, format)", async () => {
    // a chapter whose body interleaves Markdown, an image, and a PlantUML diagram
    const mixed: NodeJson = {
      ...chapter,
      value: {
        chunks: [
          { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: ":chunks[0]", value: "Intro." } },
          { $yamloverLink: { kind: "binary", type: "binary", format: "image/png", path: ":chunks[1]", size: 1234 } },
          { $yamloverLink: { kind: "scalar", type: "string", format: "text/x-plantuml", path: ":chunks[2]", value: "@startuml\nA -> B\n@enduml" } },
        ],
        children: [],
      },
    };
    const { container } = render(<ChapterView node={mixed} onNavigate={vi.fn()} />);

    expect(screen.getByText("Intro.").tagName).toBe("P"); // markdown → markdown renderer
    // the image chunk routes to the (lazily loaded) pan/zoom image renderer — wait for
    // its container to mount (Leaflet builds the actual <img> itself, beyond jsdom)
    await waitFor(() => expect(container.querySelector(".fileimagemap")).not.toBeNull());
    // the diagram chunk is an <img> pointing at a PlantUML server, not the blob endpoint
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toMatch(/\/plantuml\/svg\//);
  });

  it("renders a subchapter as a title hyperlink", () => {
    const onNav = vi.fn();
    render(<ChapterView node={chapter} onNavigate={onNav} />);

    const link = screen.getByText("Installation"); // subchapter by its title
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe(":children[0]");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":children[0]");
  });
});
