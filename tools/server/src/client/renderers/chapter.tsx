import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { NodeJson, editChunks, createNode, createObject } from "../api";
import { NODE_SCHEMA } from "./create";
import { asLink, scalarValue } from "../render";
import { canonPath } from "../paths";
import { focusEnd } from "./caret";
import { Chunk, rendererFor } from "./registry";
import { useHashScroll } from "./headings";
import { useEditing } from "./editing";
import { useExplorerTagMenu } from "./tagmenu";
import { chunkEditorFor, isJoinableFormat, renderedTextLength, type FocusAt } from "./chunk-editors";
import { markupWidthCh } from "./markup";
import { viewDepth } from "./depth";
import { InlineSubchapter } from "./subchapter";
import { ChapterProjection } from "./chapter-editor/view";
import {
  buildChapterModel,
  snapshotChapter,
  diffChapter,
  newProsePart,
  childPath,
  childSlot,
  anchorOf,
  chapterFlow,
  flowText,
  isSubchapter,
  type ChapterModel,
  type ChunkPart,
} from "./chapter-model";

/** A pending caret placement after a structural edit: which chunk to focus, and where. */
type FocusReq = { id: string; at: FocusAt };

/**
 * The renderer for an `x-yamlover-chapter` (CHAPTER.md): a chapter shown as a readable page — a
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
        projectionalChapterEditor()
          ? <ChapterProjection key={node.path} path={node.path} onNavigate={onNavigate} />
          : <ChapterEditor key={node.path} initialNode={node} onNavigate={onNavigate} />
      ) : (
        <ChapterRead node={node} onNavigate={onNavigate} />
      )}
      {tagMenu}
    </div>
  );
}

/** Whether the unlocked chapter uses the NEW projectional editor (TAB nesting, format switching)
 *  instead of the flat one. Opt-in while it grows toward parity: `?chapterEditor=projectional` in
 *  the URL, or `localStorage.chapterEditor`. Defaults off so nothing regresses. */
function projectionalChapterEditor(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get("chapterEditor");
    if (q) return q === "projectional";
    return window.localStorage?.getItem("chapterEditor") === "projectional";
  } catch {
    return false;
  }
}

/** The read-only chapter page (locked). Title, description, chunks, and subchapters all render in
 *  SOURCE order — the heading is not hoisted, subchapters are not forced to the end (CHAPTER.md).
 *  §N numbers the chunks only; subchapters render as heading links. */
function ChapterRead({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  // How many levels of SUBCHAPTER nesting are laid out in place before the rest stay links —
  // the shared `?depth=` URL parameter (depth.tsx), infinity by default, so a chapter reads as one
  // whole document. `depth=1` restores the page that only ever showed links.
  const budget = viewDepth() ?? Infinity;
  // Each lazily-loaded subtree that lands re-runs the `#fragment` scroll: a deep link may name a
  // chunk inside a subchapter that was not in the DOM when the hash was first read.
  const [loads, noteLoad] = useReducer((n: number) => n + 1, 0);
  useHashScroll(loads);

  return (
    <div className="chapter" style={{ maxWidth: `${markupWidthCh()}ch` }}>
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

/** One chapter's own stream — title, description, chunks, and subchapters, in SOURCE order — and,
 *  for each subchapter, the same thing again one level deeper (subchapter.tsx). `level` 0 is the
 *  page root; deeper levels wrap in a `<section>` that carries the indent, and their headings step
 *  down h1→h2→…→h6. `§N` restarts per chapter, so a chunk shows the same number here as it does on
 *  that subchapter's own page — the number stays a stable citation either way. */
function ChapterBody({
  value, nodePath, documentPath, anchorBase, slot, level, budget, ancestors, onLoaded, onNavigate,
}: {
  value: unknown;
  nodePath: string;
  documentPath?: string;
  anchorBase: string;
  slot: string;
  level: number;
  budget: number;
  ancestors: readonly string[];
  onLoaded: () => void;
  onNavigate: (path: string) => void;
}) {
  const flow = chapterFlow(value);
  const Heading = `h${Math.min(level + 1, 6)}` as "h1";
  let chunkNo = 0;

  const body = flow.map((f, i) => {
    if (f.kind === "title") {
      return (
        <Heading key={i} className="chapter-title" id={level > 0 ? slot : undefined}>
          {flowText(f.value)}
        </Heading>
      );
    }
    if (f.kind === "description") return <p key={i} className="chapter-subtitle">{flowText(f.value)}</p>;
    const childSlotId = childSlot(slot, f.absIndex);
    if (f.kind === "subchapter") {
      return (
        <InlineSubchapter
          key={i}
          marker={f.value}
          parentPath={nodePath}
          absIndex={f.absIndex}
          slot={childSlotId}
          level={level + 1}
          budget={budget - 1}
          ancestors={ancestors}
          onLoaded={onLoaded}
          renderBody={(p) => (
            <ChapterBody
              value={p.value}
              nodePath={p.nodePath}
              documentPath={p.documentPath ?? documentPath}
              anchorBase={anchorBase}
              slot={p.slot}
              level={p.level}
              budget={budget - 1}
              ancestors={p.ancestors}
              onLoaded={onLoaded}
              onNavigate={onNavigate}
            />
          )}
          renderLink={(p) => <SubchapterLink {...p} onNavigate={onNavigate} />}
        />
      );
    }
    return (
      <ReadChunk
        key={i}
        index={chunkNo++}
        item={f.value}
        anchorBase={anchorBase}
        slot={childSlotId}
        documentPath={documentPath}
        onNavigate={onNavigate}
      />
    );
  });

  // The page root IS the `.chapter` container (ChapterRead draws it); a nested one takes a section
  // of its own, which is what the indent hangs off. `data-chapter-path` lets the page's context
  // menu target the NEAREST enclosing chapter rather than always the page node.
  if (level === 0) return <>{body}</>;
  return <section className="chapter-sub" data-chapter-path={nodePath}>{body}</section>;
}

/** One numbered chunk rendered read-only, by the renderer for its (type, format). */
function ReadChunk({
  index,
  item,
  anchorBase,
  slot,
  documentPath,
  onNavigate,
}: {
  index: number;
  item: unknown;
  anchorBase: string;
  slot: string;
  documentPath?: string;
  onNavigate: (path: string) => void;
}) {
  const chunk = chunkOf(item, documentPath);
  const renderer = rendererFor(chunk);
  const body = renderer?.renderChunk ? renderer.renderChunk(chunk, onNavigate) : <p className="chapter-prose">{String(chunk.value ?? "")}</p>;
  // its path continuation from the page root when it lives under it, else its render slot — an
  // inlined subchapter's chunks are addressed one way on a root page and the other on a subpage
  const anchor = anchorOf(anchorBase, chunk.path, slot);
  return (
    // `data-node-path` maps this chunk's DOM back to its node path, so the annotation layer targets a
    // text fragment at the CHUNK (not the whole chapter) and scopes the highlight to it (annotate.tsx).
    <div className="chunk" id={anchor ?? undefined} data-node-path={chunk.path || undefined}>
      <ChunkIndex index={index} anchor={anchor} />
      <div className="chunk-body">{body}</div>
    </div>
  );
}

/** A subchapter as a navigable heading link — what a subchapter shows when it is NOT laid out in
 *  place: past the depth budget, mid-load, failed, a pointer cycle, or in the editor. It keeps the
 *  anchor `id` the inlined body would have had, so a `#fragment` to it still resolves, and it takes
 *  its heading level from the nesting so a link and an inlined chapter read at the same rank. */
function SubchapterLink({
  path, title, level = 1, id, note, onNavigate,
}: {
  path?: string;
  title?: string;
  level?: number;
  id?: string;
  note?: string;
  onNavigate: (path: string) => void;
}) {
  const Heading = `h${Math.min(level + 1, 6)}` as "h2";
  return (
    <Heading className="chapter-link" id={id || undefined}>
      <a
        className="descend"
        href={path ?? "#"}
        onClick={(e) => {
          e.preventDefault();
          if (path) onNavigate(path);
        }}
      >
        {title || "(untitled chapter)"}
      </a>
      {note && <span className="chapter-link-note" data-yo-chrome> {note}</span>}
    </Heading>
  );
}

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
      <EditableScalar as="h1" className="chapter-title" placeholder="Title" value={model.title} onCommit={(t) => setModel((m) => ({ ...m, title: t }))} focusNow={headFocus === "title"} onFocused={() => setHeadFocus(null)} onEnter={() => setHeadFocus("description")} />
      <EditableScalar as="p" className="chapter-subtitle" placeholder="Description" value={model.description} onCommit={(d) => setModel((m) => ({ ...m, description: d }))} focusNow={headFocus === "description"} onFocused={() => setHeadFocus(null)} onEnter={enterBody} />

      {model.chunks.map((c, i) =>
        c.subchapter ? (
          <SubchapterLink key={c.id} path={c.navPath} title={c.title} onNavigate={onNavigate} />
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
    const chunk = chunkOf(part.marker, documentPath);
    const renderer = rendererFor(chunk);
    body = renderer?.renderChunk ? renderer.renderChunk(chunk, onNavigate) : <p className="chapter-prose">{String(chunk.value ?? "")}</p>;
  }
  return (
    <div className="chunk" id={id ?? undefined}>
      <ChunkIndex index={index} anchor={id} />
      <div className="chunk-body">{body}</div>
      {Editor && onRemove && (
        <span className="chunk-tools">
          <button className="chunk-tool" title="Delete this paragraph" onClick={onRemove}>🗑</button>
        </span>
      )}
    </div>
  );
}

/** A single-line editable scalar (title / description). Uncontrolled: text is written on mount and
 *  when the model value changes while unfocused; commits on blur and on Enter.
 *
 *  Enter HANDS THE CARET ON (`onEnter`) rather than blurring: a heading field that drops focus into
 *  nothing makes the writer click to get back into their own document, once per field. `focusNow`
 *  is the other half — the caller says which field wants the caret, so unlocking starts in the
 *  title instead of waiting to be clicked. */
function EditableScalar({
  as,
  value,
  onCommit,
  className,
  placeholder,
  focusNow,
  onFocused,
  onEnter,
}: {
  as: "h1" | "p";
  value: string;
  onCommit: (text: string) => void;
  className?: string;
  placeholder?: string;
  focusNow?: boolean;
  onFocused?: () => void;
  onEnter?: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const focused = useRef(false);
  const Tag = as;
  useEffect(() => {
    if (ref.current && !focused.current) ref.current.textContent = value;
  }, [value]);
  // take the caret when this field is the one asked for, and place it at the END so typing appends
  useEffect(() => {
    if (!focusNow || !ref.current) return;
    focusEnd(ref.current);
    onFocused?.();
    // `onFocused` clears the request; re-running on its identity would fight the next field for it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNow]);
  return (
    <Tag
      ref={ref as React.Ref<never>}
      className={(className ? className + " " : "") + "editable"}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onBlur={() => { focused.current = false; onCommit((ref.current?.textContent ?? "").trim()); }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        focused.current = false;
        onCommit((ref.current?.textContent ?? "").trim());
        onEnter?.(); // …and the caller moves the caret on; no blur, so nothing is ever left nowhere
      }}
    />
  );
}

// --------------------------------------------------------------------------- //
// Shared helpers
// --------------------------------------------------------------------------- //

/** The `§N` gutter — an in-page anchor link to the chunk's own location, or a plain marker. */
function ChunkIndex({ index, anchor }: { index: number; anchor: string | null }) {
  return anchor ? (
    <a className="chunk-index" href={`#${anchor}`}>§{index}</a>
  ) : (
    <span className="chunk-index">§{index}</span>
  );
}

/** Build a {@link Chunk} (for a renderer's `renderChunk`) from a chapter chunk value/link marker.
 *
 *  An ANNOTATED chunk arrives as an omni marker — its tag applications are keyed entries laid over
 *  the prose (ANNOTATIONS.md) — so the scalar is peeled out of it before anything else looks at it;
 *  an unannotated one is already its own value.
 *
 *  An INLINE string is a chapter's prose, so it carries the chunk schema's format — `text/marklower`
 *  (CHAPTER.md `$defs/chunk`) — even when the value reached the client unstamped (a `$yamloverLink`
 *  marker carries its node's own format; a bare inline scalar has none to carry). Saying so here is
 *  what lets the registry ask for the format BY NAME instead of claiming every format-less string in
 *  the tree, which would make prose of a plain `name: Alice`. */
function chunkOf(item: unknown, documentPath?: string): Chunk {
  const link = asLink(item);
  const value = link ? link.value : scalarValue(item); // peel an annotation overlay to the prose under it
  const inlineProse = !link && typeof value === "string";
  return {
    value,
    path: link?.path ?? "",
    type: link?.type ?? "string",
    format: link?.format ?? (inlineProse ? "text/marklower" : null),
    valueType: link?.valueType ?? "string",
    hasKeyed: link?.hasKeyed ?? false,
    hasOrdinal: link?.hasOrdinal ?? false,
    documentPath,
  };
}
