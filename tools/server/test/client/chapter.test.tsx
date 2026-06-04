// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ChapterView } from "../../src/client/renderers/chapter";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);

// A chapter two levels deep: `chunks` are scalar link markers (text/markdown,
// text in `value`); `children` are object link markers carrying their `title`.
const chapter: NodeJson = {
  path: "/",
  type: "object",
  format: "x-yamlover-chapter",
  concrete: "yamlover",
  title: "The Handbook",
  description: "A friendly guide",
  value: {
    chunks: [
      { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: "/chunks[0]", value: "Welcome to the handbook." } },
      { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: "/chunks[1]", value: "Read on." } },
    ],
    children: [
      { $yamloverLink: { kind: "object", type: "object", format: "x-yamlover-chapter", path: "/children[0]", title: "Installation", count: 2 } },
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

  it("renders each chunk as a paragraph, numbered zero-based with a link to its node", () => {
    const onNav = vi.fn();
    render(<ChapterView node={chapter} onNavigate={onNav} />);

    const prose = screen.getByText("Welcome to the handbook.");
    expect(prose.tagName).toBe("P"); // a chunk is delegated to the text renderer → paragraph

    // the index §0 links to the chunk's own node
    const idx0 = screen.getByText("§0");
    expect((idx0 as HTMLAnchorElement).getAttribute("href")).toBe("/chunks[0]");
    expect(screen.getByText("§1")).toBeTruthy(); // second chunk numbered 1
    fireEvent.click(idx0);
    expect(onNav).toHaveBeenCalledWith("/chunks[0]");
  });

  it("routes a non-prose chunk to the renderer for its (type, format)", () => {
    // a chapter whose body interleaves Markdown, an image, and a PlantUML diagram
    const mixed: NodeJson = {
      ...chapter,
      value: {
        chunks: [
          { $yamloverLink: { kind: "scalar", type: "string", format: "text/markdown", path: "/chunks[0]", value: "Intro." } },
          { $yamloverLink: { kind: "binary", type: "binary", format: "image/png", path: "/chunks[1]", size: 1234 } },
          { $yamloverLink: { kind: "scalar", type: "string", format: "text/x-plantuml", path: "/chunks[2]", value: "@startuml\nA -> B\n@enduml" } },
        ],
        children: [],
      },
    };
    const { container } = render(<ChapterView node={mixed} onNavigate={vi.fn()} />);

    expect(screen.getByText("Intro.").tagName).toBe("P"); // markdown → text renderer
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBe(2); // the image chunk + the PlantUML diagram chunk
    // the image chunk points at its own node's blob
    expect(imgs[0].getAttribute("src")).toContain("/api/blob");
    expect(imgs[0].getAttribute("src")).toContain(encodeURIComponent("/chunks[1]"));
    // the diagram chunk points at a PlantUML server, not the blob endpoint
    expect(imgs[1].getAttribute("src")).toMatch(/\/plantuml\/svg\//);
  });

  it("renders a subchapter as a title hyperlink", () => {
    const onNav = vi.fn();
    render(<ChapterView node={chapter} onNavigate={onNav} />);

    const link = screen.getByText("Installation"); // subchapter by its title
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("/children[0]");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith("/children[0]");
  });
});
