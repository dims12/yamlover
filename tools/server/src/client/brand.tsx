// The yamlover mark, as an inline SVG so it can take its colours from CSS — a tab button
// inverts its foreground when active, and a bitmap or a fixed-fill file could not follow.
//
// Two-coloured like the brand lockup: the y takes `currentColor`, the o takes `--yo-o`, which
// callers set to the cobalt accent. Where the mark is REVERSED onto that same accent — an active
// tab — the caller leaves `--yo-o` at its `currentColor` default, since a cobalt o on a cobalt
// ground is no o at all.
//
// This is the SMALL CUT of brand/yo-mark.svg: the three branch nodes are dropped and the stroke
// thickened. At the ~17px a toolbar button gives it, the r=8 dots swallow the arms they sit on
// and the y turns to mush; the round caps terminate the branches anyway, so the silhouette is
// unchanged. Same construction as the full mark — 45° branches, and the o's centre one radius
// down-right of the crossing, which puts the crossing ON the circle.

export function YoMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" aria-hidden="true" focusable="false">
      <g fill="none" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 15 43 43 71 15M43 43 15 71" stroke="currentColor" />
        <circle cx="59.970563" cy="59.970563" r="24" stroke="var(--yo-o, currentColor)" />
      </g>
      <circle cx="59.970563" cy="59.970563" r="5" fill="var(--yo-o, currentColor)" />
    </svg>
  );
}
