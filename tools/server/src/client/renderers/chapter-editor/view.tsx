// The CHAPTER projection of the projectional editor: the same model host.ts drives for the source
// view, drawn as prose, headings and sections instead of token rows. Enter makes a sibling
// paragraph (THE PROSE EXCEPTION), Tab nests it into the previous block — a subchapter — and
// Shift-Tab lifts it out; the structural moves are the shared indentEntry/dedentEntry.
//
// Behind a flag for now (chapterEditorFlavor): the flat ChapterEditor keeps running until this
// reaches parity, so nothing regresses while it grows.

import { useEffect, useRef, useState } from "react";
import { useYedHost, type FocusAt, type YedHost } from "../yamlover-editor/host";
import * as M from "../yamlover-editor/model";
import type { Edit } from "../../api";
import { MarklowerChunkEditor } from "../chunk-editors";
import { focusEnd } from "../caret";
import { formatOfNode } from "./format";
import { commitProse, joinProse, splitProse, tabEdits } from "./blocks";

/** A pending caret placement — which model node to focus, and where. */
interface Focus { id: string; at: FocusAt }

/** True for a node the projection edits as PROSE — an inlined scalar chunk. */
const isProse = (node: M.MNode): boolean => node.kind === "scalar";

export function ChapterProjection({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const host = useYedHost(path, onNavigate);
  // The projection owns its own focus (blocks.ts returns the node to land on); the caret lands via
  // each cell's `focusAt`. Opening puts it in the title, so writing begins with no click.
  const [focus, setFocus] = useState<Focus | null>({ id: host.rootRef.current?.id ?? "", at: "start" });
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !host.root) return;
    opened.current = true;
    setFocus({ id: host.root.id, at: "start" }); // the root's self-value cell = the title
  }, [host.root]);

  /** Run a block mutation: step (mutate + enqueue ops), then take the caret where it says. */
  const run = (produce: (root: M.MNode) => { edits: Edit[]; focus?: Focus } | null) => {
    let next: Focus | undefined;
    host.step((r) => {
      const out = produce(r);
      next = out?.focus;
      return out?.edits ?? [];
    });
    if (next) setFocus(next);
  };

  if (!host.root) return <div className="chapter chapter-wysiwyg">…</div>;
  return (
    <div className="chapter chapter-wysiwyg" ref={host.rootEl}>
      <ChapterNode
        host={host}
        node={host.root}
        nodePath={path}
        level={0}
        focus={focus}
        clearFocus={() => setFocus(null)}
        run={run}
        onNavigate={onNavigate}
      />
    </div>
  );
}

/** One chapter (the document root, or a subchapter) — its title, then its body of paragraphs and
 *  nested subchapters, and one level deeper for each subchapter. */
function ChapterNode({
  host, node, nodePath, level, focus, clearFocus, run, onNavigate,
}: {
  host: YedHost;
  node: M.MNode;
  nodePath: string;
  level: number;
  focus: Focus | null;
  clearFocus: () => void;
  run: (produce: (root: M.MNode) => { edits: Edit[]; focus?: Focus } | null) => void;
  onNavigate: (p: string) => void;
}) {
  const Heading = `h${Math.min(level + 1, 6)}` as "h1";
  const body: JSX.Element[] = [];
  node.entries.forEach((entry, i) => {
    if (entry.key === "description") {
      body.push(
        <HeadingCell
          key={entry.id}
          as="p"
          className="chapter-subtitle"
          placeholder="Description"
          value={String(entry.node.scalar?.value ?? "")}
          focusNow={focus?.id === entry.node.id}
          onFocused={clearFocus}
          onCommit={(t) => run((r) => ({ edits: commitProse(host.path, r, entry.node.id, t) }))}
          onEnter={() => run((r) => firstBodyFocus(host.path, r, node.id))}
        />,
      );
      return;
    }
    if (entry.key !== null) return; // other keyed fields are not chapter body content
    const child = entry.node;
    if (isProse(child)) {
      body.push(
        <ProseCell key={entry.id} host={host} entry={entry} focus={focus} clearFocus={clearFocus} run={run} />,
      );
      return;
    }
    if (child.kind === "container" && formatOfNode(child) === "chapter") {
      body.push(
        <section key={entry.id} className="chapter-sub" data-chapter-path={pathOf(host, nodePath, node, i)}>
          <ChapterNode
            host={host}
            node={child}
            nodePath={pathOf(host, nodePath, node, i)}
            level={level + 1}
            focus={focus}
            clearFocus={clearFocus}
            run={run}
            onNavigate={onNavigate}
          />
        </section>,
      );
      return;
    }
    // a tagged list / table, a pointer, or a binary chunk — read-only in this projection for now
    body.push(<ReadOnlyBlock key={entry.id} node={child} path={pathOf(host, nodePath, node, i)} onNavigate={onNavigate} />);
  });

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
          // title → description (when the chapter has one) → the body
          const found = M.findNode(r, node.id);
          const desc = (found?.node ?? r).entries.find((e) => e.key === "description");
          if (desc) return { edits: [], focus: { id: desc.node.id, at: "end" } };
          return firstBodyFocus(host.path, r, node.id);
        })}
      />
      {body}
    </>
  );
}

/** A prose paragraph — the shared marklower editor, wrapped so Tab nests it (Tab is not the
 *  editor's; it is intercepted here so the wrapper can dispatch to the chapter's Tab rules). */
function ProseCell({
  host, entry, focus, clearFocus, run,
}: {
  host: YedHost;
  entry: M.MEntry;
  focus: Focus | null;
  clearFocus: () => void;
  run: (produce: (root: M.MNode) => { edits: Edit[]; focus?: Focus } | null) => void;
}) {
  const node = entry.node;
  const focusAt: FocusAt | null = focus?.id === node.id ? focus.at : null;
  return (
    <div
      className="chunk"
      onKeyDownCapture={(e) => {
        if (e.key !== "Tab") return;
        e.preventDefault();
        e.stopPropagation();
        run((r) => {
          const t = tabEdits(host.path, r, entry.id, e.shiftKey);
          if (t.intent.kind === "cell" || t.intent.kind === "nop") return { edits: [] };
          return { edits: t.edits, focus: t.focusId ? { id: t.focusId, at: "end" } : undefined };
        });
      }}
    >
      <div className="chunk-body">
        <MarklowerChunkEditor
          text={String(node.scalar?.value ?? "")}
          rev={node.rev}
          chapterPath={host.path}
          focusAt={focusAt}
          onFocused={clearFocus}
          onChangeText={(t) => run((r) => ({ edits: commitProse(host.path, r, node.id, t) }))}
          onSplit={(head, tail) => run((r) => splitProse(host.path, r, entry.id, head, tail))}
          onArrowOut={() => { /* caret walk between paragraphs — a later refinement */ }}
          onJoinPrev={() => run((r) => joinProse(host.path, r, entry.id, "prev", isProse))}
          onJoinNext={() => run((r) => joinProse(host.path, r, entry.id, "next", isProse))}
        />
      </div>
    </div>
  );
}

/** A single-line editable heading (title / subtitle). Uncontrolled, reset on `value` while
 *  unfocused; Enter HANDS THE CARET ON via `onEnter` rather than blurring to nowhere. */
function HeadingCell({
  as, value, onCommit, className, placeholder, focusNow, onFocused, onEnter,
}: {
  as: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p";
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
  useEffect(() => {
    if (!focusNow || !ref.current) return;
    focusEnd(ref.current);
    onFocused?.();
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
        onEnter?.();
      }}
    />
  );
}

/** A block this projection does not yet edit — a tagged list/table (Stage 6/7), a `*` pointer, or a
 *  binary chunk. Shown read-only with its own text so it is not lost; navigable when it is a link. */
function ReadOnlyBlock({ node, path, onNavigate }: { node: M.MNode; path: string; onNavigate: (p: string) => void }) {
  if (node.kind === "pointer" || node.kind === "link") {
    const target = node.kind === "pointer" ? node.pointer?.refPath : node.link?.path;
    const text = node.kind === "pointer" ? "*" + (node.pointer?.raw ?? "") : node.link?.title ?? node.link?.path ?? path;
    return (
      <div className="chunk"><div className="chunk-body">
        <a className="descend" href={target ?? "#"} onClick={(e) => { e.preventDefault(); if (target) onNavigate(target); }}>{text}</a>
      </div></div>
    );
  }
  const label = formatOfNode(node); // table / bullets / numbered
  return (
    <div className="chunk"><div className="chunk-body">
      <p className="chapter-prose chapter-readonly-block" data-yo-chrome>[{label} — edit in the source view for now]</p>
    </div></div>
  );
}

// --- helpers ----------------------------------------------------------------------------------- //

/** Commit a chapter's title (the node's self-value); an empty string drops the line. */
function setSelf(rootPath: string, root: M.MNode, nodeId: string, text: string): Edit[] {
  const scalar = text ? { src: JSON.stringify(text), value: text } : null; // a heading is one line — quote it
  return M.setSelfValue(rootPath, root, nodeId, scalar);
}

/** Enter out of a heading: focus the first editable body paragraph, making an empty one when the
 *  chapter has none — so a fresh chapter is title → writing, with no dead end and nothing to click. */
function firstBodyFocus(rootPath: string, root: M.MNode, nodeId: string): { edits: Edit[]; focus?: Focus } {
  const found = M.findNode(root, nodeId);
  const node = found?.node ?? root;
  const firstProse = node.entries.find((e) => e.key === null && isProse(e.node));
  if (firstProse) return { edits: [], focus: { id: firstProse.node.id, at: "start" } };
  // make one empty paragraph, focus it (born from the Enter keystroke, so merely opening writes nothing)
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
