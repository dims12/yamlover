// A tiny bridge so the chapter editor's format buttons can live in the MAIN node-bar (the
// renderer's `config` slot, rendered by NodeView) rather than in a second toolbar inside the
// editor. There is only ever one chapter editor mounted, so a single module-level store is enough:
// the editor PUBLISHES its state (is a block focused, what format it is, and how to change it), and
// the control in the bar SUBSCRIBES. When no projectional editor is mounted, the store is cleared
// and the control renders nothing.

import { useSyncExternalStore } from "react";
import type { ChosenFormat } from "../../../../../yed/src/chapter/format";

/** What the T / D buttons can do to the focused cell: it IS the role (button toggles it off), it
 *  CAN take the role, or the role does not apply there (`null` — disabled). */
export type RoleState = "is" | "can" | null;

export interface FormatBusState {
  /** A projectional chapter editor is mounted — show the buttons. */
  mounted: boolean;
  /** A block is focused (the format command has a target) — enable the buttons. */
  active: boolean;
  /** The focused block's current format — the button to highlight. */
  current: ChosenFormat | null;
  /** Apply a format to the focused block. */
  choose: (f: ChosenFormat) => void;
  /** What T / D would do to the focused cell. */
  roles: { title: RoleState; desc: RoleState };
  /** Toggle a role on the focused cell — make the chunk the title/description, or unmake it. */
  applyRole: (r: "title" | "desc") => void;
}

const EMPTY: FormatBusState = {
  mounted: false, active: false, current: null, choose: () => {},
  roles: { title: null, desc: null }, applyRole: () => {},
};
let state: FormatBusState = EMPTY;
const listeners = new Set<() => void>();

/** The editor publishes its current state (call on mount and whenever focus/format changes). */
export function publishFormatBus(next: FormatBusState): void {
  state = next;
  listeners.forEach((l) => l());
}

/** The editor clears the store on unmount, so the bar's buttons disappear with it. */
export function clearFormatBus(): void {
  publishFormatBus(EMPTY);
}

/** The bar's control subscribes here. */
export function useFormatBus(): FormatBusState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
    () => state,
  );
}
