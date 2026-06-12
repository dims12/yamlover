// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TextView } from "../../src/client/renderers/text";
import { AsciidocView } from "../../src/client/renderers/asciidoc";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);

const node = (value: string, format: string): NodeJson => ({
  path: ":doc",
  type: "string",
  format,
  concrete: null,
  title: null,
  description: null,
  value,
});

describe("Markdown / AsciiDoc heading anchors", () => {
  it("the text renderer anchors a Markdown heading with a § link to its slug", () => {
    const { container } = render(<TextView node={node("# Hello World\n\nbody", "text/markdown")} />);
    const h1 = container.querySelector(".markup h1")!;
    expect(h1.id).toBe("hello-world");
    const a = h1.querySelector("a.header-anchor")!;
    expect(a.textContent).toBe("§");
    expect(a.getAttribute("href")).toBe("#hello-world");
  });

  it("the asciidoc renderer keeps Asciidoctor's section id and adds a § link", () => {
    const { container } = render(<AsciidocView node={node("== Intro\n\nbody", "text/asciidoc")} />);
    const h2 = container.querySelector(".markup h2")!;
    expect(h2.id).toBe("_intro"); // Asciidoctor's own section id, preserved
    expect(h2.querySelector("a.header-anchor")!.getAttribute("href")).toBe("#_intro");
  });
});
