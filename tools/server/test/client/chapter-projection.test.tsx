// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

// The projection fetches its own node (host.ts) and drives /api/edit through the op queue.
const { fetchNode, editChunks } = vi.hoisted(() => ({ fetchNode: vi.fn(), editChunks: vi.fn() }));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchNode, editChunks }));

import { ChapterProjection, ChapterFormatControl } from "../../src/client/renderers/chapter-editor/view";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);
beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset();
});

const mixed = (o: Record<string, unknown>) => ({ $yamloverMixed: { kind: "mix", entries: [], ...o } });

/** A chapter node fetched by the host: title (self-value), optional description, prose body, and an
 *  optional inline subchapter. */
function chapterNode(opts: { title?: string; description?: string; body?: unknown[] } = {}): NodeJson {
  const entries: { key: string | null; value: unknown }[] = [];
  if (opts.description) entries.push({ key: "description", value: opts.description });
  for (const v of opts.body ?? []) entries.push({ key: null, value: v });
  return {
    path: ":doc", type: "object", concrete: "dir/yamlover", documentPath: ":doc", title: null, description: null,
    value: mixed({ kind: "omni", value: opts.title ?? "", selfAt: 0, format: "x-yamlover-chapter", entries }),
    comments: { "": { tag: "!!<*yamlover: $defs: chapter>" } },
  } as unknown as NodeJson;
}

/** Render the projection, wait for the async fetch/model to settle, and return the container. */
async function renderProjection(node: NodeJson) {
  fetchNode.mockResolvedValue(node);
  const utils = render(<ChapterProjection path=":doc" onNavigate={vi.fn()} />);
  await waitFor(() => expect(utils.container.querySelector("h1.chapter-title")).toBeTruthy());
  return utils;
}

/** Flush the op queue's 500ms debounce and return the last batch sent. */
async function flush() {
  await act(async () => { vi.advanceTimersByTime(600); await Promise.resolve(); });
  return editChunks.mock.calls.at(-1)?.[0];
}

describe("ChapterProjection — structure", () => {
  it("draws the title as an editable h1 and the description as a subtitle", async () => {
    const { container } = await renderProjection(chapterNode({ title: "Book", description: "a guide" }));
    expect(container.querySelector("h1.chapter-title")?.textContent).toBe("Book");
    expect(container.querySelector("p.chapter-subtitle")?.textContent).toBe("a guide");
    expect(container.querySelector("h1.chapter-title")?.getAttribute("contenteditable")).toBe("true");
  });

  it("draws prose paragraphs as editable marklower, and a subchapter as an inline <section>", async () => {
    const sub = mixed({ kind: "omni", value: "Dogs", selfAt: 0, format: "x-yamlover-chapter", entries: [{ key: null, value: "woof" }] });
    const { container } = await renderProjection(chapterNode({ title: "Book", body: ["opening", sub] }));
    const paras = container.querySelectorAll(".chunk-body .chapter-prose");
    expect(paras[0].textContent).toBe("opening");
    const section = container.querySelector("section.chapter-sub")!;
    expect(section).toBeTruthy();
    expect(section.querySelector("h2.chapter-title")?.textContent).toBe("Dogs"); // one level down
    expect(section.querySelector(".chapter-prose")?.textContent).toBe("woof");
  });

  it("opens with the caret in the title — no click to begin", async () => {
    const { container } = await renderProjection(chapterNode({ title: "Book" }));
    expect(document.activeElement).toBe(container.querySelector("h1.chapter-title"));
  });
});

describe("ChapterProjection — editing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const renderSync = (node: NodeJson) => {
    fetchNode.mockResolvedValue(node);
    const utils = render(<ChapterProjection path=":doc" onNavigate={vi.fn()} />);
    return utils;
  };
  /** Let the host's fetch promise resolve and the model build. */
  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it("typing in a paragraph queues ONE coalesced emplace, keeping it bare", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["hi"] }));
    await settle();
    const p = utils.container.querySelector(".chapter-prose") as HTMLElement;
    p.textContent = "hello there";
    fireEvent.input(p);
    const batch = await flush();
    expect(batch).toEqual([{ path: ":doc[0]", op: "emplace", yamlover: "hello there" }]);
  });

  it("Enter splits a paragraph into a sibling (two ops, the tail is a new paragraph)", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["helloworld"] }));
    await settle();
    const p = utils.container.querySelector(".chapter-prose") as HTMLElement;
    // place the caret after "hello"
    p.textContent = "helloworld";
    const range = document.createRange();
    range.setStart(p.firstChild!, 5);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.keyDown(p, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    const paras = utils.container.querySelectorAll(".chapter-prose");
    expect(paras.length).toBe(2);
    expect(paras[0].textContent).toBe("hello"); // the head's DOM RESET to the head text (rev bump)
    expect(paras[1].textContent).toBe("world");
    expect(document.activeElement).toBe(paras[1]); // the caret FOLLOWED the tail — the malfunction pin
    const batch = await flush();
    expect(batch).toEqual([
      { path: ":doc[0]", op: "emplace", yamlover: "hello" },
      { path: ":doc[1]", op: "insert", yamlover: "world" },
    ]);
  });

  it("Backspace at the start joins into the previous paragraph, caret at the junction", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["hello", "world"] }));
    await settle();
    const second = utils.container.querySelectorAll(".chapter-prose")[1] as HTMLElement;
    const range = document.createRange();
    range.setStart(second.firstChild ?? second, 0); // caret at the very start
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.keyDown(second, { key: "Backspace" });
    await act(async () => { await Promise.resolve(); });
    const remaining = utils.container.querySelectorAll(".chapter-prose");
    expect(remaining.length).toBe(1);
    expect(remaining[0].textContent).toBe("helloworld"); // the survivor's DOM reset to the merge
    expect(document.activeElement).toBe(remaining[0]);
    const batch = await flush();
    expect(batch).toEqual([
      { path: ":doc[1]", op: "remove" },
      { path: ":doc[0]", op: "emplace", yamlover: "helloworld" },
    ]);
  });

  it("Tab nests a paragraph into the previous one — it becomes a subchapter", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["parent", "child"] }));
    await settle();
    const paras = utils.container.querySelectorAll(".chapter-prose");
    fireEvent.keyDown(paras[1], { key: "Tab" });
    await act(async () => { await Promise.resolve(); });
    // "parent" is now a subchapter <section> holding "child"
    const section = utils.container.querySelector("section.chapter-sub")!;
    expect(section).toBeTruthy();
    expect(section.querySelector("h2.chapter-title")?.textContent).toBe("parent");
    expect(section.querySelector(".chapter-prose")?.textContent).toBe("child");
    const batch = await flush();
    // remove the child at [1], then re-emplace [0] as the omni parent (self + child)
    expect(batch.some((e: { op: string }) => e.op === "remove")).toBe(true);
    expect(batch.some((e: { op: string; yamlover?: string }) => e.op === "emplace" && /parent/.test(e.yamlover ?? ""))).toBe(true);
  });

  it("Shift-Tab lifts a nested paragraph back out", async () => {
    const sub = mixed({ kind: "omni", value: "Parent", selfAt: 0, format: "x-yamlover-chapter", entries: [{ key: null, value: "child" }] });
    const utils = renderSync(chapterNode({ title: "Book", body: [sub] }));
    await settle();
    const childPara = utils.container.querySelector("section.chapter-sub .chapter-prose") as HTMLElement;
    fireEvent.keyDown(childPara, { key: "Tab", shiftKey: true });
    await act(async () => { await Promise.resolve(); });
    const batch = await flush();
    expect(batch.some((e: { op: string }) => e.op === "remove")).toBe(true);
    expect(batch.some((e: { op: string }) => e.op === "insert")).toBe(true);
  });

  it("merely OPENING the editor writes nothing", async () => {
    renderSync(chapterNode({ title: "Book", body: ["hi"] }));
    await settle();
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(editChunks).not.toHaveBeenCalled();
  });
});

describe("ChapterProjection — lists and the format bar", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const renderSync = (node: NodeJson) => {
    fetchNode.mockResolvedValue(node);
    return render(<ChapterProjection path=":doc" onNavigate={vi.fn()} />);
  };
  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
  const taggedList = (format: string, items: string[]) =>
    mixed({ kind: "array", format, entries: items.map((value) => ({ key: null, value })) });

  it("draws a tagged bullets list as an editable <ul> of prose items", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: [taggedList("x-yamlover-bullets", ["one", "two"])] }));
    await settle();
    const ul = utils.container.querySelector("ul.yl-list-bullets")!;
    expect(ul).toBeTruthy();
    expect([...ul.querySelectorAll(":scope > li .chapter-prose")].map((p) => p.textContent)).toEqual(["one", "two"]);
  });

  it("a numbered list is an <ol>", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: [taggedList("x-yamlover-numbered", ["step"])] }));
    await settle();
    expect(utils.container.querySelector("ol.yl-list-numbered .chapter-prose")?.textContent).toBe("step");
  });

  it("Ctrl+Alt+3 turns the active paragraph into a bullets list (one replace op)", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["shopping"] }));
    await settle();
    const p = utils.container.querySelector(".chapter-prose") as HTMLElement;
    fireEvent.focus(p); // sets the active block
    fireEvent.keyDown(utils.container.querySelector(".chapter-wysiwyg")!, { key: "3", code: "Digit3", ctrlKey: true, altKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("ul.yl-list-bullets")).toBeTruthy();
    const batch = await flush();
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ path: ":doc[0]", op: "replace", meta: "*yamlover: $defs: bullets" });
    expect(batch[0].yamlover).toContain("shopping");
  });

  it("Ctrl+Alt+4 while in a bullets list switches it to numbered (one meta-only op)", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: [taggedList("x-yamlover-bullets", ["a", "b"])] }));
    await settle();
    const item = utils.container.querySelector("ul .chapter-prose") as HTMLElement;
    fireEvent.focus(item);
    fireEvent.keyDown(utils.container.querySelector(".chapter-wysiwyg")!, { key: "4", code: "Digit4", ctrlKey: true, altKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("ol.yl-list-numbered")).toBeTruthy();
    const batch = await flush();
    expect(batch).toEqual([{ path: ":doc[0]", op: "emplace", meta: "*yamlover: $defs: numbered" }]);
  });

  it("Ctrl+Alt+1 in a list drops the tag — it becomes a subchapter", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: [taggedList("x-yamlover-bullets", ["a"])] }));
    await settle();
    const item = utils.container.querySelector("ul .chapter-prose") as HTMLElement;
    fireEvent.focus(item);
    fireEvent.keyDown(utils.container.querySelector(".chapter-wysiwyg")!, { key: "1", code: "Digit1", ctrlKey: true, altKey: true });
    await act(async () => { await Promise.resolve(); });
    const batch = await flush();
    expect(batch).toEqual([{ path: ":doc[0]", op: "emplace", meta: null }]);
  });

  it("the format buttons (in the main bar, via the bus) highlight the active block's format", async () => {
    // the buttons live in the node-bar's config slot; render both so the format bus connects them
    fetchNode.mockResolvedValue(chapterNode({ title: "Book", body: [taggedList("x-yamlover-bullets", ["a"])] }));
    const utils = render(<><ChapterFormatControl /><ChapterProjection path=":doc" onNavigate={vi.fn()} /></>);
    await settle();
    const item = utils.container.querySelector("ul .chapter-prose") as HTMLElement;
    fireEvent.focus(item);
    await act(async () => { await Promise.resolve(); });
    const active = utils.container.querySelector(".fmt-btn.active")!;
    expect(active.textContent).toBe("•"); // bullets
  });

  it("Tab in a list item nests it — a sublist keeping the parent item's text", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: [taggedList("x-yamlover-bullets", ["parent", "child"])] }));
    await settle();
    const items = utils.container.querySelectorAll("ul > li");
    const childProse = items[1].querySelector(".chapter-prose") as HTMLElement;
    fireEvent.keyDown(childProse, { key: "Tab" });
    await act(async () => { await Promise.resolve(); });
    // parent item now holds a nested <ul> with the child, and keeps its own text
    const parentLi = utils.container.querySelector("ul > li")!;
    expect(parentLi.textContent).toContain("parent");
    expect(parentLi.querySelector(":scope > ul.yl-list-bullets .chapter-prose")?.textContent).toBe("child");
  });
});

describe("ChapterProjection — Enter adds VISIBLE paragraphs (regression: invisible empties)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const renderSync = (node: NodeJson) => {
    fetchNode.mockResolvedValue(node);
    return render(<ChapterProjection path=":doc" onNavigate={vi.fn()} />);
  };
  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it("Enter walks title → Description placeholder → ONE paragraph, caret following each step", async () => {
    const utils = renderSync(chapterNode({ title: "Book" })); // no description, no body
    await settle();
    // the Description CELL exists before the entry does — otherwise there is nowhere to type one
    const desc = utils.container.querySelector("p.chapter-subtitle") as HTMLElement;
    expect(desc).toBeTruthy();
    const h1 = utils.container.querySelector("h1.chapter-title") as HTMLElement;
    fireEvent.keyDown(h1, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(desc); // Enter from the title lands in the description
    fireEvent.keyDown(desc, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    const paras = utils.container.querySelectorAll(".chunk-body .chapter-prose");
    expect(paras.length).toBe(1); // exactly one, and it EXISTS in the DOM
    expect(document.activeElement).toBe(paras[0]); // the caret is IN it, not stuck behind
  });

  it("typing in the Description placeholder creates the keyed entry at [0]", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["hi"] }));
    await settle();
    const desc = utils.container.querySelector("p.chapter-subtitle") as HTMLElement;
    desc.textContent = "a friendly guide";
    fireEvent.blur(desc);
    await act(async () => { await Promise.resolve(); });
    const batch = await flush();
    expect(batch).toEqual([{ path: ":doc[0]", op: "insert", key: "description", yamlover: '"a friendly guide"' }]);
    // the placeholder is replaced by the real entry-backed cell, still showing the text
    expect(utils.container.querySelectorAll("p.chapter-subtitle").length).toBe(1);
    expect(utils.container.querySelector("p.chapter-subtitle")?.textContent).toBe("a friendly guide");
  });

  it("Enter in the EMPTY Description placeholder skips to the body, creating no entry", async () => {
    const utils = renderSync(chapterNode({ title: "Book" }));
    await settle();
    const desc = utils.container.querySelector("p.chapter-subtitle") as HTMLElement;
    fireEvent.keyDown(desc, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    const batch = await flush();
    // one insert only — the fresh paragraph; no description entry was born from an empty commit
    expect(batch).toEqual([{ path: ":doc[0]", op: "insert", yamlover: '""' }]);
  });

  it("a fresh paragraph carries a placeholder so an EMPTY one is visible", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: [""] }));
    await settle();
    const p = utils.container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    expect(p.getAttribute("data-placeholder")).toBeTruthy(); // the :empty::before hook the CSS needs
  });

  it("Enter in an empty paragraph makes the next one AND moves the caret into it", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: [""] }));
    await settle();
    const p = utils.container.querySelector(".chapter-prose") as HTMLElement;
    fireEvent.keyDown(p, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    const paras = utils.container.querySelectorAll(".chunk-body .chapter-prose");
    expect(paras.length).toBe(2);
    // the caret follows the fresh paragraph — repeated Enters must not pile empties after a
    // still-focused cell (the reported malfunction)
    expect(document.activeElement).toBe(paras[1]);
  });
});

describe("ChapterFormatControl — lives in the main bar via the bus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it("renders nothing when no projectional editor is mounted", () => {
    const { container } = render(<ChapterFormatControl />);
    expect(container.querySelector(".fmt-btn")).toBeNull();
  });

  it("appears while the editor is mounted and its buttons act on the focused block", async () => {
    fetchNode.mockResolvedValue(chapterNode({ title: "Book", body: ["shopping"] }));
    const { container } = render(<><ChapterFormatControl /><ChapterProjection path=":doc" onNavigate={vi.fn()} /></>);
    await settle();
    expect(container.querySelectorAll(".fmt-btn").length).toBe(4); // the buttons are present
    const p = container.querySelector(".chapter-prose") as HTMLElement;
    fireEvent.focus(p);
    await act(async () => { await Promise.resolve(); });
    // clicking Bullets (mousedown, so focus is not lost) retags the paragraph
    const bullets = [...container.querySelectorAll(".fmt-btn")].find((b) => b.textContent === "•")!;
    fireEvent.mouseDown(bullets);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector("ul.yl-list-bullets")).toBeTruthy();
    const batch = await flush();
    expect(batch[0]).toMatchObject({ op: "replace", meta: "*yamlover: $defs: bullets" });
  });
});
