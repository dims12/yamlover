// The pointer cell's COMPLETION HINTS — candidate targets enumerated from the editor's own
// in-memory model (the whole mounted subtree; no server round-trip), rendered through the parser's
// canonical `renderPointer` so every hint is byte-identical to what documents display. The popup
// is a HINT, never a validator: free-typed (including dangling) pointers always commit.

import { renderPointer } from "../../../../../parser/ts/src/pointer.ts";
import type { Pointer, Step } from "../../../../../parser/ts/src/ir.ts";
import { normalizeSpaces } from "./keys";
import type { MNode } from "./model";

export interface PointerTarget {
  display: string; // canonical spaced form — what the popup shows and the cell receives
  compact: string; // bare form — spacing-insensitive matching (and what the op would carry)
}

/** Every committed entry of the mounted model as a DOCUMENT-scope canonical path. ONE index
 *  space: keyed entries consume indices too; uncommitted holes consume none and are skipped.
 *  `excludeNodeId` drops the pointer cell being edited (a pointer to itself helps no one). */
export function enumeratePointerTargets(root: MNode, excludeNodeId?: string, limit = 500): PointerTarget[] {
  const out: PointerTarget[] = [];
  const walk = (node: MNode, steps: Step[]): void => {
    let idx = 0;
    for (const e of node.entries) {
      if (!e.committed || !e.decided) continue;
      const step: Step = e.key !== null ? { sel: "key", name: e.key } : { sel: "index", n: idx };
      idx++;
      if (out.length >= limit) return;
      const here = [...steps, step];
      if (e.node.id !== excludeNodeId) {
        const p: Pointer = { kind: "pointer", base: { scope: "document" }, steps: here, raw: "" };
        out.push({ display: renderPointer(p), compact: renderPointer(p, { spaced: false }) });
      }
      if (e.node.kind === "container") walk(e.node, here);
    }
  };
  walk(root, []);
  return out;
}

/** Rank the candidates against the typed text, spacing-insensitively (typed `: pets` matches
 *  compact `:pets[1]`): compact-prefix first, then any substring; non-matches drop. */
export function filterPointerTargets(targets: PointerTarget[], query: string, max = 8): PointerTarget[] {
  const q = normalizeSpaces(query).trim().toLowerCase();
  if (q === "") return targets.slice(0, max);
  const qc = q.replace(/\s+/g, "");
  return targets
    .map((t) => ({
      t,
      r: t.compact.toLowerCase().startsWith(qc) ? 0
        : t.compact.toLowerCase().includes(qc) || t.display.toLowerCase().includes(q) ? 1 : -1,
    }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.t.display.localeCompare(b.t.display))
    .slice(0, max)
    .map((x) => x.t);
}

/** The popup itself — dumb and fully controlled by the PointerCell. The container's mousedown is
 *  prevented so a click never steals focus from the cell (whose blur would commit the half-typed
 *  text BEFORE the click landed); onClick then commits the candidate deliberately. */
export function PointerHints({ hints, hi, onHi, onPick }: {
  hints: PointerTarget[];
  hi: number;
  onHi: (i: number) => void;
  onPick: (t: PointerTarget) => void;
}) {
  if (!hints.length) return null;
  return (
    <div className="yed-hints" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {hints.map((t, i) => (
        <div
          key={t.compact}
          role="option"
          aria-selected={i === hi}
          className={"yed-hint" + (i === hi ? " hi" : "")}
          onMouseEnter={() => onHi(i)}
          onClick={() => onPick(t)}
        >{t.display}</div>
      ))}
    </div>
  );
}
