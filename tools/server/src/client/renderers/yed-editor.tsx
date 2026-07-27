// THE YED MOUNT — the @yamlover/yed reference editor behind the unlocked data view (EDITOR.md §9),
// replacing the legacy source projection (editor.tsx). The wrapper owns everything server-shaped:
// LOAD via GET /api/source (the node's yamlover source), PERSIST via ONE `emplace` op carrying the
// serialized document (the same debounce discipline as ops.ts useOpSync: 500 ms after a change,
// one batch in flight, kept-and-alerted on failure, flushed on unmount). The editor itself is the
// package's pure EditorView — debug off; `?yed=debug` turns the panels on for diagnosis.

import { useEffect, useRef, useState } from "react";
import { EditorView } from "../../../../yed/src/page";
import { emptyDoc, parseSource, sourceOf, type EditorState } from "../../../../yed/src/state";
import { editChunks, fetchSource } from "../api";
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

export function YedEditor({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  void onNavigate; // pointers open in PICK mode later; the atom is walkable already
  const [state, setState] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<EditorState | null>(null);
  const savedRef = useRef<string>("");   // the source the SERVER has (normalized-on-load baseline)
  const timerRef = useRef<number | null>(null);
  const inflightRef = useRef(false);

  const flush = (): void => {
    const st = stateRef.current;
    if (!st || inflightRef.current) return;
    const src = sourceOf(st.doc);
    if (src === savedRef.current) return;
    inflightRef.current = true;
    editChunks([{ path, op: "emplace", yamlover: src.replace(/\n$/, "") }])
      .then(() => { savedRef.current = src; })
      .catch((e) => window.alert(`edit sync failed: ${String((e as Error)?.message || e)}`))
      .finally(() => {
        inflightRef.current = false;
        // changes that arrived while the batch was in flight go out on the next tick
        if (stateRef.current && sourceOf(stateRef.current.doc) !== savedRef.current) schedule();
      });
  };
  const schedule = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { timerRef.current = null; flush(); }, 500);
  };
  const update = (next: EditorState): void => {
    stateRef.current = next;
    setState(next);
    if (sourceOf(next.doc) !== savedRef.current) schedule();
  };

  useEffect(() => {
    let alive = true;
    setState(null);
    setError(null);
    stateRef.current = null;
    fetchSource(path)
      .then(({ source }) => {
        if (!alive) return;
        const doc = source.trim() === "" ? emptyDoc() : parseSource(source);
        const st: EditorState = { doc, cursor: freshCursor(), refused: false, log: [] };
        savedRef.current = sourceOf(doc); // the serializer's normal form is the dirty-check baseline
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
  return <EditorView state={state} setState={update} debug={debug} />;
}
