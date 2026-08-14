// ONE gutter crumb, shared by both chapter faces (the read view's ChunkGutter and the yed
// cells' chunkCrumbs) — the static markup is exactly the historical span, so face parity and
// the annotate chrome rules see nothing new. A KEYED label (a filename, not a digit) can be
// longer than the pane's left headroom; hovering it peeks the full text instantly through a
// portal twin (hover-peek.tsx), right-anchored on the same spot, never past the viewport.

import type { CSSProperties, ReactNode } from "react";
import { useHoverPeek } from "../hover-peek";

export function CrumbSpan({ label, lvl }: { label: number | string; lvl: number }): ReactNode {
  const { hoverProps, overlay } = useHoverPeek({
    side: "extend-left",
    delayMs: 0,
    className: "hover-peek peek-crumb",
    content: label,
    maxWidthPx: (anchor) => anchor.right - 8,
  });
  return (
    <span className="chunk-crumb" style={{ "--lvl": lvl } as CSSProperties} {...hoverProps}>
      {label}
      {overlay}
    </span>
  );
}
