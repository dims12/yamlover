// @vitest-environment jsdom
// THE TOC PRESENCE BUS (src/client/toc-presence.ts): the content pane publishes which nodes
// it renders inline and which one the URL #fragment names; the TOC shades from it. Tested
// here: the store's snapshot stability contract, fragment resolution through the reverse
// map, and the publisher hook's "really rendered" DOM-scan rules.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useRef } from "react";
import {
  clearPresence, getTocPresence, publishCurrentFragment, publishPresence, useTocPresencePublisher,
} from "../../src/client/toc-presence";

afterEach(() => {
  cleanup();
  clearPresence();
  window.history.replaceState(null, "", "/");
});

describe("the store", () => {
  it("swaps the snapshot only when something actually changed", () => {
    publishPresence(":", new Map([[":a", "/a"]]));
    const s1 = getTocPresence();
    publishPresence(":", new Map([[":a", "/a"]])); // identical re-scan
    expect(getTocPresence()).toBe(s1); // same object — memo'd TOC branches stay put
    publishPresence(":", new Map([[":a", "/a"], [":b", "/b"]]));
    expect(getTocPresence()).not.toBe(s1);
    expect(getTocPresence().anchors.get(":b")).toBe("/b");
  });

  it("resolves the current fragment through the reverse map — in either arrival order", () => {
    publishCurrentFragment("/a"); // fragment first, anchors later (a lazy landing)
    expect(getTocPresence().currentPath).toBeNull();
    publishPresence(":", new Map([[":a", "/a"]]));
    expect(getTocPresence().currentPath).toBe(":a");
    publishCurrentFragment("/nosuch"); // an id no scan knows — held, unresolved
    expect(getTocPresence().currentPath).toBeNull();
    publishCurrentFragment(null);
    expect(getTocPresence().currentPath).toBeNull();
  });

  it("clearPresence resets everything", () => {
    publishPresence(":", new Map([[":a", "/a"]]));
    publishCurrentFragment("/a");
    clearPresence();
    expect(getTocPresence()).toMatchObject({ base: null, currentPath: null });
    expect(getTocPresence().anchors.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------- //
// the publisher hook — the DOM scan against a hand-built content pane
// ---------------------------------------------------------------------------- //

function Publisher({ base, html }: { base: string | null; html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useTocPresencePublisher(ref, base, html);
  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

describe("the publisher's scan", () => {
  it("chunk shells, sections WITH bodies, and frag-anchors publish; lone link-face sections do not", () => {
    render(
      <Publisher
        base=":book"
        html={
          '<div class="chunk" id="/3" data-node-path=":book:3">text</div>' +
          '<section class="chapter-sub" data-chapter-path=":book:intro">' +
          '  <h2 class="chapter-title" id="/intro">Intro</h2>' +
          "  <div>the inlined body</div>" +
          "</section>" +
          '<section class="chapter-sub" data-chapter-path=":book:appendix">' +
          '  <h2 class="chapter-title" id="/appendix">Appendix (a collapsed link)</h2>' +
          "</section>" +
          '<span class="frag-anchor" id="/data/x" data-node-path=":book:data:x"></span>' +
          '<span class="frag-anchor" id="/no/path"></span>'
        }
      />,
    );
    const p = getTocPresence();
    expect(p.base).toBe(":book");
    expect(p.anchors.get(":book:3")).toBe("/3");
    expect(p.anchors.get(":book:intro")).toBe("/intro");
    expect(p.anchors.has(":book:appendix")).toBe(false); // the lone heading is the LINK face
    expect(p.anchors.get(":book:data:x")).toBe("/data/x");
    expect(p.anchors.size).toBe(3); // the pathless anchor never lands
  });

  it("first occurrence wins on a duplicated path", () => {
    render(
      <Publisher
        base=":"
        html={
          '<span class="frag-anchor" id="/first" data-node-path=":a"></span>' +
          '<span class="frag-anchor" id="/second" data-node-path=":a"></span>'
        }
      />,
    );
    expect(getTocPresence().anchors.get(":a")).toBe("/first");
  });

  it("seeds the current fragment from the URL hash (a deep link shades from the start)", () => {
    window.history.replaceState(null, "", "/#/a");
    render(<Publisher base=":" html={'<span class="frag-anchor" id="/a" data-node-path=":a"></span>'} />);
    expect(getTocPresence().currentPath).toBe(":a");
  });

  it("base null publishes nothing; unmount clears", () => {
    const { rerender, unmount } = render(<Publisher base={null} html="" />);
    expect(getTocPresence().base).toBeNull();
    rerender(<Publisher base=":" html={'<span class="frag-anchor" id="/a" data-node-path=":a"></span>'} />);
    expect(getTocPresence().base).toBe(":");
    unmount();
    expect(getTocPresence().base).toBeNull();
  });

  it("a DOM mutation re-scans after the debounce", async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <Publisher base=":" html={'<span class="frag-anchor" id="/a" data-node-path=":a"></span>'} />,
      );
      expect(getTocPresence().anchors.has(":b")).toBe(false);
      const extra = document.createElement("span");
      extra.className = "frag-anchor";
      extra.id = "/b";
      extra.dataset.nodePath = ":b";
      container.firstElementChild!.appendChild(extra); // childList mutation under the root
      await act(async () => { await vi.runAllTimersAsync(); }); // MutationObserver task + 200ms debounce
      expect(getTocPresence().anchors.get(":b")).toBe("/b");
    } finally {
      vi.useRealTimers();
    }
  });
});
