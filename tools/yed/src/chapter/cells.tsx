// THE CHAPTER CELLS, on the yed cell contract (Stage 7.5). One closed set of framed,
// captioned cells through the SHARED `Cell` wrapper — the y2-debug/y2-plain projection,
// active accents and the refusal ring are one CSS contract with the source editor.
//
// THE LAWS THIS LAYER KEEPS:
//   - cells hold NO state and NO grammar: state text is the single authority; single-line
//     cells are CONTROLLED <input>s; marklower prose is contentEditable reconciled from
//     state through an identity guard (rewrites happen exactly when the model diverged);
//   - printables are never intercepted — an unclaimed key runs natively, input/change
//     reports the text wholesale (commitText per keystroke; no commit-on-blur, no trim);
//   - focus is re-planted by a REF on every render, guarded by `document.activeElement`;
//     clicking reports the position with `caret: null` (the browser's caret stands);
//   - every position `chapterPositionsOf` yields has exactly one focusable cell, stamped
//     `data-at`/`data-path` (the positions law, asserted in DOM);
//   - refusal rings the active cell (`y2-refused`), localized state is the caption+badge.
//
// SOURCE chunks embed the standard yed EditorView with the SAME CellRegistry the source
// editor mounts (`adapter.sourceCells`) — a future math-formula editor registers new
// byFormat cells ONCE and appears in both projections. Server-only capabilities (marklower
// codec, read-only renderers, linked previews, image paste, anchors) arrive via the
// ChapterCellsAdapter; every one has a working default so the layer runs server-free.

import { createContext, useContext, useRef, useReducer, type ReactNode } from "react";
import type { EditorState, Entry, Node, Path, Value } from "../state";
import { isPointer } from "../../../parser/ts/src/ir.ts";
import { Cell, type CellRegistry } from "../cells";
import { defaultRegistry } from "../cells";
import { EditorView } from "../page";
import type { Position } from "../apply";
import type { ChapterState, SplitPayload } from "./apply";
import type { ChapterIntent, ChapterKey } from "./dispatch";
import type { ChapterEdges } from "./site";
import { chunkModeOf, explicitFormatOf, hasSelfValue, metaOf, type ChunkMode } from "./format";
import {
  applyCaret, caretAtEnd, caretAtStart, caretOnFirstLine, caretOnLastLine, caretVisibleOffset,
  placeCaretVisible, type ColumnMemory,
} from "./caret";

// ---------------------------------------------------------------------------- //
// The adapter — server capabilities, injected; defaults keep the layer standalone
// ---------------------------------------------------------------------------- //

export interface ProseCodec {
  toHtml(src: string): string;
  fromDom(el: HTMLElement): string;
  visibleLength(src: string): number;
}

/** Plain text as the codec — the debug/test default; the server injects marklower. */
export const plainCodec: ProseCodec = {
  toHtml: (src) => src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>"),
  fromDom: (el) => (el.textContent ?? ""),
  visibleLength: (src) => src.length,
};

export interface ChapterCellsAdapter {
  codec: ProseCodec;
  /** The source-chunk registry — THE extension seam shared with the source editor. */
  sourceCells?: CellRegistry;
  /** A read-only format's renderer face (csv, images, …); default: a labeled box. */
  renderReadonly?(node: Value, path: Path): ReactNode;
  /** A linked subchapter's inline preview; default: a descend heading. */
  renderLinked?(link: { path: string; title?: string; format?: string }, level: number, budget: number): ReactNode;
  /** Image paste into prose; default: none (paste stays text-only). */
  pasteFiles?(el: HTMLElement, range: Range, files: File[], commit: (text: string) => void): void;
  /** §N anchor ids (+ data-node-path); default: none. */
  anchorFor?(path: Path, index: number): string | null;
  navigate(path: string): void;
  columnMemory: ColumnMemory;
}

export interface ChapterCtxValue {
  state: ChapterState;
  debug: boolean;
  adapter: ChapterCellsAdapter;
  dispatch: (intent: ChapterIntent, split?: SplitPayload) => void;
  dispatchKey: (k: ChapterKey, edges?: ChapterEdges) => boolean;
  commitText: (path: Path, text: string) => void;
  boot: (path: Path, text: string) => void;
  focusTo: (pos: Position, caret?: ChapterState["caret"]) => void;
  graft: (path: Path, value: Value) => void;
  chapterPath: string;
}

export const ChapterCtx = createContext<ChapterCtxValue | null>(null);
export const useChapter = (): ChapterCtxValue => {
  const ctx = useContext(ChapterCtx);
  if (!ctx) throw new Error("ChapterCtx missing");
  return ctx;
};

export const CHAPTER_CELL_KINDS = ["title", "description", "prose", "item", "table", "cell", "latex", "source", "atom", "boot", "chapter"] as const;

// ---------------------------------------------------------------------------- //
// Shared helpers
// ---------------------------------------------------------------------------- //

const pathEq = (a: Path, b: Path | undefined): boolean =>
  !!b && a.length === b.length && a.every((s, i) => s === b[i]);
const scalarText = (v: Value): string => String((v as Node & { value?: unknown }).value ?? "");

const activeAt = (ctx: ChapterCtxValue, at: Position["at"], path: Path): boolean =>
  ctx.state.focus?.at === at && pathEq(path, ctx.state.focus?.path);

export function nodeAtPath(root: Value, path: Path): Node | null {
  const v = valueAtPath(root, path);
  return v === null || isPointer(v) ? null : (v as Node);
}
export function valueAtPath(root: Value, path: Path): Value | null {
  let v: Value = root;
  for (const i of path) {
    if (isPointer(v)) return null;
    const e = (v as Node).entries?.[i];
    if (!e) return null;
    v = e.value;
  }
  return v;
}

/** The SERVER path of the entry at `path` — keyed by `anchorKey` for born members. */
export function subchapterServerPath(doc: { root: Value }, basePath: string, path: Path): string {
  let v: Value = doc.root;
  let sp = basePath;
  for (const i of path) {
    if (isPointer(v)) return sp;
    const e = (v as Node).entries?.[i];
    if (!e) return sp;
    const anchorKey = ((e.meta ?? {}) as { anchorKey?: string }).anchorKey;
    sp = anchorKey !== undefined
      ? `${sp === ":" ? "" : sp}:${encodeURIComponent(anchorKey)}`
      : `${sp === ":" ? "" : sp}:${i}`; // a position is a bare-digit segment (YAML-keys round)
    v = e.value;
  }
  return sp;
}

/** The generic machine-key handler for single-line INPUT cells: edges from the selection,
 *  the column remembered before a vertical walk, preventDefault iff the machine claimed. */
function inputKeyDown(ctx: ChapterCtxValue, e: React.KeyboardEvent<HTMLInputElement>): void {
  const el = e.currentTarget;
  if (e.key === "ArrowUp" || e.key === "ArrowDown") ctx.adapter.columnMemory.remember();
  const claimed = ctx.dispatchKey(
    { key: e.ctrlKey && e.altKey && /^Digit[1-4]$/.test(e.code) ? e.code.slice(5) : e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey },
    { atStart: el.selectionStart === 0, atEnd: el.selectionEnd === el.value.length, firstLine: true, lastLine: true },
  );
  if (claimed) e.preventDefault();
}

/** A controlled single-line input cell (title / description / table cell) — active shows the
 *  input (ref-planted focus + caret), inactive a plain focusable text (typography intact). */
function LineCell({ kind, path, className, placeholder, block }: {
  kind: string; path: Path; className: string; placeholder?: string; block?: boolean;
}): ReactNode {
  const ctx = useChapter();
  const node = nodeAtPath(ctx.state.doc.root, path);
  const text = node ? scalarText(node) : "";
  const active = activeAt(ctx, "token", path);
  return (
    <Cell kind={kind} active={active} refused={ctx.state.refused} pos={{ at: "token", path }} block={block}>
      {active ? (
        <input
          className={`y2-input ${className}-input`}
          value={text}
          size={Math.max(1, text.length)} // the frame HUGS the content, like every yed cell
          placeholder={placeholder}
          ref={(el) => {
            if (el && document.activeElement !== el) {
              el.focus();
              const at = ctx.state.caret;
              if (at !== null) {
                const n = at === "end" ? el.value.length : at === "start" ? 0 : Math.min(Number(at), el.value.length);
                el.setSelectionRange(n, n);
              }
            }
          }}
          onChange={(e) => ctx.commitText(path, e.target.value)}
          onKeyDown={(e) => {
            // a table CELL's plain Enter splits at the caret — the cell starts hosting chunks
            if (kind === "cell" && e.key === "Enter" && !e.ctrlKey) {
              e.preventDefault();
              const el = e.currentTarget;
              ctx.dispatch({ kind: "splitProse" }, { head: el.value.slice(0, el.selectionStart ?? el.value.length), tail: el.value.slice(el.selectionEnd ?? el.value.length) });
              return;
            }
            inputKeyDown(ctx, e);
          }}
        />
      ) : (
        <span className={className} tabIndex={0} onFocus={() => ctx.focusTo({ at: "token", path }, null)}>
          {text === "" ? " " : text}
        </span>
      )}
    </Cell>
  );
}

// ---------------------------------------------------------------------------- //
// The document
// ---------------------------------------------------------------------------- //

/** The whole chapter page. `debug` is ONE class on this root — same DOM either way. */
export function ChapterDoc({ budget = Infinity }: { budget?: number }): ReactNode {
  const ctx = useChapter();
  return (
    <div className={(ctx.debug ? "y2-debug" : "y2-plain") + " chapter chapter-wysiwyg y2-chapter"} data-testid="yc-doc">
      <ChapterNode path={[]} spath={ctx.chapterPath} level={0} budget={budget} />
    </div>
  );
}

/** One chapter level: title, then entries in source order (description as the subtitle, other
 *  keyed fields skipped), the bootstrap slot when there is no body. Subchapters recurse in a
 *  framed `chapter` cell (the wrap badge is the LOCALIZED wrap state). */
export function ChapterNode({ path, spath, level, budget }: { path: Path; spath: string; level: number; budget: number }): ReactNode {
  const ctx = useChapter();
  const node = nodeAtPath(ctx.state.doc.root, path);
  if (!node) return null;
  const entries = node.entries ?? [];
  const body: ReactNode[] = [];
  entries.forEach((e, i) => {
    const p = [...path, i];
    const anchorKey = ((e.meta ?? {}) as { anchorKey?: string }).anchorKey;
    if (e.key === "description" && anchorKey === undefined) {
      body.push(<LineCell key={i} kind="description" path={p} className="chapter-subtitle" placeholder="Description" block />);
      return;
    }
    const mode = chunkModeOf(e.value);
    // the gutter label is the entry's yamlover ADDRESS: its key, or its absolute bare-digit index
    const label = e.key !== null && anchorKey === undefined ? e.key : String(i);
    if (mode === "chapter") {
      const sp = anchorKey !== undefined
        ? `${spath === ":" ? "" : spath}:${encodeURIComponent(anchorKey)}`
        : `${spath === ":" ? "" : spath}:${i}`; // a position is a bare-digit segment (YAML-keys round)
      const wrapped = metaOf(e.value).chapterWrapped === true;
      body.push(
        <Cell key={i} kind="chapter" active={false} refused={false} block
          badge={wrapped ? "wrapped" : anchorKey !== undefined ? "linked" : undefined}>
          {budget > 1 || wrapped ? (
            <section className="chapter-sub" data-chapter-path={sp}>
              <ChapterNode path={p} spath={sp} level={level + 1} budget={budget - 1} />
            </section>
          ) : (
            <DescendHeading path={sp} title={scalarText(e.value)} level={level + 1} />
          )}
        </Cell>,
      );
      return;
    }
    body.push(<ChunkCell key={i} path={p} index={i} label={label} mode={mode} level={level} budget={budget} />);
  });
  const hasBody = entries.some((e) => e.key !== "description" || ((e.meta ?? {}) as { anchorKey?: string }).anchorKey !== undefined);
  return (
    <>
      {hasSelfValue(node) && <TitleCell path={path} level={level} />}
      {body}
      {!hasBody && <BootCell path={path} />}
    </>
  );
}

const hx = (level: number): "h1" | "h2" | "h3" | "h4" | "h5" | "h6" =>
  (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[Math.min(level, 5)];

function TitleCell({ path, level }: { path: Path; level: number }): ReactNode {
  const H = hx(level);
  return (
    <H className="chapter-title">
      <LineCell kind="title" path={path} className="chapter-title-text" />
    </H>
  );
}

/** The collapsed subchapter face past the `?depth=` window — the descend heading. */
function DescendHeading({ path, title, level }: { path: string; title: string; level: number }): ReactNode {
  const ctx = useChapter();
  const H = hx(level);
  return (
    <section className="chapter-sub" data-chapter-path={path}>
      <H className="chapter-title">
        <span className="chapter-link-more" data-yo-chrome aria-hidden="true">»</span>
        <a className="descend" href="#" onClick={(e) => { e.preventDefault(); ctx.adapter.navigate(path); }}>{title || path}</a>
      </H>
    </section>
  );
}

// ---------------------------------------------------------------------------- //
// Chunks
// ---------------------------------------------------------------------------- //

/** The chunk skeleton — the gutter shows the entry's yamlover ADDRESS (`[i]`, or its key). */
function ChunkShell({ path, index, label, children }: { path: Path; index: number; label: string; children: ReactNode }): ReactNode {
  const ctx = useChapter();
  const anchor = ctx.adapter.anchorFor?.(path, index) ?? null;
  return (
    <div className="chunk" id={anchor ?? undefined}>
      {anchor ? <a className="chunk-index" href={`#${anchor}`}>{label}</a> : <span className="chunk-index">{label}</span>}
      <div className="chunk-body">{children}</div>
    </div>
  );
}

function ChunkCell({ path, index, label, mode, level, budget }: { path: Path; index: number; label: string; mode: ChunkMode; level: number; budget: number }): ReactNode {
  const inner =
    mode === "prose" ? <ProseCell path={path} /> :
    mode === "latex" ? <LatexCell path={path} /> :
    mode === "bullets" || mode === "numbered" ? <ListCell path={path} kind={mode} /> :
    mode === "table" ? <TableCell path={path} /> :
    mode === "source" ? <SourceCell path={path} /> :
    <AtomCell path={path} level={level} budget={budget} />;
  return <ChunkShell path={path} index={index} label={label}>{inner}</ChunkShell>;
}

/** Split a contentEditable at the caret into (head, tail) SOURCE texts via the codec. */
function splitAtCaret(el: HTMLElement, codec: ProseCodec): { head: string; tail: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.getRangeAt(0).endContainer)) return null;
  const caret = sel.getRangeAt(0);
  const cut = (which: "head" | "tail"): string => {
    const r = document.createRange();
    r.selectNodeContents(el);
    if (which === "head") r.setEnd(caret.endContainer, caret.endOffset);
    else r.setStart(caret.endContainer, caret.endOffset);
    const holder = document.createElement("div");
    holder.appendChild(r.cloneContents());
    return codec.fromDom(holder);
  };
  return { head: cut("head"), tail: cut("tail") };
}

/** The marklower prose cell: contentEditable, STATE-authoritative via the identity-guarded
 *  reconcile — a rewrite happens exactly when the model diverged from the DOM. */
export function ProseCell({ path, itemCell = false, placeholder }: { path: Path; itemCell?: boolean; placeholder?: string }): ReactNode {
  const ctx = useChapter();
  const codec = ctx.adapter.codec;
  const node = nodeAtPath(ctx.state.doc.root, path);
  const text = node ? scalarText(node) : "";
  const active = activeAt(ctx, "token", path);
  const composing = useRef(false);
  const pending = useRef(false);

  const reconcile = (el: HTMLElement | null): void => {
    if (!el) return;
    if (composing.current) { pending.current = true; return; }
    if (codec.fromDom(el) !== text) {
      const hadCaret = document.activeElement === el ? caretVisibleOffset(el) : null;
      el.innerHTML = codec.toHtml(text);
      if (hadCaret !== null && (!active || ctx.state.caret === null)) placeCaretVisible(el, hadCaret);
    }
    // THE FOCUS LAW: the active cell plants the caret, then CONSUMES the request — a plant
    // that lingered in state would re-fire on the next render and hijack mid-typing carets
    if (active && (document.activeElement !== el || ctx.state.caret !== null)) {
      const at = ctx.state.caret;
      applyCaret(el, at === null || at === "start" || at === "end" ? (at ?? "end") : codec.visibleLength(text.slice(0, Number(at))), ctx.adapter.columnMemory);
      if (at !== null) ctx.focusTo({ at: "token", path }, null); // consumed
    }
  };

  return (
    <Cell kind={itemCell ? "item" : "prose"} active={active} refused={ctx.state.refused} pos={{ at: "token", path }} block={!itemCell}>
      <p
        className="chapter-prose editable"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        ref={reconcile}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(e) => {
          composing.current = false;
          ctx.commitText(path, codec.fromDom(e.currentTarget));
          if (pending.current) { pending.current = false; reconcile(e.currentTarget); }
        }}
        onInput={(e) => { if (!composing.current) ctx.commitText(path, codec.fromDom(e.currentTarget)); }}
        onFocus={() => { if (!active) ctx.focusTo({ at: "token", path }, null); }}
        onCopy={(e) => {
          // the copy is the SOURCE, not the DOM face (atoms carry data-src)
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
          const holder = document.createElement("div");
          holder.appendChild(sel.getRangeAt(0).cloneContents());
          e.clipboardData.setData("text/plain", codec.fromDom(holder));
          e.preventDefault();
        }}
        onPaste={(e) => {
          const el = e.currentTarget;
          const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
          if (files.length === 0 || !ctx.adapter.pasteFiles) return;
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0 || !el.contains(sel.getRangeAt(0).endContainer)) return;
          e.preventDefault();
          ctx.adapter.pasteFiles(el, sel.getRangeAt(0).cloneRange(), files, (t) => ctx.commitText(path, t));
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
            e.preventDefault();
            const p = splitAtCaret(el, codec) ?? { head: codec.fromDom(el), tail: "" };
            ctx.dispatch({ kind: "splitProse" }, p);
            return;
          }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") ctx.adapter.columnMemory.remember();
          const claimed = ctx.dispatchKey(
            { key: e.ctrlKey && e.altKey && /^Digit[1-4]$/.test(e.code) ? e.code.slice(5) : e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey },
            { atStart: caretAtStart(el), atEnd: caretAtEnd(el), firstLine: caretOnFirstLine(el), lastLine: caretOnLastLine(el) },
          );
          if (claimed) e.preventDefault();
        }}
      />
    </Cell>
  );
}

/** The bootstrap paragraph — no entry exists until the first typed text, but it LOOKS like
 *  the prose chunk it is about to become (the same skeleton, the `[i]` it will take). */
function BootCell({ path }: { path: Path }): ReactNode {
  const ctx = useChapter();
  const active = ctx.state.focus?.at === "into" && pathEq(path, ctx.state.focus.path);
  const at = (nodeAtPath(ctx.state.doc.root, path)?.entries ?? []).length;
  return (
    <Cell kind="boot" active={active} refused={ctx.state.refused} pos={{ at: "into", path }} block>
      <div className="chunk">
        <span className="chunk-index">[{at}]</span>
        <div className="chunk-body">
          <p
            className="chapter-prose editable"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Write…"
            ref={(el) => { if (el && active && document.activeElement !== el) el.focus(); }}
            onFocus={() => { if (!active) ctx.focusTo({ at: "into", path }, null); }}
            onInput={(e) => {
              const t = ctx.adapter.codec.fromDom(e.currentTarget);
              if (t !== "") ctx.boot(path, t);
            }}
            onKeyDown={(e) => {
              // Ctrl+Enter falls through to the machine — on the boot cell it MATERIALIZES a table
              if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); ctx.dispatch({ kind: "splitProse" }, { head: "", tail: "" }); return; }
              const claimed = ctx.dispatchKey({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }, { atStart: true, atEnd: true, firstLine: true, lastLine: true });
              if (claimed) e.preventDefault();
            }}
          />
        </div>
      </div>
    </Cell>
  );
}

/** The LaTeX chunk — a CONTROLLED textarea over the raw source. */
function LatexCell({ path }: { path: Path }): ReactNode {
  const ctx = useChapter();
  const node = nodeAtPath(ctx.state.doc.root, path);
  const text = node ? scalarText(node) : "";
  const active = activeAt(ctx, "token", path);
  return (
    <Cell kind="latex" active={active} refused={ctx.state.refused} pos={{ at: "token", path }} block>
      <textarea
        className="chapter-latex-src editable"
        spellCheck={false}
        rows={Math.max(1, text.split("\n").length)}
        value={text}
        ref={(el) => {
          if (el && active && document.activeElement !== el) {
            el.focus();
            const at = ctx.state.caret;
            const n = at === "start" ? 0 : at === "end" || at === null ? el.value.length : Math.min(Number(at), el.value.length);
            el.setSelectionRange(n, n);
          }
        }}
        onChange={(e) => ctx.commitText(path, e.target.value)}
        onFocus={() => { if (!active) ctx.focusTo({ at: "token", path }, null); }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          const before = el.value.slice(0, el.selectionStart);
          const after = el.value.slice(el.selectionEnd);
          const collapsed = el.selectionStart === el.selectionEnd;
          if (e.key === "Enter") return; // a newline in the raw source — native
          if (e.key === "ArrowUp" || e.key === "ArrowDown") ctx.adapter.columnMemory.remember();
          const claimed = ctx.dispatchKey(
            { key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey },
            { atStart: el.selectionStart === 0, atEnd: el.selectionEnd === el.value.length, firstLine: collapsed && !before.includes("\n"), lastLine: collapsed && !after.includes("\n") },
          );
          if (claimed) e.preventDefault();
        }}
      />
    </Cell>
  );
}

/** A typographical list — items are prose cells (kind `item`); sublists inherit the kind. */
function ListCell({ path, kind }: { path: Path; kind: "bullets" | "numbered" }): ReactNode {
  const ctx = useChapter();
  const node = nodeAtPath(ctx.state.doc.root, path);
  if (!node) return null;
  const Tag = kind === "bullets" ? "ul" : "ol";
  return (
    <Tag className={`yl-list-${kind}`}>
      {(node.entries ?? []).map((e, i) => {
        if (e.key !== null) return null;
        const p = [...path, i];
        const item = e.value;
        const isCont = !isPointer(item) && ((item as Node).entries ?? []).length > 0;
        return (
          <li key={i}>
            {!isPointer(item) && (item as Node).kind === "scalar" && (
              <span className="chunk-inline"><ProseCell path={p} itemCell /></span>
            )}
            {isCont && <ListCell path={p} kind={kind} />}
          </li>
        );
      })}
    </Tag>
  );
}

/** The editable table — every cell a controlled input (kind `cell`); Tab walks the grid
 *  through the machine (cellWalk / appendRow). */
function TableCell({ path }: { path: Path }): ReactNode {
  const ctx = useChapter();
  const table = nodeAtPath(ctx.state.doc.root, path);
  if (!table) return null;
  const entries = table.entries ?? [];
  const title = entries.map((e, i) => ({ e, i })).find((x) => x.e.key === "title");
  const header = entries.map((e, i) => ({ e, i })).find((x) => x.e.key === "header");
  const rows = entries.map((e, i) => ({ e, i })).filter((x) => x.e.key === null && !isPointer(x.e.value));
  // NO SHAPE SPECIAL-CASES: a container row draws its entries as cells; a SCALAR row (the ▦
  // promote of a paragraph, a retagged list's item) is its own single cell — same table. A
  // cell that is itself a CONTAINER hosts the normal chapter flow (Enter split the cell).
  const cellsOf = (rowPath: Path, row: Value, Td: "td" | "th"): ReactNode => {
    if (!isPointer(row) && (row as Node).kind === "scalar" && ((row as Node).entries ?? []).length === 0) {
      return <Td key="self" colSpan={99}><LineCell kind="cell" path={rowPath} className="yl-cell" /></Td>;
    }
    return ((row as Node).entries ?? []).map((c, j) => {
      const cellPath = [...rowPath, j];
      const container = !isPointer(c.value) && ((c.value as Node).kind === "mapping" || ((c.value as Node).entries ?? []).length > 0);
      return (
        <Td key={j}>
          {container ? <CellChunks path={cellPath} /> : <LineCell kind="cell" path={cellPath} className="yl-cell" />}
        </Td>
      );
    });
  };
  // the + affordances show while the caret is IN the table (mousedown keeps it there)
  const focusPath = ctx.state.focus?.path ?? [];
  const inThisTable = focusPath.length > path.length && path.every((s, i) => focusPath[i] === s);
  return (
    <Cell kind="table" active={false} refused={false} block>
      <table className="yl-table csv-table">
        {title && <caption><LineCell kind="cell" path={[...path, title.i]} className="yl-cell" /></caption>}
        {header && <thead><tr>{cellsOf([...path, header.i], header.e.value, "th")}</tr></thead>}
        <tbody>
          {rows.map((r) => <tr key={r.i}>{cellsOf([...path, r.i], r.e.value, "td")}</tr>)}
        </tbody>
      </table>
      {inThisTable && (
        <span className="yl-table-tools" data-yo-chrome>
          <button type="button" className="yl-table-add" title="add a row"
            onMouseDown={(e) => { e.preventDefault(); ctx.dispatch({ kind: "appendRow" }); }}>+ row</button>
          <button type="button" className="yl-table-add" title="add a column"
            onMouseDown={(e) => { e.preventDefault(); ctx.dispatch({ kind: "appendColumn" }); }}>+ col</button>
        </span>
      )}
    </Cell>
  );
}

/** A container table cell hosts the normal chapter flow — its keyless entries are ordinary
 *  prose chunks (the row-cell→chapter fold makes their grammar the chapter's). */
function CellChunks({ path }: { path: Path }): ReactNode {
  const ctx = useChapter();
  const node = nodeAtPath(ctx.state.doc.root, path);
  if (!node) return null;
  return (
    <div className="yl-cell-chapter">
      {(node.entries ?? []).map((e, k) => (e.key === null ? <ProseCell key={k} path={[...path, k]} itemCell /> : null))}
    </div>
  );
}

/** A SOURCE chunk: the standard yed EditorView over the subtree, with the SHARED registry
 *  (adapter.sourceCells) — the future math cells' plug point. Edits graft back and persist
 *  through the same diff. */
function SourceCell({ path }: { path: Path }): ReactNode {
  const ctx = useChapter();
  const node = valueAtPath(ctx.state.doc.root, path)!;
  const subRef = useRef<EditorState | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  if (!subRef.current || subRef.current.doc.root !== node) {
    subRef.current = {
      doc: { root: node, source: { concrete: "yamlover", uri: ctx.chapterPath } } as EditorState["doc"],
      cursor: { at: "hole", path: [], index: 0, text: "", key: null } as EditorState["cursor"],
      refused: false,
      log: [],
    };
  }
  const sub = subRef.current;
  const focused = activeAt(ctx, "token", path) || ctx.state.focus?.at === "ptr" && pathEq(path, ctx.state.focus.path);
  return (
    <Cell kind="source" active={focused} refused={false} pos={{ at: "token", path }} block>
      <div
        className="chunk-source"
        onFocusCapture={() => { if (!focused) ctx.focusTo({ at: "token", path }, null); }}
      >
        <EditorView
          state={sub}
          setState={(next) => {
            const changed = next.doc.root !== subRef.current!.doc.root;
            subRef.current = next;
            force();
            if (changed) ctx.graft(path, next.doc.root as Value);
          }}
          debug={false}
          cells={ctx.adapter.sourceCells ?? defaultRegistry}
        />
      </div>
    </Cell>
  );
}

/** One focusable stop for non-editable content — links, binaries, read-only formats. */
function AtomCell({ path, level, budget }: { path: Path; level: number; budget: number }): ReactNode {
  const ctx = useChapter();
  const v = valueAtPath(ctx.state.doc.root, path);
  const active = activeAt(ctx, "ptr", path);
  const link = v !== null && !isPointer(v) ? metaOf(v).link : undefined;
  const pointerTarget = v !== null && isPointer(v) ? String((v as { raw?: string }).raw ?? "") : null;
  const target = link?.path ?? pointerTarget;
  const face = ((): ReactNode => {
    if (link !== undefined && ctx.adapter.renderLinked) return ctx.adapter.renderLinked(link, level, budget);
    if (target !== null) return <DescendHeading path={target} title={link?.title ?? target} level={level + 1} />;
    if (v !== null && ctx.adapter.renderReadonly) return ctx.adapter.renderReadonly(v, path);
    const label = v !== null ? explicitFormatOf(v) ?? "linked content" : "linked content";
    return <p className="chapter-prose chapter-readonly-block" data-yo-chrome>[{label}]</p>;
  })();
  return (
    <Cell kind="atom" active={active} refused={ctx.state.refused} pos={{ at: "ptr", path }} block>
      <span
        className="y2-atomslot"
        tabIndex={0}
        ref={(el) => { if (el && active && document.activeElement !== el) el.focus(); }}
        onFocus={() => { if (!active) ctx.focusTo({ at: "ptr", path }, null); }}
        onKeyDown={(e) => {
          const claimed = ctx.dispatchKey({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }, { atStart: true, atEnd: true, firstLine: true, lastLine: true });
          if (claimed) e.preventDefault();
        }}
      >
        {face}
      </span>
    </Cell>
  );
}
