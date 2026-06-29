// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { TextView } from "../../src/client/renderers/text";
import { AsciidocView } from "../../src/client/renderers/asciidoc";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);

const node = (value: string, format: string, path = ":doc"): NodeJson => ({
  path,
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

describe("Markdown / AsciiDoc relative links navigate in-app", () => {
  it("rewrites a relative Markdown link to its in-app path and navigates on click", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <TextView node={node("[go](sibling.md)", "text/markdown", ":dir:doc")} onNavigate={onNavigate} />,
    );
    const a = container.querySelector("a[data-navpath]") as HTMLAnchorElement;
    expect(a).toBeTruthy();
    expect(a.getAttribute("data-navpath")).toBe(":dir:sibling.md"); // anchored at the document's directory
    expect(a.getAttribute("href")).toBe(":dir:sibling.md");
    fireEvent.click(a);
    expect(onNavigate).toHaveBeenCalledWith(":dir:sibling.md"); // SPA nav, no page reload
  });

  it("resolves `..` against the document directory", () => {
    const { container } = render(
      <TextView node={node("[up](../up.md)", "text/markdown", ":dir:doc")} onNavigate={vi.fn()} />,
    );
    expect(container.querySelector("a[data-navpath]")!.getAttribute("data-navpath")).toBe(":up.md");
  });

  it("leaves external, server-root, and fragment links untouched (no in-app nav)", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <TextView
        node={node("[x](https://example.com) [y](/root) [z](#sec)", "text/markdown", ":dir:doc")}
        onNavigate={onNavigate}
      />,
    );
    expect(container.querySelector("a[data-navpath]")).toBeNull(); // none rewritten
    const ext = [...container.querySelectorAll("a")].find((a) => a.textContent === "x")!;
    expect(ext.getAttribute("href")).toBe("https://example.com");
  });

  it("rewrites a relative AsciiDoc link too", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <AsciidocView node={node("link:sibling.adoc[go]", "text/asciidoc", ":dir:doc")} onNavigate={onNavigate} />,
    );
    const a = container.querySelector("a[data-navpath]") as HTMLAnchorElement;
    expect(a.getAttribute("data-navpath")).toBe(":dir:sibling.adoc");
    fireEvent.click(a);
    expect(onNavigate).toHaveBeenCalledWith(":dir:sibling.adoc");
  });
});
