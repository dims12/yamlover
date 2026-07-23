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

  it("Tab makes the CURRENT paragraph a subchapter title — the previous one is untouched", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["parent", "child"] }));
    await settle();
    const paras = utils.container.querySelectorAll(".chapter-prose");
    fireEvent.keyDown(paras[1], { key: "Tab" });
    await act(async () => { await Promise.resolve(); });
    // "child" ITSELF is now a subchapter title; "parent" is still a plain paragraph
    const section = utils.container.querySelector("section.chapter-sub")!;
    expect(section).toBeTruthy();
    const h2 = section.querySelector("h2.chapter-title")!;
    expect(h2.textContent).toBe("child");
    expect(utils.container.querySelectorAll(".chunk-body .chapter-prose")[0].textContent).toBe("parent");
    expect(document.activeElement).toBe(h2); // the caret followed the promoted block
    // on disk `- child` is the SAME one line whether scalar or title-only chapter — zero ops
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("Enter out of a freshly promoted title re-emplaces the whole omni (no scalar descent)", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["parent", "child"] }));
    await settle();
    fireEvent.keyDown(utils.container.querySelectorAll(".chapter-prose")[1], { key: "Tab" });
    await act(async () => { await Promise.resolve(); });
    const h2 = utils.container.querySelector("section.chapter-sub h2.chapter-title")!;
    fireEvent.keyDown(h2, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    const batch = await flush();
    // the server still holds `- child` (a scalar entry) — the first body commit must re-render
    // the whole omni at the entry's own path, never insert INTO the scalar (a 400)
    expect(batch).toEqual([{ path: ":doc[1]", op: "emplace", yamlover: 'child\n- ""' }]);
    expect(document.activeElement).toBe(utils.container.querySelector("section.chapter-sub .chunk-body .chapter-prose"));
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

  it("Enter from the title lands in the description when there IS one, else in the body", async () => {
    const withDesc = renderSync(chapterNode({ title: "Book", description: "a guide", body: ["hi"] }));
    await settle();
    fireEvent.keyDown(withDesc.container.querySelector("h1.chapter-title")!, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(withDesc.container.querySelector("p.chapter-subtitle"));
  });

  it("there is NO placeholder cell — a description-less chapter has no subtitle in the DOM", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["hi"] }));
    await settle();
    expect(utils.container.querySelector("p.chapter-subtitle")).toBeNull();
  });

  it("Enter from the title of a body-less chapter creates ONE paragraph, caret in it", async () => {
    const utils = renderSync(chapterNode({ title: "Book" })); // no description, no body
    await settle();
    fireEvent.keyDown(utils.container.querySelector("h1.chapter-title")!, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    const paras = utils.container.querySelectorAll(".chunk-body .chapter-prose");
    expect(paras.length).toBe(1); // exactly one, and it EXISTS in the DOM
    expect(document.activeElement).toBe(paras[0]); // the caret is IN it, not stuck behind
    const batch = await flush();
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
    expect(container.querySelectorAll(".fmt-btn").length).toBe(6); // ¶ • 1. ▦ plus T and D
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

describe("ChapterProjection — Shift-Tab undoes Tab (the phantom-container regression)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const renderSync = (node: NodeJson) => {
    fetchNode.mockResolvedValue(node);
    return render(<ChapterProjection path=":doc" onNavigate={vi.fn()} />);
  };
  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it("Tab then Shift-Tab on the SAME block round-trips — and writes NOTHING", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["parent", "child"] }));
    await settle();
    fireEvent.keyDown(utils.container.querySelectorAll(".chapter-prose")[1], { key: "Tab" });
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("section.chapter-sub")).toBeTruthy(); // promoted
    // the caret followed the promoted title — Shift-Tab right there unmakes it
    const h2 = utils.container.querySelector("section.chapter-sub h2.chapter-title") as HTMLElement;
    fireEvent.keyDown(h2, { key: "Tab", shiftKey: true });
    await act(async () => { await Promise.resolve(); });
    // the subchapter DISSOLVED: "child" is a plain paragraph again, in place
    expect(utils.container.querySelector("section.chapter-sub")).toBeNull();
    const paras = utils.container.querySelectorAll(".chunk-body .chapter-prose");
    expect([...paras].map((p) => p.textContent)).toEqual(["parent", "child"]);
    // `- child` never changed meaning on disk — the round-trip is zero ops
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("Shift-Tab on a title with a BODY splices the body out after it, in order", async () => {
    const sub = mixed({ kind: "omni", value: "Dogs", selfAt: 0, format: "x-yamlover-chapter", entries: [{ key: null, value: "woof" }, { key: null, value: "bark" }] });
    const utils = renderSync(chapterNode({ title: "Book", body: [sub] }));
    await settle();
    const h2 = utils.container.querySelector("section.chapter-sub h2.chapter-title") as HTMLElement;
    fireEvent.keyDown(h2, { key: "Tab", shiftKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("section.chapter-sub")).toBeNull();
    const paras = utils.container.querySelectorAll(".chunk-body .chapter-prose");
    expect([...paras].map((p) => p.textContent)).toEqual(["Dogs", "woof", "bark"]);
    expect(document.activeElement).toBe(paras[0]); // the caret stayed on the demoted block
    const batch = await flush();
    expect(batch).toEqual([
      { path: ":doc[0][1]", op: "remove" },
      { path: ":doc[1]", op: "insert", yamlover: "bark" },
      { path: ":doc[0][0]", op: "remove" },
      { path: ":doc[1]", op: "insert", yamlover: "woof" },
    ]);
  });

  it("after the round-trip, adding MORE paragraphs addresses correctly (the [2] sync error)", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["parent", "child"] }));
    await settle();
    fireEvent.keyDown(utils.container.querySelectorAll(".chapter-prose")[1], { key: "Tab" });
    await act(async () => { await Promise.resolve(); });
    const h2 = utils.container.querySelector("section.chapter-sub h2.chapter-title") as HTMLElement;
    fireEvent.keyDown(h2, { key: "Tab", shiftKey: true });
    await act(async () => { await Promise.resolve(); });
    // Enter at the end of "child" — a NEW paragraph at [2], never a descent into a phantom [0][…]
    const last = utils.container.querySelectorAll(".chunk-body .chapter-prose")[1] as HTMLElement;
    const range = document.createRange();
    range.setStart(last.firstChild ?? last, (last.textContent ?? "").length);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.keyDown(last, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    const batch = await flush();
    expect(batch).toEqual([
      { path: ":doc[1]", op: "emplace", yamlover: "child" },
      { path: ":doc[2]", op: "insert", yamlover: '""' },
    ]);
  });

  it("Tab on a subchapter TITLE nests it under the PREVIOUS subchapter", async () => {
    const cats = mixed({ kind: "omni", value: "Cats", selfAt: 0, format: "x-yamlover-chapter", entries: [{ key: null, value: "meow" }] });
    const dogs = mixed({ kind: "omni", value: "Dogs", selfAt: 0, format: "x-yamlover-chapter", entries: [{ key: null, value: "woof" }] });
    const utils = renderSync(chapterNode({ title: "Book", body: [cats, dogs] }));
    await settle();
    const h2s = utils.container.querySelectorAll("section.chapter-sub h2.chapter-title");
    fireEvent.keyDown(h2s[1], { key: "Tab" });
    await act(async () => { await Promise.resolve(); });
    // the WHOLE "Dogs" subchapter now lives one level deeper, inside "Cats"
    const outer = utils.container.querySelector("section.chapter-sub")!;
    expect(outer.querySelector("h2.chapter-title")?.textContent).toBe("Cats");
    expect(outer.querySelector("section.chapter-sub h3.chapter-title")?.textContent).toBe("Dogs");
    const batch = await flush();
    expect(batch).toEqual([
      { path: ":doc[1]", op: "remove" },
      { path: ":doc[0]", op: "insert", yamlover: "Dogs\n- woof" },
    ]);
  });

  it("Tab on a title after a PLAIN paragraph does nothing — it never conscripts the paragraph", async () => {
    const dogs = mixed({ kind: "omni", value: "Dogs", selfAt: 0, format: "x-yamlover-chapter", entries: [{ key: null, value: "woof" }] });
    const utils = renderSync(chapterNode({ title: "Book", body: ["intro", dogs] }));
    await settle();
    fireEvent.keyDown(utils.container.querySelector("section.chapter-sub h2.chapter-title")!, { key: "Tab" });
    await act(async () => { await Promise.resolve(); });
    // unchanged: "intro" is still a paragraph, "Dogs" still a top-level subchapter
    expect(utils.container.querySelectorAll(".chunk-body .chapter-prose")[0].textContent).toBe("intro");
    expect(utils.container.querySelector("section.chapter-sub h2.chapter-title")?.textContent).toBe("Dogs");
    expect(utils.container.querySelector("h3.chapter-title")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(editChunks).not.toHaveBeenCalled();
  });
});

describe("ChapterProjection — the same editor at every level", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const renderSync = (node: NodeJson) => {
    fetchNode.mockResolvedValue(node);
    return render(<ChapterProjection path=":doc" onNavigate={vi.fn()} />);
  };
  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it("the D button works one level down too — a subchapter chunk becomes ITS description", async () => {
    const sub = mixed({ kind: "omni", value: "Dogs", selfAt: 0, format: "x-yamlover-chapter", entries: [{ key: null, value: "woof" }] });
    fetchNode.mockResolvedValue(chapterNode({ title: "Book", description: "a guide", body: [sub] }));
    const utils = render(<><ChapterFormatControl /><ChapterProjection path=":doc" onNavigate={vi.fn()} /></>);
    await settle();
    const section = utils.container.querySelector("section.chapter-sub")!;
    fireEvent.focus(section.querySelector(".chapter-prose")!);
    await act(async () => { await Promise.resolve(); });
    fireEvent.mouseDown([...utils.container.querySelectorAll(".fmt-btn")].find((b) => b.textContent === "D")!);
    await act(async () => { await Promise.resolve(); });
    expect(section.querySelector("p.chapter-subtitle")?.textContent).toBe("woof");
    const batch = await flush();
    // born as the subchapter's FIRST entry, then the chunk (now at [1][1]) removed
    expect(batch).toEqual([
      { path: ":doc[1][0]", op: "insert", key: "description", yamlover: '"woof"' },
      { path: ":doc[1][1]", op: "remove" },
    ]);
  });

  it("chunks carry the §N gutter while editing, same as the read view", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["one", "two"] }));
    await settle();
    const indices = [...utils.container.querySelectorAll(".chunk-index")].map((a) => a.textContent);
    expect(indices).toEqual(["§0", "§1"]);
    expect((utils.container.querySelector("a.chunk-index") as HTMLAnchorElement).getAttribute("href")).toBe("#[0]");
  });

  it("the editor takes the read view's reading width", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["one"] }));
    await settle();
    const root = utils.container.querySelector(".chapter-wysiwyg") as HTMLElement;
    expect(root.style.maxWidth).toMatch(/^\d+ch$/);
  });
});

describe("ChapterProjection — the T and D buttons give any chunk the title/description role", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
  /** Render the projection WITH the bar control, since the buttons live there. */
  const renderWithBar = (node: NodeJson) => {
    fetchNode.mockResolvedValue(node);
    return render(<><ChapterFormatControl /><ChapterProjection path=":doc" onNavigate={vi.fn()} /></>);
  };
  const button = (utils: { container: HTMLElement }, glyph: string) =>
    [...utils.container.querySelectorAll(".fmt-btn")].find((b) => b.textContent === glyph) as HTMLButtonElement;
  /** A chapter with NO title — a plain sequence body. */
  const untitled = () => ({
    path: ":doc", type: "object", concrete: "dir/yamlover", documentPath: ":doc", title: null, description: null,
    value: mixed({ kind: "array", format: "x-yamlover-chapter", entries: [{ key: null, value: "My title" }, { key: null, value: "body text" }] }),
    comments: { "": { tag: "!!<*yamlover: $defs: chapter>" } },
  } as unknown as NodeJson);

  it("T turns the focused chunk into the chapter's title (there was none — and no placeholder)", async () => {
    const utils = renderWithBar(untitled());
    await settle();
    expect(utils.container.querySelector("h1.chapter-title")).toBeNull(); // no placeholder cell
    fireEvent.focus(utils.container.querySelector(".chapter-prose")!);
    await act(async () => { await Promise.resolve(); });
    fireEvent.mouseDown(button(utils, "T"));
    await act(async () => { await Promise.resolve(); });
    const h1 = utils.container.querySelector("h1.chapter-title")!;
    expect(h1.textContent).toBe("My title");
    expect(document.activeElement).toBe(h1); // the caret followed the promoted text
    expect([...utils.container.querySelectorAll(".chunk-body .chapter-prose")].map((p) => p.textContent)).toEqual(["body text"]);
    const batch = await flush();
    expect(batch).toEqual([
      { path: ":doc[0]", op: "remove" },
      { path: ":doc", op: "emplace", yamlover: "My title" },
    ]);
  });

  it("T on the title itself demotes it back into the first chunk", async () => {
    const utils = renderWithBar(chapterNode({ title: "Book", body: ["hi"] }));
    await settle();
    // the title opens focused, so T is already armed in its "is" state
    fireEvent.mouseDown(button(utils, "T"));
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("h1.chapter-title")).toBeNull();
    const paras = [...utils.container.querySelectorAll(".chunk-body .chapter-prose")];
    expect(paras.map((p) => p.textContent)).toEqual(["Book", "hi"]);
    expect(document.activeElement).toBe(paras[0]);
    const batch = await flush();
    expect(batch).toEqual([
      { path: ":doc", op: "emplace", yamlover: '""' }, // the self line is dropped
      { path: ":doc[0]", op: "insert", yamlover: "Book" },
    ]);
  });

  it("D turns the focused chunk into the description, and the chunk entry moves", async () => {
    const utils = renderWithBar(chapterNode({ title: "Book", body: ["about the book", "x"] }));
    await settle();
    fireEvent.focus(utils.container.querySelector(".chapter-prose")!);
    await act(async () => { await Promise.resolve(); });
    fireEvent.mouseDown(button(utils, "D"));
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("p.chapter-subtitle")?.textContent).toBe("about the book");
    expect([...utils.container.querySelectorAll(".chunk-body .chapter-prose")].map((p) => p.textContent)).toEqual(["x"]);
    const batch = await flush();
    expect(batch).toEqual([
      { path: ":doc[0]", op: "insert", key: "description", yamlover: '"about the book"' },
      { path: ":doc[1]", op: "remove" }, // the chunk, now shifted one down
    ]);
  });

  it("D on the description demotes it back into a plain chunk in its place", async () => {
    const utils = renderWithBar(chapterNode({ title: "Book", description: "a guide", body: ["x"] }));
    await settle();
    fireEvent.focus(utils.container.querySelector("p.chapter-subtitle")!);
    await act(async () => { await Promise.resolve(); });
    fireEvent.mouseDown(button(utils, "D"));
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("p.chapter-subtitle")).toBeNull();
    expect([...utils.container.querySelectorAll(".chunk-body .chapter-prose")].map((p) => p.textContent)).toEqual(["a guide", "x"]);
    const batch = await flush();
    expect(batch).toEqual([
      { path: ":doc[1]", op: "insert", yamlover: "a guide" },
      { path: ":doc:description", op: "remove" }, // a keyed entry is removed BY KEY
    ]);
  });
});

describe("ChapterProjection — Up/Down walk the caret between cells", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const renderSync = (node: NodeJson) => {
    fetchNode.mockResolvedValue(node);
    return render(<ChapterProjection path=":doc" onNavigate={vi.fn()} />);
  };
  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it("ArrowDown walks title → description → paragraph, and ArrowUp walks back", async () => {
    const utils = renderSync(chapterNode({ title: "Book", description: "a guide", body: ["one"] }));
    await settle();
    const h1 = utils.container.querySelector("h1.chapter-title") as HTMLElement;
    const desc = utils.container.querySelector("p.chapter-subtitle") as HTMLElement;
    const para = utils.container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    fireEvent.keyDown(h1, { key: "ArrowDown" });
    expect(document.activeElement).toBe(desc);
    fireEvent.keyDown(desc, { key: "ArrowDown" });
    expect(document.activeElement).toBe(para);
    fireEvent.keyDown(para, { key: "ArrowUp" });
    expect(document.activeElement).toBe(desc);
    fireEvent.keyDown(desc, { key: "ArrowUp" });
    expect(document.activeElement).toBe(h1);
  });

  it("ArrowDown at the last cell and ArrowUp at the first stay put", async () => {
    const utils = renderSync(chapterNode({ title: "Book", body: ["one"] }));
    await settle();
    const h1 = utils.container.querySelector("h1.chapter-title") as HTMLElement;
    fireEvent.keyDown(h1, { key: "ArrowUp" });
    expect(document.activeElement).toBe(h1);
  });
});

describe("ChapterProjection — an EMPTY chapter bootstraps its first paragraph", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
  const empty = () => ({
    path: ":doc", type: "object", concrete: "dir/yamlover", documentPath: ":doc", title: null, description: null,
    value: mixed({ kind: "array", format: "x-yamlover-chapter", entries: [] }),
    comments: { "": { tag: "!!<*yamlover: $defs: chapter>" } },
  } as unknown as NodeJson);

  it("shows ONE writable paragraph (no title/description placeholders), writing nothing", async () => {
    fetchNode.mockResolvedValue(empty());
    const utils = render(<ChapterProjection path=":doc" onNavigate={vi.fn()} />);
    await settle();
    expect(utils.container.querySelector("h1.chapter-title")).toBeNull();
    expect(utils.container.querySelector("p.chapter-subtitle")).toBeNull();
    const p = utils.container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    expect(p.getAttribute("data-placeholder")).toBeTruthy();
    expect(document.activeElement).toBe(p); // opens ready to write
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(editChunks).not.toHaveBeenCalled(); // merely opening writes nothing
  });

  it("the first typed text creates the entry at [0]", async () => {
    fetchNode.mockResolvedValue(empty());
    const utils = render(<ChapterProjection path=":doc" onNavigate={vi.fn()} />);
    await settle();
    const p = utils.container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    p.textContent = "hello";
    fireEvent.input(p);
    await act(async () => { await Promise.resolve(); });
    const batch = await flush();
    expect(batch).toEqual([{ path: ":doc[0]", op: "insert", yamlover: "hello" }]);
  });
});
