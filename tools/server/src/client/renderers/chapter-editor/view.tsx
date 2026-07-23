// The CHAPTER projection of the projectional editor: the same model host.ts drives for the source
// view, drawn as prose, headings, sections and lists instead of token rows. Enter makes a sibling
// paragraph (THE PROSE EXCEPTION); Tab makes the CURRENT chunk a subchapter title and Shift-Tab
// unmakes it (tab.ts); Up/Down walk the caret between cells. A block's format is chosen from the
// bar or Ctrl+Alt+1..4 (Ctrl+1..9 is browser-reserved), and the bar's T / D buttons make the
// focused chunk the chapter's title / description — there are NO placeholder cells for either,
// since both are optional.
//
// Behind a flag for now (chapterEditorFlavor): the flat ChapterEditor keeps running until this
// reaches parity, so nothing regresses while it grows.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useYedHost, type FocusAt, type YedHost } from "../yamlover-editor/host";
import * as M from "../yamlover-editor/model";
import type { Edit } from "../../api";
import { MarklowerChunkEditor } from "../chunk-editors";
import { markupWidthCh } from "../markup";
import { anchorOf, childSlot, CHAPTER_META, isSubchapter } from "../chapter-model";
import { focusEnd, focusStart } from "../caret";
import { enclosingFormat, formatOfNode, type ChosenFormat } from "./format";
import { formatTarget } from "./tab";
import {
  commitProse, createFirstChunk, demoteDescription, demoteTitle, joinProse, makeDescription,
  makeTitle, promoteFormat, splitProse, tabEdits,
} from "./blocks";
import { clearFormatBus, publishFormatBus, useFormatBus, type RoleState } from "./format-bus";

/** A pending caret placement — which model node to focus, and where. */
interface Focus { id: string; at: FocusAt }

/** The cell the caret is in: a body entry, and — when it is a title cell — the titled node (the
 *  title has no entry of its own; `entryId` is then the subchapter's, or null at the root). */
interface Active { entryId: string | null; titleOf?: string }

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
  /** The cell the caret is in — the format bar's target. */
  setActive: (a: Active | null) => void;
  onNavigate: (p: string) => void;
}
const ProjCtx = createContext<Proj | null>(null);
const useProj = (): Proj => useContext(ProjCtx)!;

export function ChapterProjection({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const host = useYedHost(path, onNavigate);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !host.root) return;
    opened.current = true;
    // write with no click: the first cell that EXISTS — title, description, first paragraph, or
    // the bootstrap cell of a still-empty chapter
    const r = host.root;
    const desc = r.entries.find((e) => e.key === "description");
    const prose = r.entries.find((e) => e.key === null && isProse(e.node));
    const id = r.selfValue ? r.id : desc ? desc.node.id : prose ? prose.node.id : r.id + ":boot";
    setFocus({ id, at: "start" });
  }, [host.root]);

  const run: Proj["run"] = (produce) => {
    let next: Focus | undefined;
    host.step((r) => {
      const out = produce(r);
      next = out?.focus;
      const edits = out?.edits ?? [];
      // A formerly PLAIN folder being written as a chapter (the offered tab): the first batch that
      // actually says anything also stamps the document `!!<*::yamlover:$defs:chapter>` — that tag
      // is what makes the TOC show subchapters (not every chunk) and the read view lay them out.
      // Never a re-stamp (an already-tagged chapter/task keeps its own schema), and never on a
      // batch of zero ops, so merely opening — or a byte-neutral Tab — still writes nothing.
      if (edits.length && r.metaTag == null && !isSubchapter(r.format ?? null)) {
        r.metaTag = CHAPTER_META;
        r.metaOnServer = true;
        edits.unshift({ path: host.path, op: "emplace", meta: CHAPTER_META });
      }
      return edits;
    });
    if (next) setFocus(next);
  };

  /** Set the active block's format. Ctrl+Alt+1..4 and the bar both land here. */
  const choose = (fmt: ChosenFormat) => {
    if (!active?.entryId) return;
    const entryId = active.entryId;
    run((r) => {
      const targetId = formatTarget(r, entryId);
      if (!targetId) return { edits: [] };
      const rootTag = r.metaTag;
      return { edits: promoteFormat(host.path, r, targetId, fmt, rootTag) };
    });
  };

  /** Toggle a role (title / description) on the focused cell — the bar's T / D buttons. */
  const applyRole = (role: "title" | "desc") => {
    run((r) => {
      const roles = rolesOf(r, active);
      let out: { edits: Edit[]; focusId: string } | null = null;
      if (role === "title") {
        if (roles.title === "is" && active?.titleOf) out = demoteTitle(host.path, r, active.titleOf);
        else if (roles.title === "can" && active?.entryId) out = makeTitle(host.path, r, active.entryId);
      } else {
        if (roles.desc === "is" && active?.entryId) out = demoteDescription(host.path, r, active.entryId);
        else if (roles.desc === "can" && active?.entryId) out = makeDescription(host.path, r, active.entryId);
      }
      return out && { edits: out.edits, focus: { id: out.focusId, at: "end" as const } };
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
    const r = host.rootRef.current;
    publishFormatBus({
      mounted: true,
      active: !!active?.entryId,
      current: active?.entryId && r ? currentFormat(r, active.entryId) : null,
      choose,
      roles: r ? rolesOf(r, active) : { title: null, desc: null },
      applyRole,
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
 *  such editor is mounted. T / D toggle the title / description role on the focused chunk. */
export function ChapterFormatControl() {
  const { mounted, active, current, choose, roles, applyRole } = useFormatBus();
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
  const role = (r: "title" | "desc", glyph: string, name: string) => (
    <button
      type="button"
      className={"fmt-btn" + (roles[r] === "is" ? " active" : "")}
      title={`${name} — make this chunk the ${name.toLowerCase()}; on the ${name.toLowerCase()} itself, unmake it`}
      disabled={roles[r] === null}
      onMouseDown={(e) => { e.preventDefault(); applyRole(r); }}
    >{glyph}</button>
  );
  return (
    <span className="fmt-group" data-yo-chrome>
      {btn("chapter", "¶", "Normal")}
      {btn("bullets", "•", "Bullets")}
      {btn("numbered", "1.", "Numbered")}
      {btn("table", "▦", "Table")}
      {role("title", "T", "Title")}
      {role("desc", "D", "Description")}
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

/** What the T / D buttons would do to the focused cell (blocks.ts performs it). A one-line chunk
 *  in a chapter CAN take a role its chapter does not have yet; the title / description cells ARE
 *  theirs, and the buttons toggle them back off. */
function rolesOf(root: M.MNode, active: Active | null): { title: RoleState; desc: RoleState } {
  const none = { title: null, desc: null };
  if (!active) return none;
  if (active.titleOf) return { title: "is", desc: null };
  if (!active.entryId) return none;
  const spine = M.findEntry(root, active.entryId);
  if (!spine) return none;
  if (spine.entry.key === "description") return { title: null, desc: "is" };
  if (spine.entry.key !== null) return none;
  const node = spine.entry.node;
  if (node.kind !== "scalar" || node.scalar?.block || String(node.scalar?.value ?? "").includes("\n")) return none;
  if (enclosingFormat(root, active.entryId) !== "chapter") return none; // list items and cells have no title
  const { container } = spine.parents[spine.parents.length - 1];
  return {
    title: container.selfValue || container.flow ? null : "can",
    desc: container.entries.some((e) => e.key === "description") ? null : "can",
  };
}

/** One chapter (the document root, or a subchapter) — its title, then its body. The SAME editor at
 *  every level, indented. Title and description are OPTIONAL and have NO placeholder cells: a cell
 *  exists only when the model does, and any chunk becomes one via the bar's T / D buttons. An
 *  empty chapter renders one bootstrap paragraph so there is always somewhere to type.
 *  `entryId` is the subchapter's own entry — Tab/Shift-Tab on its TITLE moves the whole subchapter. */
function ChapterNode({ node, nodePath, level, entryId }: { node: M.MNode; nodePath: string; level: number; entryId?: string }) {
  const proj = useProj();
  const { host, focus, clearFocus, run, tabRun, setActive } = proj;
  const Heading = `h${Math.min(level + 1, 6)}` as "h1";
  const hasBody = node.entries.some((e) => e.key === null);
  return (
    <>
      {node.selfValue != null && (
        <HeadingCell
          as={Heading}
          className="chapter-title"
          value={String(node.selfValue?.value ?? "")}
          focusNow={focus?.id === node.id}
          onFocused={clearFocus}
          onFocus={() => setActive({ entryId: entryId ?? null, titleOf: node.id })}
          onCommit={(t) => run((r) => ({ edits: setSelf(host.path, r, node.id, t) }))}
          onEnter={() => run((r) => {
            // Enter walks title → description → the body
            const found = M.findNode(r, node.id);
            const desc = (found?.node ?? r).entries.find((e) => e.key === "description");
            if (desc) return { edits: [], focus: { id: desc.node.id, at: "end" } };
            return firstBodyFocus(host.path, r, node.id);
          })}
          onTab={entryId ? (shift) => tabRun(entryId, shift) : undefined}
          onArrow={(dir) => walkCaret(host.rootEl.current, dir)}
        />
      )}
      <BlockBody node={node} nodePath={nodePath} level={level} />
      {!hasBody && <BootstrapCell node={node} />}
    </>
  );
}

/** The one cell an EMPTY chapter shows — a paragraph that exists before its entry does, born from
 *  the first typed text (nothing is written by merely opening the editor). */
function BootstrapCell({ node }: { node: M.MNode }) {
  const proj = useProj();
  const { host, focus, clearFocus, run } = proj;
  const bootId = node.id + ":boot";
  return (
    <div className="chunk">
      <div className="chunk-body">
        <MarklowerChunkEditor
          text=""
          rev={0}
          chapterPath={host.path}
          focusAt={focus?.id === bootId ? focus.at : null}
          placeholder="Write…"
          onFocused={clearFocus}
          onChangeText={(t) => run((r) => {
            const out = createFirstChunk(host.path, r, node.id, t);
            // the real entry-backed cell replaces this one — the caret must follow into it
            return out && { edits: out.edits, focus: { id: out.focusId, at: "end" } };
          })}
          onSplit={(head, tail) => run((r) => {
            const first = createFirstChunk(host.path, r, node.id, head);
            if (!first) return null;
            const sp = splitProse(host.path, r, first.entryId, head, tail);
            if (!sp) return { edits: first.edits, focus: { id: first.focusId, at: "end" } };
            return { edits: [...first.edits, ...sp.edits], focus: { id: sp.focusId, at: "start" } };
          })}
          onArrowOut={(dir) => walkCaret(host.rootEl.current, dir)}
          onJoinPrev={() => {}}
          onJoinNext={() => {}}
        />
      </div>
    </div>
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
      onArrowOut={(dir) => walkCaret(host.rootEl.current, dir)}
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
  const onFocus = () => setActive({ entryId: entry.id });

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
      onFocus={() => setActive({ entryId: entry.id })}
      onCommit={(t) => run((r) => ({ edits: commitProse(host.path, r, entry.node.id, t) }))}
      onEnter={() => run((r) => firstBodyFocus(host.path, r, node.id))}
      onArrow={(dir) => walkCaret(host.rootEl.current, dir)}
    />
  );
}

/** A single-line editable heading (title / subtitle). Uncontrolled, reset on `value` while
 *  unfocused; Enter HANDS THE CARET ON via `onEnter` rather than blurring to nowhere. */
function HeadingCell({
  as, value, onCommit, className, placeholder, focusNow, onFocused, onEnter, onFocus, onTab, onArrow,
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
        if ((e.key === "ArrowUp" || e.key === "ArrowDown") && onArrow) {
          e.preventDefault();
          onArrow(e.key === "ArrowUp" ? "up" : "down"); // the focus move blurs → commitIfChanged
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
 *  chapter has none — so a fresh chapter is title → writing, no dead end and nothing to click.
 *  Creation goes through blocks.ts so a freshly wrapped title (a scalar entry server-side)
 *  re-emplaces the whole omni instead of descending into it. */
function firstBodyFocus(rootPath: string, root: M.MNode, nodeId: string): { edits: Edit[]; focus?: Focus } {
  const found = M.findNode(root, nodeId);
  const node = found?.node ?? root;
  const firstProse = node.entries.find((e) => e.key === null && isProse(e.node));
  if (firstProse) return { edits: [], focus: { id: firstProse.node.id, at: "start" } };
  const out = createFirstChunk(rootPath, root, node.id, "");
  if (!out) return { edits: [] };
  return { edits: out.edits, focus: { id: out.focusId, at: "start" } };
}

/** Up/Down between cells: the caret walks to the adjacent EDITABLE cell in document order —
 *  titles, descriptions, paragraphs and list items are all one flat walk, exactly the order the
 *  page reads in. */
function walkCaret(rootEl: HTMLElement | null, dir: "up" | "down"): void {
  if (!rootEl) return;
  const cells = Array.from(rootEl.querySelectorAll<HTMLElement>('[contenteditable="true"]'));
  const i = cells.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  const next = cells[i + (dir === "down" ? 1 : -1)];
  if (!next) return;
  (dir === "down" ? focusStart : focusEnd)(next);
}

/** The node path of a container's `i`-th entry. */
function pathOf(host: YedHost, containerPath: string, container: M.MNode, i: number): string {
  const found = M.findNode(host.rootRef.current!, container.entries[i].node.id);
  return found?.spine ? M.pathOfSpine(host.path, found.spine) : `${containerPath === ":" ? "" : containerPath}[${i}]`;
}

