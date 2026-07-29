// THE CHAPTER WATCHDOG — the never-locked law, enforced mechanically (the chapter twin of
// apply.ts watchdog): for every advertised key, if chapterInterpret CLAIMS it at the current
// site, applyChapterKey must RESPOND — change the doc, move the focus/caret, or ring
// (refused). A claimed key that does nothing is a dead advertised key: throw, loudly.
//
// Exemptions, by contract:
//   - `null`   — not this grammar's key (source chunks, native prose editing);
//   - `nop`    — claimed-to-swallow (Tab must not walk the browser's focus out);
//   - `move`   — may decline at the walk's ends (the caret deliberately stays put);
//   - `joinPrev/joinNext` — may refuse across a non-prose block, which IS the ring (counted).

import { sourceOf } from "../state";
import { chapterSiteOf, type ChapterEdges } from "./site";
import { chapterInterpret, type ChapterKey } from "./dispatch";
import { applyChapterIntent, type ChapterState } from "./apply";

export const CHAPTER_WATCHDOG_KEYS: ChapterKey[] = [
  { key: "Enter" },
  { key: "Tab" },
  { key: "Tab", shift: true },
  { key: "Backspace" },
  { key: "Delete" },
  { key: "ArrowUp" },
  { key: "ArrowDown" },
  { key: "1", ctrl: true, alt: true },
  { key: "2", ctrl: true, alt: true },
  { key: "3", ctrl: true, alt: true },
  { key: "4", ctrl: true, alt: true },
];

/** What a key would do at the current state: acts, refuses, or nothing (unclaimed / swallow). */
export function chapterKeyVerdict(s: ChapterState, k: ChapterKey, edges: ChapterEdges = {}): "acts" | "refuses" | "none" {
  const site = chapterSiteOf(s.doc, s.focus, edges);
  const intent = chapterInterpret(k, site);
  if (intent === null || intent.kind === "nop") return "none";
  const out = applyChapterIntent(s, intent, { head: "", tail: "" });
  const acted =
    JSON.stringify(out.doc.root) !== JSON.stringify(s.doc.root) ||
    JSON.stringify(out.focus) !== JSON.stringify(s.focus) ||
    out.caret !== s.caret;
  if (acted) return "acts";
  return out.refused ? "refuses" : "none";
}

/** Throws when any advertised key is CLAIMED yet dead at the given state. The edges describe
 *  the boundary caret (start+end+first+last), the posture every claim must survive. */
export function chapterWatchdog(s: ChapterState): void {
  const edges: ChapterEdges = { atStart: true, atEnd: true, firstLine: true, lastLine: true };
  for (const k of CHAPTER_WATCHDOG_KEYS) {
    const site = chapterSiteOf(s.doc, s.focus, edges);
    const intent = chapterInterpret(k, site);
    if (intent === null || intent.kind === "nop" || intent.kind === "move") continue;
    const out = applyChapterIntent(s, intent, { head: "", tail: "" });
    const responded =
      out.refused ||
      JSON.stringify(out.doc.root) !== JSON.stringify(s.doc.root) ||
      JSON.stringify(out.focus) !== JSON.stringify(s.focus) ||
      out.caret !== s.caret;
    if (!responded) {
      throw new Error(
        `chapter watchdog: dead advertised key ${JSON.stringify(k)} — claimed ${JSON.stringify(intent)} ` +
        `at cell=${site.cell} but neither the doc, the focus, nor the ring responded.\n` +
        `source:\n${sourceOf(s.doc)}`,
      );
    }
  }
}
