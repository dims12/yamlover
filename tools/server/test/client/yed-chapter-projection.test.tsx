// @vitest-environment jsdom
// THE YED CHAPTER PROJECTION — the Stage 4 law suite: structure, caret (activeElement pinned
// after EVERY interaction), op batches via the DIFF channel, the stamp, the bus-driven bar.
// The legacy suite (chapter-projection.test.tsx) stays green beside this one until the flip.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

const { fetchNode, editChunks, queryTree, queryFilter } = vi.hoisted(() => ({ fetchNode: vi.fn(), editChunks: vi.fn(), queryTree: vi.fn(), queryFilter: vi.fn() }));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchNode, editChunks, queryTree, queryFilter }));

import { YedChapterEditor } from "../../src/client/renderers/yed-chapter-editor";
import { ChapterFormatControl } from "../../src/client/renderers/chapter-editor/format-control";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);
beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset();
  queryTree.mockReset().mockResolvedValue([]); // the reference kit's candidates — empty by default
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock")); // pick Enter falls back to verbatim
});

const mixed = (o: Record<string, unknown>) => ({ $yamloverMixed: { kind: "mix", entries: [], ...o } });

/** A chapter node as the wire carries it: a titled chapter is an omni, an untitled one a mix. */
function chapterNode(opts: { title?: string; description?: string; body?: unknown[]; tagged?: boolean } = {}): NodeJson {
  const entries: { key: string | null; value: unknown }[] = [];
  if (opts.description) entries.push({ key: "description", value: opts.description });
  for (const v of opts.body ?? []) entries.push({ key: null, value: v });
  const tagged = opts.tagged ?? true;
  return {
    path: ":doc", type: "object", concrete: "dir/yamlover", documentPath: ":doc", title: null, description: null,
    value: opts.title !== undefined
      ? mixed({ kind: "omni", value: opts.title, selfAt: 0, ...(tagged ? { format: "x-yamlover-chapter" } : {}), entries })
      : mixed({ kind: "mix", ...(tagged ? { format: "x-yamlover-chapter" } : {}), entries }),
    ...(tagged ? { comments: { "": { tag: "!!<*yamlover: $defs: chapter>" } } } : {}),
  } as unknown as NodeJson;
}

const renderSync = (node: NodeJson) => {
  fetchNode.mockResolvedValue(node);
  return render(<YedChapterEditor path=":doc" onNavigate={vi.fn()} />);
};
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
async function flush() {
  await act(async () => { vi.advanceTimersByTime(600); await Promise.resolve(); });
  return editChunks.mock.calls.at(-1)?.[0];
}

/** The title's text — the ACTIVE cell is a controlled input, the inactive one a text face. */
function titleText(scope: Element): string | null {
  const input = scope.querySelector(".y2-cell[data-kind=title] input.y2-input") as HTMLInputElement | null;
  if (input) return input.value;
  return scope.querySelector(".y2-cell[data-kind=title] .chapter-title-text")?.textContent ?? null;
}
function descriptionText(scope: Element): string | null {
  const input = scope.querySelector(".y2-cell[data-kind=description] input.y2-input") as HTMLInputElement | null;
  if (input) return input.value;
  return scope.querySelector(".y2-cell[data-kind=description] .chapter-subtitle")?.textContent ?? null;
}

describe("yed chapter — structure", () => {
  it("draws the title as an editable h1, the description as a subtitle, prose with §gutters", async () => {
    fetchNode.mockResolvedValue(chapterNode({ title: "Book", description: "a guide", body: ["opening"] }));
    const { container } = render(<YedChapterEditor path=":doc" onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("h1.chapter-title")).toBeTruthy());
    expect(titleText(container)).toBe("Book"); // active on open — the controlled input holds it
    expect(container.querySelector("h1.chapter-title input.y2-input")).toBeTruthy();
    expect(descriptionText(container)).toBe("a guide");
    expect(container.querySelector(".chunk-body .chapter-prose")?.textContent).toBe("opening");
    // the gutter shows the entry's yamlover ADDRESS — the absolute index (description sits at [0])
    expect(container.querySelector(".chunk-index")?.textContent).toBe("1");
  });

  it("a subchapter is an inline <section> with the SAME editor one level down; it takes no §", async () => {
    const sub = mixed({ kind: "omni", value: "Dogs", selfAt: 0, entries: [{ key: null, value: "woof" }] });
    fetchNode.mockResolvedValue(chapterNode({ title: "Book", body: ["opening", sub, "closing"] }));
    const { container } = render(<YedChapterEditor path=":doc" onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("section.chapter-sub")).toBeTruthy());
    const section = container.querySelector("section.chapter-sub")!;
    expect(section.querySelector("h2.chapter-title")).toBeTruthy();
    expect(titleText(section)).toBe("Dogs");
    expect(section.querySelector(".chapter-prose")?.textContent).toBe("woof");
    const gutters = Array.from(container.querySelectorAll(".chunk-index")).map((g) => g.textContent);
    // the composed positional address from the page root: "opening"=0, the subchapter's
    // "woof" cites its place in the page's nested array (`1: 0`), "closing"=2
    expect(gutters).toEqual(["0", "1: 0", "2"]);
  });

  it("an EMPTY chapter shows one bootstrap paragraph with the placeholder", async () => {
    fetchNode.mockResolvedValue(chapterNode({ body: [] }));
    const { container } = render(<YedChapterEditor path=":doc" onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector(".chapter-wysiwyg")).toBeTruthy());
    const boot = container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    expect(boot?.getAttribute("data-placeholder")).toBe("Write…");
  });

  it("opens with the caret in the title — no click to begin", async () => {
    fetchNode.mockResolvedValue(chapterNode({ title: "Book", body: ["p"] }));
    const { container } = render(<YedChapterEditor path=":doc" onNavigate={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector("h1.chapter-title input.y2-input")));
  });
});

describe("yed chapter — editing (ops via the diff channel)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merely OPENING writes nothing", async () => {
    renderSync(chapterNode({ title: "Book", body: ["p"] }));
    await settle();
    await flush();
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("typing coalesces to ONE bare emplace", async () => {
    const { container } = renderSync(chapterNode({ title: "Book", body: ["hi"] }));
    await settle();
    const p = container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    p.textContent = "hello there";
    fireEvent.input(p);
    p.textContent = "hello there!";
    fireEvent.input(p);
    expect(await flush()).toEqual([{ path: ":doc:0", op: "emplace", yamlover: "hello there!" }]);
    expect(editChunks).toHaveBeenCalledTimes(1);
  });

  it("Enter splits at the caret: emplace head + insert tail, the CARET follows the tail", async () => {
    const { container } = renderSync(chapterNode({ title: "Book", body: ["helloworld"] }));
    await settle();
    const p = container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    p.focus();
    // place the caret between "hello" and "world"
    const textNode = p.firstChild!;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(textNode, 5);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    await act(async () => { fireEvent.keyDown(p, { key: "Enter" }); });
    const paras = container.querySelectorAll(".chunk-body .chapter-prose");
    expect(paras.length).toBe(2);
    expect(paras[0].textContent).toBe("hello");
    expect(paras[1].textContent).toBe("world");
    expect(document.activeElement).toBe(paras[1]);
    expect(await flush()).toEqual([
      { path: ":doc:0", op: "emplace", yamlover: "hello" },
      { path: ":doc:1", op: "insert", yamlover: "world" },
    ]);
  });

  it("a structural insert never leaves STALE DOM in shifted siblings (stable entry keys)", async () => {
    // the T-demote bug class: index-keyed cells + rev-gated contentEditable showed the OLD
    // entry's text after any splice that shifted siblings
    const { container } = renderSync(chapterNode({ title: "Book", body: ["headtail", "after"] }));
    await settle();
    const p = container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    p.focus();
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(p.firstChild!, 4);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    await act(async () => { fireEvent.keyDown(p, { key: "Enter" }); });
    const texts = Array.from(container.querySelectorAll(".chunk-body .chapter-prose")).map((x) => x.textContent);
    expect(texts).toEqual(["head", "tail", "after"]); // "after" must not appear twice
    await flush();
  });

  it("Backspace at the start joins into the previous paragraph — caret at the junction", async () => {
    const { container } = renderSync(chapterNode({ title: "Book", body: ["hello", "world"] }));
    await settle();
    const paras = container.querySelectorAll(".chunk-body .chapter-prose");
    const second = paras[1] as HTMLElement;
    second.focus();
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(second.firstChild!, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    await act(async () => { fireEvent.keyDown(second, { key: "Backspace" }); });
    const after = container.querySelectorAll(".chunk-body .chapter-prose");
    expect(after.length).toBe(1);
    expect(after[0].textContent).toBe("helloworld");
    expect(document.activeElement).toBe(after[0]);
    expect(await flush()).toEqual([
      { path: ":doc:0", op: "emplace", yamlover: "helloworld" },
      { path: ":doc:1", op: "remove" },
    ]);
  });

  it("Tab NESTS the paragraph (one replace); Shift-Tab round-trips (one replace back)", async () => {
    const { container } = renderSync(chapterNode({ title: "Book", body: ["p1", "fresh"] }));
    await settle();
    const p = container.querySelectorAll(".chunk-body .chapter-prose")[1] as HTMLElement;
    await act(async () => { fireEvent.focus(p); });
    await act(async () => { fireEvent.keyDown(p, { key: "Tab" }); });
    // the nest keeps a PARAGRAPH focused — one level deeper, in a badged group
    expect((document.activeElement as HTMLElement).classList.contains("chapter-prose")).toBe(true);
    expect(container.querySelector(".y2-cell[data-kind=chapter] .y2-badge")?.textContent).toContain("wrapped");
    expect(await flush()).toEqual([{ path: ":doc:1", op: "replace", yamlover: "- fresh" }]);
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true }); });
    const back = container.querySelectorAll(".chunk-body .chapter-prose");
    expect(back.length).toBe(2);
    expect(document.activeElement).toBe(back[1]);
    expect(await flush()).toEqual([{ path: ":doc:1", op: "replace", yamlover: "fresh" }]); // the inverse
  });

  it("a plain untagged folder gains the chapter stamp as the LEADING op, exactly once", async () => {
    const { container } = renderSync(chapterNode({ body: ["hi"], tagged: false }));
    await settle();
    const p = container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    p.textContent = "hello";
    fireEvent.input(p);
    expect(await flush()).toEqual([
      { path: ":doc", op: "emplace", meta: "*::yamlover:$defs:chapter" },
      { path: ":doc:0", op: "emplace", yamlover: "hello" },
    ]);
    p.textContent = "hello again";
    fireEvent.input(p);
    expect(await flush()).toEqual([{ path: ":doc:0", op: "emplace", yamlover: "hello again" }]); // no re-stamp
  });

  it("Enter on the title walks: description, then the first paragraph — the caret follows", async () => {
    const { container } = renderSync(chapterNode({ title: "Book", description: "d", body: ["p"] }));
    await settle();
    const h1Input = container.querySelector("h1.chapter-title input.y2-input") as HTMLElement;
    expect(document.activeElement).toBe(h1Input); // opened here
    await act(async () => { fireEvent.keyDown(h1Input, { key: "Enter" }); });
    expect((document.activeElement as HTMLInputElement).value).toBe("d"); // the description input
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "Enter" }); });
    expect(document.activeElement).toBe(container.querySelector(".chunk-body .chapter-prose"));
  });

  it("Up/Down walk the flat document order: title → description → paragraph and back", async () => {
    const { container } = renderSync(chapterNode({ title: "Book", description: "d", body: ["p"] }));
    await settle();
    const h1Input = container.querySelector("h1.chapter-title input.y2-input") as HTMLElement;
    await act(async () => { fireEvent.keyDown(h1Input, { key: "ArrowDown" }); });
    expect((document.activeElement as HTMLInputElement).value).toBe("d");
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" }); });
    expect(document.activeElement).toBe(container.querySelector("h1.chapter-title input.y2-input"));
  });
});

describe("yed chapter — tables and source chunks (Stage 7)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tableNode = () => chapterNode({
    title: "Book",
    body: [{ $yamloverMixed: { kind: "mix", entries: [
      { key: "header", value: ["A", "B"] },
      { key: null, value: ["1", "2"] },
    ] } }],
  });
  const withTag = (n: NodeJson, frag: string, tag: string): NodeJson =>
    ({ ...n, comments: { ...(n as { comments?: object }).comments, [frag]: { tag } } }) as NodeJson;

  const activeInput = (): HTMLInputElement => {
    const el = document.activeElement as HTMLInputElement;
    expect(el?.tagName).toBe("INPUT");
    return el;
  };

  it("a tagged table draws an editable grid; a cell edit is one emplace at the cell", async () => {
    const { container } = renderSync(withTag(tableNode(), "/0", "!!<*yamlover: $defs: table>"));
    await settle();
    const faces = container.querySelectorAll("td .yl-cell");
    expect(faces.length).toBe(2);
    await act(async () => { fireEvent.focus(faces[0]); });
    const input = activeInput();
    expect(input.value).toBe("1");
    fireEvent.change(input, { target: { value: "9" } });
    // the cell's committed value was the STRING "1" — typed text stays a string, and the
    // serializer quotes what would otherwise re-read as a number (value fidelity)
    expect(await flush()).toEqual([{ path: ":doc:0:1:0", op: "emplace", yamlover: "'9'" }]);
  });

  it("Tab walks header → rows; at the VERY last cell it appends a row of the table's width", async () => {
    const { container } = renderSync(withTag(tableNode(), "/0", "!!<*yamlover: $defs: table>"));
    await settle();
    const headerFaces = container.querySelectorAll("th .yl-cell");
    await act(async () => { fireEvent.focus(headerFaces[1]); });
    expect(activeInput().value).toBe("B");
    await act(async () => { fireEvent.keyDown(activeInput(), { key: "Tab" }); });
    expect(activeInput().value).toBe("1"); // header end wraps to the first data row
    await act(async () => { fireEvent.keyDown(activeInput(), { key: "Tab" }); });
    expect(activeInput().value).toBe("2");
    await act(async () => { fireEvent.keyDown(activeInput(), { key: "Tab" }); });
    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBe(2); // a fresh row appeared
    expect(activeInput().value).toBe("");
    expect(await flush()).toEqual([{ path: ":doc:0:2", op: "insert", yamlover: "- ''\n- ''" }]);
  });

  it("Shift-Tab at the header's first cell never un-appends", async () => {
    const { container } = renderSync(withTag(tableNode(), "/0", "!!<*yamlover: $defs: table>"));
    await settle();
    const first = container.querySelector("th .yl-cell") as HTMLElement;
    await act(async () => { fireEvent.focus(first); });
    const input = activeInput();
    await act(async () => { fireEvent.keyDown(input, { key: "Tab", shiftKey: true }); });
    expect(document.activeElement).toBe(input);
    await flush();
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("an explicitly NON-chapter-typed structure edits as inline yamlover SOURCE", async () => {
    const node = withTag(chapterNode({
      title: "Recipes",
      body: [
        "The stew needs:",
        { $yamloverMixed: { kind: "mix", entries: [{ key: "serves", value: 4 }, { key: "time", value: 20 }] } },
      ],
    }), "/1", "!!<*yamlover: $defs: recipe>");
    const { container } = renderSync(node);
    await settle();
    const source = container.querySelector(".chunk-source");
    expect(source, "the data chunk renders SOURCE cells, not prose").toBeTruthy();
    expect(source!.querySelectorAll(".y2-cell").length).toBeGreaterThan(0);
    expect(source!.textContent).toContain("serves");
    // the first chunk is still ordinary prose
    expect(container.querySelector(".chunk-body .chapter-prose")?.textContent).toBe("The stew needs:");
    // edit a value THROUGH the source grammar: focus the token, retype, commit
    const token = Array.from(source!.querySelectorAll(".y2-v")).find((el) => el.textContent === "4") as HTMLElement;
    expect(token).toBeTruthy();
    fireEvent.focus(token);
    const input = document.activeElement as HTMLInputElement;
    expect(input instanceof HTMLInputElement).toBe(true);
    fireEvent.change(input, { target: { value: "6" } });
    input.setSelectionRange(1, 1);
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(await flush()).toEqual([{ path: ":doc:1:serves", op: "emplace", yamlover: "6" }]);
  });

  it("a REFERENCE typed in a source chunk mounts the PICK kit; the commit grafts and flushes COMPACT", async () => {
    const node = withTag(chapterNode({
      title: "Recipes",
      body: [
        "The stew needs:",
        { $yamloverMixed: { kind: "mix", entries: [{ key: "serves", value: 4 }] } },
      ],
    }), "/1", "!!<*yamlover: $defs: recipe>");
    const { container } = renderSync(node);
    await settle();
    const source = container.querySelector(".chunk-source")!;
    // the sub-editor's fresh hole — `*` starts a reference; the chapter's sourceCells
    // registry (makeSourceCells) mounts the query kit over it
    const hole = source.querySelector<HTMLInputElement>(".y2-hole .y2-input")!;
    expect(hole, "the source chunk draws its entry hole").toBeTruthy();
    // FOCUS the chunk first — an unfocused embedded editor never plants the caret, and the
    // kit only claims the machine's first cell while it may hold focus
    await act(async () => { fireEvent.focus(hole); });
    const hole2 = container.querySelector<HTMLInputElement>(".chunk-source .y2-hole .y2-input")!;
    await act(async () => { fireEvent.change(hole2, { target: { value: "*" } }); });
    // re-query — the re-render may have replaced the chunk's DOM subtree
    const cell = container.querySelector<HTMLElement>(".chunk-source .y2-ptrwrap .crumb-cell")!;
    expect(cell, "the PICK kit did not mount over the `*` hole").toBeTruthy();
    // free-type a target and reduce — no match (the filter mock rejects) → verbatim commit
    cell.textContent = "serves";
    fireEvent.input(cell);
    await act(async () => { fireEvent.keyDown(cell, { key: "Enter" }); vi.advanceTimersByTime(10); await Promise.resolve(); await Promise.resolve(); });
    // the commit grafted into the chapter doc and the diff flushed ONE compact keyless insert
    expect(await flush()).toEqual([{ path: ":doc:1:0", op: "insert", yamlover: "*serves" }]);
  });

  it("TWO source chunks never fight for the caret — opening pins it in the title", async () => {
    // Regression: each embedded source EditorView used to plant its own caret unconditionally;
    // with two data islands they stole focus from each other every commit — an unbounded render
    // cascade that froze the whole page (the docs/language mount). An embedded editor plants
    // only while the CHAPTER machine focuses its chunk (plantCaret={focused}).
    const node = withTag(withTag(chapterNode({
      title: "Data",
      body: [
        { $yamloverMixed: { kind: "mix", entries: [{ key: "a", value: 1 }] } },
        { $yamloverMixed: { kind: "mix", entries: [{ key: "b", value: 2 }] } },
      ],
    }), "/0", "!!<*yamlover: $defs: island>"), "/1", "!!<*yamlover: $defs: island>");
    const { container } = renderSync(node);
    await settle();
    expect(container.querySelectorAll(".chunk-source").length).toBe(2);
    // the caret law holds: the title input owns the caret, no source editor stole it
    expect(document.activeElement).toBe(container.querySelector("h1.chapter-title input.y2-input"));
    await settle();
    expect(document.activeElement).toBe(container.querySelector("h1.chapter-title input.y2-input"));
  });
});

describe("yed chapter — the ?depth= window", () => {
  afterEach(() => { window.history.replaceState(null, "", "/"); });

  it("at depth=1 a subchapter collapses to the descend heading; a WRAP stays editable", async () => {
    window.history.replaceState(null, "", "/?depth=1");
    const sub = mixed({ kind: "omni", value: "Dogs", selfAt: 0, entries: [{ key: null, value: "woof" }] });
    fetchNode.mockResolvedValue(chapterNode({ title: "Book", body: [sub, "fresh"] }));
    const onNavigate = vi.fn();
    const { container } = render(<YedChapterEditor path=":doc" onNavigate={onNavigate} />);
    await waitFor(() => expect(container.querySelector("h1.chapter-title")).toBeTruthy());
    // the loaded subchapter is a linked heading — its body is NOT inlined
    const heading = container.querySelector("section.chapter-sub .chapter-title") as HTMLElement;
    expect(heading?.textContent).toContain("Dogs");
    expect(container.textContent).not.toContain("woof");
    // …but a freshly nested group stays editable in place (never strand a nest)
    const p = container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    await act(async () => { fireEvent.focus(p); });
    await act(async () => { fireEvent.keyDown(p, { key: "Tab" }); });
    const sections = container.querySelectorAll("section.chapter-sub");
    expect(sections.length).toBe(2);
    expect(sections[1].querySelector(".chapter-prose"), "the nested paragraph edits in place").toBeTruthy();
  });
});

describe("yed chapter — the format bar rides the SHARED bus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const renderWithBar = (node: NodeJson) => {
    fetchNode.mockResolvedValue(node);
    return render(
      <>
        <YedChapterEditor path=":doc" onNavigate={vi.fn()} />
        <ChapterFormatControl />
      </>,
    );
  };

  it("the group appears while the yed editor is mounted; buttons act on MOUSEDOWN", async () => {
    const { container, unmount } = renderWithBar(chapterNode({ title: "Book", body: ["item"] }));
    await settle();
    expect(container.querySelector(".fmt-group")).toBeTruthy();
    const p = container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    await act(async () => { fireEvent.focus(p); });
    await settle();
    const bullets = Array.from(container.querySelectorAll("button.fmt-btn")).find((b) => b.getAttribute("title")?.startsWith("Bullets")) as HTMLElement;
    expect((bullets as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.mouseDown(bullets); });
    expect(await flush()).toEqual([
      { path: ":doc:0", op: "replace", yamlover: "- item", meta: "*yamlover: $defs: bullets" },
    ]);
    unmount();
    cleanup();
  });

  it("T promotes the focused chunk to the TITLE of its (untitled) chapter", async () => {
    const { container } = renderWithBar(chapterNode({ body: ["My title", "p2"] }));
    await settle();
    const p = container.querySelector(".chunk-body .chapter-prose") as HTMLElement;
    await act(async () => { fireEvent.focus(p); });
    await settle();
    const t = Array.from(container.querySelectorAll("button.fmt-btn")).find((b) => b.textContent === "T") as HTMLButtonElement;
    expect(t.disabled).toBe(false);
    await act(async () => { fireEvent.mouseDown(t); });
    const h1Input = container.querySelector("h1.chapter-title input.y2-input") as HTMLInputElement;
    expect(h1Input?.value).toBe("My title");
    expect(document.activeElement).toBe(h1Input);
    expect(await flush()).toEqual([
      { path: ":doc", op: "emplace", yamlover: "My title" },
      { path: ":doc:0", op: "remove" },
    ]);
  });

  it("T on the TITLE itself demotes it into the first body chunk (after the description)", async () => {
    const { container } = renderWithBar(chapterNode({ title: "Book", description: "d", body: ["p1"] }));
    await settle(); // opens focused in the title
    expect(document.activeElement).toBe(container.querySelector("h1.chapter-title input.y2-input"));
    const t = Array.from(container.querySelectorAll("button.fmt-btn")).find((b) => b.textContent === "T") as HTMLButtonElement;
    expect(t.disabled).toBe(false);
    expect(t.className).toContain("active"); // the title HOLDS the role
    await act(async () => { fireEvent.mouseDown(t); });
    expect(container.querySelector("h1.chapter-title")).toBeNull();
    const paras = container.querySelectorAll(".chunk-body .chapter-prose");
    expect(paras[0].textContent).toBe("Book"); // demoted after the description
    expect(await flush()).toEqual([
      { path: ":doc", op: "emplace", yamlover: '""' },
      { path: ":doc:1", op: "insert", yamlover: "Book" },
    ]);
  });

  it("T is OFFERED on the first chunk typed into an EMPTY chapter (rolesOf is value-based)", async () => {
    const { rolesOf } = await import("../../src/client/renderers/yed-chapter-editor");
    const { parseSource } = await import("../../../yed/src/state");
    const { initialChapterState, applyChapterIntent } = await import("../../../yed/src/chapter/apply");
    // the debug page's empty fixture: parseSource("") roots as a scalar with a NULL self
    const born = applyChapterIntent(
      { ...initialChapterState(parseSource("")), focus: { at: "into", path: [] }, caret: null },
      { kind: "splitProse" }, { head: "hello", tail: "" },
    );
    expect(rolesOf(born)).toEqual({ title: "can", desc: "can" });
  });

  it("D makes the focused chunk the description — the container's FIRST entry", async () => {
    const { container } = renderWithBar(chapterNode({ title: "Book", body: ["p1", "about it"] }));
    await settle();
    const p = container.querySelectorAll(".chunk-body .chapter-prose")[1] as HTMLElement;
    await act(async () => { fireEvent.focus(p); });
    await settle();
    const d = Array.from(container.querySelectorAll("button.fmt-btn")).find((b) => b.textContent === "D") as HTMLButtonElement;
    expect(d.disabled).toBe(false);
    await act(async () => { fireEvent.mouseDown(d); });
    expect(descriptionText(container)).toBe("about it");
    // the diff channel's canonical order (removals last-first, then inserts forward) — the
    // server applies progressively, so this lands the same bytes as the legacy insert-then-remove
    expect(await flush()).toEqual([
      { path: ":doc:1", op: "remove" },
      { path: ":doc:0", op: "insert", yamlover: "about it", key: "description" },
    ]);
  });
});
