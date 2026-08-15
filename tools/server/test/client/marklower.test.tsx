// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { MarklowerChunk } from "../../src/client/renderers/marklower";
import type { Chunk } from "../../src/client/renderers/registry";

afterEach(cleanup);

const chunk = (value: unknown, documentPath?: string): Chunk => ({
  value,
  path: ":chunks[0]",
  type: "string",
  format: null,
  documentPath,
});
const noop = () => {};

describe("marklower (the default format for bare strings)", () => {
  it("types plain prose through verbatim", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("just plain text")} onNavigate={noop} />);
    expect(container.textContent).toBe("just plain text");
  });

  it("escapes HTML in plain prose (no raw markup injection)", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("a < b & c > d")} onNavigate={noop} />);
    expect(container.textContent).toBe("a < b & c > d");
    expect(container.querySelector("b")).toBeNull(); // not parsed as a tag
  });

  it("typesets an inline $$…$$ span with KaTeX, leaving surrounding text", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("Einstein: $$E = mc^2$$ — neat")} onNavigate={noop} />);
    // KaTeX wraps output in a .katex element; the source text remains around it
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).toContain("Einstein:");
    expect(container.textContent).toContain("neat");
  });

  it("handles two formulas without merging them", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("$$a$$ and $$b$$")} onNavigate={noop} />);
    expect(container.querySelectorAll(".katex").length).toBe(2);
  });

  it("styles **bold** / __bold__ as <strong> and *italic* / _italic_ as <em>", () => {
    const { container } = render(
      <MarklowerChunk chunk={chunk("**b1** __b2__ *i1* _i2_")} onNavigate={noop} />,
    );
    expect(container.querySelectorAll("strong")).toHaveLength(2);
    expect(container.querySelectorAll("em")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("b1");
    expect(container.querySelector("em")?.textContent).toBe("i1");
  });

  it("does not mistake a **bold** pair for two italics", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("**bold** not *it*")} onNavigate={noop} />);
    expect(container.querySelectorAll("strong")).toHaveLength(1);
    expect(container.querySelectorAll("em")).toHaveLength(1);
  });

  it("leaves an intra-word _ literal (snake_case ids stay whole - Markdown's rule)", () => {
    const { container } = render(
      <MarklowerChunk chunk={chunk("unquoted_scalar_appending and empty_cell_of_origin")} onNavigate={noop} />,
    );
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("unquoted_scalar_appending and empty_cell_of_origin");
  });

  it("keeps whole-word _italic_ and __bold__ working next to snake_case", () => {
    const { container } = render(
      <MarklowerChunk chunk={chunk("_it_ meets snake_case_id and __b__")} onNavigate={noop} />,
    );
    expect(container.querySelector("em")?.textContent).toBe("it");
    expect(container.querySelector("strong")?.textContent).toBe("b");
    expect(container.textContent).toContain("snake_case_id");
  });

  it("keeps snake_case whole inside a link label", () => {
    const { container } = render(
      <MarklowerChunk chunk={chunk("[unquoted_scalar_appending](:target)")} onNavigate={noop} />,
    );
    expect(container.querySelector("a")?.textContent).toBe("unquoted_scalar_appending");
    expect(container.querySelector("em")).toBeNull();
  });

  it("renders ~~strikethrough~~ as <del>", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("~~gone~~")} onNavigate={noop} />);
    expect(container.querySelector("del")?.textContent).toBe("gone");
  });

  it("renders `code` as a literal <code> span (no markup inside)", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("use `**not bold**` here")} onNavigate={noop} />);
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("**not bold**"); // contents kept literal
    expect(container.querySelector("strong")).toBeNull();
  });

  it("lets **bold** wrap a `code` span (the emphasis-over-tokens law)", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("the **`yamlover-fragments`** key")} onNavigate={noop} />);
    const strong = container.querySelector("strong");
    expect(strong?.querySelector("code")?.textContent).toBe("yamlover-fragments");
    expect(container.textContent).toBe("the yamlover-fragments key"); // no stray asterisks
  });

  it("lets *italic* span across a token with text on both sides", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("*see `x` too*")} onNavigate={noop} />);
    const em = container.querySelector("em");
    expect(em?.textContent).toBe("see x too");
    expect(em?.querySelector("code")?.textContent).toBe("x");
  });

  it("never pairs a marker inside a code span with one outside", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("a `*x` b *c*")} onNavigate={noop} />);
    expect(container.querySelector("code")?.textContent).toBe("*x"); // stays literal
    expect(container.querySelector("em")?.textContent).toBe("c"); // only the real pair styles
  });

  it("renders a link-less fragment token as a mark of its value", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("reads twice: [once to scan](), once to build")} onNavigate={noop} />);
    const mark = container.querySelector("mark.yo-inline-fragment");
    expect(mark?.textContent).toBe("once to scan");
    expect(container.textContent).toBe("reads twice: once to scan, once to build"); // no token chrome
  });

  it("hides a membership bookmark riding the token's label", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("a [&:: yamlover: ontos: colors: yellow: -: word]() here")} onNavigate={noop} />);
    expect(container.querySelector("mark.yo-inline-fragment")?.textContent).toBe("word");
    expect(container.textContent).toBe("a word here");
  });

  it("keeps a link as an emphasis boundary (labels style themselves instead)", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("**[a](*:b)** t")} onNavigate={noop} />);
    expect(container.querySelector("strong")).toBeNull(); // the pair spans a link — literal
    expect(container.textContent).toBe("**a** t");
  });

  it("resolves a `/path` link relative to the chunk's document", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <MarklowerChunk chunk={chunk("see [the intro](/chunks[0]) please", ":examples:book")} onNavigate={onNavigate} />,
    );
    const a = container.querySelector("a.descend") as HTMLAnchorElement;
    expect(a.textContent).toBe("the intro");
    expect(a.getAttribute("href")).toBe(":examples:book:chunks:0"); // document-relative
    fireEvent.click(a);
    expect(onNavigate).toHaveBeenCalledWith(":examples:book:chunks:0");
    expect(container.textContent).toContain("see ");
    expect(container.textContent).toContain(" please");
  });

  it("resolves a `//path` link relative to the project root", () => {
    const { container } = render(
      <MarklowerChunk chunk={chunk("[over there](//examples/other/chunks[1])", ":examples:book")} onNavigate={noop} />,
    );
    expect(container.querySelector("a.descend")?.getAttribute("href")).toBe(":examples:other:chunks:1");
  });

  it("renders an http(s) target as an external link", () => {
    const { container } = render(
      <MarklowerChunk chunk={chunk("[docs](https://example.com)", ":examples:book")} onNavigate={noop} />,
    );
    const a = container.querySelector("a.extlink") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://example.com");
  });

  it("styles a link's own label and keeps surrounding text", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("[**bold** link](/x)", ":doc")} onNavigate={noop} />);
    const a = container.querySelector("a.descend");
    expect(a?.querySelector("strong")?.textContent).toBe("bold");
  });

  it("allows a path (with [n] indices) as the link's own label", () => {
    const { container } = render(
      <MarklowerChunk chunk={chunk("see [:children[0]](:children[0])", ":doc")} onNavigate={noop} />,
    );
    const a = container.querySelector("a.descend") as HTMLAnchorElement;
    expect(a.textContent).toBe(":children[0]"); // label keeps its brackets
    expect(a.getAttribute("href")).toBe(":doc:children:0");
  });

  it("reflows a hard-wrapped source line: a single newline renders as a space", () => {
    // Block scalars are hard-wrapped for source readability; the reading width (markupWidthCh),
    // not the authored column, decides where a rendered line breaks.
    const { container } = render(<MarklowerChunk chunk={chunk("wrapped at the\nauthored column")} onNavigate={noop} />);
    expect(container.textContent).toBe("wrapped at the authored column");
  });

  it("keeps a blank line (it is the gap the author drew, shown by pre-wrap)", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("first\n\nsecond")} onNavigate={noop} />);
    expect(container.textContent).toBe("first\n\nsecond");
  });

  it("joins a soft-wrapped line across an inline token", () => {
    const { container } = render(
      <MarklowerChunk chunk={chunk("breaks before\n$$x$$\nand after")} onNavigate={noop} />,
    );
    expect(container.textContent).not.toContain("\n"); // one flowing sentence around the math
    expect(container.textContent).toContain("breaks before ");
    expect(container.textContent).toContain(" and after");
  });

  it("styles emphasis that spans a soft-wrapped line", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("**bold across\nlines**")} onNavigate={noop} />);
    expect(container.querySelector("strong")?.textContent).toBe("bold across lines");
  });

  it("leaves a non-link [bracketed] word in prose untouched", () => {
    const { container } = render(<MarklowerChunk chunk={chunk("a [note] and [go](/x)", ":doc")} onNavigate={noop} />);
    expect(container.querySelectorAll("a")).toHaveLength(1); // only the real link
    expect(container.textContent).toContain("a [note] and");
  });
});
