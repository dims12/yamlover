// Format-dependent CHUNK EDITORS. Editing a chapter is per-chunk, and how a chunk is edited depends
// on its (type, format) — mirroring the read-only renderer registry. A marklower/markdown chunk
// edits WYSIWYG (the rendered prose is contentEditable); a LaTeX chunk edits its raw source in a
// textarea. `chunkEditorFor(format)` picks the editor (null ⇒ the chunk is read-only).
//
// Every editor speaks the same {@link ChunkEditorProps} contract, so chapter.tsx drives them all the
// same way: report text changes, split on Enter (prose), navigate to the adjacent chunk when the
// caret leaves the top/bottom line, and join with a neighbour on Backspace-at-start / Delete-at-end.

import { useEffect, useRef } from "react";
import { marklowerToEditableHtml } from "./marklower";
import { domToMarklower } from "../marklower-serialize";
import { focusStart, focusEnd, placeCaret, caretAtStart, caretAtEnd, caretOnFirstLine, caretOnLastLine } from "./caret";
import { clipboardFiles, fileToBase64, pastedName } from "../clipboard";
import { pasteFileInline } from "../api";

/** Where a freshly-focused editor should drop its caret. */
export type FocusAt = "start" | "end" | number | null;

export interface ChunkEditorProps {
  text: string;
  rev: number; // bumped when the MODEL changed the text (a split/join) → the editor resets its content
  chapterPath: string; // the chapter this chunk belongs to — where a pasted image is uploaded
  focusAt: FocusAt;
  onFocused: () => void;
  onChangeText: (text: string) => void;
  onSplit: (head: string, tail: string) => void; // Enter at the caret (prose only)
  onArrowOut: (dir: "up" | "down") => void; // caret left the first/last line → go to the adjacent chunk
  onJoinPrev: () => void; // Backspace at the very start → merge into the previous chunk
  onJoinNext: () => void; // Delete at the very end → pull the next chunk into this one
}

export type ChunkEditor = (props: ChunkEditorProps) => JSX.Element;

/** The rendered (visible) length of a marklower source — the caret offset of a join junction. */
export function renderedTextLength(src: string): number {
  const el = document.createElement("div");
  el.innerHTML = marklowerToEditableHtml(src);
  return el.textContent?.length ?? 0;
}

/** Split a marklower contentEditable at the caret into (head, tail) source — atoms land whole on one
 *  side. Null when there is no caret inside `el`. */
function splitAtCaret(el: HTMLElement): { head: string; tail: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.getRangeAt(0).endContainer)) return null;
  const caret = sel.getRangeAt(0);
  const cut = (which: "head" | "tail"): string => {
    const r = document.createRange();
    r.selectNodeContents(el);
    if (which === "head") r.setEnd(caret.endContainer, caret.endOffset);
    else r.setStart(caret.endContainer, caret.endOffset);
    const holder = document.createElement("div");
    holder.appendChild(r.cloneContents());
    return domToMarklower(holder);
  };
  return { head: cut("head"), tail: cut("tail") };
}

/** A caption for a pasted image: its filename without the extension (`sunset-01.png` → `sunset-01`),
 *  which is all the name the clipboard ever gives us. */
function captionOf(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

/**
 * Upload each pasted image beside the chapter and drop an embed atom for it at the caret. The
 * upload is `inline`, so the server writes the file and does NOT append a chunk — the picture
 * belongs in this sentence, not after the chapter.
 *
 * The atom's HTML comes from {@link marklowerToEditableHtml} rather than being hand-built, so a
 * freshly pasted image and one reloaded from source are the same DOM. The caret `Range` is captured
 * before the upload: the contentEditable is not touched while we await, so it stays valid.
 */
async function insertPastedImages(el: HTMLElement, range: Range, files: File[], chapterPath: string, onChangeText: (text: string) => void): Promise<void> {
  for (const f of files) {
    const name = pastedName(f);
    const res = await pasteFileInline(chapterPath, name, await fileToBase64(f));
    // `res.path` is a `:`-rooted node path; a second colon makes it project-rooted (SEPARATOR.md),
    // which is the spelling `resolveLink` reads back.
    const holder = document.createElement("span");
    holder.innerHTML = marklowerToEditableHtml(`*[${captionOf(name)}](:${res.path})`);
    const atom = holder.firstChild;
    if (!atom) continue;
    range.insertNode(atom);
    range.setStartAfter(atom); // the next image lands after this one, not before it
    range.collapse(true);
  }
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); } // leave the caret after the last image
  onChangeText(domToMarklower(el));
}

function applyFocus(el: HTMLElement, at: FocusAt): void {
  if (at === "start") focusStart(el);
  else if (at === "end") focusEnd(el);
  else if (typeof at === "number") placeCaret(el, at);
}

/**
 * The marklower / markdown editor: the rendered prose itself is contentEditable (atoms — math, code,
 * links — are non-editable and carry their source in `data-src`, so the round-trip is lossless).
 * CONTROLLED-ON-`rev`: the DOM is rewritten from `text` only when `rev` changes (mount + a
 * model-driven text change like a split head), never mid-type — so typing never loses the caret.
 */
export const MarklowerChunkEditor: ChunkEditor = ({ text, rev, chapterPath, focusAt, onFocused, onChangeText, onSplit, onArrowOut, onJoinPrev, onJoinNext }) => {
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = marklowerToEditableHtml(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  useEffect(() => {
    if (focusAt != null && ref.current) { applyFocus(ref.current, focusAt); onFocused(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAt]);

  return (
    <p
      ref={ref}
      className="chapter-prose editable"
      contentEditable
      suppressContentEditableWarning
      onInput={() => { if (ref.current) onChangeText(domToMarklower(ref.current)); }}
      onPaste={(e) => {
        // An image on the clipboard becomes a FILE beside the chapter plus an embed atom here.
        // Everything else (text, HTML) falls through to the browser's own paste, which the input
        // handler then re-serializes.
        const el = ref.current;
        const images = clipboardFiles(e.nativeEvent).filter((f) => f.type.startsWith("image/"));
        if (!el || images.length === 0) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !el.contains(sel.getRangeAt(0).endContainer)) return;
        e.preventDefault();
        void insertPastedImages(el, sel.getRangeAt(0).cloneRange(), images, chapterPath, onChangeText);
      }}
      onKeyDown={(e) => {
        const el = ref.current;
        if (!el) return;
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const p = splitAtCaret(el); if (p) onSplit(p.head, p.tail); return; }
        if (e.key === "ArrowUp" && caretOnFirstLine(el)) { e.preventDefault(); onArrowOut("up"); return; }
        if (e.key === "ArrowDown" && caretOnLastLine(el)) { e.preventDefault(); onArrowOut("down"); return; }
        if (e.key === "Backspace" && caretAtStart(el)) { e.preventDefault(); onJoinPrev(); return; }
        if (e.key === "Delete" && caretAtEnd(el)) { e.preventDefault(); onJoinNext(); return; }
      }}
    />
  );
};

/**
 * The LaTeX editor: a chunk of `text/x-latex` (a whole math block) edits its RAW SOURCE in a
 * textarea (multi-line formulas survive verbatim). No WYSIWYG typesetting while editing — the
 * locked view renders it with KaTeX. Enter is a normal newline (no split); leaving the top/bottom
 * line navigates to the adjacent chunk.
 */
export const LatexChunkEditor: ChunkEditor = ({ text, rev, focusAt, onFocused, onChangeText, onArrowOut }) => {
  const ref = useRef<HTMLTextAreaElement>(null);

  const grow = (el: HTMLTextAreaElement): void => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };

  useEffect(() => {
    if (ref.current) { ref.current.value = text; grow(ref.current); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  useEffect(() => {
    const el = ref.current;
    if (focusAt == null || !el) return;
    const n = focusAt === "start" ? 0 : focusAt === "end" ? el.value.length : focusAt;
    el.focus();
    el.setSelectionRange(n, n);
    onFocused();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAt]);

  return (
    <textarea
      ref={ref}
      className="chapter-latex-src editable"
      spellCheck={false}
      rows={1}
      defaultValue={text}
      onInput={(e) => { const el = e.currentTarget; grow(el); onChangeText(el.value); }}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        const before = el.value.slice(0, el.selectionStart);
        const after = el.value.slice(el.selectionEnd);
        const collapsed = el.selectionStart === el.selectionEnd;
        if (e.key === "ArrowUp" && collapsed && !before.includes("\n")) { e.preventDefault(); onArrowOut("up"); return; }
        if (e.key === "ArrowDown" && collapsed && !after.includes("\n")) { e.preventDefault(); onArrowOut("down"); return; }
      }}
    />
  );
};

/** The editor for a chunk of `format` — mirrors the read-only renderer registry. null ⇒ read-only. */
export function chunkEditorFor(format: string | null): ChunkEditor | null {
  if (format === null || format === "text/marklower" || format === "text/markdown") return MarklowerChunkEditor;
  if (format === "text/x-latex") return LatexChunkEditor;
  return null;
}

/** Whether joining two adjacent chunks makes sense — only WYSIWYG prose chunks merge (a LaTeX block
 *  is never merged into prose). */
export function isJoinableFormat(format: string | null): boolean {
  return format === null || format === "text/marklower" || format === "text/markdown";
}
