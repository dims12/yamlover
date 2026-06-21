import { useEffect, useState } from "react";

/**
 * The render depth for the structured-data views (`yamlover` / `json5p` / `yamlover/schema`).
 * Like the markup reading-width (markup.tsx), the depth is a **URL parameter** — `?depth=<n>`,
 * alongside `?format=` — so a particular depth is a shareable link.
 *
 * The default is **`.inf` (infinity)**: a text data file (json / json5 / yaml / yamlover) inlines
 * whole, and references show *as references* (their pointer text, local ones as in-page `#` links).
 * A FINITE depth `n` inlines `n` levels of nested containers (collapsible) and *resolves* references
 * within that budget; anything deeper becomes a `{ … }` continuation hyperlink. Infinity is `null`
 * here, the value the server treats as unlimited; non-text concretes fall back to one level
 * server-side. The control lives in the node bar next to the data tabs (see NodeView).
 */
const MIN_DEPTH = 1;
const params = () => new URLSearchParams(window.location.search);

/** Whether `text` denotes infinity (`.inf` / `inf`, case-insensitive). */
function isInf(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === ".inf" || t === "inf";
}

/** A depth string is valid if it is `.inf`/`inf` or an integer ≥ 1. */
export function validDepth(text: string): boolean {
  if (isInf(text)) return true;
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= MIN_DEPTH;
}

/** The render depth from the URL's `?depth=`: `null` for infinity (the default, and an explicit
 *  `.inf`/absent), else the finite level. An out-of-range / malformed value falls back to infinity. */
export function viewDepth(): number | null {
  const raw = params().get("depth");
  if (raw == null || raw === "" || isInf(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_DEPTH ? n : null;
}

function writeDepth(d: number | null): void {
  const q = params();
  if (d == null) q.delete("depth"); // infinity is the default — drop the param
  else q.set("depth", String(d));
  const qs = q.toString();
  window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
}

/**
 * The depth control beside the data-view tabs (in the node bar). It accepts ANY input — a valid
 * level (`.inf`, or an integer ≥ 1) is applied to the URL and `onChange()` refetches the node value
 * at the new depth; an impossible/half-typed value is left unapplied and the field turns red (no
 * editing is blocked). No visible label: the hover title reads "depth".
 */
export function DepthControl({ onChange }: { onChange: () => void }) {
  const urlDepth = viewDepth();
  const initial = urlDepth == null ? ".inf" : String(urlDepth);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]); // resync when the URL changes (nav / apply)
  const valid = validDepth(text);
  return (
    <input
      className={"depth-control" + (valid ? "" : " invalid")}
      type="text"
      title="depth"
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (validDepth(v)) {
          writeDepth(isInf(v) ? null : Number(v));
          onChange();
        }
      }}
    />
  );
}
