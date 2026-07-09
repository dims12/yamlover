import { useState } from "react";
import { Embed } from "../embed";

/**
 * The render half of the marklower `*[label](target)` embed token — {@link Embed} (the resolved
 * target) → pixels. Two shapes, chosen by the token's position in the source, not by its kind:
 *
 *   - **block** — the token stands alone on its line: a `<figure>`, the label its `<figcaption>`;
 *   - **inline** — the token sits inside a sentence: a compact chip, so prose still flows.
 *
 * A provider iframe is never mounted on load: it renders as a **facade** (poster + play button)
 * and swaps in the frame on click. That keeps a third party's scripts out of the page until the
 * reader actually asks for the video, and keeps a chapter of ten videos cheap.
 */

/** The chip's type glyph — also what the WYSIWYG editor stamps on an embed atom, so a chip in the
 *  editor and a chip in the read view are the same object. */
export const GLYPH: Record<Embed["kind"], string> = { iframe: "▶", video: "▶", audio: "♪", image: "🖼" };

/** The lazily-mounted provider frame: poster + play button until clicked. Vimeo gives us no poster
 *  URL, so it gets a plain play surface. */
function Facade({ spec, label }: { spec: Extract<Embed, { kind: "iframe" }>; label: string }) {
  const [playing, setPlaying] = useState(false);
  if (playing) {
    return (
      <iframe
        className="mlw-embed-frame"
        src={`${spec.src}${spec.src.includes("?") ? "&" : "?"}autoplay=1`}
        title={label || spec.provider}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    );
  }
  return (
    <button
      type="button"
      className={`mlw-embed-facade mlw-embed-${spec.provider}`}
      onClick={() => setPlaying(true)}
      title={`Play${label ? `: ${label}` : ""}`}
      style={spec.poster ? { backgroundImage: `url(${spec.poster})` } : undefined}
    >
      <span className="mlw-embed-play" aria-hidden="true">
        ▶
      </span>
      <span className="visually-hidden">{`Play ${label || spec.provider} video`}</span>
    </button>
  );
}

/** The embed's media element, without the surrounding figure/chip. */
function Media({ spec, label }: { spec: Embed; label: string }) {
  switch (spec.kind) {
    case "iframe":
      return <Facade spec={spec} label={label} />;
    case "video":
      return <video className="mlw-embed-video" src={spec.src} controls preload="metadata" />;
    case "audio":
      return <audio className="mlw-embed-audio" src={spec.src} controls preload="metadata" />;
    case "image":
      return <img className="mlw-embed-image" src={spec.src} alt={label} loading="lazy" />;
  }
}

/** A block embed: its own figure in the chapter's flow, captioned by the token's label. */
export function EmbedFigure({ spec, label }: { spec: Embed; label: string }) {
  return (
    <figure className="mlw-embed">
      <Media spec={spec} label={label} />
      {label && <figcaption className="mlw-embed-caption">{label}</figcaption>}
    </figure>
  );
}

/** An inline embed: a chip carrying the kind's glyph and the label. An image is small enough to
 *  show as itself; everything else would break the line box, so it opens in place on click.
 *
 *  Opened, it stays a `<span>` — a chip lives inside the chunk's `<p>`, and a `<figure>` (or the
 *  `<figcaption>` under it) may not: the browser hoists such an element out of the paragraph and
 *  scrambles the surrounding DOM. Only a token that STANDS ALONE gets to be a figure. */
export function EmbedChip({ spec, label }: { spec: Embed; label: string }) {
  const [open, setOpen] = useState(false);
  if (spec.kind === "image") return <img className="mlw-embed-chip-image" src={spec.src} alt={label} loading="lazy" />;
  if (open) {
    return (
      <span className="mlw-embed-opened">
        <Media spec={spec} label={label} />
      </span>
    );
  }
  return (
    <button type="button" className="mlw-embed-chip" onClick={() => setOpen(true)} title={`Open${label ? `: ${label}` : ""}`}>
      <span aria-hidden="true">{GLYPH[spec.kind]}</span>
      {label}
    </button>
  );
}
