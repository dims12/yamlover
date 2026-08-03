// The chapter cell-layer test kit: a harness owning ChapterState over the NEW cells, with
// the plain codec (spy-able) and a ctx-scoped column memory — the pure-view counterpart of
// the server mount. Used by chapter-cells.test.tsx (laws) and chapter-dom-typing.test.tsx.
import { useRef, useState } from "react";
import { act, render } from "@testing-library/react";
import { parseSource, type Value, type Path } from "../src/state";
import {
  applyChapterIntent, applyChapterKey, commitChapterText, createFirstChunk, initialChapterState,
  type ChapterState, type SplitPayload,
} from "../src/chapter/apply";
import type { ChapterIntent, ChapterKey } from "../src/chapter/dispatch";
import type { ChapterEdges } from "../src/chapter/site";
import { chapterPositionsOf } from "../src/chapter/positions";
import { withNode } from "../src/apply";
import { createColumnMemory } from "../src/chapter/caret";
import { ChapterCtx, ChapterDoc, plainCodec, type ChapterCellsAdapter, type ChapterCtxValue, type ProseCodec } from "../src/chapter/cells";

export interface ChapterHarness {
  container: HTMLElement;
  state(): ChapterState;
  update(next: ChapterState): void;
  dispatch(intent: ChapterIntent, split?: SplitPayload): void;
  codec: ProseCodec;
  navigations: string[];
  rerender(): void;
  unmount(): void;
}

export function mountChapter(src: string, opts: { debug?: boolean; codec?: ProseCodec } = {}): ChapterHarness {
  const doc = parseSource(src);
  const first = chapterPositionsOf(doc)[0] ?? null;
  let last: ChapterState = { ...initialChapterState(doc), focus: first, caret: first ? "end" : null };
  let push: (s: ChapterState) => void = () => {};
  const navigations: string[] = [];
  const codec = opts.codec ?? { ...plainCodec };
  const columnMemory = createColumnMemory();

  function App() {
    const [state, setState] = useState(last);
    const stateRef = useRef(state);
    stateRef.current = state;
    last = state;
    push = (s) => { last = s; setState(s); };
    const adapter: ChapterCellsAdapter = { codec, navigate: (p) => navigations.push(p), columnMemory };
    const ctx: ChapterCtxValue = {
      state,
      debug: opts.debug ?? true,
      adapter,
      dispatch: (intent, split) => push(applyChapterIntent(stateRef.current, intent, split)),
      dispatchKey: (k: ChapterKey, edges?: ChapterEdges) => {
        const out = applyChapterKey(stateRef.current, k, edges);
        if (out) push(out);
        return out !== null;
      },
      commitText: (p: Path, text: string) => push(commitChapterText(stateRef.current, p, text)),
      boot: (p: Path, text: string) => push(createFirstChunk(stateRef.current, p, text)),
      focusTo: (pos, caret = null) => push({ ...stateRef.current, focus: pos, caret }),
      graft: (p: Path, value: Value, focus?) => push({ ...stateRef.current, doc: withNode(stateRef.current.doc, p, () => value as never), ...(focus ? { focus, caret: "start" as const } : {}) }),
      chapterPath: ":doc",
    };
    return <ChapterCtx.Provider value={ctx}><ChapterDoc /></ChapterCtx.Provider>;
  }

  const utils = render(<App />);
  // pushes from TEST code run outside React's event path — act() makes them flush
  const acted = (fn: () => void): void => { act(fn); };
  return {
    container: utils.container,
    state: () => last,
    update: (next) => acted(() => push(next)),
    dispatch: (intent, split) => acted(() => push(applyChapterIntent(last, intent, split))),
    codec,
    navigations,
    rerender: () => acted(() => push({ ...last })),
    unmount: utils.unmount,
  };
}

/** The closed set of legal caret homes — `document.activeElement` must be one after EVERY
 *  interaction (the chapter twin of dom-typing's focusedInput). */
export function focusedHome(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  return (
    (el.tagName === "INPUT" && el.classList.contains("y2-input")) ||
    (el.getAttribute("contenteditable") === "true" && el.classList.contains("chapter-prose")) ||
    (el.tagName === "TEXTAREA" && el.classList.contains("chapter-latex-src")) ||
    el.classList.contains("y2-atomslot") ||
    el.classList.contains("y2-gapslot")
  );
}

/** Put the collapsed caret at `offset` inside a contentEditable's first text node. */
export function setCaret(el: HTMLElement, offset: number): void {
  el.focus();
  const sel = window.getSelection()!;
  const r = document.createRange();
  const t = el.firstChild ?? el;
  r.setStart(t, Math.min(offset, t.textContent?.length ?? 0));
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}
