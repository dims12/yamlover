// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { embed, isEmbeddable } from "../../src/client/embed";
import { marklowerToEditableHtml } from "../../src/client/renderers/marklower";

describe("embed — providers", () => {
  it("claims every spelling YouTube hands out, and frames it on the no-cookie host", () => {
    const spellings = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
    ];
    for (const url of spellings) {
      expect(embed(url), url).toEqual({
        kind: "iframe",
        provider: "youtube",
        src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        poster: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      });
    }
  });

  it("carries a start offset through, in either spelling", () => {
    expect(embed("https://youtu.be/abc?t=90")).toMatchObject({ src: expect.stringContaining("?start=90") });
    expect(embed("https://youtu.be/abc?t=90s")).toMatchObject({ src: expect.stringContaining("?start=90") });
    expect(embed("https://youtu.be/abc?t=1m30s")).toMatchObject({ src: expect.stringContaining("?start=90") });
    expect(embed("https://youtu.be/abc?t=1h2m3s")).toMatchObject({ src: expect.stringContaining("?start=3723") });
    expect(embed("https://www.youtube.com/watch?v=abc&start=5")).toMatchObject({ src: expect.stringContaining("?start=5") });
  });

  it("claims Vimeo, with do-not-track on", () => {
    expect(embed("https://vimeo.com/123456")).toEqual({
      kind: "iframe",
      provider: "vimeo",
      src: "https://player.vimeo.com/video/123456?dnt=1",
      poster: null,
    });
    expect(embed("https://player.vimeo.com/video/123456")).toMatchObject({ provider: "vimeo" });
  });

  it("does not mistake a channel, a search, or a lookalike host for a video", () => {
    expect(embed("https://www.youtube.com/@someone")).toBeNull();
    expect(embed("https://www.youtube.com/results?search_query=cats")).toBeNull();
    expect(embed("https://youtube.com.evil.example/watch?v=abc")).toBeNull();
    expect(embed("https://vimeo.com/staffpicks")).toBeNull();
  });
});

describe("embed — bare media", () => {
  it("routes an external media file by extension", () => {
    expect(embed("https://x.example/clip.mp4")).toEqual({ kind: "video", src: "https://x.example/clip.mp4" });
    expect(embed("https://x.example/song.mp3")).toEqual({ kind: "audio", src: "https://x.example/song.mp3" });
    expect(embed("https://x.example/pic.PNG")).toEqual({ kind: "image", src: "https://x.example/pic.PNG" });
  });

  it("streams an in-app node from the blob endpoint, keeping its path for click-through", () => {
    const spec = embed("::media:clip.webm");
    expect(spec).toMatchObject({ kind: "video", path: ":media:clip.webm" });
    expect(spec!.src).toContain("/api/blob?path=");
  });
});

describe("isEmbeddable", () => {
  // The serializers ask the allowlist a yes/no question; they must never disagree with the resolver
  // about the answer, or a pasted embed becomes a token the renderer refuses to inline.
  it("agrees with embed() on every target", () => {
    const targets = [
      "https://youtu.be/abc",
      "https://www.youtube.com/embed/abc",
      "https://vimeo.com/123456",
      "https://x.example/clip.mp4",
      "https://x.example/pic.PNG",
      "::media:clip.webm",
      "https://evil.example/anything",
      "https://cdn.x/render?id=7",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "mailto:a@b.c",
      "",
      "not a target",
    ];
    for (const t of targets) expect(isEmbeddable(t), t).toBe(embed(t) !== null);
  });

  it("rejects the data: URL a browser inserts when an image is pasted into a contentEditable", () => {
    expect(isEmbeddable("data:image/png;base64,AAAA")).toBe(false);
  });
});

describe("the embed token vs. emphasis", () => {
  // The one ambiguity `*` buys us: a leading `*` starts an embed, but it may equally be the opening
  // marker of an italic run that happens to wrap a link. The trailing `*` decides.
  const chip = (src: string) => marklowerToEditableHtml(src).includes("mlw-embed-chip");
  const link = (src: string) => marklowerToEditableHtml(src).includes("mlw-link");

  it("*[a](b) is an embed", () => expect(chip("*[cat](https://youtu.be/abc)")).toBe(true));
  it("*[a](b)* is an italic link, not an embed", () => {
    expect(chip("*[cat](https://youtu.be/abc)*")).toBe(false);
    expect(link("*[cat](https://youtu.be/abc)*")).toBe(true);
  });
  it("**[a](b)** is a bold link, not an embed", () => {
    expect(chip("**[cat](https://youtu.be/abc)**")).toBe(false);
    expect(link("**[cat](https://youtu.be/abc)**")).toBe(true);
  });
  it("leaves plain links and plain emphasis exactly as they were", () => {
    expect(marklowerToEditableHtml("[cat](:x)")).toContain('data-src="[cat](:x)"');
    expect(marklowerToEditableHtml("*cat*")).toContain("<em>cat</em>");
  });
});

describe("embed — the allowlist is the security boundary", () => {
  it("refuses to frame an arbitrary origin, a non-http scheme, or a nonsense target", () => {
    expect(embed("https://evil.example/anything")).toBeNull(); // an ordinary page — never an iframe
    expect(embed("javascript:alert(1)")).toBeNull();
    expect(embed("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(embed("mailto:a@b.c")).toBeNull();
    expect(embed("")).toBeNull();
    expect(embed("not a target")).toBeNull();
  });
});
