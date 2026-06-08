import { useEffect, useState } from "react";

/**
 * The rendered-HTML body for the markdown/asciidoc page views, plus the control that sets its
 * line-wrap measure. The **reading width is a URL parameter** — `?width=<ch>`, alongside
 * `?format=` — so a particular width is a shareable link (the CSV renderer keeps its options in
 * the query the same way). Default 72ch. The control lives in the tab bar next to the renderer
 * button (see NodeView), not in the body. Chapter *chunks* render plain `.markup`, unaffected.
 */
const DEFAULT_WIDTH_CH = 72;
const MIN_CH = 20;
const MAX_CH = 400;
const params = () => new URLSearchParams(window.location.search);

/** The reading width in `ch` from the URL's `?width=`, or the default (out-of-range ignored). */
export function markupWidthCh(): number {
  const w = Number(params().get("width"));
  return Number.isFinite(w) && w >= MIN_CH && w <= MAX_CH ? w : DEFAULT_WIDTH_CH;
}

function writeWidth(ch: number): void {
  const q = params();
  if (ch === DEFAULT_WIDTH_CH) q.delete("width");
  else q.set("width", String(ch));
  const qs = q.toString();
  window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
}

/** The markdown/asciidoc body at the URL-configured reading width. */
export function Markup({ html }: { html: string }) {
  return <div className="markup" style={{ maxWidth: `${markupWidthCh()}ch` }} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * The width control beside the markdown/asciidoc renderer button (in the tab bar). It accepts
 * ANY input — a valid measure (20–400 ch) is applied to the URL and `rerender()` re-wraps the
 * body; an impossible/half-typed value is simply left unapplied and the field turns red (no
 * editing is blocked). No visible label: the hover title reads "width, ch".
 */
export function MarkupWidthControl({ rerender }: { rerender: () => void }) {
  const urlWidth = markupWidthCh();
  const [text, setText] = useState(String(urlWidth));
  useEffect(() => setText(String(urlWidth)), [urlWidth]); // resync when the URL changes (nav / apply)
  const n = Number(text);
  const valid = text.trim() !== "" && Number.isInteger(n) && n >= MIN_CH && n <= MAX_CH;
  return (
    <input
      className={"markup-width" + (valid ? "" : " invalid")}
      type="text"
      inputMode="numeric"
      title="width, ch"
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        const num = Number(v);
        if (v.trim() !== "" && Number.isInteger(num) && num >= MIN_CH && num <= MAX_CH) {
          writeWidth(num);
          rerender();
        }
      }}
    />
  );
}
