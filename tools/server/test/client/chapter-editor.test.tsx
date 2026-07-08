// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";

// Mock the write APIs — the editor's background sync + the context menu's create call.
// (hoisted so the mock fns exist before vi.mock's hoisted factory runs.)
const { editChunks, createObject } = vi.hoisted(() => ({ editChunks: vi.fn(), createObject: vi.fn() }));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), editChunks, createObject }));

import { ChapterView } from "../../src/client/renderers/chapter";
import { EditingContext } from "../../src/client/renderers/editing";
import { creatablesFor } from "../../src/client/renderers/create";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);
beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  createObject.mockReset().mockResolvedValue({ path: ":doc[9]" });
});

/** An inlined prose chunk marker at body slot `i` (its marker points at its own slot `:doc[i+1]`,
 *  past the keyed `title` at store index 0 — inline ⇒ editable). */
const chunk = (i: number, value: string) => ({
  $yamloverLink: { kind: "scalar", type: "string", path: `:doc[${i + 1}]`, format: "text/marklower", concrete: "yamlover", value },
});

/** A chapter node: title/description keyed, then the positional body (prose chunks + one
 *  subchapter) as the mixed marker's keyless entries (CHAPTER.md). */
function chapterNode(chunks: string[], title = "My Title", description = "My subtitle"): NodeJson {
  return {
    path: ":doc",
    type: "variant",
    format: "x-yamlover-chapter",
    concrete: "yamlover",
    documentPath: ":doc",
    title,
    description,
    value: {
      $yamloverMixed: {
        kind: "mix",
        entries: [
          { key: "title", value: title },
          ...(description ? [{ key: "description", value: description }] : []),
          ...chunks.map((t, i) => ({ key: null, value: chunk(i, t) })),
          { key: null, value: { $yamloverLink: { kind: "object", type: "object", path: ":doc[9]", format: "x-yamlover-chapter", title: "Sub", count: 2 } } },
        ],
      },
    },
  } as unknown as NodeJson;
}

const renderUnlocked = (node: NodeJson) =>
  render(
    <EditingContext.Provider value={{ unlocked: true }}>
      <ChapterView node={node} onNavigate={vi.fn()} />
    </EditingContext.Provider>,
  );

describe("ChapterView (locked) read-only", () => {
  it("renders plain, no contentEditable, subchapter is a link", () => {
    const { container } = render(
      <EditingContext.Provider value={{ unlocked: false }}>
        <ChapterView node={chapterNode(["First"])} onNavigate={vi.fn()} />
      </EditingContext.Provider>,
    );
    expect(container.querySelector("[contenteditable=true]")).toBeNull();
    expect(container.querySelector("h1.chapter-title")?.textContent).toBe("My Title");
    expect(container.querySelector("h2.chapter-link a.descend")?.textContent).toBe("Sub");
  });
});

describe("ChapterEditor (unlocked)", () => {
  it("makes title, description and prose chunks editable; subchapter stays a read-only link", () => {
    const { container } = renderUnlocked(chapterNode(["First", "Second"]));
    expect((container.querySelector("h1.chapter-title") as HTMLElement).getAttribute("contenteditable")).toBe("true");
    expect((container.querySelector("p.chapter-subtitle") as HTMLElement).getAttribute("contenteditable")).toBe("true");
    expect(container.querySelectorAll("p.chapter-prose.editable")).toHaveLength(2);
    // subchapter is NOT edited in this iteration — still a navigable link
    expect(container.querySelector("h2.chapter-link a.descend")?.textContent).toBe("Sub");
  });

  it("SPLIT: caret before the tail, Enter → head truncates in place AND a new chunk holds the tail (the reported bug)", () => {
    const { container } = renderUnlocked(chapterNode(["onetwo"]));
    const p = container.querySelector("p.chapter-prose.editable") as HTMLElement;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(p.firstChild!, 3); // caret after "one"
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    act(() => { fireEvent.keyDown(p, { key: "Enter" }); });
    const proses = container.querySelectorAll("p.chapter-prose.editable");
    expect(proses).toHaveLength(2);
    expect(proses[0].textContent).toBe("one"); // head truncated — NOT the old "onetwo" duplicate
    expect(proses[1].textContent).toBe("two");
  });

  it("Enter at the end of the last chunk adds a new (empty) chunk — no ＋ button needed", () => {
    const { container } = renderUnlocked(chapterNode(["only"]));
    const p = container.querySelector("p.chapter-prose.editable") as HTMLElement;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false); // caret at end
    sel.removeAllRanges();
    sel.addRange(r);
    act(() => { fireEvent.keyDown(p, { key: "Enter" }); });
    expect(container.querySelectorAll("p.chapter-prose.editable")).toHaveLength(2);
  });

  it("JOIN: Backspace at the start of chunk 1 merges it into chunk 0", () => {
    const { container } = renderUnlocked(chapterNode(["head", "tail"]));
    const proses = container.querySelectorAll("p.chapter-prose.editable");
    const p1 = proses[1] as HTMLElement;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(p1.firstChild!, 0); // caret at the very start of chunk 1
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    act(() => { fireEvent.keyDown(p1, { key: "Backspace" }); });
    const after = container.querySelectorAll("p.chapter-prose.editable");
    expect(after).toHaveLength(1);
    expect(after[0].textContent).toBe("headtail");
  });

  it("right-click empty space offers create with a concrete selector; creates + navigates", async () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <EditingContext.Provider value={{ unlocked: true }}>
        <ChapterView node={chapterNode(["First"])} onNavigate={onNavigate} />
      </EditingContext.Provider>,
    );
    const page = container.querySelector(".chapter-page") as HTMLElement;
    await act(async () => { fireEvent.contextMenu(page, { clientX: 5, clientY: 5 }); });
    const action = container.querySelector(".annotate-action") as HTMLElement;
    expect(action?.textContent).toContain("New"); // "＋ New <schema label>"
    const select = container.querySelector("select.annotate-concrete") as HTMLSelectElement;
    expect(select.value).toBe("yamlover"); // a subchapter's default concrete = inline
    await act(async () => { fireEvent.change(select, { target: { value: "file/yamlover" } }); }); // pick a linked file
    await act(async () => { fireEvent.click(action); });
    expect(createObject).toHaveBeenCalledWith("::yamlover:$defs:chapter", ":doc", "file/yamlover");
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith(":doc[9]"));
  });

  it("the context menu is a titled, movable window (path title + close in the title bar + drag)", async () => {
    const { container } = renderUnlocked(chapterNode(["First"]));
    const page = container.querySelector(".chapter-page") as HTMLElement;
    await act(async () => { fireEvent.contextMenu(page, { clientX: 20, clientY: 30 }); });
    const bar = container.querySelector(".annotate-titlebar") as HTMLElement;
    expect(bar.querySelector(".annotate-title")?.textContent).toContain("doc"); // displayPath(":doc")
    expect(bar.querySelector("button.close")).not.toBeNull(); // the ✕ moved into the title bar
    const menu = container.querySelector(".annotate-menu") as HTMLElement;
    const left0 = menu.style.left;
    act(() => { fireEvent.mouseDown(bar, { clientX: 100, clientY: 100 }); });
    act(() => { fireEvent.mouseMove(document, { clientX: 140, clientY: 125 }); });
    act(() => { fireEvent.mouseUp(document); });
    expect(menu.style.left).not.toBe(left0); // dragging moved the window
  });

  it("makes a LaTeX chunk editable as a source textarea", () => {
    const node = {
      path: ":doc",
      type: "object",
      format: "x-yamlover-chapter",
      concrete: "yamlover",
      documentPath: ":doc",
      title: "Math",
      description: "",
      value: {
        $yamloverMixed: {
          kind: "mix",
          entries: [
            { key: "title", value: "Math" },
            { key: null, value: { $yamloverLink: { kind: "scalar", type: "string", path: ":doc[1]", format: "text/x-latex", concrete: "yamlover", value: "e^{i\\pi}" } } },
          ],
        },
      },
    } as unknown as NodeJson;
    const { container } = renderUnlocked(node);
    const ta = container.querySelector("textarea.chapter-latex-src") as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe("e^{i\\pi}");
  });

  it("syncs edits to the server in the background (debounced batch) — title set", async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderUnlocked(chapterNode(["First"]));
      const h1 = container.querySelector("h1.chapter-title") as HTMLElement;
      h1.textContent = "Renamed";
      fireEvent.blur(h1);
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(editChunks).toHaveBeenCalledTimes(1);
      expect(editChunks.mock.calls[0][0]).toEqual([{ path: ":doc:title", op: "set", text: "Renamed" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("creatablesFor (what/where a schema object can be created)", () => {
  it("a chapter → child concretes (inline default); a directory → member concretes (dir default); else none", () => {
    const chap = creatablesFor({ format: "x-yamlover-chapter", concrete: "yamlover" }, {});
    expect(chap).toHaveLength(1);
    expect(chap[0].concretes.map((c) => c.id)).toEqual(["yamlover", "file/yamlover", "dir/yamlover"]);
    expect(chap[0].defaultConcrete).toBe("yamlover");
    expect(chap[0].label).toContain("chapter"); // schema title absent → path fallback

    expect(creatablesFor({ format: "x-yamlover-task", concrete: "dir/yamlover" }, {})[0].defaultConcrete).toBe("yamlover"); // task also hosts subchapters

    const dir = creatablesFor({ concrete: "dir" }, {});
    expect(dir[0].concretes.map((c) => c.id)).toEqual(["file/yamlover", "dir/yamlover"]);
    expect(dir[0].defaultConcrete).toBe("dir/yamlover"); // the last / richer form

    expect(creatablesFor({ format: "text/markdown", concrete: "file/yaml" }, {})).toEqual([]);
    expect(creatablesFor({ format: null, concrete: null }, {})).toEqual([]);

    // a fetched title overrides the path label
    expect(creatablesFor({ concrete: "dir" }, { "::yamlover:$defs:chapter": "Chapter" })[0].label).toBe("Chapter");
  });
});
