// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { MarklowerChunk } from "../../src/client/renderers/marklower";

afterEach(cleanup);

const chunk = (value: string) => ({ value, type: "string", format: null, path: ":doc[1]", documentPath: ":doc" });
const draw = (src: string) => render(<MarklowerChunk chunk={chunk(src) as never} onNavigate={() => {}} />);

const YT = "https://youtu.be/dQw4w9WgXcQ";

describe("body-level media, rendered", () => {
  // Embedding is structural (docs/documents/marklower/embeds): a chunk whose ENTIRE text is one
  // embeddable target renders as a figure. There is no text-level embed token any more.

  it("a chunk that IS the URL is a captionless figure — and loads NO third-party frame until clicked", () => {
    const { container } = draw(YT);

    const figure = container.querySelector("figure.mlw-embed");
    expect(figure).not.toBeNull();
    expect(container.querySelector(".mlw-embed-caption")).toBeNull(); // a media chunk has no caption

    // the facade, not the player: no iframe exists before the reader asks for one
    expect(container.querySelector("iframe")).toBeNull();
    const facade = container.querySelector("button.mlw-embed-facade") as HTMLElement;
    expect(facade.style.backgroundImage).toContain("i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");

    fireEvent.click(facade);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
    expect(frame.getAttribute("src")).toContain("youtube-nocookie.com"); // the no-tracking host
  });

  it("surrounding whitespace does not unmake the media chunk", () => {
    const { container } = draw(`  ${YT}\n`);
    expect(container.querySelector("figure.mlw-embed")).not.toBeNull();
  });

  it("the SAME URL inside a sentence is plain prose — never a figure, never a frame", () => {
    const { container } = draw(`watch ${YT} now`);
    expect(container.querySelector("figure")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("button")).toBeNull(); // no facade, no chip — nothing clickable
    const p = container.querySelector("p.chapter-prose")!;
    expect(p.textContent).toBe(`watch ${YT} now`); // the URL is just text
  });

  it("a prose chunk always wraps in <p class=\"chapter-prose\">", () => {
    expect(draw("just prose").container.querySelector("p.chapter-prose")).not.toBeNull();
    // a link token stays inline prose too — a chunk with ANY prose around a target is not media
    const { container } = draw(`see [this](${YT})`);
    expect(container.querySelector("p.chapter-prose")).not.toBeNull();
    expect(container.querySelector("figure")).toBeNull();
  });

  it("a target off the allowlist degrades to prose, not a figure", () => {
    const { container } = draw("https://evil.example/x");
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".mlw-embed")).toBeNull();
    const p = container.querySelector("p.chapter-prose")!;
    expect(p.textContent).toBe("https://evil.example/x");
  });

  it("an image-URL chunk renders as an image figure, not a player", () => {
    const { container } = draw("https://x.example/cat.png");
    expect(container.querySelector("figure.mlw-embed")).not.toBeNull();
    expect(container.querySelector("img.mlw-embed-image")?.getAttribute("src")).toBe("https://x.example/cat.png");
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });
});
