// THE CHAPTER LEGEND — the keycap row over DRY-RUN verdicts (the yed legend law: enabled
// means ACTS, never "would only ring"). The same discipline powers the format bar's T / D
// role states (rolesOf) — no hand-written gates anywhere; the machine's refusals are the
// single source of truth, so the UI can never disagree with what a press would do.

import type { ReactNode } from "react";
import { applyChapterIntent, type ChapterState } from "./apply";
import { chapterSiteOf } from "./site";
import { chapterKeyVerdict } from "./watchdog";
import type { ChapterKey } from "./dispatch";

export type RoleState = "is" | "can" | null;

/** The T / D button states — "is" when the cell holds the role, "can" iff the dry run acts. */
export function rolesOf(state: ChapterState): { title: RoleState; desc: RoleState } {
  const site = chapterSiteOf(state.doc, state.focus);
  const verdict = (role: "title" | "desc"): RoleState => {
    if (role === "title" && site.cell === "title") return "is";
    if (role === "desc" && site.cell === "description") return "is";
    const out = applyChapterIntent(state, { kind: "role", role });
    return !out.refused && out.doc !== state.doc ? "can" : null;
  };
  return { title: verdict("title"), desc: verdict("desc") };
}

const CAPS: { label: string; key: ChapterKey }[] = [
  { label: "⏎", key: { key: "Enter" } },
  { label: "⇥", key: { key: "Tab" } },
  { label: "⇤", key: { key: "Tab", shift: true } },
  { label: "⌫", key: { key: "Backspace" } },
  { label: "⌦", key: { key: "Delete" } },
  { label: "↑", key: { key: "ArrowUp" } },
  { label: "↓", key: { key: "ArrowDown" } },
  { label: "¶", key: { key: "1", ctrl: true, alt: true } },
  { label: "▦", key: { key: "2", ctrl: true, alt: true } },
  { label: "•", key: { key: "3", ctrl: true, alt: true } },
  { label: "1.", key: { key: "4", ctrl: true, alt: true } },
];

/** The keycap row: each cap is a dry run of the real apply at the current state (boundary
 *  caret edges — the posture the watchdog also checks). */
export function ChapterLegend({ state }: { state: ChapterState }): ReactNode {
  const edges = { atStart: true, atEnd: true, firstLine: true, lastLine: true };
  return (
    <div className="y2-legend" data-testid="yc-legend">
      {CAPS.map((c) => {
        const v = chapterKeyVerdict(state, c.key, edges);
        return (
          <span key={c.label} className={"y2-cap " + (v === "acts" ? "y2-on" : v === "refuses" ? "y2-ring" : "y2-off")} title={JSON.stringify(c.key)}>
            {c.label}
          </span>
        );
      })}
    </div>
  );
}
