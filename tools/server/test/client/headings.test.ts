// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { anchorizeHeadings, navigateToFragment } from "../../src/client/renderers/headings";
import { clearPresence, getTocPresence, publishPresence } from "../../src/client/toc-presence";

/** Parse the rewritten HTML so assertions read against a real DOM. */
function dom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = anchorizeHeadings(html);
  return el;
}

describe("anchorizeHeadings", () => {
  it("gives a heading a slug id and a leading § anchor link", () => {
    const el = dom("<h1>Hello World</h1>");
    const h = el.querySelector("h1")!;
    expect(h.id).toBe("hello-world");
    const a = h.querySelector("a.header-anchor")!;
    expect(a.textContent).toBe("§");
    expect(a.getAttribute("href")).toBe("#hello-world");
  });

  it("keeps an id already on the heading (e.g. Asciidoctor's section id)", () => {
    const el = dom('<h2 id="_intro">Intro</h2>');
    const h = el.querySelector("h2")!;
    expect(h.id).toBe("_intro");
    expect(h.querySelector("a.header-anchor")!.getAttribute("href")).toBe("#_intro");
  });

  it("de-duplicates colliding slugs within one document", () => {
    const el = dom("<h2>Notes</h2><h2>Notes</h2>");
    const ids = [...el.querySelectorAll("h2")].map((h) => h.id);
    expect(ids).toEqual(["notes", "notes-2"]);
  });

  it("slugs from text only, ignoring nested markup and punctuation", () => {
    const el = dom("<h3>A <code>code</code> &amp; more!</h3>");
    expect(el.querySelector("h3")!.id).toBe("a-code-more");
  });

  it("anchors every heading level h1–h6", () => {
    const html = "<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6>";
    expect(dom(html).querySelectorAll("a.header-anchor").length).toBe(6);
  });

  it("leaves a heading with no sluggable text un-anchored", () => {
    const el = dom("<h2>—</h2>");
    const h = el.querySelector("h2")!;
    expect(h.id).toBe("");
    expect(h.querySelector("a.header-anchor")).toBeNull();
  });

  it("passes through markup with no headings untouched", () => {
    const html = "<p>just a paragraph</p>";
    expect(anchorizeHeadings(html)).toBe(html);
  });
});

describe("navigateToFragment × toc-presence", () => {
  afterEach(() => {
    clearPresence();
    window.history.replaceState(null, "", "/");
  });

  it("pushes the hash and publishes the fragment even when nothing scrolls (jsdom)", () => {
    publishPresence(":", new Map([[":x", "/x"]]));
    navigateToFragment("/x"); // no element with that id, no scrollIntoView in jsdom
    expect(window.location.hash).toBe("#/x");
    expect(getTocPresence().currentPath).toBe(":x"); // the TOC shade moved regardless
  });

  it("a `#/` navigation scrolls the pane to the origin — not to a root anchor after a banner", () => {
    const pane = document.createElement("div");
    pane.className = "pane";
    pane.scrollTop = 400;
    const root = document.createElement("span");
    root.id = "/";
    pane.appendChild(root);
    document.body.appendChild(pane);
    try {
      navigateToFragment("/");
      expect(window.location.hash).toBe("#/");
      expect(pane.scrollTop).toBe(0);
    } finally {
      pane.remove();
    }
  });
});
