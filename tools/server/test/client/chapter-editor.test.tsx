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
  // These suites exercise the FLAT editor — since the projection became the default
  // (chapter.tsx projectionalChapterEditor), opt back in via the escape hatch.
  window.history.replaceState({}, "", "/?chapterEditor=flat");
});
afterEach(() => window.history.replaceState({}, "", "/"));

/** An inlined prose chunk marker at body slot `i` (its marker points at its own slot `:doc[i+1]`,
 *  past the keyed `description` at store index 0 — inline ⇒ editable). */
const chunk = (i: number, value: string) => ({
  $yamloverLink: { kind: "scalar", type: "string", path: `:doc[${i + 1}]`, format: "text/marklower", concrete: "yamlover", value },
});

/** A chapter node, FULLY OMNI (CHAPTER.md): the title is the mixed marker's `value` (the scalar
 *  self-value — no index), `description` keyed at [0], then the positional body (prose chunks +
 *  one subchapter) as the marker's keyless entries. */
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
        kind: "omni",
        value: title,
        entries: [
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
    expect(container.querySelector("h2.chapter-title a.descend")?.textContent).toBe("Sub");
  });
});

describe("ChapterView (unlocked) — editor dispatch", () => {
  it("the PROJECTIONAL editor is the default; ?chapterEditor=flat is the escape hatch", () => {
    window.history.replaceState({}, "", "/"); // no flag → the default
    const { container, unmount } = renderUnlocked(chapterNode(["First"]));
    expect(container.querySelector(".chapter-wysiwyg")).toBeTruthy(); // the projection mounts
    unmount();
    window.history.replaceState({}, "", "/?chapterEditor=flat");
    const flat = renderUnlocked(chapterNode(["First"]));
    expect(flat.container.querySelector(".chapter-wysiwyg")).toBeNull();
    expect(flat.container.querySelector("h1.chapter-title.editable")).toBeTruthy(); // the flat editor
  });
});

describe("ChapterEditor (unlocked)", () => {
  it("makes title, description and prose chunks editable; subchapter stays a read-only link", () => {
    const { container } = renderUnlocked(chapterNode(["First", "Second"]));
    expect((container.querySelector("h1.chapter-title") as HTMLElement).getAttribute("contenteditable")).toBe("true");
    expect((container.querySelector("p.chapter-subtitle") as HTMLElement).getAttribute("contenteditable")).toBe("true");
    expect(container.querySelectorAll("p.chapter-prose.editable")).toHaveLength(2);
    // subchapter is NOT edited in this iteration — still a navigable link (same heading face)
    expect(container.querySelector("h2.chapter-title a.descend")?.textContent).toBe("Sub");
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

  it("the context menu is a titled, movable window (path title + close at top-right + drag)", async () => {
    const { container } = renderUnlocked(chapterNode(["First"]));
    const page = container.querySelector(".chapter-page") as HTMLElement;
    await act(async () => { fireEvent.contextMenu(page, { clientX: 20, clientY: 30 }); });
    const bar = container.querySelector(".annotate-titlebar") as HTMLElement;
    expect(bar.querySelector(".annotate-title")?.textContent).toContain("doc"); // displayPath(":doc")
    // the ✕ sits at the top-right, OUTSIDE the draggable path cell (a sibling in the top bar)
    expect(container.querySelector(".annotate-topbar button.close")).not.toBeNull();
    expect(bar.querySelector("button.close")).toBeNull();
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
      // the title is the omni self-value: the emplace addresses the chapter node ITSELF
      expect(editChunks.mock.calls[0][0]).toEqual([{ path: ":doc", op: "emplace", yamlover: '"Renamed"' }]);
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

    // a DIRECTORY-concrete chapter/task defaults new subchapters to a SUBDIRECTORY (the
    // 66-pet-keeper-handbook shape); the inline/file options stay in the picker
    const dirTask = creatablesFor({ format: "x-yamlover-task", concrete: "dir/yamlover" }, {})[0];
    expect(dirTask.defaultConcrete).toBe("dir/yamlover");
    expect(dirTask.concretes.map((c) => c.id)).toEqual(["yamlover", "file/yamlover", "dir/yamlover"]);

    const dir = creatablesFor({ concrete: "dir" }, {});
    expect(dir[0].concretes.map((c) => c.id)).toEqual(["file/yamlover", "dir/yamlover"]);
    expect(dir[0].defaultConcrete).toBe("dir/yamlover"); // the last / richer form

    // every filesystem directory ALSO offers a generic NODE (untagged document, default directory)
    expect(dir[1]).toEqual({
      schema: "node",
      label: "node",
      concretes: [{ id: "file/yamlover", label: "file" }, { id: "dir/yamlover", label: "directory" }],
      defaultConcrete: "dir/yamlover",
    });
    const dirChap = creatablesFor({ format: "x-yamlover-chapter", concrete: "dir/yamlover" }, {});
    expect(dirChap.map((c) => c.schema)).toEqual(["::yamlover:$defs:chapter", "node"]); // dir-backed chapter: both
    expect(chap.map((c) => c.schema)).toEqual(["::yamlover:$defs:chapter"]); // inline chapter: no node — no dir to hold it

    expect(creatablesFor({ format: "text/markdown", concrete: "file/yaml" }, {})).toEqual([]);
    expect(creatablesFor({ format: null, concrete: null }, {})).toEqual([]);

    // a fetched title overrides the path label
    expect(creatablesFor({ concrete: "dir" }, { "::yamlover:$defs:chapter": "Chapter" })[0].label).toBe("Chapter");
  });
});

// A plain folder opened through the OFFERED chapter tab (registry `offers`): it has no body, and
// it is not a chapter yet. The editor must give it a place to type, and the first edit must stamp
// `!!<*::yamlover:$defs:chapter>` — which is what turns the folder INTO one.
describe("ChapterView (unlocked) — a folder written as a chapter", () => {
  const emptyFolder = {
    path: ":", type: "object", format: null, valueType: null, concrete: "dir",
    documentPath: ":", title: null, description: null, value: {},
  } as unknown as NodeJson;

  it("opens with the caret in the title — no click needed to begin", () => {
    const { container } = renderUnlocked(emptyFolder);
    expect(document.activeElement).toBe(container.querySelector("h1.chapter-title"));
    expect(container.querySelector(".chunk-addbtn")).toBeNull(); // no button, no extra click
  });

  it("Enter walks title → description → a first paragraph, made on the way", () => {
    const { container } = renderUnlocked(emptyFolder);
    const h1 = container.querySelector("h1.chapter-title") as HTMLElement;
    fireEvent.keyDown(h1, { key: "Enter" });
    expect(document.activeElement).toBe(container.querySelector("p.chapter-subtitle"));
    expect(container.querySelectorAll(".chunk").length).toBe(0); // no body yet — Enter alone made none

    const desc = container.querySelector("p.chapter-subtitle") as HTMLElement;
    fireEvent.keyDown(desc, { key: "Enter" });
    expect(container.querySelectorAll(".chunk").length).toBe(1);
    const para = container.querySelector(".chunk-body [contenteditable=true]") as HTMLElement;
    expect(para).toBeTruthy();
    expect(document.activeElement).toBe(para); // the caret is IN the paragraph, ready to type
  });

  it("Enter from the description of an EXISTING chapter lands in its first paragraph, making none", () => {
    const { container } = renderUnlocked(chapterNode(["First"]));
    const desc = container.querySelector("p.chapter-subtitle") as HTMLElement;
    fireEvent.keyDown(desc, { key: "Enter" });
    expect(container.querySelectorAll(".chunk").length).toBe(1); // the existing one, not a new one
    expect(document.activeElement).toBe(container.querySelector(".chunk-body [contenteditable=true]"));
  });

  /** Run `fn` with fake timers, so the editor's 500ms debounce can be flushed deterministically. */
  const timed = async (fn: () => Promise<void>) => {
    vi.useFakeTimers();
    try { await fn(); } finally { vi.useRealTimers(); }
  };
  /** Retitle through the h1 and flush the debounce. */
  const retitle = async (container: HTMLElement, text: string) => {
    const h1 = container.querySelector("h1.chapter-title") as HTMLElement;
    h1.textContent = text;
    fireEvent.blur(h1);
    await act(async () => { vi.advanceTimersByTime(600); });
  };

  it("merely OPENING the editor writes nothing", () => timed(async () => {
    renderUnlocked(emptyFolder);
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(editChunks).not.toHaveBeenCalled();
  }));

  it("the first title edit carries the schema stamp on the same op", () => timed(async () => {
    const { container } = renderUnlocked(emptyFolder);
    await retitle(container, "My book");
    expect(editChunks).toHaveBeenCalledWith([
      { path: ":", op: "emplace", yamlover: '"My book"', meta: "*::yamlover:$defs:chapter" },
    ]);
  }));

  it("a SECOND edit carries no stamp — the folder is a chapter now", () => timed(async () => {
    const { container } = renderUnlocked(emptyFolder);
    await retitle(container, "One");
    await retitle(container, "Two");
    expect(editChunks).toHaveBeenLastCalledWith([{ path: ":", op: "emplace", yamlover: '"Two"' }]);
  }));

  it("an already-tagged chapter is never re-stamped", () => timed(async () => {
    const { container } = renderUnlocked(chapterNode(["First"]));
    await retitle(container, "Renamed");
    expect(editChunks).toHaveBeenCalledWith([{ path: ":doc", op: "emplace", yamlover: '"Renamed"' }]);
  }));
});
