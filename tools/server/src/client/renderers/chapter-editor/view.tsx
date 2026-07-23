// The CHAPTER projection of the projectional editor: the same model host.ts drives for the source
// view, drawn as prose, headings, sections and lists instead of token rows. Enter makes a sibling
// paragraph (THE PROSE EXCEPTION), Tab nests it into the previous block — a subchapter, or a list
// item — and Shift-Tab lifts it out; the structural moves are the shared indentEntry/dedentEntry.
// A block's format is chosen from the bar or Ctrl+Alt+1..4 (Ctrl+1..9 is browser-reserved).
//
// Behind a flag for now (chapterEditorFlavor): the flat ChapterEditor keeps running until this
// reaches parity, so nothing regresses while it grows.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useYedHost, type FocusAt, type YedHost } from "../yamlover-editor/host";
import * as M from "../yamlover-editor/model";
import type { Edit } from "../../api";
import { MarklowerChunkEditor } from "../chunk-editors";
import { markupWidthCh } from "../markup";
import { anchorOf, childSlot } from "../chapter-model";
import { focusEnd } from "../caret";
import { formatOfNode, type ChosenFormat } from "./format";
import { formatTarget } from "./tab";
import { commitProse, createDescription, joinProse, promoteFormat, splitProse, tabEdits } from "./blocks";
import { clearFormatBus, publishFormatBus, useFormatBus } from "./format-bus";

/** A pending caret placement — which model node to focus, and where. */
interface Focus { id: string; at: FocusAt }

/** True for a node the projection edits as PROSE — an inlined scalar chunk. */
const isProse = (node: M.MNode): boolean => node.kind === "scalar";

/** Everything a cell needs from the projection, so the tree passes ONE value instead of six props. */
interface Proj {
  host: YedHost;
  focus: Focus | null;
  clearFocus: () => void;
  /** Run a block mutation: step (mutate + enqueue ops), then take the caret where it says. */
  run: (produce: (root: M.MNode) => { edits: Edit[]; focus?: Focus } | null) => void;
  /** Tab / Shift-Tab on the block owned by `entryId` — one dispatch for prose cells and
   *  subchapter titles alike (tab.ts decides; the caret follows the moved block). */
  tabRun: (entryId: string, shift: boolean) => void;
  /** The entry the caret is in — the format bar's target. */
  setActive: (entryId: string | null) => void;
  onNavigate: (p: string) => void;
}
const ProjCtx = createContext<Proj | null>(null);
const useProj = (): Proj => useContext(ProjCtx)!;

export function ChapterProjection({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const host = useYedHost(path, onNavigate);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !host.root) return;
    opened.current = true;
    setFocus({ id: host.root.id, at: "start" }); // the root's self-value cell = the title; write with no click
  }, [host.root]);

  const run: Proj["run"] = (produce) => {
    let next: Focus | undefined;
    host.step((r) => {
      const out = produce(r);
      next = out?.focus;
      return out?.edits ?? [];
    });
    if (next) setFocus(next);
  };

  /** Set the active block's format. Ctrl+Alt+1..4 and the bar both land here. */
  const choose = (fmt: ChosenFormat) => {
    if (!active) return;
    run((r) => {
      const targetId = formatTarget(r, active);
      if (!targetId) return { edits: [] };
      const rootTag = r.metaTag;
      return { edits: promoteFormat(host.path, r, targetId, fmt, rootTag) };
    });
  };

  const tabRun: Proj["tabRun"] = (entryId, shift) => {
    run((r) => {
      const t = tabEdits(host.path, r, entryId, shift);
      if (t.intent.kind === "cell" || t.intent.kind === "nop") return { edits: [] };
      return { edits: t.edits, focus: t.focusId ? { id: t.focusId, at: "end" } : undefined };
    });
  };

  const proj: Proj = { host, focus, clearFocus: () => setFocus(null), run, tabRun, setActive, onNavigate };

  // Publish the format state to the MAIN node-bar (the renderer's config slot renders
  // ChapterFormatControl, which reads this) — one toolbar, not two. Cleared on unmount.
  useEffect(() => {
    publishFormatBus({
      mounted: true,
      active: !!active,
      current: active && host.rootRef.current ? currentFormat(host.rootRef.current, active) : null,
      choose,
    });
  });
  useEffect(() => clearFormatBus, []);

  if (!host.root) return <div className="chapter chapter-wysiwyg">…</div>;
  return (
    <ProjCtx.Provider value={proj}>
      <div
        className="chapter chapter-wysiwyg"
        // the same reading width as the read view — editing must not reflow the text
        style={{ maxWidth: `${markupWidthCh()}ch` }}
        ref={host.rootEl}
        onKeyDown={(e) => {
          // Ctrl+Alt+1..4 chooses the block format (Ctrl+1..9 is a browser tab shortcut a page
          // cannot intercept). `e.code` reads the digit through Alt's dead keys on macOS.
          if (!(e.ctrlKey && e.altKey)) return;
          const n = { Digit1: "chapter", Digit2: "table", Digit3: "bullets", Digit4: "numbered" }[e.code] as ChosenFormat | undefined;
          if (!n) return;
          e.preventDefault();
          choose(n);
        }}
      >
        <ChapterNode node={host.root} nodePath={host.path} level={0} />
      </div>
    </ProjCtx.Provider>
  );
}

/** The block-format buttons, docked in the MAIN node-bar (the chapter renderer's `config` slot) —
 *  they act on the projectional editor's focused block through the format bus, and vanish when no
 *  such editor is mounted. */
export function ChapterFormatControl() {
  const { mounted, active, current, choose } = useFormatBus();
  if (!mounted) return null;
  const btn = (fmt: ChosenFormat, glyph: string, title: string) => (
    <button
      type="button"
      className={"fmt-btn" + (current === fmt ? " active" : "")}
      title={`${title} (Ctrl+Alt+${{ chapter: 1, table: 2, bullets: 3, numbered: 4 }[fmt]})`}
      disabled={!active}
      // mousedown, not click: a click would blur the caret cell first, losing the active block
      onMouseDown={(e) => { e.preventDefault(); choose(fmt); }}
    >{glyph}</button>
  );
  return (
    <span className="fmt-group" data-yo-chrome>
      {btn("chapter", "¶", "Normal")}
      {btn("bullets", "•", "Bullets")}
      {btn("numbered", "1.", "Numbered")}
      {btn("table", "▦", "Table")}
    </span>
  );
}

/** The format the bar should show ACTIVE for the entry the caret is in — the format of the block
 *  the format command would target (formatTarget). */
function currentFormat(root: M.MNode, entryId: string): ChosenFormat | null {
  const targetId = formatTarget(root, entryId);
  const node = targetId ? M.findNode(root, targetId)?.node : null;
  if (!node) return null;
  const f = formatOfNode(node);
  return f === "table" || f === "bullets" || f === "numbered" ? f : "chapter";
}

/** One chapter (the document root, or a subchapter) — its title, then its body. The SAME editor at
 *  every level, indented: title, description, body — title and description are OPTIONAL, so their
 *  cells exist (as placeholders) before the model does and are born from the first committed text.
 *  `entryId` is the subchapter's own entry — Tab/Shift-Tab on its TITLE moves the whole subchapter. */
function ChapterNode({ node, nodePath, level, entryId }: { node: M.MNode; nodePath: string; level: number; entryId?: string }) {
  const proj = useProj();
  const { host, focus, clearFocus, run, tabRun } = proj;
  const Heading = `h${Math.min(level + 1, 6)}` as "h1";
  const hasDesc = node.entries.some((e) => e.key === "description");
  const descKey = node.id + ":desc";
  return (
    <>
      <HeadingCell
        as={Heading}
        className="chapter-title"
        placeholder={level === 0 ? "Title" : "Subchapter title"}
        value={String(node.selfValue?.value ?? "")}
        focusNow={focus?.id === node.id}
        onFocused={clearFocus}
        onCommit={(t) => run((r) => ({ edits: setSelf(host.path, r, node.id, t) }))}
        onEnter={() => run((r) => {
          // Enter walks title → description → the body
          const found = M.findNode(r, node.id);
          const desc = (found?.node ?? r).entries.find((e) => e.key === "description");
          if (desc) return { edits: [], focus: { id: desc.node.id, at: "end" } };
          return { edits: [], focus: { id: descKey, at: "end" } };
        })}
        onTab={entryId ? (shift) => tabRun(entryId, shift) : undefined}
      />
      {!hasDesc && (
        <HeadingCell
          as="p"
          className="chapter-subtitle"
          placeholder="Description"
          value=""
          focusNow={focus?.id === descKey}
          onFocused={clearFocus}
          onCommit={(t) => { if (t) run((r) => createDescription(host.path, r, node.id, t)); }}
          onEnter={() => run((r) => firstBodyFocus(host.path, r, node.id))}
        />
      )}
      <BlockBody node={node} nodePath={nodePath} level={level} />
    </>
  );
}

/** A container's body entries rendered as blocks — shared by a chapter and a list item. Chunks
 *  carry the same `§N` gutter as the read view (numbering restarts per chapter, subchapters
 *  consume no number), so the page reads identically locked and unlocked. */
function BlockBody({ node, nodePath, level }: { node: M.MNode; nodePath: string; level: number }) {
  const proj = useProj();
  const out: JSX.Element[] = [];
  let chunkNo = 0;
  node.entries.forEach((entry, i) => {
    if (entry.key === "description") {
      out.push(<DescriptionCell key={entry.id} entry={entry} node={node} />);
      return;
    }
    if (entry.key !== null) return; // other keyed fields are not body content
    const child = entry.node;
    const childPath = pathOf(proj.host, nodePath, node, i);
    const anchor = anchorOf(proj.host.path, childPath, childSlot("", i));
    if (isProse(child)) {
      out.push(<ProseCell key={entry.id} entry={entry} index={chunkNo++} anchor={anchor} />);
      return;
    }
    if (child.kind === "container") {
      const f = formatOfNode(child);
      if (f === "bullets" || f === "numbered") {
        out.push(
          <div key={entry.id} className="chunk" id={anchor || undefined}>
            <ChunkNo index={chunkNo++} anchor={anchor} />
            <div className="chunk-body"><ListNode node={child} nodePath={childPath} kind={f} /></div>
          </div>,
        );
        return;
      }
      if (f === "chapter") {
        out.push(
          <section key={entry.id} className="chapter-sub" data-chapter-path={childPath}>
            <ChapterNode node={child} nodePath={childPath} level={level + 1} entryId={entry.id} />
          </section>,
        );
        return;
      }
    }
    // a tagged table, a pointer, or a binary chunk — read-only in this projection for now
    out.push(<ReadOnlyBlock key={entry.id} node={child} path={childPath} index={chunkNo++} anchor={anchor} />);
  });
  return <>{out}</>;
}

/** The `§N` gutter — the same in-page anchor link the read view draws. */
function ChunkNo({ index, anchor }: { index: number; anchor: string }) {
  return anchor ? (
    <a className="chunk-index" href={`#${anchor}`}>§{index}</a>
  ) : (
    <span className="chunk-index">§{index}</span>
  );
}

/** An editable typographical list: <ul>/<ol> whose items are prose (or a nested sublist). Tab in an
 *  item nests it — the SAME move as a subchapter, since an untagged nested container inherits the
 *  list's kind (blocks.ts / MARKLOWER.md). */
function ListNode({ node, nodePath, kind }: { node: M.MNode; nodePath: string; kind: "bullets" | "numbered" }) {
  const proj = useProj();
  const Tag = kind === "numbered" ? "ol" : "ul";
  return (
    <Tag className={`yl-list yl-list-${kind}`}>
      {node.entries.map((entry, i) => {
        if (entry.key !== null) return null;
        const child = entry.node;
        const childPath = pathOf(proj.host, nodePath, node, i);
        return (
          <li key={entry.id} data-node-path={childPath}>
            {isProse(child) ? (
              <ProseCell entry={entry} tag="span" />
            ) : child.kind === "container" ? (
              // an omni item — its OWN text (the container's self-value) above its nested SUBLIST,
              // which inherits this list's kind unless the item carries an explicit tag of its own
              <>
                {child.selfValue != null && <ProseCell entry={entry} tag="span" />}
                <ListNode node={child} nodePath={childPath} kind={sublistKind(child, kind)} />
              </>
            ) : (
              <ReadOnlyBlock node={child} path={childPath} />
            )}
          </li>
        );
      })}
    </Tag>
  );
}

/** A nested list item's kind: its own tag if it carries one, else the parent list's (the any-depth
 *  inheritance rule, MARKLOWER.md). */
function sublistKind(node: M.MNode, parent: "bullets" | "numbered"): "bullets" | "numbered" {
  const f = formatOfNode(node);
  return f === "bullets" || f === "numbered" ? f : parent;
}

/** A prose paragraph — the shared marklower editor, wrapped so Tab nests it and focus tracks the
 *  active block. `tag` is the wrapper element (a `div.chunk` in a chapter, a bare span in a list
 *  item, so the <li> marker stays on one line). */
function ProseCell({ entry, tag = "chunk", index, anchor }: { entry: M.MEntry; tag?: "chunk" | "span"; index?: number; anchor?: string }) {
  const proj = useProj();
  const { host, focus, clearFocus, run, setActive } = proj;
  const node = entry.node;
  // a container entry standing in for its self-value (a list item's own text) edits the self-value
  const self = node.kind === "container";
  const text = String((self ? node.selfValue?.value : node.scalar?.value) ?? "");
  const focusAt: FocusAt | null = focus?.id === node.id ? focus.at : null;
  const commit = (t: string): Edit[] =>
    self ? setSelf(host.path, host.rootRef.current!, node.id, t, /* asSelfValue */ true) : commitProse(host.path, host.rootRef.current!, node.id, t);

  const inner = (
    <MarklowerChunkEditor
      text={text}
      rev={node.rev}
      chapterPath={host.path}
      focusAt={focusAt}
      placeholder={tag === "span" ? "List item" : "Write…"}
      onFocused={clearFocus}
      onChangeText={(t) => run(() => ({ edits: commit(t) }))}
      onSplit={(head, tail) => run((r) => {
        // the CARET must follow the tail — a split whose focus stays behind piles empty
        // paragraphs up after the still-focused cell (the reported malfunction)
        const out = splitProse(host.path, r, entry.id, head, tail);
        return out && { edits: out.edits, focus: { id: out.focusId, at: "start" as const } };
      })}
      onArrowOut={() => { /* caret walk between paragraphs — a later refinement */ }}
      onJoinPrev={() => run((r) => {
        const out = joinProse(host.path, r, entry.id, "prev", isProse);
        return out && { edits: out.edits, focus: { id: out.focusId, at: out.caret } };
      })}
      onJoinNext={() => run((r) => {
        const out = joinProse(host.path, r, entry.id, "next", isProse);
        return out && { edits: out.edits, focus: { id: out.focusId, at: out.caret } };
      })}
    />
  );
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    proj.tabRun(entry.id, e.shiftKey);
  };
  const onFocus = () => setActive(entry.id);

  if (tag === "span") return <span className="chunk-inline" onKeyDownCapture={onKeyDownCapture} onFocus={onFocus}>{inner}</span>;
  return (
    <div className="chunk" id={anchor || undefined} onKeyDownCapture={onKeyDownCapture} onFocus={onFocus}>
      {index !== undefined && <ChunkNo index={index} anchor={anchor ?? ""} />}
      <div className="chunk-body">{inner}</div>
    </div>
  );
}

/** The chapter's description — an editable subtitle. */
function DescriptionCell({ entry, node }: { entry: M.MEntry; node: M.MNode }) {
  const proj = useProj();
  const { host, focus, clearFocus, run, setActive } = proj;
  return (
    <HeadingCell
      as="p"
      className="chapter-subtitle"
      placeholder="Description"
      value={String(entry.node.scalar?.value ?? "")}
      focusNow={focus?.id === entry.node.id}
      onFocused={clearFocus}
      onFocus={() => setActive(entry.id)}
      onCommit={(t) => run((r) => ({ edits: commitProse(host.path, r, entry.node.id, t) }))}
      onEnter={() => run((r) => firstBodyFocus(host.path, r, node.id))}
    />
  );
}

/** A single-line editable heading (title / subtitle). Uncontrolled, reset on `value` while
 *  unfocused; Enter HANDS THE CARET ON via `onEnter` rather than blurring to nowhere. */
function HeadingCell({
  as, value, onCommit, className, placeholder, focusNow, onFocused, onEnter, onFocus, onTab,
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
}) {
  const ref = useRef<HTMLElement>(null);
  const focused = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  const Tag = as;
  useEffect(() => {
    if (ref.current && !focused.current) ref.current.textContent = value;
  }, [value]);
  useEffect(() => {
    if (!focusNow || !ref.current) return;
    focusEnd(ref.current);
    onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNow]);
  // Commit ONLY when the text actually changed. A blur fires whenever the caret moves anywhere
  // else (every Enter walk, every split), and an unchanged commit is not free here: each one
  // emits a real op into the queue.
  const commitIfChanged = () => {
    const t = (ref.current?.textContent ?? "").trim();
    if (t !== latest.current) onCommit(t);
  };
  return (
    <Tag
      ref={ref as React.Ref<never>}
      className={(className ? className + " " : "") + "editable"}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onFocus={() => { focused.current = true; onFocus?.(); }}
      onBlur={() => { focused.current = false; commitIfChanged(); }}
      onKeyDown={(e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          onTab?.(e.shiftKey);
          return;
        }
        if (e.key !== "Enter") return;
        e.preventDefault();
        focused.current = false;
        commitIfChanged();
        onEnter?.();
      }}
    />
  );
}

/** A block this projection does not yet edit inline — a tagged table (Stage 7), a `*` pointer, or a
 *  binary chunk. Shown read-only so it is not lost; navigable when it is a link. */
function ReadOnlyBlock({ node, path, index, anchor }: { node: M.MNode; path: string; index?: number; anchor?: string }) {
  const { onNavigate } = useProj();
  const gutter = index !== undefined ? <ChunkNo index={index} anchor={anchor ?? ""} /> : null;
  if (node.kind === "pointer" || node.kind === "link") {
    const target = node.kind === "pointer" ? node.pointer?.refPath : node.link?.path;
    const text = node.kind === "pointer" ? "*" + (node.pointer?.raw ?? "") : node.link?.title ?? node.link?.path ?? path;
    return (
      <div className="chunk" id={anchor || undefined}>{gutter}<div className="chunk-body">
        <a className="descend" href={target ?? "#"} onClick={(e) => { e.preventDefault(); if (target) onNavigate(target); }}>{text}</a>
      </div></div>
    );
  }
  const label = formatOfNode(node); // table
  return (
    <div className="chunk" id={anchor || undefined}>{gutter}<div className="chunk-body">
      <p className="chapter-prose chapter-readonly-block" data-yo-chrome>[{label} — edit in the source view for now]</p>
    </div></div>
  );
}

// --- helpers ----------------------------------------------------------------------------------- //

/** Commit a chapter TITLE (`asSelfValue` false) or a list item's OWN text (a container's
 *  self-value, `asSelfValue` true) — both are the node's self-value; an empty string drops it. */
function setSelf(rootPath: string, root: M.MNode, nodeId: string, text: string, _asSelfValue = false): Edit[] {
  const scalar = text ? { src: JSON.stringify(text), value: text } : null; // one line — quote it
  return M.setSelfValue(rootPath, root, nodeId, scalar);
}

/** Enter out of a heading: focus the first editable body paragraph, making an empty one when the
 *  chapter has none — so a fresh chapter is title → writing, no dead end and nothing to click. */
function firstBodyFocus(rootPath: string, root: M.MNode, nodeId: string): { edits: Edit[]; focus?: Focus } {
  const found = M.findNode(root, nodeId);
  const node = found?.node ?? root;
  const firstProse = node.entries.find((e) => e.key === null && isProse(e.node));
  if (firstProse) return { edits: [], focus: { id: firstProse.node.id, at: "start" } };
  const entry: M.MEntry = {
    id: M.nid(), key: null, decided: true, committed: true,
    node: { id: M.nid(), rev: 0, kind: "scalar", scalar: { src: '""', value: "" }, entries: [], selfAt: 0, metaTag: null, setTag: false },
  };
  node.entries.push(entry);
  const at = M.serverIndexOf(node, node.entries.length - 1);
  const contPath = found?.spine ? M.pathOfSpine(rootPath, found.spine) : rootPath;
  return {
    edits: [{ path: `${contPath === ":" ? "" : contPath}[${at}]`, op: "insert", yamlover: '""' }],
    focus: { id: entry.node.id, at: "start" },
  };
}

/** The node path of a container's `i`-th entry. */
function pathOf(host: YedHost, containerPath: string, container: M.MNode, i: number): string {
  const found = M.findNode(host.rootRef.current!, container.entries[i].node.id);
  return found?.spine ? M.pathOfSpine(host.path, found.spine) : `${containerPath === ":" ? "" : containerPath}[${i}]`;
}

