// THE YED CHAPTER MOUNT — the chapter projection over the yed architecture, behind
// `?chapterEditor=yed` until the superset parity gate passes (chapter.tsx chapterEditorFlavor).
//
// LOAD is the ONE WIRE (/api/content, depth `.inf`) → parser IR (yed-content-load.ts) —
// concrete-agnostic like the source yed mount. EDIT is the pure chapter machine (tools/yed/src/chapter/); the
// CELLS are the yed-contract layer (tools/yed/src/chapter/cells.tsx) — this file only fills
// the ChapterCellsAdapter with the server's capabilities: the marklower codec, read-only
// renderers, linked previews, image paste, §N anchors, navigation, and the column memory.
// PERSIST is the IR tree diff (yed-sync.ts diffToOps) on the same 500 ms debounce as
// yed-editor.tsx — plus the CHAPTER STAMP (leading op, exactly once, never on zero ops) and
// the DEFERRED MATERIALIZATION (yed-chapter/materialize.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import type { Document, Node, Path, Value } from "../../../../yed/src/state";
import { withNode, type Position } from "../../../../yed/src/apply";
import "../../../../yed/src/yed.css"; // the y2 cell contract (frames, captions, ring)
import "../../../../yed/src/chapter/chapter-cells.css";
import {
  applyChapterIntent, applyChapterKey, commitChapterText, createFirstChunk, initialChapterState,
  type ChapterState, type SplitPayload,
} from "../../../../yed/src/chapter/apply";
import type { ChapterIntent, ChapterKey } from "../../../../yed/src/chapter/dispatch";
import type { ChapterEdges } from "../../../../yed/src/chapter/site";
import { chapterSiteOf } from "../../../../yed/src/chapter/site";
import { chapterPositionsOf } from "../../../../yed/src/chapter/positions";
import { chunkModeOf, explicitFormatOf, hasSelfValue, metaOf, tagContentOf } from "../../../../yed/src/chapter/format";
import {
  ChapterCtx, ChapterDoc, nodeAtPath, subchapterServerPath, valueAtPath,
  type ChapterCellsAdapter, type ChapterCtxValue,
} from "../../../../yed/src/chapter/cells";
import { rolesOf } from "../../../../yed/src/chapter/legend";
import { createColumnMemory } from "../../../../yed/src/chapter/caret";
import { editChunks, fetchNode, pasteFileInline, rekeyNode, type NodeJson } from "../api";
import { forgetRecentEntry, makeSourceCells, recordRefCommit, treeHints, treeRecents } from "./yed-cells";
import { useRecentsPane } from "../recents";
import { fetchContent } from "../content";
import { irFromContent } from "./yed-content-load";
import { diffToOps } from "./yed-sync";
import { anchorOf, CHAPTER_META, childSlot, isSubchapter } from "./chapter-model";
import { canonPath } from "../paths";
import { clearFormatBus, publishFormatBus } from "./chapter-editor/format-bus";
import { materializeSubchapters, stampBorn, type MaterializeResult } from "./yed-chapter/materialize";
import { marklowerToEditableHtml } from "./marklower";
import { domToMarklower } from "../marklower-serialize";
import { renderedTextLength } from "./chunk-editors";
import { clipboardFiles, fileToBase64, pastedName } from "../clipboard";
import { ChapterBody, renderChunkBody } from "./chapter-shared";
import type { Chunk } from "./registry";
import { viewDepth } from "./depth";
import { markupWidthCh } from "./markup";
import { useFragmentScrollSpy, useHashScroll } from "./headings";
import { useTocPresencePublisher } from "../toc-presence";

export { rolesOf }; // the debug page imported it from here historically; the source is yed's legend

export function YedChapterEditor({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const [state, setState] = useState<ChapterState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<ChapterState | null>(null);
  const committedRef = useRef<Document | null>(null);
  const stampedRef = useRef(true); // true = the root already reads as a chapter/task (never re-stamp)
  const concreteRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const inflightRef = useRef(false);
  const failedRef = useRef(false); // a failed sync STOPS auto-retry — the next user edit re-arms
  const columnMemory = useMemo(createColumnMemory, []);
  const [bagOpen, setBagOpen] = useRecentsPane("editor"); // the inline bag's ✕, remembered

  /** Flush the pending diff (+ any DEFERRED MATERIALIZATION, whose ops lead the batch).
   *  Returns the born members synchronously so auto-descend can address them by key.
   *  `final` — the LAST flush (Done / navigating away): a titled childless wrap births now
   *  (its titleness has no inline spelling and would otherwise be silently dropped). */
  const flush = (final = false): MaterializeResult["born"] => {
    const st = stateRef.current;
    const committed = committedRef.current;
    if (!st || !committed || inflightRef.current) return [];
    const snapshot = st.doc;
    const mat = materializeSubchapters(path, committed, snapshot, concreteRef.current, final);
    const { ops, renames, unserializable } = diffToOps(path, mat.committed, mat.next);
    if (unserializable) { window.alert("this edit cannot be persisted (a binary or a member-backed subtree is inside the rewritten region)"); return mat.born; }
    const all = [...mat.ops, ...ops];
    if (all.length === 0 && renames.length === 0) return mat.born;
    // THE STAMP: a non-empty batch on an untagged plain container leads with the chapter meta
    const batch = all.length > 0 && !stampedRef.current
      ? [{ path, op: "emplace" as const, meta: CHAPTER_META }, ...all]
      : all;
    // the born members are addressed by KEY from here on — the LIVE doc gains the stamps too
    if (mat.born.length > 0 && stateRef.current) {
      const live = stateRef.current;
      const patched = { ...live, doc: live.doc === snapshot ? mat.next : stampBorn(live.doc, mat.born) };
      stateRef.current = patched;
      setState(patched);
      // a BORN member now counts toward the `?depth=` window — descend if the caret is beyond
      const target = beyondWindow(patched, path, false);
      if (target !== null) onNavigate(target);
    }
    inflightRef.current = true;
    (batch.length > 0 ? editChunks(batch) : Promise.resolve({ ok: true as const }))
      .then(async () => {
        for (const r of renames) await rekeyNode(r.path, r.key);
        committedRef.current = mat.next;
        if (batch !== all) stampedRef.current = true; // stamped exactly once
      })
      .catch((e) => {
        // a failed batch alerts ONCE and stands down — an unbounded retry loop against a
        // persistent failure re-applies the diff forever (the reported duplicate cascade);
        // the next USER edit re-arms the sync
        failedRef.current = true;
        // the DIAGNOSTIC the alert cannot carry: the exact batch that failed, verbatim —
        // enough to find and replay the problem from the browser console alone
        console.error(
          `[yed-chapter] edit sync FAILED at ${path}: ${String((e as Error)?.message || e)}\n` +
          `  ops: ${JSON.stringify(batch)}\n` +
          (renames.length ? `  renames: ${JSON.stringify(renames)}\n` : "") +
          (mat.born.length ? `  born: ${JSON.stringify(mat.born.map((b) => b.anchorKey))}\n` : ""),
        );
        window.alert(`edit sync failed: ${String((e as Error)?.message || e)}`);
      })
      .finally(() => {
        inflightRef.current = false;
        if (!failedRef.current && stateRef.current && committedRef.current && stateRef.current.doc !== committedRef.current) schedule();
      });
    return mat.born;
  };
  const schedule = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { timerRef.current = null; flush(); }, 500);
  };
  const update = (next: ChapterState): void => {
    const docChanged = stateRef.current !== null && next.doc !== stateRef.current.doc;
    stateRef.current = next;
    setState(next);
    if (!docChanged) return; // caret walks never rearm (or delay) the flush
    failedRef.current = false; // a fresh USER edit re-arms a sync that stood down on failure
    // AUTO-DESCEND: an edit whose caret sits beyond the `?depth=` window flushes NOW (the born
    // member's insert must land before the child page fetches); the flush itself navigates
    // once the member is born. `countPending` treats a wrapped subchapter that already gained
    // body as counting — the birth is this flush.
    if (beyondWindow(next, path, true) !== null) {
      flush();
      return;
    }
    schedule();
  };

  useEffect(() => {
    let alive = true;
    setState(null);
    setError(null);
    stateRef.current = null;
    committedRef.current = null;
    fetchContent(path, null)
      .then((content) => {
        if (!alive) return;
        if (content.header.type === "binary") { setError("a binary node has no chapter projection"); return; }
        const doc = irFromContent(content);
        const tagged = tagContentOf(doc.root) !== null || isSubchapter(explicitFormatOf(doc.root));
        // THE STAMP BELONGS TO THE DOCUMENT: only a mount at a document's own root may stamp.
        // A mounted SUBNODE inherits its chapterhood from the enclosing document — and a
        // value-position tag on a keyed member is not even writable by the server surgery.
        const isDocRoot = canonPath(String(content.header.documentPath ?? path)) === canonPath(path);
        stampedRef.current = tagged || !isDocRoot;
        concreteRef.current = (content.header.concrete as string | undefined) ?? null;
        const st = initialChapterState(doc);
        // open with the caret in the first cell that EXISTS — no click to begin, nothing written
        const first = chapterPositionsOf(doc)[0] ?? null;
        const opened: ChapterState = { ...st, focus: first, caret: first ? "end" : null };
        committedRef.current = doc;
        stateRef.current = opened;
        setState(opened);
      })
      .catch((e) => { if (alive) setError(String((e as Error)?.message || e)); });
    return () => {
      alive = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      flush(true); // the FINAL flush: pending work leaves with the mount — titled wraps birth
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // the format bar rides the SHARED bus — the node-bar ChapterFormatControl works unchanged
  useEffect(() => {
    if (!state) return;
    const site = chapterSiteOf(state.doc, state.focus);
    const editable = site.cell === "title" || site.cell === "description" || site.cell === "prose" || site.cell === "listItem" || site.cell === "tableCell" || site.cell === "boot"; // boot too — the bar MATERIALIZES the first entry (no idle state)
    publishFormatBus({
      mounted: true,
      active: editable,
      current: editable ? site.currentFormat : null,
      choose: (f) => dispatch({ kind: "format", chosen: f }),
      roles: rolesOf(state),
      applyRole: (r) => dispatch({ kind: "role", role: r === "title" ? "title" : "desc" }),
    });
  });
  useEffect(() => () => clearFormatBus(), []);

  // The reading position carries across the view/edit switch: the mount restores the URL
  // fragment ONCE (`once` — the doc dep changes on every keystroke, and re-centering while
  // typing would yank the page), and scrolling in edit mode keeps the fragment following.
  useHashScroll(state !== null, { once: true });
  const rootRef = useRef<HTMLDivElement>(null);
  useFragmentScrollSpy(rootRef, path);
  // the TOC's shading survives the view/edit switch (the edit face may stamp fewer
  // data-node-paths — those rows just fall back to navigation)
  useTocPresencePublisher(rootRef, path, state !== null);

  const dispatch = (intent: ChapterIntent, split?: SplitPayload): void => {
    const st = stateRef.current;
    if (st) update(applyChapterIntent(st, intent, split));
  };

  // THE ADAPTER — the server's capabilities behind the yed-owned cell layer
  const adapter: ChapterCellsAdapter = useMemo(() => ({
    codec: { toHtml: marklowerToEditableHtml, fromDom: domToMarklower, visibleLength: renderedTextLength },
    anchorFor: (p: Path, index: number): string | null => {
      const doc = stateRef.current?.doc;
      if (!doc) return null;
      return anchorOf(path, subchapterServerPath(doc, path, p), childSlot("", index));
    },
    anchorForSection: (p: Path): string | null => {
      const doc = stateRef.current?.doc;
      if (!doc) return null;
      // the read view's heading fragment, so `#/concretes` resolves in edit mode too
      return anchorOf(path, subchapterServerPath(doc, path, p), "/" + p.join("/"));
    },
    renderReadonly: (node: Value, p: Path) => {
      const doc = stateRef.current?.doc;
      const chunk: Chunk = {
        value: !((node as Node).kind === undefined) ? ((node as Node & { value?: unknown }).value ?? null) : null,
        path: doc ? subchapterServerPath(doc, path, p) : path,
        type: "string",
        format: explicitFormatOf(node),
        documentPath: path,
      };
      return renderChunkBody(chunk, onNavigate);
    },
    renderLinked: (link, level, budget) => (
      <LinkedPreview link={link} level={level} budget={budget} chapterPath={path} onNavigate={onNavigate} />
    ),
    pasteFiles: (el, range, files, commit) => { void insertPastedImages(el, range, files, path, commit); },
    navigate: onNavigate,
    columnMemory,
    // the SERVER registry: PICK-mode reference cells + link atoms in source chunks (future
    // math cells register byFormat entries over this same object)
    sourceCells: makeSourceCells({ navigate: onNavigate }),
    // completion over a source chunk's reference portion cells - the tree-backed provider
    sourceHints: treeHints,
    // the per-project recents bag below those hints, and the commit-side recording
    sourceRecents: treeRecents,
    sourceRecentsPaneOpen: bagOpen,
    sourceRecentsPane: setBagOpen,
    sourceRecentForget: forgetRecentEntry,
    sourceRefCommit: (p, c) => {
      const doc = stateRef.current?.doc;
      if (doc) recordRefCommit(c, { base: subchapterServerPath(doc, path, p), doc: path });
    },
    // a source chunk's wire addresses — its reference cells spell and address from here
    sourceHost: (p) => {
      const doc = stateRef.current?.doc;
      if (!doc) return undefined;
      return { base: subchapterServerPath(doc, path, p), doc: path };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [path, onNavigate, columnMemory, bagOpen]);

  const debug = ((): boolean => {
    try { return new URLSearchParams(window.location.search).get("yed") === "debug"; } catch { return false; }
  })();

  const ctx: ChapterCtxValue | null = state && {
    state,
    debug,
    adapter,
    dispatch,
    dispatchKey: (k: ChapterKey, edges?: ChapterEdges): boolean => {
      const st = stateRef.current;
      if (!st) return false;
      const out = applyChapterKey(st, k, edges);
      if (out) update(out);
      return out !== null;
    },
    commitText: (p, text) => { const st = stateRef.current; if (st) update(commitChapterText(st, p, text)); },
    boot: (p, text) => { const st = stateRef.current; if (st) update(createFirstChunk(st, p, text)); },
    focusTo: (pos: Position, caret: ChapterState["caret"] = null) => {
      const st = stateRef.current;
      if (st) update({ ...st, focus: pos, caret });
    },
    graft: (p, value, focus) => {
      const st = stateRef.current;
      if (st) update({ ...st, doc: withNode(st.doc, p, () => value as Node), ...(focus ? { focus, caret: "start" as const } : {}) });
    },
    chapterPath: path,
  };

  if (error) return <div className="muted">the chapter could not load: {error}</div>;
  if (!ctx) return <div className="muted">…</div>;
  return (
    <div ref={rootRef}>
      <ChapterCtx.Provider value={ctx}>
        {/* the reading width carries into the editor — the same measure the read view takes */}
        <ChapterDoc budget={viewDepth() ?? Infinity} style={{ maxWidth: `${markupWidthCh()}ch` }} />
      </ChapterCtx.Provider>
    </div>
  );
}

/** A linked chapter-shaped body element lays out READ-ONLY inline within the depth window;
 *  editing it means descending (the legacy LinkedBlock behavior over the shared ChapterBody). */
function LinkedPreview({ link, level, budget, chapterPath, onNavigate }: {
  link: { path: string; title?: string; format?: string };
  level: number; budget: number; chapterPath: string; onNavigate: (p: string) => void;
}) {
  const chapterish = link.format === "x-yamlover-chapter" || link.format === "x-yamlover-task";
  const inline = chapterish && budget > 1;
  const [fetched, setFetched] = useState<NodeJson | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setFetched(null);
    setFailed(null);
    if (!inline) return;
    fetchNode(link.path, 1)
      .then((n) => { if (alive) setFetched(n); })
      .catch((e) => { if (alive) setFailed(String((e as Error)?.message || e)); });
    return () => { alive = false; };
  }, [inline, link.path]);
  if (inline && fetched) {
    return (
      <section className="chapter-sub" data-chapter-path={link.path}>
        <ChapterBody value={fetched.value} nodePath={link.path} documentPath={fetched.documentPath ?? link.path}
          anchorBase={link.path} slot="" level={level + 1} budget={budget - 1}
          ancestors={[canonPath(chapterPath), canonPath(link.path)]} onLoaded={() => {}} onNavigate={onNavigate} />
      </section>
    );
  }
  const H = (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[Math.min(level + 1, 5)];
  return (
    <section className="chapter-sub" data-chapter-path={link.path}>
      <H className="chapter-title">
        <a className="descend" href="#" onClick={(e) => { e.preventDefault(); onNavigate(link.path); }}>
          {link.title ?? link.path}
        </a>
        {failed && <span className="muted"> failed to load: {failed}</span>}
        {inline && !fetched && !failed && <span className="muted"> …</span>}
      </H>
    </section>
  );
}

/** Upload pasted images beside the chapter, insert LINK atoms at the caret, recommit —
 *  mid-sentence there is no embedding (a figure is a body element), the prose gains a link. */
async function insertPastedImages(el: HTMLElement, range: Range, files: File[], chapterPath: string, commit: (text: string) => void): Promise<void> {
  for (const f of files) {
    const name = pastedName(f);
    const res = await pasteFileInline(chapterPath, name, await fileToBase64(f));
    const holder = document.createElement("span");
    holder.innerHTML = marklowerToEditableHtml(`[${name.replace(/\.[^.]+$/, "")}](*:${res.path})`);
    const atom = holder.firstChild;
    if (!atom) continue;
    range.insertNode(atom);
    range.setStartAfter(atom);
    range.collapse(true);
  }
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  commit(domToMarklower(el));
}
void clipboardFiles; // the cells read e.clipboardData.files directly; kept for parity with legacy paste

/** Whether the focused cell sits DEEPER than the `?depth=` window allows — and if so, the
 *  server path of the first-level subchapter to descend into. A freshly wrapped subchapter
 *  stays editable at any depth (it never counts) — until it is BORN (`anchorKey`), or, with
 *  `countPending`, the moment it has body content (the birth is the imminent flush). */
function beyondWindow(state: ChapterState, basePath: string, countPending: boolean): string | null {
  const budget = viewDepth() ?? Infinity;
  const focusPath = state.focus?.path ?? [];
  if (focusPath.length === 0 || budget === Infinity) return null;
  let depth = 0;
  for (let i = 1; i < focusPath.length; i++) {
    const prefix = focusPath.slice(0, i);
    const anc = nodeAtPath(state.doc.root, prefix);
    if (!anc) break;
    if (chunkModeOf(anc) !== "chapter") continue;
    const parent = nodeAtPath(state.doc.root, prefix.slice(0, -1));
    const entry = parent?.entries?.[prefix[prefix.length - 1]];
    const bornKey = entry !== undefined && ((entry.meta ?? {}) as { anchorKey?: string }).anchorKey !== undefined;
    const wrapped = metaOf(anc).chapterWrapped === true;
    const pendingBirth = wrapped && (anc.entries ?? []).length > 0;
    if (!wrapped || bornKey || (countPending && pendingBirth)) depth++;
  }
  if (depth < budget) return null;
  return subchapterServerPath(state.doc, basePath, focusPath.slice(0, 1));
}
void hasSelfValue;
void valueAtPath;
