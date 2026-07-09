// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MarklowerChunkEditor, type ChunkEditorProps } from "../../src/client/renderers/chunk-editors";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const props = (over: Partial<ChunkEditorProps> = {}): ChunkEditorProps => ({
  text: "before after",
  rev: 0,
  chapterPath: ":doc",
  focusAt: null,
  onFocused: vi.fn(),
  onChangeText: vi.fn(),
  onSplit: vi.fn(),
  onArrowOut: vi.fn(),
  onJoinPrev: vi.fn(),
  onJoinNext: vi.fn(),
  ...over,
});

/** A clipboard carrying one image file, in the shape `clipboardFiles` reads. */
const imageClipboard = (name = "cat.png") => ({
  files: [new File(["PNG"], name, { type: "image/png" })],
  items: [],
});

/** Put the caret at the end of the editable's first text node. */
function caretAtEndOf(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe("pasting an image into a prose chunk", () => {
  it("uploads it beside the chapter (no chunk appended) and writes an embed token at the caret", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ path: ":doc:cat.png", dir: ":doc", open: false }) };
    }));
    const onChangeText = vi.fn();
    const { container } = render(<MarklowerChunkEditor {...props({ onChangeText })} />);
    const el = container.querySelector(".chapter-prose") as HTMLElement;
    caretAtEndOf(el);

    fireEvent.paste(el, { clipboardData: imageClipboard() });

    await waitFor(() => expect(onChangeText).toHaveBeenCalled());

    // the upload asked for an INLINE paste — the server must not append a pointer chunk
    expect(posted).toEqual([{ path: ":doc", filename: "cat.png", contentBase64: btoa("PNG"), inline: true }]);

    // the chunk's source gained an embed token pointing at the new file, project-rooted
    expect(onChangeText).toHaveBeenLastCalledWith("before after*[cat](::doc:cat.png)");

    // and it landed as a non-editable atom, exactly as a reloaded one would
    const atom = container.querySelector(".mlw-atom.mlw-embed-chip") as HTMLElement;
    expect(atom.getAttribute("contenteditable")).toBe("false");
    expect(atom.dataset.src).toBe("*[cat](::doc:cat.png)");
    expect(atom.textContent).toBe("🖼 cat"); // the image glyph, not the play glyph
  });

  it("lets a text paste fall through to the browser", () => {
    const onChangeText = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { container } = render(<MarklowerChunkEditor {...props({ onChangeText })} />);
    const el = container.querySelector(".chapter-prose") as HTMLElement;
    caretAtEndOf(el);

    fireEvent.paste(el, { clipboardData: { files: [], items: [] } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
