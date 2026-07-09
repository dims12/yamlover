// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { MarklowerChunk } from "../../src/client/renderers/marklower";

afterEach(cleanup);

const chunk = (value: string) => ({ value, type: "string", format: null, path: ":doc[1]", documentPath: ":doc" });
const draw = (src: string) => render(<MarklowerChunk chunk={chunk(src) as never} onNavigate={() => {}} />);

const YT = "https://youtu.be/dQw4w9WgXcQ";

describe("a marklower embed, rendered", () => {
  it("a token alone on its line is a captioned figure — and loads NO third-party frame until clicked", () => {
    const { container } = draw(`*[Rickroll](${YT})`);

    const figure = container.querySelector("figure.mlw-embed");
    expect(figure).not.toBeNull();
    expect(container.querySelector(".mlw-embed-caption")?.textContent).toBe("Rickroll");

    // the facade, not the player: no iframe exists before the reader asks for one
    expect(container.querySelector("iframe")).toBeNull();
    const facade = container.querySelector("button.mlw-embed-facade") as HTMLElement;
    expect(facade.style.backgroundImage).toContain("i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");

    fireEvent.click(facade);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
    expect(frame.getAttribute("src")).toContain("youtube-nocookie.com"); // the no-tracking host
  });

  it("the SAME token inside a sentence is an inline chip, expanding in place on click", () => {
    const { container } = draw(`watch *[this](${YT}) now`);
    expect(container.querySelector("figure.mlw-embed")).toBeNull();
    const chip = container.querySelector("button.mlw-embed-chip") as HTMLElement;
    expect(chip.textContent).toContain("this");

    fireEvent.click(chip);
    expect(container.querySelector(".mlw-embed-opened")).not.toBeNull();
    // opened INSIDE the paragraph, so it must not become a <figure>: the browser would hoist one
    // out of the <p> and scramble the sentence around it
    expect(container.querySelector("figure")).toBeNull();
    expect(container.querySelector("p.chapter-prose")).not.toBeNull();
  });

  it("a block embed wraps in a <div>, never a <p> (a <figure> inside a <p> is hoisted out)", () => {
    expect(draw(`*[x](${YT})`).container.querySelector("div.chapter-prose")).not.toBeNull();
    expect(draw("just prose").container.querySelector("p.chapter-prose")).not.toBeNull();
  });

  it("a block embed does not leave a blank line where its own line was", () => {
    // `.chapter-prose` preserves whitespace, so the newlines around the figure must not survive.
    const { container } = draw(`before\n\n*[x](${YT})\n\nafter`);
    // only the prose runs — the facade's own spans live inside the figure
    const text = Array.from(container.querySelectorAll(".chapter-prose > span")).map((s) => s.textContent).join("");
    expect(text).toBe("before\n\nafter"); // the figure's own line is gone, the blank line remains
  });

  it("a target off the allowlist degrades to the plain link it already was", () => {
    const { container } = draw("*[a page](https://evil.example/x)");
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".mlw-embed")).toBeNull();
    const a = container.querySelector("a.extlink")!;
    expect(a.getAttribute("href")).toBe("https://evil.example/x");
  });

  it("an image target renders as an image, not a player", () => {
    const { container } = draw("*[cat](https://x.example/cat.png)");
    expect(container.querySelector("img.mlw-embed-image")?.getAttribute("src")).toBe("https://x.example/cat.png");
  });
});
