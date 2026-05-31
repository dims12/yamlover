// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ChapterView } from "../../src/client/renderers/chapter";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);

// A chapter one level deep: prose blocks are scalar link markers (text in
// `value`); subchapters are container link markers carrying their `title`.
const chapter: NodeJson = {
  path: "/",
  type: "array",
  format: "x-yamlover-chapter",
  concrete: "yamlover",
  title: "The Handbook",
  description: "A friendly guide",
  value: [
    { $yamloverLink: { kind: "scalar", path: "[0]", value: "Welcome to the handbook." } },
    { $yamloverLink: { kind: "array", path: "[1]", title: "Installation", count: 2 } },
  ],
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

  it("renders prose as a paragraph and a subchapter as a title hyperlink", () => {
    const onNav = vi.fn();
    render(<ChapterView node={chapter} onNavigate={onNav} />);

    const prose = screen.getByText("Welcome to the handbook.");
    expect(prose.tagName).toBe("P"); // prose is a paragraph, not a link

    const link = screen.getByText("Installation"); // subchapter by its title
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("[1]");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith("[1]");
  });
});
