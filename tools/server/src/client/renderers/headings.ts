import { useEffect, useRef, type RefObject } from "react";

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
 *  A FRAGMENT hash (`…#/yamlover-fragments/<slug>` — see {@link fragmentAnchorId}) also
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
  useEffect(() => {
    if (restore.current === undefined) restore.current = decodeURIComponent(window.location.hash.slice(1)) || null;
    const reveal = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const fresh = restore.current === id; // the mount's own hash — restored even when spy-written
      if (!fresh && id === spyHash) return; // reader-following hash: never scroll back to it
      if (opts?.once && done.current === id) return; // landed once — later dep runs stay put
      // the navigation intent is registered EVEN IF the anchor has not landed yet — the spy stays
      // quiet through the loading layout shifts until the reader actually scrolls (the spy below)
      hashScrolledAt = Date.now();
      const el = document.getElementById(id);
      if (!el?.scrollIntoView) return; // absent in jsdom, or no such anchor yet (value still loading)
      el.scrollIntoView({ block: "center" });
      done.current = id;
      if (fresh) { restore.current = null; if (spyHash === id) spyHash = null; } // consumed
      if (!id.includes("yamlover-fragments/")) return; // only fragments flash
      el.classList.add("yo-reveal-flash");
      window.setTimeout(() => el.classList.remove("yo-reveal-flash"), 1000);
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
 */
export function useFragmentScrollSpy(root: RefObject<HTMLElement | null>, dep: unknown): void {
  useEffect(() => {
    const noteUser = (e: Event) => {
      if (e.type === "mousemove" && (e as MouseEvent).buttons === 0) return; // only a scrollbar DRAG counts
      userScrolledAt = Date.now();
    };
    const inputs = ["wheel", "touchmove", "keydown", "mousedown", "mousemove"] as const;
    for (const t of inputs) window.addEventListener(t, noteUser, { capture: true, passive: true });
    let timer: number | null = null;
    const settle = () => {
      timer = null;
      // act only on READER scrolling: the reader must have touched a scroll input since our last
      // programmatic reveal — layout shifts and the reveal's own scroll never rewrite the hash
      if (userScrolledAt <= hashScrolledAt) return;
      const el = root.current;
      if (!el || !el.isConnected) return;
      const pane = (el.closest(".pane") ?? document.documentElement) as HTMLElement;
      const paneRect = pane.getBoundingClientRect();
      const line = paneRect.top + Math.min(pane.clientHeight * 0.3, 240); // the reading line
      let current: string | null = null;
      for (const a of el.querySelectorAll<HTMLElement>("[id]")) {
        if (a.getBoundingClientRect().top <= line) current = a.id; // document order — the last one above the line
        else break;
      }
      const now = decodeURIComponent(window.location.hash.slice(1));
      if (current === (now || null)) return;
      spyHash = current; // ours, reader-following — the reveal must never scroll back to it
      history.replaceState(null, "", current !== null
        ? "#" + current
        : window.location.pathname + window.location.search);
    };
    const onScroll = () => {
      if (timer !== null) window.clearTimeout(timer);
      // trailing, and long enough that flick-scrolling never coincides with the settle work —
      // the URL follows only a REAL pause
      timer = window.setTimeout(settle, 450);
    };
    window.addEventListener("scroll", onScroll, true); // capture: the scrolling box is a .pane, not the window
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll, true);
      for (const t of inputs) window.removeEventListener(t, noteUser, { capture: true } as EventListenerOptions);
    };
  }, [dep]); // eslint-disable-line react-hooks/exhaustive-deps
}
