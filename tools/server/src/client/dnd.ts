// In-project drag plumbing. HTML5 DnD hides `getData` during dragover, so the dragged
// node travels out-of-band in a module-level ref (one drag at a time per window) — which
// also lets the TOC tree and the explorer view interoperate with zero prop drilling.
// OS-file drags coexist untouched: they carry "Files" in `types`, never YL_DND_TYPE;
// internal drags carry YL_DND_TYPE, never "Files". A drop from a FOREIGN window carries
// the type but no ref — surfaces ignore it (no concrete facet to plan with).

import type { DragEvent as ReactDragEvent } from "react";
import type { DropNode } from "../drop-policy";

export const YL_DND_TYPE = "application/x-yamlover-path";

let current: DropNode | null = null;

/** Start dragging a project node — call from the source's onDragStart. */
export function beginNodeDrag(e: ReactDragEvent, src: DropNode): void {
  current = src;
  e.dataTransfer.setData(YL_DND_TYPE, src.path);
  e.dataTransfer.setData("text/plain", src.path); // a nicety: dropping into a text editor pastes the path
  e.dataTransfer.effectAllowed = "move";
}

/** Clear the drag ref — call from onDragEnd UNCONDITIONALLY (cancelled drags included). */
export function endNodeDrag(): void {
  current = null;
}

/** The node being dragged right now, if any. */
export function currentDrag(): DropNode | null {
  return current;
}

/** Whether a drag carries a project node (readable during dragover, unlike getData). */
export function dragHasNode(e: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(YL_DND_TYPE);
}
