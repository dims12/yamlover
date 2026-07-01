import { useCallback, useEffect, useRef, useState } from "react";
import { NodeJson, editChunks, createObject } from "../api";
import { asLink, Link } from "../render";
import { fragmentOf } from "../paths";
import { Chunk, rendererFor } from "./registry";
import { useHashScroll } from "./headings";
import { useEditing } from "./editing";
import { useExplorerTagMenu } from "./tagmenu";
import { chunkEditorFor, isJoinableFormat, renderedTextLength, type FocusAt } from "./chunk-editors";
import {
  buildChapterModel,
  snapshotChapter,
  diffChapter,
  newProsePart,
  childPath,
  type ChapterModel,
  type ChunkPart,
} from "./chapter-model";

/** A pending caret placement after a structural edit: which chunk to focus, and where. */
type FocusReq = { id: string; at: FocusAt };

/**
 * The renderer for an `object`/`x-yamlover-chapter`: a chapter shown as a readable page — a heading
 * (`title`/`description`) plus a `chunks` body (numbered blocks, each delegated to the renderer for
 * its own (type, format)) and `children` subchapters (rendered as navigable heading links). See the
 * registry for how a chapter is flattened into this page.
 *
 * When the page is UNLOCKED (the header lock; NodeView + editing.tsx), editing switches to
 * {@link ChapterEditor}: the chapter is loaded into an in-memory model (chapter-model.ts) that the
 * WYSIWYG editor mutates instantly, with a background sync writing changes back. This iteration edits
 * ONE chapter entity — its title, description, and prose chunks; subchapters and non-prose chunks
 * stay read-only (deeper editing arrives later via "depth").
 */
export function ChapterView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  const { unlocked } = useEditing();
  // Right-click on EMPTY space (not on prose/links/controls) → the whole-chapter tag picker plus a
  // "＋ New <schema>" entry with a concrete selector (this page IS a chapter → a subchapter). Creating
  // navigates into the new object (still in edit mode — see NodeView).
  const { openAt, tagMenu } = useExplorerTagMenu({
    onCreate: (schema, parent, concrete) => void createObject(schema, parent, concrete).then((r) => onNavigate(r.path)).catch((e) => window.alert("create failed: " + (e as Error).message)),
  });
  const onContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".chunk-body, .editable, a, button, textarea")) return; // native menu on text/links/controls
    e.preventDefault();
    openAt(node.path, e.clientX, e.clientY, { format: node.format, concrete: node.concrete });
  };
  // `key` on the chapter path: navigating to a subchapter (still in edit mode) remounts the editor so
  // it rebuilds its model from the new chapter rather than keeping the old one.
  return (
    <div className="chapter-page" onContextMenu={onContextMenu}>
      {unlocked ? <ChapterEditor key={node.path} initialNode={node} onNavigate={onNavigate} /> : <ChapterRead node={node} onNavigate={onNavigate} />}
      {tagMenu}
    </div>
  );
}

/** The read-only chapter page (locked). */
function ChapterRead({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  const v = (node.value ?? {}) as { chunks?: unknown; children?: unknown };
  const chunks = Array.isArray(v.chunks) ? v.chunks : [];
  const children = Array.isArray(v.children) ? v.children : [];
  useHashScroll(node);

  return (
    <div className="chapter">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      {chunks.map((item, i) => (
        <ReadChunk key={i} index={i} item={item} basePath={node.path} documentPath={node.documentPath} onNavigate={onNavigate} />
      ))}
      {children.map((item, i) => (
        <SubchapterLink key={i} item={item} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

/** One numbered chunk rendered read-only, by the renderer for its (type, format). */
function ReadChunk({
  index,
  item,
  basePath,
  documentPath,
  onNavigate,
}: {
  index: number;
  item: unknown;
  basePath: string;
  documentPath?: string;
  onNavigate: (path: string) => void;
}) {
  const chunk = chunkOf(item, documentPath);
  const renderer = rendererFor(chunk);
  const body = renderer?.renderChunk ? renderer.renderChunk(chunk, onNavigate) : <p className="chapter-prose">{String(chunk.value ?? "")}</p>;
  const anchor = chunk.path ? fragmentOf(basePath, chunk.path) : null;
  return (
    <div className="chunk" id={anchor ?? undefined}>
      <ChunkIndex index={index} anchor={anchor} />
      <div className="chunk-body">{body}</div>
    </div>
  );
}

/** A subchapter as a navigable heading link (never edited in this iteration). */
function SubchapterLink({ item, onNavigate }: { item: unknown; onNavigate: (path: string) => void }) {
  const link = asLink(item);
  return (
    <h2 className="chapter-link">
      <a
        className="descend"
        href={link?.path ?? "#"}
        onClick={(e) => {
          e.preventDefault();
          if (link) onNavigate(link.path);
        }}
      >
        {chapterTitle(link)}
      </a>
    </h2>
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
  const flush = useChapterSync(model);

  // Flush any pending edits when the editor unmounts (lock or navigation). Best-effort (unmount is
  // synchronous); the server then broadcasts, so the re-locked read-only view refetches fresh.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => void flushRef.current(), []);

  const children = ((initialNode.value ?? {}) as { children?: unknown }).children;
  const childList = Array.isArray(children) ? children : [];

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
    <div className="chapter">
      <EditableScalar as="h1" className="chapter-title" placeholder="Title" value={model.title} onCommit={(t) => setModel((m) => ({ ...m, title: t }))} />
      <EditableScalar as="p" className="chapter-subtitle" placeholder="Description" value={model.description} onCommit={(d) => setModel((m) => ({ ...m, description: d }))} />

      {model.chunks.map((c, i) => (
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
          onRemove={model.chunks.length > 1 ? () => removeChunk(c.id) : undefined}
        />
      ))}

      {childList.map((item, i) => (
        <SubchapterLink key={i} item={item} onNavigate={onNavigate} />
      ))}
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
  const anchor = childPath(basePath, "chunks") + `[${index}]`;
  const id = fragmentOf(basePath, anchor);
  const Editor = part.editable ? chunkEditorFor(part.format) : null;
  let body;
  if (Editor) {
    body = (
      <Editor
        text={part.text}
        rev={part.rev}
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
 *  when the model value changes while unfocused; commits on blur (and Enter, which blurs). */
function EditableScalar({
  as,
  value,
  onCommit,
  className,
  placeholder,
}: {
  as: "h1" | "p";
  value: string;
  onCommit: (text: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const focused = useRef(false);
  const Tag = as;
  useEffect(() => {
    if (ref.current && !focused.current) ref.current.textContent = value;
  }, [value]);
  return (
    <Tag
      ref={ref as React.Ref<never>}
      className={(className ? className + " " : "") + "editable"}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onBlur={() => { focused.current = false; onCommit((ref.current?.textContent ?? "").trim()); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); } }}
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

/** Build a {@link Chunk} (for a renderer's `renderChunk`) from a chapter chunk value/link marker. */
function chunkOf(item: unknown, documentPath?: string): Chunk {
  const link = asLink(item);
  return {
    value: link ? link.value : item,
    path: link?.path ?? "",
    type: link?.type ?? "string",
    format: link?.format ?? null,
    valueType: link?.valueType ?? "string",
    hasKeyed: link?.hasKeyed ?? false,
    hasOrdinal: link?.hasOrdinal ?? false,
    documentPath,
  };
}

/** A subchapter link's label: its schema title, else a generic fallback. */
function chapterTitle(link: Link | null): string {
  return link?.title ?? "(untitled chapter)";
}
