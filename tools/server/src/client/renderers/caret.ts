// Generic caret utilities for the in-place chunk editors (chunk-editors.tsx). None of this is
// marklower-specific: it operates on a contentEditable element and the window selection.

/** Focus `el` and place the caret at the very start of its content. */
export function focusStart(el: HTMLElement): void {
  placeCaret(el, 0);
}

/** Focus `el` and place the caret at the very end of its content. */
export function focusEnd(el: HTMLElement): void {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Focus `el` and place the caret after `offset` VISIBLE characters (counting the text inside atoms
 *  — math/code/link — as their rendered length, but never landing inside one). Used to drop the
 *  caret at a join junction. Falls off the end → caret at the end. */
export function placeCaret(el: HTMLElement, offset: number): void {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let rem = Math.max(0, offset);
  const walk = (node: Node): boolean => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const len = child.textContent?.length ?? 0;
        if (rem <= len) { range.setStart(child, rem); range.collapse(true); return true; }
        rem -= len;
      } else if (child instanceof HTMLElement) {
        const atom = child.getAttribute("contenteditable") === "false" || child.hasAttribute("data-src");
        if (atom) {
          const len = child.textContent?.length ?? 0;
          if (rem <= len) { range.setStartAfter(child); range.collapse(true); return true; }
          rem -= len;
        } else if (walk(child)) {
          return true;
        }
      }
    }
    return false;
  };
  if (!walk(el)) { range.selectNodeContents(el); range.collapse(false); }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The collapsed caret's range within `el`, or null when there is no caret inside it. */
function caretRange(el: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const c = sel.getRangeAt(0);
  return el.contains(c.startContainer) ? c : null;
}

/** Whether the collapsed caret sits at the very start of `el` (no text precedes it). */
export function caretAtStart(el: HTMLElement): boolean {
  const c = caretRange(el);
  if (!c) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(c.startContainer, c.startOffset);
  return r.toString().length === 0;
}

/** Whether the collapsed caret sits at the very end of `el` (no text follows it). */
export function caretAtEnd(el: HTMLElement): boolean {
  const c = caretRange(el);
  if (!c) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setStart(c.endContainer, c.endOffset);
  return r.toString().length === 0;
}

/** The caret's bounding rect (using a zero-width probe when the range itself has no box). */
function caretRect(c: Range): DOMRect | null {
  const r = c.cloneRange();
  r.collapse(true);
  let rect = r.getBoundingClientRect();
  if (rect.height === 0 && rect.top === 0) {
    const probe = document.createElement("span");
    probe.textContent = "​";
    r.insertNode(probe);
    rect = probe.getBoundingClientRect();
    const p = probe.parentNode;
    probe.remove();
    p?.normalize();
  }
  return rect;
}

/** The element's line height in px (best-effort). */
function lineHeightOf(el: HTMLElement): number {
  const st = getComputedStyle(el);
  const lh = parseFloat(st.lineHeight);
  return Number.isFinite(lh) && lh > 0 ? lh : (parseFloat(st.fontSize) || 16) * 1.4;
}

/** Whether the caret is on the FIRST visual line of `el` (so ArrowUp should leave the chunk). When
 *  the element can't be measured (e.g. jsdom → zero-height), treat it as a single line. */
export function caretOnFirstLine(el: HTMLElement): boolean {
  const c = caretRange(el);
  if (!c) return false;
  if (el.clientHeight === 0) return true; // unmeasurable (test env) → single line
  const cr = caretRect(c);
  if (!cr) return true;
  return cr.top - el.getBoundingClientRect().top < lineHeightOf(el) * 0.75;
}

/** Whether the caret is on the LAST visual line of `el` (so ArrowDown should leave the chunk). */
export function caretOnLastLine(el: HTMLElement): boolean {
  const c = caretRange(el);
  if (!c) return false;
  if (el.clientHeight === 0) return true; // unmeasurable (test env) → single line
  const cr = caretRect(c);
  if (!cr) return true;
  return el.getBoundingClientRect().bottom - cr.bottom < lineHeightOf(el) * 0.75;
}
