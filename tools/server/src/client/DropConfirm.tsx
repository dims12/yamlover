// The UNIFIED drop confirmation popup: every drag-drop (node move, OS-file upload, board
// retag) produces a DropPlan (drop-policy.ts) and runs through here before executing. An
// anchored floating popup at the drop point — the annotate-menu idiom: position:fixed at
// {x,y}, outside-click / scroll / Escape cancel, Enter or the button confirms.

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { DropPlan } from "../drop-policy";

const VERB: Record<DropPlan["kind"], string> = {
  "move-node": "Move",
  "upload-files": "Upload",
  "board-move": "Move task",
};

export function DropConfirm({ x, y, plan, onConfirm, onCancel }: {
  x: number;
  y: number;
  plan: DropPlan;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Outside-click closes; so does scrolling/wheeling the page, since the popup is
  // position:fixed and would otherwise float away from its anchor (tagmenu idiom).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onCancel();
    };
    const onShift = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onShift, true);
    window.addEventListener("wheel", onShift, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onShift, true);
      window.removeEventListener("wheel", onShift, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onConfirm, onCancel]);

  // Keep the popup on-screen when the drop lands near the viewport edge (a coordinate an
  // event failed to carry — jsdom drops — anchors at the corner rather than at NaN).
  const left = Math.min(Number.isFinite(x) ? x : 0, Math.max(0, window.innerWidth - 380));
  const top = Math.min(Number.isFinite(y) ? y : 0, Math.max(0, window.innerHeight - 120));

  return (
    <div ref={ref} className="drop-confirm" role="dialog" aria-label="confirm drop" style={{ left, top }}>
      <div className="drop-confirm-text">{plan.description}</div>
      <div className="drop-confirm-actions">
        <button autoFocus onClick={onConfirm}>{VERB[plan.kind]}</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Per-surface popup owner (mirrors useExplorerTagMenu's shape): `request(x, y, plan, run)`
 *  opens the popup at the drop point; confirming executes `run` (a rejection alerts — the
 *  codebase's error idiom, and where the server's "target already exists" lands). Render
 *  `element` once near the surface's root. `request` is stable, safe in effect closures. */
export function useDropConfirm(): {
  request: (x: number, y: number, plan: DropPlan, run: () => void | Promise<void>) => void;
  element: ReactNode;
} {
  const [pending, setPending] = useState<{ x: number; y: number; plan: DropPlan; run: () => void | Promise<void> } | null>(null);

  const request = useCallback((x: number, y: number, plan: DropPlan, run: () => void | Promise<void>) => {
    setPending({ x, y, plan, run });
  }, []);

  const element = pending ? (
    <DropConfirm
      x={pending.x}
      y={pending.y}
      plan={pending.plan}
      onConfirm={() => {
        setPending(null);
        Promise.resolve(pending.run()).catch((e) => window.alert("drop failed: " + String((e as Error)?.message || e)));
      }}
      onCancel={() => setPending(null)}
    />
  ) : null;

  return { request, element };
}
