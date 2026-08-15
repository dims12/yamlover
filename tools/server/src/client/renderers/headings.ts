import { useEffect, useRef, type RefObject } from "react";
import { clearLanding, noteLandingAttempt, noteLandingDone } from "../landing-progress";
import { publishCurrentFragment } from "../toc-presence";

/**
 * Shared heading machinery for the rendered-markup formats (Markdown and AsciiDoc).
 *
 * A `.md`/`.adoc` page is a single HTML blob dumped via `dangerouslySetInnerHTML`,
 * so on its own a heading is not addressable. {@link anchorizeHeadings} gives every
 * heading a stable `id` and a small `§` link to it, mirroring the way GitHub renders
 * the same documents — so a deep link like `<page>#<slug>` lands on, and scrolls to,
 * one section. This is the prose-document counterpart of the chapter renderer's `§N`
 * chunk anchors (see `chapter.tsx`): there the locator is the chunk's path; here it
 * is the heading's slug.
 */

/** GitHub-style slug of a heading's text: lowercase, punctuation dropped, runs of
 *  whitespace collapsed to single hyphens. Unicode letters/numbers are kept. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** `base`, suffixed `-2`, `-3`, … until it is not already in `used` (which it is
 *  then added to). Empty `base` (a heading with no sluggable text) yields "". */
function uniqueId(base: string, used: Set<string>): string {
  if (!base) return "";
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/** Give every heading in a block of rendered markup an `id` and a leading `§`
 *  anchor link to it (placed first so it sits in the left gutter, like a chapter
 *  chunk's `§N` index). An id already present (Asciidoctor stamps section ids) is
 *  kept — so its anchor matches the document's own cross-references — otherwise a
 *  de-duplicated slug of the heading text is assigned. Returns the rewritten HTML.
 *  Runs in the browser/jsdom; with no `DOMParser` (or no headings) it is a no-op. */
export function anchorizeHeadings(html: string): string {
  if (typeof DOMParser === "undefined" || !html.includes("<h")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const used = new Set<string>();
  for (const h of doc.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    // slug from the text before inserting the anchor, so the `§` is not part of it
    const id = uniqueId(h.id || slugify(h.textContent ?? ""), used);
    if (!id) continue;
    h.id = id;
    const a = doc.createElement("a");
    a.className = "header-anchor";
    a.href = `#${id}`;
    a.setAttribute("aria-label", "Link to this section");
    a.textContent = "§";
    h.insertBefore(a, h.firstChild);
  }
  return doc.body.innerHTML;
}

/** Scroll to the element named by the URL hash once `dep` (the rendered node)
 *  settles. A deep link `<page>#<slug>` lands on the page, but the value is fetched
 *  async — after the browser's own one-shot scroll — so re-scroll when it arrives.
 *  The same pattern the chapter renderer uses for `#/chunks/0`-style chunk anchors.
 *
 *  A FRAGMENT hash (`…#/yo/fragments/<slug>` — see {@link fragmentAnchorId}) also
 *  briefly FLASHES its target, so clicking a fragment in the RHS panel (which just sets the
 *  hash) or opening a shared fragment link draws the eye to the region. Heading slug anchors
 *  and ordinary `#/cont` data anchors stay scroll-only. Re-runs on `hashchange` too, so an
 *  in-page hash change (no navigation) reveals without a remount.
 *
 *  A hash the SPY wrote (the fragment following the reader's scroll) is revealed exactly
 *  once, on this component's FIRST run — that is the view/edit switch restoring the reading
 *  position — and never again from a dep re-run, so late loads and editing keystrokes cannot
 *  yank the page back. `once: true` (the editor) extends that to every hash: dep changes on
 *  each keystroke there, and only a real hashchange may scroll twice. */
export function useHashScroll(dep: unknown, opts?: { once?: boolean }): void {
  const restore = useRef<string | null | undefined>(undefined); // the hash this mount OPENED with
  const done = useRef<string | null>(null); // the hash already revealed once (for `once`)
  useEffect(() => () => clearLanding(), []); // page unmounted — a pending landing chip is moot
  useEffect(() => {
    if (restore.current === undefined) restore.current = decodeURIComponent(window.location.hash.slice(1)) || null;
    const reveal = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) { clearLanding(); return; }
      const fresh = restore.current === id; // the mount's own hash — restored even when spy-written
      if (!fresh && id === spyHash) return; // reader-following hash: never scroll back to it
      if (opts?.once && done.current === id) return; // landed once — later dep runs stay put
      // An ALREADY-REVEALED hash may re-anchor through late layout shifts (a subtree landing
      // above the target pushes it down) — but ONLY while the reader has not scrolled since the
      // last programmatic reveal. The wheel always wins over a landing subchapter: without this,
      // every lazy load yanked the page back to the hash mid-scroll (the aperiodic-interruption
      // report). `lastRevealed` is module-level so click navigations (navigateToFragment) count.
      if (lastRevealed === id && userScrolledAt > hashScrolledAt) return;
      // absent in jsdom, or no such anchor yet (value still loading) — the landing chip in the
      // topbar's TaskStrip tracks how deep the unfold has reached until the anchor exists
      if (!scrollToId(id)) { noteLandingAttempt(id); return; }
      noteLandingDone(id);
      done.current = id;
      if (fresh) { restore.current = null; if (spyHash === id) spyHash = null; } // consumed
    };
    const onHashChange = () => { spyHash = null; restore.current = null; done.current = null; reveal(); };
    reveal();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
}

/** The fragment the spy last wrote while FOLLOWING the reader (null once a real navigation —
 *  a hashchange — happens). {@link useHashScroll} never scrolls back to it: the reader is
 *  already there, and a late-loading subchapter re-running the reveal must not yank the page. */
let spyHash: string | null = null;

/** The fragment the last programmatic scroll landed on — module-level, so the user-veto guard
 *  in {@link useHashScroll} covers reveals AND click navigations alike. */
let lastRevealed: string | null = null;

/** THE ONE SCROLLING PRIMITIVE every fragment navigation uses — the deep-link reveal and the
 *  click navigations (§ anchors, gutter digits, in-page chapter links). Lands the target at the
 *  TOP of the pane (its `scroll-margin-top` gives it air) — the deterministic place a reader
 *  expects of an anchor, not a viewport-dependent centering. Returns whether it scrolled. */
function scrollToId(id: string): boolean {
  const el = document.getElementById(id);
  if (!el?.scrollIntoView) return false;
  // stamped only when a scroll actually happens — a retry against a not-yet-landed anchor
  // must not stand the spy down (it would keep a stale hash pinned against real reading)
  hashScrolledAt = Date.now();
  lastRevealed = id;
  // The STICKY node bar overlays the pane's top, so a bare top-anchored scroll lands the
  // target beneath it. Measure the ACTUAL overlay — the bar's bottom relative to its
  // scroller's top, the same whether the bar is stuck or at rest, and robust to it wrapping
  // taller at narrow widths — and stamp it as the element's scroll margin; scrollIntoView
  // respects it, and so would a native anchor jump.
  const nh = document.querySelector<HTMLElement>(".nodehead");
  if (nh) {
    const scroller = nh.closest(".pane") ?? document.documentElement;
    const clearance = Math.max(0, nh.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top);
    el.style.scrollMarginTop = `${Math.round(clearance) + 12}px`;
  }
  el.scrollIntoView({ block: "start" });
  if (id.includes("yo/fragments/")) { // only fragments flash
    el.classList.add("yo-reveal-flash");
    window.setTimeout(() => el.classList.remove("yo-reveal-flash"), 1000);
  }
  return true;
}

/** Navigate to an in-page anchor from a CLICK — never via `location.hash`: assigning an equal
 *  hash fires NO hashchange (so nothing would scroll — the "sometimes works" report; whether
 *  the hashes are equal depended on what the scroll SPY last wrote), and assigning a different
 *  one also triggers the browser's own jump, doubling the motion. `pushState` records the
 *  navigation (back-button works), the shared primitive does the one scroll, and the spy is
 *  reset — this is a real navigation, not the reader drifting. */
export function navigateToFragment(id: string): void {
  spyHash = null;
  if (decodeURIComponent(window.location.hash.slice(1)) !== id) {
    history.pushState(null, "", "#" + id);
  }
  scrollToId(id);
  // the TOC's current shade follows — NOT gated on the scroll landing (jsdom, or the anchor
  // not rendered yet): the hash IS the navigation, and a later presence scan may resolve it
  publishCurrentFragment(id);
}

/** When {@link useHashScroll} last scrolled programmatically — the scroll spy stands down after,
 *  so following a link keeps the CLICKED fragment rather than whichever anchor the centering
 *  scroll happened to drag past the reading line. */
let hashScrolledAt = 0;
/** When the READER last touched a scroll input (wheel / touch / key / drag). The spy acts only
 *  when this is newer than {@link hashScrolledAt}: a scroll event with no user input behind it is
 *  a layout shift (an inlined subchapter landing) or our own reveal — never grounds to rewrite
 *  the fragment the reader navigated to. */
let userScrolledAt = 0;

/**
 * The reverse of {@link useHashScroll}: as the reader SCROLLS, the URL fragment follows — the
 * address bar always names the anchored element under the reading line (~1/3 down the pane), so
 * copying the URL mid-read cites the place. `history.replaceState` (never `location.hash`), so
 * no scroll is triggered back, no history entries pile up, and `hashchange` stays silent.
 *
 * `root` scopes the spy to the rendered page's own `[id]` anchors (chunks, subchapter headings);
 * scroll events are captured window-wide because the scrolling box is an ancestor pane, not the
 * window. ALL work — the anchor scan and the `replaceState` — runs once, ~200 ms after the
 * scrolling SETTLES (profiled: mid-scroll per-frame URL writes are what lags a long page; a
 * scroll event itself only re-arms a timer). Scrolling above the first anchor clears the
 * fragment.
 *
 * A WIDTH change of the content root (pane splitter, window resize) is a RESHAPE, not reading:
 * the spy stands down for the episode and, once the reflow settles, the element the URL names
 * is scrolled back to the pane offset it held before — the location survives the reshape.
 */
export function useFragmentScrollSpy(root: RefObject<HTMLElement | null>, dep: unknown): void {
  useEffect(() => {
    const noteUser = (e: Event) => {
      if (e.type === "mousemove" && (e as MouseEvent).buttons === 0) return; // only a scrollbar DRAG counts
      userScrolledAt = Date.now();
    };
    const inputs = ["wheel", "touchmove", "keydown", "mousedown", "mousemove"] as const;
    for (const t of inputs) window.addEventListener(t, noteUser, { capture: true, passive: true });
    const paneOf = (el: HTMLElement): HTMLElement => (el.closest(".pane") ?? document.documentElement) as HTMLElement;
    // THE RESHAPE ANCHOR — a WIDTH change (the pane splitter, the window itself) re-wraps the
    // page while the pane keeps its old pixel scrollTop, so the content under the viewport
    // becomes a random place; a reshape is NOT reading. `anchorRec` remembers, from the last
    // settled layout, where the element the URL names sat in the pane; `restore` scrolls it
    // back there once the reflow settles, and the spy stands down for the whole episode so the
    // reflow's scroll events can never rewrite the reader's fragment (the width-change report:
    // URL cleared to root, position random, TOC shading stale).
    let reshaping = false;
    let anchorRec: { id: string; top: number } | null = null;
    const findAnchor = (el: HTMLElement, id: string): HTMLElement | null => {
      // scan in DOCUMENT ORDER, never getElementById — ids are deliberately duplicated on a
      // chapter page (the ID LAW, chapter-shared.tsx) and hash resolution takes the first bearer
      for (const a of el.querySelectorAll<HTMLElement>("[id]")) {
        if (a.id === id && !a.closest("svg")) return a;
      }
      return null;
    };
    const record = () => {
      const el = root.current;
      const id = decodeURIComponent(window.location.hash.slice(1));
      const t = el && id ? findAnchor(el, id) : null;
      anchorRec = t ? { id, top: t.getBoundingClientRect().top - paneOf(el!).getBoundingClientRect().top } : null;
    };
    let timer: number | null = null;
    const settle = () => {
      timer = null;
      if (reshaping) return; // mid-reshape scrolls are the reflow's, not the reader's
      const el = root.current;
      if (!el || !el.isConnected) return;
      // act only on READER scrolling: the reader must have touched a scroll input since our last
      // programmatic reveal — layout shifts and the reveal's own scroll never rewrite the hash
      if (userScrolledAt > hashScrolledAt) {
        const pane = paneOf(el);
        const paneRect = pane.getBoundingClientRect();
        const line = paneRect.top + Math.min(pane.clientHeight * 0.3, 240); // the reading line
        let current: string | null = null;
        for (const a of el.querySelectorAll<HTMLElement>("[id]")) {
          // an embedded diagram's internal ids (xyflow arrow markers, SVG defs) are not reading
          // anchors — following one would write garbage like `#1__color=var(--fg)…` into the URL
          if (a.closest("svg")) continue;
          if (a.getBoundingClientRect().top <= line) current = a.id; // document order — the last one above the line
          else break;
        }
        const now = decodeURIComponent(window.location.hash.slice(1));
        if (current !== (now || null)) {
          spyHash = current; // ours, reader-following — the reveal must never scroll back to it
          publishCurrentFragment(current); // the TOC's current shade follows the reading line
          history.replaceState(null, "", current !== null
            ? "#" + current
            : window.location.pathname + window.location.search);
        }
      }
      record(); // the layout is settled — remember where the URL's element sits in the pane
    };
    const onScroll = () => {
      if (timer !== null) window.clearTimeout(timer);
      // trailing, and long enough that flick-scrolling never coincides with the settle work —
      // the URL follows only a REAL pause
      timer = window.setTimeout(settle, 450);
    };
    window.addEventListener("scroll", onScroll, true); // capture: the scrolling box is a .pane, not the window
    let reshapeTimer: number | null = null;
    const restore = () => {
      reshapeTimer = null;
      const el = root.current;
      if (el && el.isConnected && anchorRec) {
        const t = findAnchor(el, anchorRec.id);
        if (t) {
          const pane = paneOf(el);
          const delta = t.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchorRec.top;
          if (delta !== 0) pane.scrollTop += delta;
        }
      }
      hashScrolledAt = Date.now(); // the restore's scroll is ours — the spy has nothing to follow
      reshaping = false;
      record(); // fresh layout, same reading place — the next reshape restores against this
    };
    let lastWidth = -1; // the observer's first callback reports the size AT observe — the baseline
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width ?? lastWidth;
      if (w === lastWidth) return; // height-only growth is a lazy landing, not a reshape
      const first = lastWidth === -1;
      lastWidth = w;
      if (first) return;
      reshaping = true;
      hashScrolledAt = Date.now(); // stand the spy down from the first width tick
      if (reshapeTimer !== null) window.clearTimeout(reshapeTimer);
      reshapeTimer = window.setTimeout(restore, 250);
    }) : null;
    if (root.current) ro?.observe(root.current);
    record(); // the mount's own layout (the deep-link reveal ran first — effect order)
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      if (reshapeTimer !== null) window.clearTimeout(reshapeTimer);
      ro?.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      for (const t of inputs) window.removeEventListener(t, noteUser, { capture: true } as EventListenerOptions);
    };
  }, [dep]); // eslint-disable-line react-hooks/exhaustive-deps
}
