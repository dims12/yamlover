// THE CHAPTER CARET MODULE — yed-owned, zero server imports. The write side (placeCaretVisible)
// and the missing read side (caretVisibleOffset) speak the same VISIBLE-offset law: text inside
// an ATOM (contenteditable=false / data-src) counts as its rendered length, but the caret never
// lands inside one — it lands after. Machine caret numbers are SOURCE offsets; the prose cell
// converts via codec.visibleLength before calling in here.
//
// Column memory: a vertical walk keeps the caret's horizontal position. Ctx-scoped (one per
// mounted editor — createColumnMemory), consume-once, 400 ms freshness; layoutless
// environments remember nothing and fall back to plain start/end.

export function focusStart(el: HTMLElement): void {
  placeCaretVisible(el, 0);
}

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

/** Focus `el` and place the caret after `offset` VISIBLE characters — atoms count as their
 *  rendered length, the caret lands after them, never inside. Falls off the end → the end. */
export function placeCaretVisible(el: HTMLElement, offset: number): void {
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

/** The read side: the collapsed caret's VISIBLE offset within `el`, or null when the caret is
 *  not inside it. `range.toString()` counts atom text the same way the write side does. */
export function caretVisibleOffset(el: HTMLElement): number | null {
  const c = caretRange(el);
  if (!c) return null;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(c.startContainer, c.startOffset);
  return r.toString().length;
}

function caretRange(el: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const c = sel.getRangeAt(0);
  return el.contains(c.startContainer) ? c : null;
}

export function caretAtStart(el: HTMLElement): boolean {
  const c = caretRange(el);
  if (!c) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(c.startContainer, c.startOffset);
  return r.toString().length === 0;
}

export function caretAtEnd(el: HTMLElement): boolean {
  const c = caretRange(el);
  if (!c) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setStart(c.endContainer, c.endOffset);
  return r.toString().length === 0;
}

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

function lineHeightOf(el: HTMLElement): number {
  const st = getComputedStyle(el);
  const lh = parseFloat(st.lineHeight);
  return Number.isFinite(lh) && lh > 0 ? lh : (parseFloat(st.fontSize) || 16) * 1.4;
}

/** The caret is on the FIRST visual line (ArrowUp should walk). Unmeasurable (jsdom) ⇒ one line. */
export function caretOnFirstLine(el: HTMLElement): boolean {
  const c = caretRange(el);
  if (!c) return false;
  if (el.clientHeight === 0) return true;
  const cr = caretRect(c);
  if (!cr) return true;
  return cr.top - el.getBoundingClientRect().top < lineHeightOf(el) * 0.75;
}

/** The caret is on the LAST visual line (ArrowDown should walk). */
export function caretOnLastLine(el: HTMLElement): boolean {
  const c = caretRange(el);
  if (!c) return false;
  if (el.clientHeight === 0) return true;
  const cr = caretRect(c);
  if (!cr) return true;
  return el.getBoundingClientRect().bottom - cr.bottom < lineHeightOf(el) * 0.75;
}

// ---------------------------------------------------------------------------- //
// Column memory — the vertical walk keeps its horizontal position
// ---------------------------------------------------------------------------- //

export interface ColumnMemory {
  /** Remember the caret's x just before a vertical walk hands the caret off. */
  remember(): void;
  /** Consume the remembered x (once; stale memories evaporate). */
  take(): number | null;
}

export function createColumnMemory(): ColumnMemory {
  let mem: { x: number; at: number } | null = null;
  return {
    remember(): void {
      try {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const r = sel.getRangeAt(0);
        const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
        if (rect && (rect.left !== 0 || rect.top !== 0)) mem = { x: rect.left, at: Date.now() };
      } catch { /* no geometry, no memory */ }
    },
    take(): number | null {
      if (mem === null || Date.now() - mem.at > 400) { mem = null; return null; }
      const x = mem.x;
      mem = null;
      return x;
    },
  };
}

/** Land a programmatic focus: at the walk's edge, honoring the remembered column when the
 *  environment has layout; else plain start/end. `at` numbers are VISIBLE offsets. */
export function applyCaret(el: HTMLElement, at: "start" | "end" | number, mem?: ColumnMemory): void {
  if (at === "start" || at === "end") {
    const x = mem?.take() ?? null;
    const caretFromPoint = (document as { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint;
    if (x !== null && typeof caretFromPoint === "function") {
      el.focus();
      const box = el.getBoundingClientRect();
      const y = at === "start" ? Math.min(box.top + 4, box.bottom - 1) : Math.max(box.bottom - 4, box.top);
      const r = caretFromPoint.call(document, Math.min(Math.max(x, box.left), Math.max(box.right - 1, box.left)), y);
      if (r && el.contains(r.startContainer)) {
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); r.collapse(true); sel.addRange(r); return; }
      }
    }
    if (at === "start") focusStart(el);
    else focusEnd(el);
    return;
  }
  placeCaretVisible(el, at);
}
