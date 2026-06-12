// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { htmlToRich, resolveImages, countImages, RichDraft } from "../../src/client/paste-html";

afterEach(() => vi.unstubAllGlobals());

describe("htmlToRich", () => {
  it("returns null for formatted text with no images and no headings (plain text serves it)", () => {
    expect(htmlToRich("<p>just <b>bold</b> and <a href='https://x.y'>links</a></p>")).toBeNull();
    expect(htmlToRich("plain words")).toBeNull();
  });

  it("a Wikipedia-like selection: intro, image, nested headings → chunks + subchapter tree", () => {
    const rich = htmlToRich(
      `<p>The <b>cat</b> is a <a href="https://en.wikipedia.org/wiki/Felidae">felid</a>.</p>
       <figure><img src="//upload.wikimedia.org/cat.jpg" alt="A cat"><figcaption>A domestic cat</figcaption></figure>
       <h2>Etymology<span>[edit]</span></h2>
       <p>From Latin <i>cattus</i>.</p>
       <h3>Disputed origins</h3>
       <p>Possibly Afroasiatic.</p>
       <h2>Biology</h2>
       <p>Cats have retractable claws.</p>`,
    )!;
    expect(rich.chunks).toEqual([
      { text: "The **cat** is a [felid](https://en.wikipedia.org/wiki/Felidae)." },
      { image: { url: "https://upload.wikimedia.org/cat.jpg", alt: "A cat" } }, // protocol-relative → https
      { text: "A domestic cat" },
    ]);
    expect(rich.children.map((c) => c.title)).toEqual(["Etymology", "Biology"]); // [edit] stripped
    expect(rich.children[0].chunks).toEqual([{ text: "From Latin *cattus*." }]);
    expect(rich.children[0].children.map((c) => c.title)).toEqual(["Disputed origins"]); // h3 nests under h2
    expect(rich.children[0].children[0].chunks).toEqual([{ text: "Possibly Afroasiatic." }]);
    expect(rich.children[1].chunks).toEqual([{ text: "Cats have retractable claws." }]);
    expect(countImages(rich)).toBe(1);
  });

  it("bullets merge into one list chunk; pre becomes a fenced block; br keeps the line break", () => {
    const rich = htmlToRich("<h2>T</h2><ul><li>one</li><li>two</li></ul><pre>code()\n  more</pre><p>a<br>b</p>")!;
    expect(rich.children[0].chunks).toEqual([
      { text: "- one\n- two" },
      { text: "```\ncode()\n  more\n```" },
      { text: "a\nb" },
    ]);
  });

  it("an image inside a link still becomes its own chunk; relative srcs are dropped", () => {
    const rich = htmlToRich('<h2>T</h2><a href="https://a.b"><img src="https://a.b/i.png" alt=""></a><img src=":w:rel.png">')!;
    expect(rich.children[0].chunks).toEqual([{ image: { url: "https://a.b/i.png", alt: "" } }]);
  });
});

describe("resolveImages", () => {
  const draft: RichDraft = {
    chunks: [{ text: "intro" }, { image: { url: "https://upload.wikimedia.org/wikipedia/commons/9/9a/Cat03.jpg", alt: "A cat" } }],
    children: [{ title: "Sub", chunks: [{ image: { url: "https://x.y/gone.png", alt: "lost" } }], children: [] }],
  };

  it("downloads images into inline file chunks; a failed fetch degrades to a marklower link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) =>
        url.includes("Cat03")
          ? { ok: true, blob: async () => new Blob(["JPG"], { type: "image/jpeg" }) }
          : { ok: false, status: 403 },
      ),
    );
    const rich = await resolveImages(draft);
    expect(rich.chunks[0]).toEqual({ text: "intro" });
    const file = (rich.chunks[1] as { file: { name: string; contentBase64: string } }).file;
    expect(file.name).toBe("Cat03.jpg");
    expect(atob(file.contentBase64)).toBe("JPG");
    expect(rich.children[0].chunks[0]).toEqual({ text: "![lost](https://x.y/gone.png)" }); // the reference survives
  });

  it("synthesizes a name with an extension when the URL has none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["PNG"], { type: "image/png" }) }));
    const rich = await resolveImages({ chunks: [{ image: { url: "https://cdn.x/render?id=7", alt: "" } }], children: [] });
    expect((rich.chunks[0] as { file: { name: string } }).file.name).toBe("render.png");
  });
});
