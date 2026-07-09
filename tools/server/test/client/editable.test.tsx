// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { marklowerToEditableHtml } from "../../src/client/renderers/marklower";
import { MarklowerChunkEditor, type ChunkEditorProps } from "../../src/client/renderers/chunk-editors";
import { domToMarklower } from "../../src/client/marklower-serialize";

afterEach(cleanup);

/** Render marklower into an editor DOM (via the same helper the editor uses), then serialize it back. */
function roundTrip(src: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = marklowerToEditableHtml(src);
  return domToMarklower(holder);
}

describe("marklower editor round-trip (domToMarklower ∘ marklowerToEditableHtml)", () => {
  it("preserves plain prose, emphasis, code, math and links", () => {
    expect(roundTrip("just plain text")).toBe("just plain text");
    expect(roundTrip("a **b** and *i* and ~~s~~")).toBe("a **b** and *i* and ~~s~~");
    expect(roundTrip("use `**not bold**` here")).toBe("use `**not bold**` here");
    expect(roundTrip("Euler $$e^{i\\pi}+1=0$$ done")).toBe("Euler $$e^{i\\pi}+1=0$$ done");
    expect(roundTrip("see [the intro](/chunks[0]) please")).toBe("see [the intro](/chunks[0]) please");
  });

  it("maps <br> and <div> line wrappers to newlines", () => {
    const a = document.createElement("div");
    a.innerHTML = "line one<br>line two";
    expect(domToMarklower(a)).toBe("line one\nline two");
    const b = document.createElement("div");
    b.innerHTML = "first<div>second</div><div>third</div>";
    expect(domToMarklower(b)).toBe("first\nsecond\nthird");
  });
});

const props = (over: Partial<ChunkEditorProps> = {}): ChunkEditorProps => ({
  text: "hello",
  rev: 0,
  chapterPath: ":chapter.yamlover",
  focusAt: null,
  onFocused: vi.fn(),
  onChangeText: vi.fn(),
  onSplit: vi.fn(),
  onArrowOut: vi.fn(),
  onJoinPrev: vi.fn(),
  onJoinNext: vi.fn(),
  ...over,
});

/** Put the collapsed caret at `offset` within the editor's first text node. */
function caretAt(p: HTMLElement, offset: number) {
  const sel = window.getSelection()!;
  const r = document.createRange();
  r.setStart(p.firstChild!, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

describe("MarklowerChunkEditor (controlled-on-rev)", () => {
  it("reports typed text via onChangeText (serialized to marklower)", () => {
    const onChangeText = vi.fn();
    const { container } = render(<MarklowerChunkEditor {...props({ onChangeText })} />);
    const p = container.querySelector("p.chapter-prose.editable") as HTMLElement;
    expect(p.getAttribute("contenteditable")).toBe("true");
    p.innerHTML = "hello <strong>world</strong>";
    fireEvent.input(p);
    expect(onChangeText).toHaveBeenLastCalledWith("hello **world**");
  });

  it("resets the DOM from the model when rev changes — even while focused (the split fix)", () => {
    const { container, rerender } = render(<MarklowerChunkEditor {...props({ text: "onetwo", rev: 0 })} />);
    const p = container.querySelector("p.editable") as HTMLElement;
    p.focus();
    rerender(<MarklowerChunkEditor {...props({ text: "one", rev: 1 })} />);
    expect(p.textContent).toBe("one");
  });

  it("does NOT reset the DOM on a text change without a rev bump (caret preserved while typing)", () => {
    const { container, rerender } = render(<MarklowerChunkEditor {...props({ text: "a", rev: 0 })} />);
    const p = container.querySelector("p.editable") as HTMLElement;
    p.innerHTML = "a user typed more";
    rerender(<MarklowerChunkEditor {...props({ text: "a user typed more", rev: 0 })} />);
    expect(p.innerHTML).toBe("a user typed more");
  });

  it("Enter splits at the caret → onSplit(head, tail)", () => {
    const onSplit = vi.fn();
    const { container } = render(<MarklowerChunkEditor {...props({ text: "onetwo", onSplit })} />);
    const p = container.querySelector("p.editable") as HTMLElement;
    caretAt(p, 3); // after "one"
    fireEvent.keyDown(p, { key: "Enter" });
    expect(onSplit).toHaveBeenCalledWith("one", "two");
  });

  it("Backspace at the very start → onJoinPrev", () => {
    const onJoinPrev = vi.fn();
    const { container } = render(<MarklowerChunkEditor {...props({ text: "tail", onJoinPrev })} />);
    const p = container.querySelector("p.editable") as HTMLElement;
    caretAt(p, 0);
    fireEvent.keyDown(p, { key: "Backspace" });
    expect(onJoinPrev).toHaveBeenCalledOnce();
  });

  it("Delete at the very end → onJoinNext", () => {
    const onJoinNext = vi.fn();
    const { container } = render(<MarklowerChunkEditor {...props({ text: "head", onJoinNext })} />);
    const p = container.querySelector("p.editable") as HTMLElement;
    caretAt(p, 4); // end of "head"
    fireEvent.keyDown(p, { key: "Delete" });
    expect(onJoinNext).toHaveBeenCalledOnce();
  });
});
