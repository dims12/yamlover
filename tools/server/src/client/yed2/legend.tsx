// yed2 — THE KEYBOARD LEGEND (requirement 6): every supported key drawn as a keycap; enabled
// exactly when `interpret(key, site)` has a meaning at the CURRENT site — the same pure function
// the editor runs, so the legend cannot lie. Hover shows the intent a key would mean.

import { interpret, type Site } from "../renderers/yamlover-editor/dispatch";

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

export function Legend({ site }: { site: Site }) {
  const textCell = site.cell === "holeEntry" || site.cell === "holeValue" || site.cell === "token" || site.cell === "key" || site.cell === "quotedInner";
  return (
    <div className="y2-legend" data-testid="y2-legend">
      {KEYS.map((k) => {
        const intent = interpret({ key: k.key, shift: k.shift }, site);
        // a `nop` is claimed-to-swallow (Enter must not type a newline into a hole) — it DOES
        // nothing, so its keycap must not light up: an enabled key always responds (the
        // watchdog's law)
        const on = intent !== null && intent.kind !== "nop";
        return (
          <span key={k.label} className={"y2-keycap" + (on ? " y2-on" : " y2-off")} title={intent ? intent.kind : "(no meaning here)"}>
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
