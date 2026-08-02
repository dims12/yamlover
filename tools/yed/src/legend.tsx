// yed2 — THE KEYBOARD LEGEND (requirement 6): every supported key drawn as a keycap; enabled
// exactly when pressing it WOULD ACT at the current state — each keycap is a DRY-RUN of the real
// applyKey, so the legend cannot lie: enabled means "changes the document or moves the caret",
// never "would only ring". Hover shows the intent (or why the key is grey).

import { interpret } from "./grammar/dispatch";
import { keyVerdict, siteOf } from "./apply";
import type { EditorState } from "./state";

const KEYS: { label: string; key: string; shift?: boolean }[] = [
  { label: ",", key: "," },
  { label: "]", key: "]" },
  { label: "}", key: "}" },
  { label: ":", key: ":" },
  { label: "Enter", key: "Enter" },
  { label: "Tab", key: "Tab" },
  { label: "⇧Tab", key: "Tab", shift: true },
  { label: "⌫", key: "Backspace" },
  { label: "←", key: "ArrowLeft" },
  { label: "→", key: "ArrowRight" },
  { label: "↑", key: "ArrowUp" },
  { label: "↓", key: "ArrowDown" },
];

export function Legend({ state }: { state: EditorState }) {
  const site = siteOf(state);
  const textCell = site.cell === "holeEntry" || site.cell === "holeValue" || site.cell === "token" || site.cell === "key" || site.cell === "quotedInner" || site.cell === "tag" || site.cell === "anchors";
  return (
    <div className="y2-legend" data-testid="y2-legend">
      {KEYS.map((k) => {
        const intent = interpret({ key: k.key, shift: k.shift }, site);
        const verdict = keyVerdict(state, { key: k.key, shift: k.shift });
        // a key the grammar leaves alone still EDITS TEXT natively in a text cell
        const nativeText = textCell && (k.key === "Backspace" || k.key.startsWith("Arrow"));
        const on = verdict === "acts" || (verdict === "none" && nativeText);
        const title =
          verdict === "acts" ? (intent ? intent.kind : "text")
          : verdict === "refuses" ? `${intent ? intent.kind + " — " : ""}refuses here`
          : nativeText ? "text editing"
          : "(no meaning here)";
        return (
          <span key={k.label} className={"y2-keycap" + (on ? " y2-on" : " y2-off")} title={title}>
            {k.label}
          </span>
        );
      })}
      <span className={"y2-keycap" + (textCell ? " y2-on" : " y2-off")} title={textCell ? "text" : "a gap takes no text"}>
        a…z
      </span>
    </div>
  );
}
