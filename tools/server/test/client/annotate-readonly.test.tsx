// @vitest-environment jsdom
// READ-ONLY is its own file because `READ_ONLY` is a module constant resolved at import time —
// the rest of the annotation suite runs writable, and one process cannot hold both.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";

vi.mock("../../src/client/base", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  READ_ONLY: true,
}));

const { fetchNode } = vi.hoisted(() => ({ fetchNode: vi.fn() }));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchNode }));

import { AnnotatedMaterial } from "../../src/client/renderers/annotate";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Select `world` inside the rendered prose. */
function select(container: HTMLElement): void {
  const text = container.querySelector("p")!.firstChild!;
  const sel = window.getSelection()!;
  const r = document.createRange();
  r.setStart(text, 6);
  r.setEnd(text, 11);
  (r as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({ left: 10, bottom: 10 }) as DOMRect;
  sel.removeAllRanges();
  sel.addRange(r);
}

const material = (
  <AnnotatedMaterial path=":doc"><p className="chapter-prose">hello world foo</p></AnnotatedMaterial>
);

describe("a read-only reader can still get text off the page", () => {
  // THE DEAD END this fixes: the tag popup only ever opens to write, so read-only bails out of
  // it — but the handler suppressed the NATIVE menu first. The result was a page with no menu at
  // all: no Copy, no Search, nothing.
  it("leaves the native context menu alone — it is the only menu there is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "no" }) }) as Response));
    const { container } = render(material);
    select(container);

    const target = container.querySelector("p")!;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    fireEvent(target, ev);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(ev.defaultPrevented).toBe(false); // the browser gets to draw its own menu
    expect(container.querySelector(".annotate-menu")).toBeNull(); // and ours stays away
  });

  it("leaves the SELECTION alone, so the native Ctrl+C still has something to copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "no" }) }) as Response));
    const { container } = render(material);
    select(container);
    fireEvent.mouseUp(container.querySelector(".annotated > div")!, { button: 0, clientX: 10, clientY: 10 });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // no popup means no query cells, and no query cells means nothing stole the one selection
    expect(container.querySelector(".annotate-menu")).toBeNull();
    expect(window.getSelection()!.toString()).toBe("world");
  });
});
