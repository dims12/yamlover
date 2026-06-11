// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { arxivPdf, tweetUrl, fetchTweetText } from "../../src/client/paste-links";

afterEach(() => vi.unstubAllGlobals());

describe("arxivPdf", () => {
  it("recognizes a lone arXiv link in every shape — and only that", () => {
    const PDF = { url: "https://arxiv.org/pdf/2605.00615", name: "arxiv-2605.00615.pdf" };
    expect(arxivPdf("https://arxiv.org/abs/2605.00615")).toEqual(PDF);
    expect(arxivPdf("  http://www.arxiv.org/pdf/2605.00615.pdf\n")).toEqual(PDF); // trimmed, .pdf dropped
    expect(arxivPdf("https://arxiv.org/html/2605.00615?context=cs.LG")).toEqual(PDF); // query dropped
    expect(arxivPdf("https://arxiv.org/abs/2605.00615v3")).toEqual({
      url: "https://arxiv.org/pdf/2605.00615v3",
      name: "arxiv-2605.00615v3.pdf",
    });
    expect(arxivPdf("https://arxiv.org/abs/math/0211159")).toEqual({
      url: "https://arxiv.org/pdf/math/0211159",
      name: "arxiv-math-0211159.pdf", // old-style id: the slash can't be a filename
    });

    expect(arxivPdf("see https://arxiv.org/abs/2605.00615 for details")).toBeNull(); // prose stays text
    expect(arxivPdf("https://arxiv.org/list/cs.LG/recent")).toBeNull(); // not a paper
    expect(arxivPdf("https://example.org/abs/2605.00615")).toBeNull();
    expect(arxivPdf("2605.00615")).toBeNull(); // a bare number is just text
  });
});

describe("tweetUrl", () => {
  it("recognizes a lone status link on either host, canonicalized", () => {
    const T = "https://twitter.com/tsoding/status/2065098226374443051";
    expect(tweetUrl("https://x.com/tsoding/status/2065098226374443051")).toBe(T);
    expect(tweetUrl("  twitter.com/tsoding/status/2065098226374443051\n")).toBe(T);
    expect(tweetUrl("https://mobile.twitter.com/tsoding/statuses/2065098226374443051")).toBe(T);
    expect(tweetUrl("https://x.com/tsoding/status/2065098226374443051?s=20&t=abc")).toBe(T); // tracking dropped
    expect(tweetUrl("https://x.com/tsoding/status/2065098226374443051/photo/1")).toBe(T);

    expect(tweetUrl("look: https://x.com/tsoding/status/2065098226374443051")).toBeNull(); // prose stays text
    expect(tweetUrl("https://x.com/tsoding")).toBeNull(); // a profile is not a message
    expect(tweetUrl("https://x.com/tsoding/status/notanid")).toBeNull();
  });
});

describe("fetchTweetText", () => {
  // the real payload shape for x.com/tsoding/status/2065098226374443051 (publish.x.com/oembed)
  const OEMBED = {
    url: "https://x.com/tsoding/status/2065098226374443051",
    author_name: "Тsфdiиg",
    author_url: "https://x.com/tsoding",
    html:
      '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">claude code spawning subagents' +
      ' <a href="https://t.co/pS4niZRx0V">pic.twitter.com/pS4niZRx0V</a></p>&mdash; Тsфdiиg (@tsoding)' +
      ' <a href="https://x.com/tsoding/status/2065098226374443051?ref_src=twsrc%5Etfw">June 11, 2026</a></blockquote>\n\n',
  };

  it("composes the whole message + attribution + link from the oEmbed payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => OEMBED });
    vi.stubGlobal("fetch", fetchMock);

    const text = await fetchTweetText("https://twitter.com/tsoding/status/2065098226374443051");
    expect(text).toBe(
      "claude code spawning subagents pic.twitter.com/pS4niZRx0V\n" +
        "\n" +
        "— Тsфdiиg @tsoding, June 11, 2026\n" +
        "https://x.com/tsoding/status/2065098226374443051",
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://publish.x.com/oembed?url=" +
        encodeURIComponent("https://twitter.com/tsoding/status/2065098226374443051") +
        "&omit_script=true&dnt=true",
    );
  });

  it("keeps a multiline tweet's line breaks (<br> → newline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...OEMBED, html: '<blockquote><p>first line<br>second line</p>&mdash; A <a href="#">June 1, 2026</a></blockquote>' }),
      }),
    );
    const text = await fetchTweetText("https://twitter.com/a/status/1");
    expect(text.startsWith("first line\nsecond line\n")).toBe(true);
  });

  it("throws on an oEmbed error or an empty payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchTweetText("https://twitter.com/a/status/1")).rejects.toThrow(/HTTP 404/);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ html: "" }) }));
    await expect(fetchTweetText("https://twitter.com/a/status/1")).rejects.toThrow(/no tweet text/);
  });
});
