// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MarklowerChunk } from "../../src/client/renderers/marklower";
import type { Chunk } from "../../src/client/renderers/registry";

afterEach(cleanup);

const chunk = (value: unknown): Chunk => ({ value, path: "/chunks[0]", type: "string", format: null });

describe("marklower (the default format for bare strings)", () => {
  it("types plain prose through verbatim", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("just plain text")} />);
    expect(container.textContent).toBe("just plain text");
  });

  it("escapes HTML in plain prose (no raw markup injection)", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("a < b & c > d")} />);
    expect(container.textContent).toBe("a < b & c > d");
    expect(container.querySelector("b")).toBeNull(); // not parsed as a tag
  });

  it("typesets an inline $$…$$ span with KaTeX, leaving surrounding text", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("Einstein: $$E = mc^2$$ — neat")} />);
    // KaTeX wraps output in a .katex element; the source text remains around it
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).toContain("Einstein:");
    expect(container.textContent).toContain("neat");
  });

  it("handles two formulas without merging them", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("$$a$$ and $$b$$")} />);
    expect(container.querySelectorAll(".katex").length).toBe(2);
  });
});
