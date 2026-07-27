// yed2 — THE DEBUG PAGE. Left: the recursive cell projection (everything framed and titled).
// Right: every piece of state, visible — the active Site, the cursor, the live serialized source,
// the last edit's line diff, the intent history, and the keyboard legend driven by the same
// `interpret` the editor runs. Requirements 4–6 in one screen.
//
// `EditorView` is pure over its props (the tests render it directly); `DebugEditorPage` owns the
// state, the corpus picker and document-level copy/paste.

import { useMemo, useState } from "react";
import { applyKey, applyText, positionsOf, siteOf, type Position } from "./apply";
import { DocCells, type CellCtx } from "./cells";
import { lineDiff } from "./diff";
import { Legend } from "./legend";
import { initialState, parseSource, sourceOf, type Cursor, type EditorState } from "./state";

export function EditorView({ state, setState, debug = true }: { state: EditorState; setState: (s: EditorState) => void; debug?: boolean }) {
  const site = siteOf(state);
  const source = sourceOf(state.doc);
  const last = state.log[state.log.length - 1];
  const ctx: CellCtx = {
    cursor: state.cursor,
    refused: state.refused,
    onKey: (e, edges) => {
      // printable characters flow into the controlled input natively (onText); the grammar takes
      // the rest — and ONLY when it has a meaning, so unknown keys are never swallowed
      const next = applyKey(state, { key: e.key, shift: e.shiftKey }, edges);
      if (next !== state) { e.preventDefault(); setState(next); }
    },
    onText: (text) => setState(applyText(state, text)),
    onFocus: (pos: Position) => {
      const cursor: Cursor =
        pos.at === "after" ? { at: "after", path: pos.path }
        : pos.at === "key" ? { at: "key", path: pos.path, text: "" }
        : { at: "token", path: pos.path, text: "" };
      // entering a token/key cell loads its current text (the same rule movement uses)
      const list = positionsOf(state.doc);
      void list;
      setState({ ...state, cursor: cursor.at === "after" ? cursor : loadText(state, cursor), refused: false });
    },
  };
  return (
    <div className={"y2-layout " + (debug ? "y2-debug" : "y2-plain")}>
      <div className="y2-editor">
        <DocCells doc={state.doc} ctx={ctx} />
      </div>
      <div className="y2-panels">
        <Panel title="keyboard (what would each key mean HERE)"><Legend site={site} /></Panel>
        <Panel title="site (what interpret sees)"><pre data-testid="y2-site">{JSON.stringify(site, null, 1)}</pre></Panel>
        <Panel title="cursor"><pre data-testid="y2-cursor">{JSON.stringify(state.cursor)}{state.refused ? "\nREFUSED" : ""}</pre></Panel>
        <Panel title="source (serialized IR, live)"><pre data-testid="y2-source">{source || "(empty)"}</pre></Panel>
        <Panel title="last diff">
          <pre data-testid="y2-diff">
            {last && last.before !== last.after
              ? lineDiff(last.before, last.after).map((d, i) => <div key={i} className={d.type === "+" ? "y2-add" : d.type === "-" ? "y2-del" : ""}>{d.type} {d.line}</div>)
              : "(no document change yet)"}
          </pre>
        </Panel>
        <Panel title={`history (${state.log.length})`}>
          <pre className="y2-history">{state.log.slice(-12).map((l, i) => `${l.key} → ${l.intent}`).join("\n")}</pre>
        </Panel>
      </div>
    </div>
  );
}

function loadText(state: EditorState, cursor: Cursor): Cursor {
  if (cursor.at === "token") {
    const list = positionsOf(state.doc);
    void list;
    // read the node's current raw/value as the edit text
    let n: unknown = state.doc.root;
    for (const i of cursor.path) n = (n as { entries: { value: unknown }[] }).entries[i].value;
    const v = n as { raw?: string; value?: unknown };
    return { ...cursor, text: String(v?.raw ?? v?.value ?? "") };
  }
  if (cursor.at === "key") {
    let n: unknown = state.doc.root;
    for (const i of cursor.path.slice(0, -1)) n = (n as { entries: { value: unknown }[] }).entries[i].value;
    const e = (n as { entries: { key: string | null }[] }).entries[cursor.path[cursor.path.length - 1]];
    return { ...cursor, text: String(e?.key ?? "") };
  }
  return cursor;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="y2-panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** The page: state + the corpus picker + document copy/paste. The corpus is inlined at build time
 *  (import.meta.glob), so the page needs no server at all. */
export function DebugEditorPage({ corpus }: { corpus: Record<string, string> }) {
  const [state, setState] = useState<EditorState>(initialState);
  const [debug, setDebug] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const names = useMemo(() => Object.keys(corpus).sort(), [corpus]);

  const load = (src: string): void => {
    try {
      const doc = parseSource(src);
      setState({ doc, cursor: { at: "hole", path: [], index: 0, text: "", key: null }, refused: false, log: [] });
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  return (
    <div className="y2-page">
      <header className="y2-bar">
        <strong>yed2 — the debug editor</strong>
        <button onClick={() => setState(initialState())}>new</button>
        <select onChange={(e) => { if (e.target.value) load(corpus[e.target.value]); }} defaultValue="">
          <option value="" disabled>load a corpus sample…</option>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <button onClick={() => void navigator.clipboard.writeText(sourceOf(state.doc))}>copy document</button>
        <button onClick={() => void navigator.clipboard.readText().then(load)}>paste document</button>
        <label className="y2-mode"><input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> debug</label>
        {loadError && <span className="y2-loaderr">parse failed: {loadError}</span>}
      </header>
      <EditorView state={state} setState={setState} debug={debug} />
    </div>
  );
}
