// The block-format buttons, docked in the MAIN node-bar (the chapter renderer's `config` slot,
// rendered by NodeView through the registry). They act on the mounted chapter editor's focused
// block through the FORMAT BUS (format-bus.ts) and vanish when no editor is mounted. T / D
// toggle the title / description role on the focused chunk — their enabled state is the
// machine's own dry-run verdict (rolesOf), never a hand-written gate.
//
// This control OUTLIVED the legacy projectional editor it was born with (Stage 9 retired it):
// the yed chapter mount publishes to the same bus.

import type { ChosenFormat } from "../../../../../yed/src/chapter/format";
import { useFormatBus } from "./format-bus";

export function ChapterFormatControl() {
  const { mounted, active, current, choose, roles, applyRole } = useFormatBus();
  if (!mounted) return null;
  const btn = (fmt: ChosenFormat, glyph: string, title: string) => (
    <button
      type="button"
      className={"fmt-btn" + (current === fmt ? " active" : "")}
      title={`${title} (Ctrl+Alt+${{ chapter: 1, table: 2, bullets: 3, numbered: 4 }[fmt]})`}
      disabled={!active}
      // mousedown, not click: a click would blur the caret cell first, losing the active block
      onMouseDown={(e) => { e.preventDefault(); choose(fmt); }}
    >{glyph}</button>
  );
  const role = (r: "title" | "desc", glyph: string, name: string) => (
    <button
      type="button"
      className={"fmt-btn" + (roles[r] === "is" ? " active" : "")}
      title={`${name} — make this chunk the ${name.toLowerCase()}; on the ${name.toLowerCase()} itself, unmake it`}
      disabled={roles[r] === null}
      onMouseDown={(e) => { e.preventDefault(); applyRole(r); }}
    >{glyph}</button>
  );
  return (
    <span className="fmt-group" data-yo-chrome>
      {btn("chapter", "¶", "Normal")}
      {btn("bullets", "•", "Bullets")}
      {btn("numbered", "1.", "Numbered")}
      {btn("table", "▦", "Table")}
      {role("title", "T", "Title")}
      {role("desc", "D", "Description")}
    </span>
  );
}
