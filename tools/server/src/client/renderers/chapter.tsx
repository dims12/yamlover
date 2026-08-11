import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { NodeJson, editChunks, createNode, createObject } from "../api";
import { NODE_SCHEMA } from "./create";
import { canonPath, ROOT_FRAGMENT } from "../paths";
import { ChapterBody, ChunkGutter, ChunkShell, chunkOf, EditableLine, renderChunkBody, SubchapterHeading } from "./chapter-shared";
import { useFragmentScrollSpy, useHashScroll } from "./headings";
import { useTocPresencePublisher } from "../toc-presence";
import { useEditing } from "./editing";
import { useExplorerTagMenu } from "./tagmenu";
import { chunkEditorFor, isJoinableFormat, renderedTextLength, type FocusAt } from "./chunk-editors";
import { markupWidthCh } from "./markup";
import { viewDepth } from "./depth";
import { YedChapterEditor } from "./yed-chapter-editor";
import {
  buildChapterModel,
  snapshotChapter,
  diffChapter,
  newProsePart,
  childPath,
  childSlot,
  anchorOf,
  type ChapterModel,
  type ChunkPart,
} from "./chapter-model";

/** A pending caret placement after a structural edit: which chunk to focus, and where. */
type FocusReq = { id: string; at: FocusAt };

/**
 * The renderer for an `x-yamlover-chapter` (docs/documents/chapter): a chapter shown as a readable page — a
 * heading (`title`/`description`) plus a POSITIONAL body of elements, each either a numbered chunk
 * (delegated to the renderer for its own (type, format)) or a subchapter (a navigable heading link),
 * interleaved in source order. See the registry for how a chapter is flattened into this page.
 *
 * When the page is UNLOCKED (the header lock; NodeView + editing.tsx), editing switches to
 * {@link ChapterEditor}: the chapter is loaded into an in-memory model (chapter-model.ts) that the
 * WYSIWYG editor mutates instantly, with a background sync writing changes back. This iteration edits
 * ONE chapter entity — its title, description, and prose chunks; subchapters and non-prose chunks
 * stay read-only (deeper editing arrives later via "depth").
 */
export function ChapterView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  const { unlocked, unlock } = useEditing();
  // Right-click on EMPTY space (not on prose/links/controls) → the whole-chapter tag picker plus a
  // "＋ New <schema>" entry with a concrete selector (this page IS a chapter → a subchapter). Creating
  // navigates into the new object and opens it UNLOCKED (the context `unlock` — see NodeView).
  const { openAt, tagMenu } = useExplorerTagMenu({
    onCreate: (schema, parent, concrete) =>
      void (schema === NODE_SCHEMA ? createNode(parent, concrete) : createObject(schema, parent, concrete))
        .then((r) => {
          onNavigate(r.path);
          unlock?.();
        })
        .catch((e) => window.alert("create failed: " + (e as Error).message)),
  });
  const onContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".chunk-body, .editable, a, button, textarea")) return; // native menu on text/links/controls
    e.preventDefault();
    // Subchapters are laid out IN PLACE, so the click may land inside one — create there, not at
    // the page root. `data-chapter-path` is stamped by every nested chapter body (subchapter.tsx).
    const within = target.closest("[data-chapter-path]")?.getAttribute("data-chapter-path");
    openAt(within || node.path, e.clientX, e.clientY, { format: node.format, concrete: node.concrete });
  };
  // `key` on the chapter path: navigating to a subchapter (still in edit mode) remounts the editor so
  // it rebuilds its model from the new chapter rather than keeping the old one.
  return (
    <div className="chapter-page" onContextMenu={onContextMenu}>
      {unlocked ? (
        chapterEditorFlavor() === "yed"
          ? <YedChapterEditor key={node.path} path={node.path} onNavigate={onNavigate} />
          : <ChapterEditor key={node.path} initialNode={node} onNavigate={onNavigate} />
      ) : (
        <ChapterRead node={node} onNavigate={onNavigate} />
      )}
      {tagMenu}
    </div>
  );
}

/** Which unlocked chapter editor runs. The YED chapter editor is the DEFAULT — the superset
 *  parity gate passed (test/yed-chapter-parity.test.tsx, the port plan Stage 8) and the legacy
 *  PROJECTIONAL editor is RETIRED (Stage 9). The FLAT editor remains the old escape hatch
 *  (`?chapterEditor=flat`) slated for deletion (TODO.md). */
export function chapterEditorFlavor(): "yed" | "flat" {
  try {
    const q = new URLSearchParams(window.location.search).get("chapterEditor")
      ?? window.localStorage?.getItem("chapterEditor");
    return q === "flat" ? "flat" : "yed";
  } catch {
    return "yed";
  }
}

/** The read-only chapter page (locked). Title, description, chunks, and subchapters all render in
 *  SOURCE order — the heading is not hoisted, subchapters are not forced to the end (docs/documents/chapter).
 *  `[n]` labels each chunk with its absolute entry index; subchapters render as heading links. */
function ChapterRead({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  // How many levels of SUBCHAPTER nesting are laid out in place before the rest stay links —
  // the shared `?depth=` URL parameter (depth.tsx), infinity by default, so a chapter reads as one
  // whole document. `depth=1` restores the page that only ever showed links.
  const budget = viewDepth() ?? Infinity;
  // Each lazily-loaded subtree that lands re-runs the `#fragment` scroll: a deep link may name a
  // chunk inside a subchapter that was not in the DOM when the hash was first read.
  const [loads, noteLoad] = useReducer((n: number) => n + 1, 0);
  useHashScroll(loads);
  // …and the reverse: scrolling updates the fragment to the anchor under the reading line
  const rootRef = useRef<HTMLDivElement>(null);
  useFragmentScrollSpy(rootRef, node.path);
  // the TOC shades what this page renders inline; `loads` re-scans on each lazy landing
  useTocPresencePublisher(rootRef, node.path, loads);

  return (
    <div className="chapter" ref={rootRef} style={{ maxWidth: `${markupWidthCh()}ch` }}>
      {/* the page root's own anchor (`#/`): the TOC's click on THIS chapter scrolls here, the
          presence scan maps the base row to it, and the spy names it when reading the top */}
      <span id={ROOT_FRAGMENT} className="frag-anchor" data-node-path={node.path} />
      <ChapterBody
        value={node.value}
        nodePath={node.path}
        documentPath={node.documentPath}
        anchorBase={node.path}
        slot=""
        level={0}
        budget={budget}
        ancestors={[canonPath(node.path)]}
        onLoaded={noteLoad}
        onNavigate={onNavigate}
      />
    </div>
  );
}

// ChapterBody / ReadChunk (the read-only chapter stream) live in chapter-shared.tsx — the
// projectional editor inlines read-only subchapters through the very same components.

// --------------------------------------------------------------------------- //
// The editor (unlocked): an in-memory model + background sync.
// --------------------------------------------------------------------------- //

/** Reconcile the model to the server in the background: debounced, serialized, coalesced. Diffs the
 *  live model against the last-synced snapshot and sends the minimal batch of ops (each routed to its
 *  own backing file server-side). Returns a `flush` for lock/unmount. */
function useChapterSync(model: ChapterModel): () => Promise<void> {
  const committed = useRef<ChapterModel | null>(null);
  if (committed.current === null) committed.current = snapshotChapter(model); // the server state at unlock
  const modelRef = useRef(model);
  modelRef.current = model;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef(false);
  const dirty = useRef(false);

  const run = useCallback(async () => {
    if (running.current) { dirty.current = true; return; }
    const current = modelRef.current;
    const edits = diffChapter(committed.current!, current);
    if (!edits.length) return;
    running.current = true;
    try {
      await editChunks(edits);
      committed.current = snapshotChapter(current); // only advance the baseline on success
    } catch (e) {
      window.alert("edit sync failed: " + (e as Error).message); // keep baseline → retried next change/flush
    } finally {
      running.current = false;
      if (dirty.current) { dirty.current = false; void run(); }
    }
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), 500);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [model, run]);

  return useCallback(() => { if (timer.current) clearTimeout(timer.current); return run(); }, [run]);
}

/** The unlocked chapter editor. Builds the model ONCE from the node (never rebuilt from props while
 *  mounted, so background refetches can't reset it), renders editable title/description + prose
 *  chunks, and drives {@link useChapterSync}. */
function ChapterEditor({ initialNode, onNavigate }: { initialNode: NodeJson; onNavigate: (path: string) => void }) {
  const [model, setModel] = useState<ChapterModel>(() => buildChapterModel(initialNode));
  const [focusReq, setFocusReq] = useState<FocusReq | null>(null);
  // Which HEADING field wants the caret. Unlocking lands in the title, and Enter walks title →
  // description → the body: pressing Edit means "I am writing now", so the editor never asks for a
  // click to begin, and no field is a dead end that drops the caret out of the document.
  const [headFocus, setHeadFocus] = useState<"title" | "description" | null>("title");
  const flush = useChapterSync(model);
  useHashScroll(model); // a `#[1]` deep link must land while unlocked too, not only in the read view

  // Flush any pending edits when the editor unmounts (lock or navigation). Best-effort (unmount is
  // synchronous); the server then broadcasts, so the re-locked read-only view refetches fresh.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => void flushRef.current(), []);

  // ----- model mutations (instant; the sync persists them) -----
  const setText = useCallback((id: string, text: string) => {
    setModel((m) => ({ ...m, chunks: m.chunks.map((c) => (c.id === id ? { ...c, text } : c)) }));
  }, []);
  // Enter at the caret: this chunk keeps the head (rev++ resets its DOM), the tail becomes a new chunk.
  const splitChunk = useCallback((id: string, head: string, tail: string) => {
    setModel((m) => {
      const i = m.chunks.findIndex((c) => c.id === id);
      if (i < 0) return m;
      const part = newProsePart(tail, m.chunks[i].format);
      const chunks = m.chunks.slice();
      chunks[i] = { ...chunks[i], text: head, rev: chunks[i].rev + 1 };
      chunks.splice(i + 1, 0, part);
      setFocusReq({ id: part.id, at: "start" });
      return { ...m, chunks };
    });
  }, []);
  const insertAfter = useCallback((index: number) => {
    setModel((m) => {
      const part = newProsePart("");
      const chunks = m.chunks.slice();
      chunks.splice(index + 1, 0, part);
      setFocusReq({ id: part.id, at: "start" });
      return { ...m, chunks };
    });
  }, []);
  /** Enter out of the description: into the first editable paragraph, making one when the chapter
   *  has no body yet — so a brand-new chapter is title → description → writing, with no dead end
   *  and nothing to click. The paragraph is born from a KEYSTROKE, so merely opening the editor
   *  still writes nothing. */
  const enterBody = useCallback(() => {
    setHeadFocus(null);
    setModel((m) => {
      const first = m.chunks.find((c) => c.editable);
      if (first) { setFocusReq({ id: first.id, at: "start" }); return m; }
      const part = newProsePart("");
      setFocusReq({ id: part.id, at: "start" });
      return { ...m, chunks: [...m.chunks, part] };
    });
  }, []);
  const removeChunk = useCallback((id: string) => {
    setModel((m) => {
      const i = m.chunks.findIndex((c) => c.id === id);
      if (i < 0 || m.chunks.length <= 1) return m; // keep at least one chunk
      const chunks = m.chunks.slice();
      chunks.splice(i, 1);
      const prev = chunks[Math.max(0, i - 1)];
      if (prev?.editable) setFocusReq({ id: prev.id, at: "end" });
      return { ...m, chunks };
    });
  }, []);
  // ArrowUp/Down off the top/bottom line: move the caret to the adjacent EDITABLE chunk.
  const arrowOut = useCallback((id: string, dir: "up" | "down") => {
    setModel((m) => {
      const i = m.chunks.findIndex((c) => c.id === id);
      const target = dir === "up" ? i - 1 : i + 1;
      const t = m.chunks[target];
      if (t?.editable) setFocusReq({ id: t.id, at: dir === "up" ? "end" : "start" });
      return m;
    });
  }, []);
  // Backspace at the start joins into the previous chunk; Delete at the end pulls in the next — but
  // only between joinable (WYSIWYG prose) chunks; a LaTeX block never merges into prose.
  const join = useCallback((id: string, dir: "prev" | "next") => {
    setModel((m) => {
      const i = m.chunks.findIndex((c) => c.id === id);
      const a = dir === "prev" ? i - 1 : i; // the chunk that keeps the text
      const b = dir === "prev" ? i : i + 1; // the chunk that is absorbed
      if (a < 0 || b >= m.chunks.length) return m;
      const keep = m.chunks[a];
      const drop = m.chunks[b];
      if (!keep.editable || !drop.editable || !isJoinableFormat(keep.format) || !isJoinableFormat(drop.format)) return m;
      const junction = renderedTextLength(keep.text); // caret lands where the two joined
      const chunks = m.chunks.slice();
      chunks[a] = { ...keep, text: keep.text + drop.text, rev: keep.rev + 1 };
      chunks.splice(b, 1);
      setFocusReq({ id: keep.id, at: junction });
      return { ...m, chunks };
    });
  }, []);

  return (
    <div className="chapter" style={{ maxWidth: `${markupWidthCh()}ch` }}>
      <EditableLine as="h1" className="chapter-title" placeholder="Title" value={model.title} commitUnchanged onCommit={(t) => setModel((m) => ({ ...m, title: t }))} focusNow={headFocus === "title"} onFocused={() => setHeadFocus(null)} onEnter={() => setHeadFocus("description")} />
      <EditableLine as="p" className="chapter-subtitle" placeholder="Description" value={model.description} commitUnchanged onCommit={(d) => setModel((m) => ({ ...m, description: d }))} focusNow={headFocus === "description"} onFocused={() => setHeadFocus(null)} onEnter={enterBody} />

      {model.chunks.map((c, i) =>
        c.subchapter ? (
          <SubchapterHeading key={c.id} path={c.navPath} title={c.title} onNavigate={onNavigate} />
        ) : (
          <EditChunk
            key={c.id}
            index={i}
            part={c}
            basePath={model.path}
            documentPath={initialNode.documentPath}
            onNavigate={onNavigate}
            focusAt={focusReq?.id === c.id ? focusReq.at : null}
            onFocused={() => setFocusReq(null)}
            onChangeText={(t) => setText(c.id, t)}
            onSplit={(head, tail) => splitChunk(c.id, head, tail)}
            onArrowOut={(dir) => arrowOut(c.id, dir)}
            onJoinPrev={() => join(c.id, "prev")}
            onJoinNext={() => join(c.id, "next")}
            onRemove={model.chunks.filter((k) => !k.subchapter).length > 1 ? () => removeChunk(c.id) : undefined}
          />
        ),
      )}
    </div>
  );
}

/** One chunk in the editor: its format's editor (chunk-editors.tsx) for an editable part, else the
 *  read-only render. A `🗑` deletes the chunk (adding is via Enter / arrow-driven flow). */
function EditChunk({
  index,
  part,
  basePath,
  documentPath,
  onNavigate,
  focusAt,
  onFocused,
  onChangeText,
  onSplit,
  onArrowOut,
  onJoinPrev,
  onJoinNext,
  onRemove,
}: {
  index: number;
  part: ChunkPart;
  basePath: string;
  documentPath?: string;
  onNavigate: (path: string) => void;
  focusAt: FocusAt;
  onFocused: () => void;
  onChangeText: (text: string) => void;
  onSplit: (head: string, tail: string) => void;
  onArrowOut: (dir: "up" | "down") => void;
  onJoinPrev: () => void;
  onJoinNext: () => void;
  onRemove?: () => void;
}) {
  const id = anchorOf(basePath, childPath(basePath, index), childSlot("", index)); // the body element's slot
  const Editor = part.editable ? chunkEditorFor(part.format) : null;
  let body;
  if (Editor) {
    body = (
      <Editor
        text={part.text}
        rev={part.rev}
        chapterPath={basePath}
        focusAt={focusAt}
        onFocused={onFocused}
        onChangeText={onChangeText}
        onSplit={onSplit}
        onArrowOut={onArrowOut}
        onJoinPrev={onJoinPrev}
        onJoinNext={onJoinNext}
      />
    );
  } else {
    body = renderChunkBody(chunkOf(part.marker, documentPath, childPath(basePath, index)), onNavigate);
  }
  return (
    <ChunkShell
      anchor={id}
      gutter={<ChunkGutter index={index} anchor={id} />}
      tools={
        Editor && onRemove ? (
          <span className="chunk-tools">
            <button className="chunk-tool" title="Delete this paragraph" onClick={onRemove}>🗑</button>
          </span>
        ) : null
      }
    >
      {body}
    </ChunkShell>
  );
}

// --------------------------------------------------------------------------- //
// Shared helpers
// --------------------------------------------------------------------------- //

