// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { inlineMd, domToMarklower } from "../../src/client/marklower-serialize";

/** Serialize the single element parsed from `html`. */
const one = (html: string): string => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return inlineMd(d.firstElementChild!);
};

describe("inlineMd — media becomes an embed token", () => {
  it("turns an allowlisted <img> into an embed, captioned by its alt", () => {
    expect(one('<img src="https://x.example/pic.png" alt="A cat">')).toBe("*[A cat](https://x.example/pic.png)");
    expect(one('<img src="https://x.example/pic.png">')).toBe("*[](https://x.example/pic.png)");
  });

  it("turns an allowlisted <iframe> into an embed, captioned by its title", () => {
    expect(one('<iframe src="https://www.youtube.com/embed/abc" title="Talk"></iframe>')).toBe("*[Talk](https://www.youtube.com/embed/abc)");
  });

  it("upgrades a protocol-relative src", () => {
    expect(one('<img src="//x.example/pic.png" alt="c">')).toBe("*[c](https://x.example/pic.png)");
  });

  it("drops media the allowlist refuses — an arbitrary framed origin, a relative src, a data: image", () => {
    expect(one('<iframe src="https://evil.example/x"></iframe>')).toBe("");
    expect(one('<img src="data:image/png;base64,AAAA" alt="pasted">')).toBe("");
  });

  // A site-relative `src` is a URL with no base, NOT a yamlover path — even though `resolveLink`
  // would happily read `/img/cat.png` as a document-relative node path and embed a node that
  // doesn't exist. `mediaSrc` is the guard.
  it("never mistakes a site-relative src for an in-app node path", () => {
    expect(one('<img src="/local/relative.png" alt="rel">')).toBe("");
    expect(one('<img src="../up/one.png" alt="rel">')).toBe("");
  });

  it("keeps an existing embed atom verbatim — data-src still wins over the tag", () => {
    const d = document.createElement("div");
    d.innerHTML = '<span class="mlw-atom" contenteditable="false" data-src="*[cat](https://youtu.be/abc)">▶ cat</span>';
    expect(domToMarklower(d)).toBe("*[cat](https://youtu.be/abc)");
  });

  it("leaves the emphasis and link mappings alone", () => {
    const d = document.createElement("div");
    d.innerHTML = 'a <b>bold</b> <a href="https://x.y">link</a>';
    expect(domToMarklower(d)).toBe("a **bold** [link](https://x.y)");
  });
});
