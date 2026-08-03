// yed2 — THE DEBUG PAGE. Left: the recursive cell projection (everything framed and titled).
// Right: every piece of state, visible — the active Site, the cursor, the live serialized source,
// the last edit's line diff, the intent history, and the keyboard legend driven by the same
// `interpret` the editor runs. Requirements 4–6 in one screen.
//
// `EditorView` is pure over its props (the tests render it directly); `DebugEditorPage` owns the
// state, the corpus picker and document-level copy/paste.

import { useMemo, useState } from "react";
import { applyKey, applyText, blockEditText, commitPending, copySubtree, pasteSubtree, positionsOf, siteOf, watchdog, type Position } from "./apply";
import { interpret } from "./grammar/dispatch";
import { defaultRegistry, DocCells, type CellCtx, type CellRegistry } from "./cells";
import { lineDiff } from "./diff";
import { Legend } from "./legend";
import { anchorDecorations, initialState, parseSource, schemaTextOf, sourceOf, type Cursor, type EditorState } from "./state";

export function EditorView({ state, setState, debug = true, cells = defaultRegistry, plantCaret = true }: { state: EditorState; setState: (s: EditorState) => void; debug?: boolean; cells?: CellRegistry; plantCaret?: boolean }) {
  const site = siteOf(state);
  const source = sourceOf(state.doc);
  const last = state.log[state.log.length - 1];
  // THE WATCHDOG (debug mode only — never invoked otherwise, costing nothing): after every edit,
  // every key the legend lights up must respond one keystroke deep. A dead advertised key raises
  // THE ALARM — the red panel below, impossible to miss — and logs the full error.
  const [alarm, setAlarm] = useState<string | null>(null);
  const apply = (next: EditorState): void => {
    setState(next);
    if (debug) {
      try { watchdog(next); setAlarm(null); }
      catch (err) { setAlarm((err as Error).message); console.error(err); }
    }
  };
  const ctx: CellCtx = {
    cursor: state.cursor,
    refused: state.refused,
    cells,
    plantCaret, // an EMBEDDED editor (a chapter source chunk) plants only while it holds focus
    onKey: (e, edges) => {
      // SUBTREE copy/paste (requirement 10): Ctrl+C on a GAP copies the container it closes (the
      // gap is the container, selected); Ctrl+V in an empty HOLE splices the clipboard in through
      // pasteSubtree — the same laws typing obeys, a parse failure rings. Text-level copy/paste
      // inside a cell input stays native.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "c" && state.cursor.at === "after") {
        const text = copySubtree(state);
        if (text !== null) { e.preventDefault(); void navigator.clipboard.writeText(text); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v" && state.cursor.at === "hole" && state.cursor.text.trim() === "") {
        e.preventDefault();
        void navigator.clipboard.readText().then((t) => apply(pasteSubtree(state, t)));
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return; // other chords stay native
      // a PRINTABLE with no grammar meaning inserts NATIVELY — at the caret, wherever it stands
      // (onChange → applyText picks up the result); intercepting it would append at the end
      const withEdges = { ...site, ...(edges ? { caretAtStart: edges.atStart, caretAtEnd: edges.atEnd } : {}) };
      if (e.key.length === 1 && interpret({ key: e.key, shift: e.shiftKey }, withEdges) === null) return;
      // the grammar takes the rest — and ONLY when it has a meaning, so unknown keys are never swallowed
      const next = applyKey(state, { key: e.key, shift: e.shiftKey }, edges);
      if (next !== state) { e.preventDefault(); apply(next); }
    },
    onText: (text) => apply(applyText(state, text)),
    onFocus: (pos: Position) => {
      const cursor: Cursor =
        pos.at === "after" ? { at: "after", path: pos.path }
        : pos.at === "into" ? { at: "hole", path: pos.path, index: 0, text: "", key: null }
        : pos.at === "ptr" ? { at: "ptr", path: pos.path }
        : pos.at === "key" ? { at: "key", path: pos.path, text: "" }
        : pos.at === "tag" ? { at: "tag", path: pos.path, text: "" }
        : pos.at === "anchors" ? { at: "anchors", path: pos.path, index: pos.index ?? 0, text: "" }
        : { at: "token", path: pos.path, text: "" };
      // entering a token/key/tag cell loads its current text (the same rule movement uses)
      const list = positionsOf(state.doc);
      void list;
      apply({ ...state, cursor: cursor.at === "token" || cursor.at === "key" || cursor.at === "tag" || cursor.at === "anchors" ? loadText(state, cursor) : cursor, refused: false });
    },
  };
  return (
    <div className={"y2-layout " + (debug ? "y2-debug" : "y2-plain")}>
      <div
        className="y2-editor"
        onCopy={(e) => {
          // the projection's DOM text is NOT the document (captions, gap glyphs, CSS-only
          // indentation) — a selection copy across cells gets the SERIALIZED source instead.
          // Copying inside one cell input stays native. Pending input COMMITS first; input that
          // cannot land rings and nothing is copied.
          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
          e.preventDefault();
          const committed = commitPending(state);
          if (committed === null) { apply({ ...state, refused: true }); return; }
          if (committed !== state) apply({ ...committed, refused: false });
          e.clipboardData.setData("text/plain", sourceOf(committed.doc));
        }}
      >
        <DocCells doc={state.doc} ctx={ctx} />
      </div>
      {debug && <div className="y2-panels">
        {alarm && (
          <section className="y2-panel y2-alarm" data-testid="y2-alarm">
            <h3>⚠ watchdog</h3>
            <pre>{alarm}</pre>
          </section>
        )}
        <Panel title="keyboard (what would each key DO here — a dry-run)"><Legend state={state} /></Panel>
        <Panel title="site (what interpret sees)"><pre data-testid="y2-site">{JSON.stringify(site, null, 1)}</pre></Panel>
        <Panel title={`cursor (dialect: ${state.dialect ?? "yamlover"})`}><pre data-testid="y2-cursor">{JSON.stringify(state.cursor)}{state.refused ? "\nREFUSED" : ""}</pre></Panel>
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
      </div>}
    </div>
  );
}

function loadText(state: EditorState, cursor: Cursor): Cursor {
  if (cursor.at === "token") {
    const list = positionsOf(state.doc);
    void list;
    // read the node's current raw/value as the edit text — a `|`/`>` scalar loads its
    // REPARSEABLE block spelling (header + re-indented body), never the flattened raw
    let n: unknown = state.doc.root;
    for (const i of cursor.path) n = (n as { entries: { value: unknown }[] }).entries[i].value;
    const v = n as { raw?: string; value?: unknown };
    const block = blockEditText(n as never);
    return { ...cursor, text: block ?? String(v?.raw ?? v?.value ?? "") };
  }
  if (cursor.at === "key") {
    let n: unknown = state.doc.root;
    for (const i of cursor.path.slice(0, -1)) n = (n as { entries: { value: unknown }[] }).entries[i].value;
    const e = (n as { entries: { key: string | null }[] }).entries[cursor.path[cursor.path.length - 1]];
    return { ...cursor, text: String(e?.key ?? "") };
  }
  if (cursor.at === "tag") {
    let n: unknown = state.doc.root;
    for (const i of cursor.path) n = (n as { entries: { value: unknown }[] }).entries[i].value;
    return { ...cursor, text: schemaTextOf(n as never) ?? "" };
  }
  if (cursor.at === "anchors") {
    let n: unknown = state.doc.root;
    for (const i of cursor.path) n = (n as { entries: { value: unknown }[] }).entries[i].value;
    const body = anchorDecorations(n as never)[cursor.index]?.slice(1) ?? ""; // "" — the ADD slot
    return { ...cursor, text: body };
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
        <button
          onClick={() => {
            // COMMIT FIRST — unfinished input must not be silently left out of the copy; input
            // that cannot land rings RED and copies NOTHING
            const committed = commitPending(state);
            if (committed === null) { setState({ ...state, refused: true }); return; }
            setState({ ...committed, refused: false });
            void navigator.clipboard.writeText(sourceOf(committed.doc));
          }}
        >copy document</button>
        <button onClick={() => void navigator.clipboard.readText().then(load)}>paste document</button>
        <label className="y2-mode"><input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> debug</label>
        {loadError && <span className="y2-loaderr">parse failed: {loadError}</span>}
      </header>
      <EditorView state={state} setState={setState} debug={debug} />
    </div>
  );
}
