// THE YED MOUNT — the @yamlover/yed reference editor behind the unlocked data view (EDITOR.md §9),
// replacing the legacy source projection (editor.tsx). CONCRETE-AGNOSTIC by construction:
// LOAD is the /api/json PROJECTION (depth `.inf`) converted to parser IR (yed-load.ts) — it
// exists for every storage shape (flat files, dir-backed documents, bare directories, .yaml
// bodies, deep nodes); PERSIST is an IR tree diff emitted as PER-NODE /api/edit ops
// (yed-sync.ts) — the backend's concrete-inheritance rules route each write, and untouched
// regions (comments, spellings) survive because nothing rewrites them. Key renames follow the
// legacy sequencing: flush the ops, then POST /api/rekey.
//
// The flush discipline mirrors ops.ts useOpSync: 500 ms debounce, one batch in flight, kept-
// and-alerted on failure (the NEXT flush re-diffs from the same committed snapshot against the
// newest document — never a queued-op double-apply), flushed on unmount.

import { useEffect, useRef, useState } from "react";
import { EditorView } from "../../../../yed/src/page";
import type { CellRegistry } from "../../../../yed/src/cells";
import { type Document, type EditorState } from "../../../../yed/src/state";
import { editChunks, fetchNode, rekeyNode } from "../api";
import { irFromNodeJson } from "./yed-load";
import { diffToOps } from "./yed-sync";
import "../../../../yed/src/yed.css";

/** The rollout flag (the chapter editor's exact escape-hatch shape): yed is the DEFAULT;
 *  `?yedEditor=legacy` (or `localStorage.yedEditor = "legacy"`) brings the old editor back. */
export function yedSourceEditor(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get("yedEditor");
    if (q) return q !== "legacy";
    return window.localStorage?.getItem("yedEditor") !== "legacy";
  } catch {
    return true;
  }
}

const freshCursor = (): EditorState["cursor"] => ({ at: "hole", path: [], index: 0, text: "", key: null });

export function YedEditor({ path, onNavigate, cells }: { path: string; onNavigate: (p: string) => void; cells?: CellRegistry }) {
  void onNavigate; // pointers open in PICK mode later; the atom is walkable already
  const [state, setState] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<EditorState | null>(null);
  const committedRef = useRef<Document | null>(null); // the doc the SERVER has (per the last acked flush)
  const timerRef = useRef<number | null>(null);
  const inflightRef = useRef(false);

  const flush = (): void => {
    const st = stateRef.current;
    const committed = committedRef.current;
    if (!st || !committed || inflightRef.current) return;
    const snapshot = st.doc;
    const { ops, renames, unserializable } = diffToOps(path, committed, snapshot);
    if (unserializable) { window.alert("this edit cannot be persisted (a binary is inside the rewritten region)"); return; }
    if (ops.length === 0 && renames.length === 0) return;
    inflightRef.current = true;
    (ops.length > 0 ? editChunks(ops) : Promise.resolve({ ok: true as const }))
      .then(async () => {
        for (const r of renames) await rekeyNode(r.path, r.key);
        committedRef.current = snapshot; // the server now has exactly this doc
      })
      .catch((e) => window.alert(`edit sync failed: ${String((e as Error)?.message || e)}`))
      .finally(() => {
        inflightRef.current = false;
        // changes that arrived while the batch was in flight go out on the next tick
        if (stateRef.current && committedRef.current && stateRef.current.doc !== committedRef.current) schedule();
      });
  };
  const schedule = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { timerRef.current = null; flush(); }, 500);
  };
  const update = (next: EditorState): void => {
    stateRef.current = next;
    setState(next);
    if (committedRef.current && next.doc !== committedRef.current) schedule();
  };

  useEffect(() => {
    let alive = true;
    setState(null);
    setError(null);
    stateRef.current = null;
    committedRef.current = null;
    fetchNode(path, null) // depth `.inf` — the whole subtree, every storage shape
      .then((node) => {
        if (!alive) return;
        const doc = irFromNodeJson(node);
        if ((doc.root as { kind?: string }).kind === "blob") {
          setError("a binary node has no cell projection");
          return;
        }
        const st: EditorState = { doc, cursor: freshCursor(), refused: false, log: [] };
        committedRef.current = doc;
        stateRef.current = st;
        setState(st);
      })
      .catch((e) => { if (alive) setError(String((e as Error)?.message || e)); });
    return () => {
      alive = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      flush(); // pending work leaves with the mount, never dropped
    };
  }, [path]);

  if (error) return <div className="muted">yed could not load this node: {error}</div>;
  if (!state) return <div className="muted">loading…</div>;
  const debug = ((): boolean => {
    try { return new URLSearchParams(window.location.search).get("yed") === "debug"; } catch { return false; }
  })();
  return <EditorView state={state} setState={update} debug={debug} cells={cells} />;
}
