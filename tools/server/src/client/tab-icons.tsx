// The tab bar's drawn icons — the views whose meaning no Unicode glyph carries: the graph
// (xyflow) and the explorer family. Same idiom as the YoMark (brand.tsx): line-style strokes in
// `currentColor`, so an icon inverts with the active tab; sized by `.tab-icon` (styles.css).
import type { ReactNode } from "react";

const TabSvg = ({ children }: { children: ReactNode }) => (
  <svg
    className="tab-icon"
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

/** xyflow: a minimal left-to-right DAG — one box fanning out to two, the way the renderer draws
 *  its node boxes and ranks (boxes, not circles, or it reads as a share icon). */
export const GraphIcon = () => (
  <TabSvg>
    <rect x="1.25" y="6.4" width="4.5" height="3.4" rx="1" />
    <rect x="10.25" y="1.25" width="4.5" height="3.4" rx="1" />
    <rect x="10.25" y="11.35" width="4.5" height="3.4" rx="1" />
    <path d="M5.75 7.2 10.25 3.8M5.75 8.8 10.25 12.2" />
  </TabSvg>
);

/** Thumbnails: the classic photo — sun and mountains in a plain rounded rectangle, no frame. */
export const ThumbnailsIcon = () => (
  <TabSvg>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <circle cx="5.4" cy="6.3" r="1.1" />
    <path d="M3.9 11.3 7.6 7.4 9.8 9.6 11.3 8.1 13.2 10" />
  </TabSvg>
);

/** Large icons: big tiles, two by two. */
export const LargeIconsIcon = () => (
  <TabSvg>
    <rect x="2" y="2" width="4.75" height="4.75" rx="1" />
    <rect x="9.25" y="2" width="4.75" height="4.75" rx="1" />
    <rect x="2" y="9.25" width="4.75" height="4.75" rx="1" />
    <rect x="9.25" y="9.25" width="4.75" height="4.75" rx="1" />
  </TabSvg>
);

/** Small icons: an icon with its name beside it, stacked. */
export const SmallIconsIcon = () => (
  <TabSvg>
    <rect x="2" y="3" width="3.25" height="3.25" rx="0.75" />
    <path d="M8 4.6h6" />
    <rect x="2" y="9.75" width="3.25" height="3.25" rx="0.75" />
    <path d="M8 11.4h6" />
  </TabSvg>
);

/** Details: tight rows, each an entry with its columns of text. */
export const DetailsIcon = () => (
  <TabSvg>
    <rect x="2" y="2.4" width="2.4" height="2.4" rx="0.5" />
    <path d="M6.4 3.6H14" />
    <rect x="2" y="6.8" width="2.4" height="2.4" rx="0.5" />
    <path d="M6.4 8H14" />
    <rect x="2" y="11.2" width="2.4" height="2.4" rx="0.5" />
    <path d="M6.4 12.4H14" />
  </TabSvg>
);
