import { useEffect, useState } from "react";

/**
 * The render depth for the structured-data views (`yamlover` / `json5p` / `yamlover/schema`).
 * Like the markup reading-width (markup.tsx), the depth is a **URL parameter** — `?depth=<n>`,
 * alongside `?format=` — so a particular depth is a shareable link. Default 2: two levels of
 * nested containers are shown inline (and are collapsible); anything deeper stays a `{ … }`
 * continuation hyperlink. The control lives in the node bar next to the data tabs (see NodeView).
 */
export const DEFAULT_DEPTH = 2;
const MIN_DEPTH = 1;
const MAX_DEPTH = 10;
const params = () => new URLSearchParams(window.location.search);

/** The render depth from the URL's `?depth=`, or the default (out-of-range ignored). */
export function viewDepth(): number {
  const d = Number(params().get("depth"));
  return Number.isInteger(d) && d >= MIN_DEPTH && d <= MAX_DEPTH ? d : DEFAULT_DEPTH;
}

function writeDepth(n: number): void {
  const q = params();
  if (n === DEFAULT_DEPTH) q.delete("depth");
  else q.set("depth", String(n));
  const qs = q.toString();
  window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
}

/**
 * The depth control beside the data-view tabs (in the node bar). It accepts ANY input — a valid
 * level (1–10) is applied to the URL and `onChange()` refetches the node value at the new depth;
 * an impossible/half-typed value is left unapplied and the field turns red (no editing is blocked).
 * No visible label: the hover title reads "depth".
 */
export function DepthControl({ onChange }: { onChange: () => void }) {
  const urlDepth = viewDepth();
  const [text, setText] = useState(String(urlDepth));
  useEffect(() => setText(String(urlDepth)), [urlDepth]); // resync when the URL changes (nav / apply)
  const n = Number(text);
  const valid = text.trim() !== "" && Number.isInteger(n) && n >= MIN_DEPTH && n <= MAX_DEPTH;
  return (
    <input
      className={"depth-control" + (valid ? "" : " invalid")}
      type="text"
      inputMode="numeric"
      title="depth"
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        const num = Number(v);
        if (v.trim() !== "" && Number.isInteger(num) && num >= MIN_DEPTH && num <= MAX_DEPTH) {
          writeDepth(num);
          onChange();
        }
      }}
    />
  );
}
