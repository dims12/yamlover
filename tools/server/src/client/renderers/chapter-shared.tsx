// The chapter family's shared presentation primitives — ONE implementation for the read view
// (chapter.tsx), the flat editor (chapter.tsx), and the projectional chapter editor
// (the yed chapter cells), so the page reads identically locked and unlocked and a styling
// decision is made exactly once.
//
// THE DEPTH-STYLING RULE: a subchapter looks the SAME whether its body is laid out in place or
// not — {@link SubchapterHeading} always draws the `chapter-title` heading at the nesting's
// rank; crossing the depth budget only turns the title text into a `descend` hyperlink (and
// the body is absent). Depth changes toggle links, never typography.

import { useEffect, useRef } from "react";
import { rendererFor, type Chunk } from "./registry";
import { focusEnd } from "./caret";
import { asLink, asMixed, scalarValue } from "../render";
import { anchorOf, chapterFlow, childSlot, flowText } from "./chapter-model";
import { InlineSubchapter } from "./subchapter";
import { DataChunk } from "./data-chunk";

/** The index gutter — an in-page anchor link to the chunk's own location, or a plain marker.
 *  `n` is the chunk's ABSOLUTE entry index (CHAPTER.md §Addressing), shown as the canonical
 *  bare-digit ADDRESS token (the YAML-keys round retired the `[n]` display): the same number a
 *  marklower link (`:i`), an edit path, and the tree label spell — the gutter shows the address,
 *  not a render-order count (the legacy `§N` chunk counter skipped keyed entries and disagreed
 *  with all three). */
export function ChunkGutter({ index, anchor }: { index: number; anchor: string | null }) {
  return anchor ? (
    <a className="chunk-index" href={`#${anchor}`}>{index}</a>
  ) : (
    <span className="chunk-index">{index}</span>
  );
}

/** The chunk skeleton — `div.chunk` + gutter + `div.chunk-body` (+ optional trailing tools).
 *  `data-node-path` maps the chunk's DOM back to its node path so the annotation layer targets
 *  the CHUNK, not the whole chapter (annotate.tsx). Extra div props (key handlers, focus) pass
 *  through for the editors. */
export function ChunkShell({
  anchor, nodePath, gutter, tools, children, ...divProps
}: {
  anchor?: string | null;
  nodePath?: string;
  gutter?: React.ReactNode;
  tools?: React.ReactNode;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="chunk" id={anchor || undefined} data-node-path={nodePath || undefined} {...divProps}>
      {gutter}
      <div className="chunk-body">{children}</div>
      {tools}
    </div>
  );
}

/** A read-only chunk body: the renderer for the chunk's (type, format), else plain prose. */
export function renderChunkBody(chunk: Chunk, onNavigate: (path: string) => void): JSX.Element {
  const renderer = rendererFor(chunk);
  return renderer?.renderChunk ? renderer.renderChunk(chunk, onNavigate) : <p className="chapter-prose">{String(chunk.value ?? "")}</p>;
}

/** A subchapter's heading, at the rank its nesting gives it — the SAME `chapter-title` face
 *  whether the body is laid out in place or not (the depth-styling rule above). It wraps in its
 *  own `chapter-sub` SECTION so a collapsed subchapter keeps the exact indent + left rule its
 *  inlined body would have (and `data-chapter-path` keeps drops/creates targeting it). With
 *  `linked`, the title text is a `descend` hyperlink and a trailing `»` marks the collapsed
 *  state (past the depth budget, mid-load, failed, a pointer cycle, or the flat editor); the
 *  anchor `id` the inlined body would have had is kept either way, so a `#fragment` resolves. */
export function SubchapterHeading({
  path, title, level = 1, id, note, linked = true, onNavigate,
}: {
  path?: string;
  title?: string;
  level?: number;
  id?: string;
  note?: string;
  /** False renders the title as plain text (an in-place body follows it). */
  linked?: boolean;
  onNavigate?: (path: string) => void;
}) {
  const Heading = `h${Math.min(level + 1, 6)}` as "h2";
  return (
    <section className="chapter-sub" data-chapter-path={path || undefined}>
      <Heading className="chapter-title" id={id || undefined}>
        {linked && <span className="chapter-link-more" data-yo-chrome aria-hidden="true">»</span>}
        {linked ? (
          <a
            className="descend"
            href={path ?? "#"}
            onClick={(e) => {
              e.preventDefault();
              if (path) onNavigate?.(path);
            }}
          >
            {title || "(untitled chapter)"}
          </a>
        ) : (
          title || "(untitled chapter)"
        )}
        {note && <span className="chapter-link-note" data-yo-chrome> {note}</span>}
      </Heading>
    </section>
  );
}

/** A single-line editable scalar cell (title / subtitle). Uncontrolled: the text is written on
 *  mount and when `value` changes while unfocused; commits on blur and on Enter. Enter HANDS
 *  THE CARET ON (`onEnter`) rather than blurring to nowhere; `focusNow` is the other half —
 *  the caller says which field wants the caret, so unlocking starts writing without a click.
 *
 *  By default a commit fires only when the text actually CHANGED — a blur fires on every caret
 *  walk, and an unchanged commit is not free in the projectional editor (each one emits a real
 *  op). `commitUnchanged` restores the flat editor's always-commit behavior (its model diffing
 *  absorbs the no-ops). */
export function EditableLine({
  as, value, onCommit, className, placeholder, focusNow, onFocused, onEnter, onFocus, onTab, onArrow, commitUnchanged,
}: {
  as: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p";
  value: string;
  onCommit: (text: string) => void;
  className?: string;
  placeholder?: string;
  focusNow?: boolean;
  onFocused?: () => void;
  onEnter?: () => void;
  onFocus?: () => void;
  /** Tab/Shift-Tab — a SUBCHAPTER title moves the whole subchapter; absent, the key is consumed
   *  (a heading never lets the browser walk focus out of the document). */
  onTab?: (shift: boolean) => void;
  /** Up/Down — a heading is one line, so both always walk to the adjacent cell. */
  onArrow?: (dir: "up" | "down") => void;
  commitUnchanged?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const focused = useRef(false);
  const latest = useRef(value);
  latest.current = value;
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
  const commit = () => {
    const t = (ref.current?.textContent ?? "").trim();
    if (commitUnchanged || t !== latest.current) onCommit(t);
  };
  return (
    <Tag
      ref={ref as React.Ref<never>}
      className={(className ? className + " " : "") + "editable"}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onFocus={() => { focused.current = true; onFocus?.(); }}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={(e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          onTab?.(e.shiftKey);
          return;
        }
        if ((e.key === "ArrowUp" || e.key === "ArrowDown") && onArrow) {
          e.preventDefault();
          onArrow(e.key === "ArrowUp" ? "up" : "down"); // the focus move blurs → commit
          return;
        }
        if (e.key !== "Enter") return;
        e.preventDefault();
        focused.current = false;
        commit();
        onEnter?.(); // …and the caller moves the caret on; no blur, so nothing is ever left nowhere
      }}
    />
  );
}

// --------------------------------------------------------------------------- //
// The read-only chapter stream — shared by the read view (chapter.tsx) and the
// yed chapter editor's read-only faces (linked previews, beyond-depth subchapters).
// --------------------------------------------------------------------------- //

/** One chapter's own stream — title, description, chunks, and subchapters, in SOURCE order — and,
 *  for each subchapter, the same thing again one level deeper (subchapter.tsx). `level` 0 is the
 *  page root; deeper levels wrap in a `<section>` that carries the indent, and their headings step
 *  down h1→h2→…→h6. `[n]` is each chunk's absolute entry index IN ITS OWN chapter, so a chunk
 *  shows the same number here as it does on that subchapter's own page — the number stays a
 *  stable citation either way. */
export function ChapterBody({
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
    if (f.kind === "data") {
      // a `!!yo` island: exempt from the chapter schema, drawn by the generic renderer —
      // still a numbered body element, so it keeps the [n] gutter and its anchor slot
      const link = asLink(f.value);
      const anchor = anchorOf(anchorBase, link?.path ?? "", childSlotId);
      return (
        <ChunkShell key={i} anchor={anchor} nodePath={link?.path} gutter={<ChunkGutter index={f.absIndex} anchor={anchor} />}>
          <DataChunk item={f.value} documentPath={documentPath} onNavigate={onNavigate} />
        </ChunkShell>
      );
    }
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
          renderLink={(p) => <SubchapterHeading {...p} onNavigate={onNavigate} />}
        />
      );
    }
    return (
      <ReadChunk
        key={i}
        index={f.absIndex}
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
export function ReadChunk({
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
  // its path continuation from the page root when it lives under it, else its render slot — an
  // inlined subchapter's chunks are addressed one way on a root page and the other on a subpage
  const anchor = anchorOf(anchorBase, chunk.path, slot);
  return (
    <ChunkShell anchor={anchor} nodePath={chunk.path} gutter={<ChunkGutter index={index} anchor={anchor} />}>
      {renderChunkBody(chunk, onNavigate)}
    </ChunkShell>
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
export function chunkOf(item: unknown, documentPath?: string): Chunk {
  const link = asLink(item);
  const value = link ? link.value : scalarValue(item); // peel an annotation overlay to the prose under it
  const inlineProse = !link && typeof value === "string";
  // an INLINED tagged container (a deeper fetch's $yamloverMixed marker) carries its format on
  // the marker — without it the registry cannot dispatch and the chunk prints "[object Object]"
  const mixedFormat = asMixed(item)?.format ?? null;
  return {
    value,
    path: link?.path ?? "",
    type: link?.type ?? "string",
    format: link?.format ?? mixedFormat ?? (inlineProse ? "text/marklower" : null),
    valueType: link?.valueType ?? "string",
    hasKeyed: link?.hasKeyed ?? false,
    hasOrdinal: link?.hasOrdinal ?? false,
    documentPath,
  };
}
