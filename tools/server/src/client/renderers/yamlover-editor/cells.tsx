// The projectional editor's CELLS — the React elements the yamlover structure projects into. The
// DOM nesting mirrors the AST: a node's block children live inside an <IndentRegion> element, a
// row is one source line, and every editable token (key, scalar, pointer raw, tag content) is its
// own small cell. Finished content reads as properly formatted yamlover (the read-only view's
// token classes); unfinished parts are HOLE cells whose typed prefix materializes the structure
// (keys.ts): `"` projects its closing quote with the caret between, `{` projects `}` around a
// fresh entry cell, `- ` / `k: ` shape the entry, `*` opens a reference cell, `!!<` a tag cell.

import { createContext, Fragment, ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommentBucket } from "../../api";
import type { Link } from "../../render";
import { caretAtStart, caretOnFirstLine, caretOnLastLine } from "../caret";
import { keyToken, type MEntry, type MNode } from "./model";
import type { HoleAction } from "./keys";
import { classifyHoleInput, keyedEditParts, normalizeSpaces } from "./keys";

/** The LIVE keyed trigger of a plain-token cell (unquoted_scalar_appending/inserting): fires the
 *  moment the text reads `key: ` (or already carries a value) — a committed `abc` grown into
 *  `abc: ` restructures exactly like typing it in a fresh hole. */
function liveKeyedText(el: HTMLElement): string | null {
  const t = normalizeSpaces(el.textContent ?? "");
  const kv = keyedEditParts(t);
  return kv && (kv.rest !== "" || /: $/.test(t)) ? t : null;
}

// --------------------------------------------------------------------------- //
// The editor context — actions provided by editor.tsx, consumed by every cell
// --------------------------------------------------------------------------- //

export interface YedActions {
  /** Commit a token-mode scalar cell (verbatim yamlover source). False = rejected (not a scalar). */
  commitToken(nodeId: string, src: string): boolean;
  /** Commit a quoted/block cell's TEXT (the cell's mode decides the serialization). In an
   *  UNDECIDED entry hole the token becomes the node's scalar LINE (false when one exists);
   *  `submit` (Enter) also opens the follow-up hole. */
  commitText(nodeId: string, text: string, submit?: boolean): boolean;
  /** `quoted_token_closed`: the closing quote was typed — nothing committed, caret jumps after. */
  quoteClose(nodeId: string, inner: string): void;
  /** Backspace from the after-quote cell: step back INSIDE the quotes without committing. */
  quoteReopen(nodeId: string): void;
  /** A colon after the closed quote: the quoted string becomes a KEY (entry / root / nested).
   *  False = the key already exists in the node (keys are unique). */
  quotedKey(nodeId: string): boolean;
  /** Backspace in an EMPTY value hole: UNDO the last structural token (colon/dash) of an
   *  uncommitted entry — the quoted key returns closed, a plain key's text returns to the hole. */
  undoDecision(entryId: string): void;
  /** Commit a pointer cell's raw expression (no `*`). False = does not parse as a pointer. */
  commitPointer(nodeId: string, raw: string): boolean;
  /** Commit a self-value cell's SOURCE token ("" clears the line). False = not a scalar. */
  commitSelfToken(nodeId: string, src: string): boolean;
  /** Commit a QUOTED self-value's inner text — the quoted concrete is kept. */
  commitSelfQuoted(nodeId: string, text: string, quote: '"' | "'"): void;
  /** Commit a BLOCK self-value's TEXT — the authored `|`/`>` header is kept over the edited
   *  lines; `submit` (Ctrl+Enter / Tab) also opens the node's first entry hole. */
  commitSelfText(nodeId: string, text: string, submit?: boolean): void;
  /** Commit a meta-tag cell's content (null/empty clears the tag). */
  commitMeta(nodeId: string, content: string | null): void;
  /** A hole's typed prefix decided a structure (keys.ts) — materialize it. False = rejected
   *  (a duplicate key); the typed text stays in the hole with the error ring. */
  holeAction(entryId: string, action: HoleAction): boolean;
  /** Commit a hole's plain text (blur): a bare token in an UNDECIDED entry hole becomes the
   *  node's scalar SELF-VALUE line; a decided value hole commits the entry. False = rejected. */
  holeText(entryId: string, text: string): boolean;
  /** The Enter form of {@link holeText}: commit AND open the follow-up hole, caret in it. */
  holeSubmit(entryId: string, text: string): boolean;
  /** The EMPTY document's root hole: its typed prefix shapes the ROOT itself (a scalar/pointer
   *  value, a first entry, or the root meta tag). */
  rootHole(action: HoleAction): void;
  /** Commit the root hole's plain text as the document's root scalar. False = rejected. */
  rootText(text: string): boolean;
  /** `empty_cell_of_origin`: dismantle an UNPERSISTED projected cell (quotes / `*` / braces)
   *  back to the hole it grew from. No-op for persisted cells. */
  dismantle(nodeId: string): void;
  /** Enter in an EMPTY inline value hole: the value becomes a nested BLOCK — an indented
   *  entry hole opens on the next row. */
  nestValue(entryId: string): void;
  /** Enter: a fresh sibling hole after this entry. */
  enterAfter(entryId: string): void;
  /** Enter on a self-value / root cell: a fresh hole as the container's first entry. */
  enterInto(nodeId: string): void;
  indent(entryId: string): void;
  dedent(entryId: string): void;
  /** Backspace on an empty cell: drop the entry (a hole silently; committed → a remove op). */
  removeEmpty(entryId: string): void;
  /** Move focus to the previous/next cell in visual order. */
  focusSibling(from: HTMLElement, dir: -1 | 1): void;
}

export interface YedCtxType {
  rootPath: string;
  act: YedActions;
  registerCell(key: string, el: HTMLElement | null): void;
  onNavigate(path: string): void;
}

export const YedCtx = createContext<YedCtxType | null>(null);
export const useYed = (): YedCtxType => useContext(YedCtx)!;

/** The token colour class of a decoded value — mirrors the read-only view. */
export function tokenClass(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "b";
  if (typeof value === "number") return "n";
  return "s";
}

// --------------------------------------------------------------------------- //
// Shared editable-span behaviour
// --------------------------------------------------------------------------- //

interface EditableProps {
  cellKey: string;
  className: string;
  initial: string;
  rev: number; // model-driven text change → DOM reset (never mid-type)
  placeholder?: string;
  /** The cell was materialized from a hole and is NOT persisted yet — commit on blur even when
   *  the text still equals the preset initial. */
  force?: boolean;
  onCommit(text: string): boolean; // false = rejected → error ring, keep text
  onKeyDown?(e: React.KeyboardEvent, el: HTMLElement): boolean; // true = handled
  onInput?(el: HTMLElement): void; // live per-edit hook (the token cells' keyed trigger)
}

/** An uncontrolled contentEditable token cell: commits on blur, Enter commits (the caller's
 *  onKeyDown usually also opens the next hole), Esc reverts. `rev` gates DOM resets. */
function EditableCell({ cellKey, className, initial, rev, placeholder, force = false, onCommit, onKeyDown, onInput }: EditableProps) {
  const { act, registerCell } = useYed();
  const ref = useRef<HTMLElement | null>(null);
  const [error, setError] = useState(false);
  const cancel = useRef(false);
  useEffect(() => {
    // skip when the DOM already shows the text: re-setting replaces the text node, which
    // collapses a just-placed caret back to the cell start
    if (ref.current && ref.current.textContent !== initial) ref.current.textContent = initial;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);
  const commit = () => {
    if (cancel.current) { cancel.current = false; if (ref.current) ref.current.textContent = initial; return; }
    const text = ref.current?.textContent ?? "";
    if (text === initial && !force) { setError(false); return; }
    setError(!onCommit(text));
  };
  return (
    <span
      ref={(el) => {
        ref.current = el;
        registerCell(cellKey, el);
        // seed on mount only — never clobber a focused cell the user just emptied
        if (el && el.textContent === "" && initial && document.activeElement !== el) el.textContent = initial;
      }}
      data-yed-cell={cellKey}
      className={className + " editable" + (error ? " edit-error" : "")}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder={placeholder}
      onInput={(e) => onInput?.(e.currentTarget as HTMLElement)}
      onBlur={commit}
      onKeyDown={(e) => {
        const el = e.currentTarget as HTMLElement;
        if (onKeyDown && onKeyDown(e, el)) return;
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { cancel.current = true; el.blur(); } // NodeView's Esc then locks
        else if (e.key === "ArrowUp" && caretOnFirstLine(el)) { e.preventDefault(); act.focusSibling(el, -1); }
        else if (e.key === "ArrowDown" && caretOnLastLine(el)) { e.preventDefault(); act.focusSibling(el, 1); }
      }}
    />
  );
}

// --------------------------------------------------------------------------- //
// Value cells
// --------------------------------------------------------------------------- //

/** A scalar cell. Token mode edits the SOURCE token; quote mode projects the paired quotes around
 *  an inner text cell; block mode is a multiline textarea committing via block-scalar escaping. */
export function ScalarCell({ node, entryId }: { node: MNode; entryId: string | null }) {
  const { act } = useYed();
  const s = node.scalar!;
  const structuralKeys = (e: React.KeyboardEvent, el: HTMLElement): boolean => {
    if (e.key === "Tab" && entryId) { e.preventDefault(); if (e.shiftKey) act.dedent(entryId); else act.indent(entryId); return true; }
    if (e.key === "Backspace" && entryId && (el.textContent ?? "") === "") { e.preventDefault(); act.removeEmpty(entryId); return true; }
    if (e.key === "Backspace" && (el.textContent ?? "") !== "" && caretAtStart(el)) { e.preventDefault(); act.focusSibling(el, -1); return true; }
    return false;
  };
  if (s.block) {
    // the AUTHORED header is PROJECTED and kept — the text lines edit below it in ordinary styling
    const header = s.src.startsWith("|") || s.src.startsWith(">") ? s.src.split("\n")[0] : "|";
    return (
      <>
        <span className="punct">{header}</span>
        <BlockScalarCell node={node} />
      </>
    );
  }
  if (s.quote) {
    const q = s.quote;
    return (
      <>
        <span className="s">{q}</span>
        <EditableCell
          cellKey={node.id}
          className="s"
          initial={String(s.value ?? "")}
          rev={node.rev}
          force={!!node.dirty}
          onCommit={(text) => (node.scalar?.closed ? true : act.commitText(node.id, text))} // closed → the after-cell owns the commit
          onKeyDown={(e, el) => {
            if (e.key === "Backspace" && (el.textContent ?? "") === "" && node.dirty) {
              // `…_started` + Backspace → empty_cell_of_origin: the quotes dismantle
              e.preventDefault();
              act.dismantle(node.id);
              return true;
            }
            if (structuralKeys(e, el)) return true;
            if (e.key === q) {
              // the CLOSING quote → quoted_token_closed: caret jumps after it, nothing committed
              e.preventDefault();
              act.quoteClose(node.id, el.textContent ?? "");
              return true;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              act.commitText(node.id, el.textContent ?? "", true);
              return true;
            }
            return false;
          }}
        />
        <span className="s">{q}</span>
        {s.closed && <AfterQuoteCell node={node} />}
      </>
    );
  }
  return (
    <EditableCell
      cellKey={node.id}
      className={tokenClass(s.value)}
      initial={s.src}
      rev={node.rev}
      placeholder="…"
      force={!!node.dirty}
      onCommit={(text) => act.commitToken(node.id, text.trim())}
      onInput={(el) => {
        // the LIVE keyed trigger — `abc` edited into `abc: ` restructures like a fresh hole
        const t = liveKeyedText(el);
        if (t !== null) act.commitToken(node.id, t);
      }}
      onKeyDown={(e, el) => {
        if (structuralKeys(e, el)) return true;
        if (e.key === "Enter") {
          e.preventDefault();
          const text = (el.textContent ?? "").trim();
          const editing = text !== s.src || !!node.dirty; // ≠ committed source → an edit is pending
          if (text !== "" && editing && !act.commitToken(node.id, text)) return true; // rejected → stay
          if (node.kind !== "scalar") return true; // the commit RESTRUCTURED into `key: value` — focus moved
          // THE LEVEL RULE: descend — the hole opens INSIDE this node, root and entry alike
          act.enterInto(node.id);
          return true;
        }
        return false;
      }}
    />
  );
}

/** The `quoted_token_closed` landing spot: a zero-width cell right AFTER the closing quote. The
 *  next key decides what the quoted token is — `:` makes it a KEY, Enter commits it as the scalar
 *  it reads as, Backspace steps back inside the quotes. Nothing else is legal here. */
function AfterQuoteCell({ node }: { node: MNode }) {
  const { act, registerCell } = useYed();
  const [error, setError] = useState(false);
  const commit = (submit: boolean) => act.commitText(node.id, String(node.scalar?.value ?? ""), submit);
  return (
    <span
      ref={(el) => registerCell(node.id + ":after", el)}
      data-yed-cell={node.id + ":after"}
      className={"yed-after editable" + (error ? " edit-error" : "")}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={() => { if (node.scalar?.closed) commit(false); }}
      onKeyDown={(e) => {
        e.preventDefault();
        setError(false);
        if (e.key === ":") setError(!act.quotedKey(node.id)); // duplicate key → error ring, stay
        else if (e.key === "Enter") setError(!commit(true));
        else if (e.key === "Backspace" || e.key === "ArrowLeft") act.quoteReopen(node.id); // back INSIDE, no commit
        else if (e.key === "ArrowUp") act.focusSibling(e.currentTarget, -1);
        else if (e.key === "ArrowDown") act.focusSibling(e.currentTarget, 1);
      }}
    />
  );
}

/** A multiline (block-scalar) cell: an auto-growing textarea editing the authored content TEXT;
 *  the commit re-emits the AUTHORED `|`/`>` header over the edited lines (or a quoted line when
 *  block form cannot hold them). With `self`, the cell edits the node's omni SELF-VALUE line. */
function BlockScalarCell({ node, self = false }: { node: MNode; self?: boolean }) {
  const { act, registerCell } = useYed();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const cellKey = self ? node.id + ":self" : node.id;
  const scalar = () => (self ? node.selfValue : node.scalar);
  const commit = (text: string, submit: boolean) =>
    self ? act.commitSelfText(node.id, text, submit) : void act.commitText(node.id, text, submit);
  const grow = () => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; } };
  useEffect(() => {
    const want = String(scalar()?.value ?? "");
    if (ref.current && ref.current.value !== want) { ref.current.value = want; grow(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.rev]);
  return (
    <textarea
      ref={(el) => { ref.current = el; registerCell(cellKey, el); }}
      data-yed-cell={cellKey}
      className="s yed-blocktext"
      defaultValue={String(scalar()?.value ?? "")}
      spellCheck={false}
      onInput={grow}
      onBlur={(e) => commit(e.currentTarget.value, false)} // click_outside → scalar_committed
      onKeyDown={(e) => {
        // Enter is a NEWLINE here (the machine's one exception); Ctrl+Enter, Tab and Shift-Tab
        // all FINISH the block — the text is prose, the structural keys leave; only the
        // first/last source line's Up/Down leave the cell
        const el = e.currentTarget;
        if ((e.key === "Enter" && (e.ctrlKey || e.metaKey)) || e.key === "Tab") {
          e.preventDefault();
          commit(el.value, true);
        } else if (e.key === "ArrowUp" && !el.value.slice(0, el.selectionStart ?? 0).includes("\n")) {
          e.preventDefault();
          act.focusSibling(el, -1);
        } else if (e.key === "ArrowDown" && !el.value.slice(el.selectionEnd ?? el.value.length).includes("\n")) {
          e.preventDefault();
          act.focusSibling(el, 1);
        }
      }}
    />
  );
}

/** A reference cell: the `*` sigil, an editable pointer expression, and a `↗` that navigates to
 *  the resolved target (kept out of the editable so clicks don't fight the caret). */
export function PointerCell({ node, entryId }: { node: MNode; entryId: string | null }) {
  const { act, onNavigate } = useYed();
  const p = node.pointer!;
  return (
    <>
      <span className="punct">*</span>
      <EditableCell
        cellKey={node.id}
        className="s"
        initial={p.raw}
        rev={node.rev}
        placeholder="pointer"
        force={!!node.dirty}
        onCommit={(text) => act.commitPointer(node.id, text.trim())}
        onKeyDown={(e, el) => {
          if (e.key === "Tab" && entryId) { e.preventDefault(); if (e.shiftKey) act.dedent(entryId); else act.indent(entryId); return true; }
          if (e.key === "Backspace" && (el.textContent ?? "") === "") {
            e.preventDefault();
            // `pointer_started` + Backspace → empty_cell_of_origin (the `*` dismantles);
            // a persisted pointer entry emptied → remove the entry, focus the previous cell
            if (node.dirty) act.dismantle(node.id);
            else if (entryId) act.removeEmpty(entryId);
            return true;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if ((el.textContent ?? "").trim() === "") return true; // pointer_started + Enter → nop
            if (!act.commitPointer(node.id, (el.textContent ?? "").trim())) return true;
            if (entryId) act.enterAfter(entryId); // ENTRY → entry_hole; ROOT → pointer_committed (stays)
            return true;
          }
          return false;
        }}
      />
      {p.refPath && (
        <a
          className="descend yed-refnav"
          href={p.refPath}
          title="go to the target"
          onClick={(e) => { e.preventDefault(); onNavigate(p.refPath!); }}
        >↗</a>
      )}
    </>
  );
}

/** A `!!<…>` meta-tag cell: the delimiters are projection artifacts, the content edits. Emptying
 *  the content drops the tag. */
export function MetaTagCell({ node }: { node: MNode }) {
  const { act } = useYed();
  return (
    <>
      <span className="b">{"!!<"}</span>
      <EditableCell
        cellKey={node.id + ":meta"}
        className="b"
        initial={node.metaTag ?? ""}
        rev={node.rev}
        placeholder="schema"
        onCommit={(text) => { act.commitMeta(node.id, text.trim() === "" ? null : text.trim()); return true; }}
        onKeyDown={(e, el) => {
          if (e.key === "Enter" || e.key === ">") {
            e.preventDefault();
            const t = (el.textContent ?? "").trim();
            act.commitMeta(node.id, t === "" ? null : t); // → the value_hole (commitMeta focuses it)
            return true;
          }
          if (e.key === "Backspace" && (el.textContent ?? "") === "") {
            // `meta_tag_editing` emptied → empty_cell_of_origin: the `!!<…>` dismantles
            e.preventDefault();
            act.commitMeta(node.id, null);
            return true;
          }
          return false;
        }}
      />
      <span className="b">{">"}</span>{" "}
    </>
  );
}

/** An omni self-value cell — shown in its SOURCE concrete: a quoted self keeps its projected
 *  quotes and commits quoted; anything else edits the token verbatim. Enter opens the node's
 *  first entry hole. */
export function SelfValueCell({ node }: { node: MNode }) {
  const { act } = useYed();
  const s = node.selfValue!;
  if (s.block) {
    // the AUTHORED block header is projected and kept — the self-value's lines edit below it
    return (
      <>
        <span className="punct">{s.src.startsWith("|") || s.src.startsWith(">") ? s.src.split("\n")[0] : "|"}</span>
        <BlockScalarCell node={node} self />
      </>
    );
  }
  if (s.quote) {
    const q = s.quote;
    return (
      <>
        <span className="s">{q}</span>
        <EditableCell
          cellKey={node.id + ":self"}
          className="s"
          initial={String(s.value ?? "")}
          rev={node.rev}
          onCommit={(text) => { act.commitSelfQuoted(node.id, text, q); return true; }}
          onKeyDown={(e, el) => {
            if (e.key === "Enter") {
              e.preventDefault();
              act.commitSelfQuoted(node.id, el.textContent ?? "", q);
              act.enterInto(node.id);
              return true;
            }
            return false;
          }}
        />
        <span className="s">{q}</span>
      </>
    );
  }
  return (
    <EditableCell
      cellKey={node.id + ":self"}
      className={tokenClass(s.value)}
      initial={s.src}
      rev={node.rev}
      placeholder="value…"
      onCommit={(text) => act.commitSelfToken(node.id, text.trim())}
      onInput={(el) => {
        // the LIVE keyed trigger applies to the self line too
        const t = liveKeyedText(el);
        if (t !== null) act.commitSelfToken(node.id, t);
      }}
      onKeyDown={(e, el) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const t = (el.textContent ?? "").trim();
          if (t !== "" && !act.commitSelfToken(node.id, t)) return true;
          if (t !== "" && !node.selfValue) return true; // RESTRUCTURED into `key: value` — focus moved
          act.enterInto(node.id);
          return true;
        }
        return false;
      }}
    />
  );
}

/** A HOLE — the unfinished part. Its typed prefix runs through the typing grammar; anything
 *  structural materializes the corresponding cells, plain text commits as a scalar on Enter/blur. */
export function HoleCell({ entry, stage }: { entry: MEntry; stage: "entry" | "value" }) {
  const { act, registerCell } = useYed();
  const ref = useRef<HTMLElement | null>(null);
  const [error, setError] = useState(false);
  const node = entry.node;
  // layout effect: the reset must land BEFORE the editor's focus placement, or a just-placed
  // caret collapses; `prefill` restores an undone `key:` decision's text (consumed once)
  useLayoutEffect(() => {
    const want = node.prefill ?? "";
    if (ref.current && ref.current.textContent !== want) ref.current.textContent = want;
    node.prefill = undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.rev]);
  const classify = (enter: boolean): boolean => {
    const text = ref.current?.textContent ?? "";
    const action = classifyHoleInput(text, stage === "entry", enter);
    if (action && action.kind !== "text") {
      if (!act.holeAction(entry.id, action)) setError(true); // e.g. a duplicate key — text stays
      return true;
    }
    return false;
  };
  return (
    <span
      ref={(el) => { ref.current = el; registerCell(node.id, el); }}
      data-yed-cell={node.id}
      className={"yed-hole editable" + (error ? " edit-error" : "")}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={() => { setError(false); classify(false); }}
      onBlur={() => {
        const text = (ref.current?.textContent ?? "").trim();
        if (text !== "" && !classify(false)) setError(!act.holeText(entry.id, text));
      }}
      onKeyDown={(e) => {
        const el = e.currentTarget as HTMLElement;
        const text = (el.textContent ?? "").trim();
        if (e.key === "Enter") {
          e.preventDefault();
          if (classify(true)) return;
          if (text === "") {
            // an EMPTY value hole's Enter opens the value as a nested block (entry-stage: nop)
            if (stage === "value") act.nestValue(entry.id);
            return;
          }
          if (!act.holeSubmit(entry.id, text)) setError(true);
        } else if (e.key === "Tab") {
          e.preventDefault();
          if (e.shiftKey) act.dedent(entry.id); else act.indent(entry.id);
        } else if (e.key === "Backspace" && text === "") {
          e.preventDefault();
          // an uncommitted DECIDED entry: undo the marker (colon/dash), never the whole entry
          if (!entry.committed && entry.decided) act.undoDecision(entry.id);
          else act.removeEmpty(entry.id);
        } else if (e.key === "ArrowUp" && caretOnFirstLine(el)) { e.preventDefault(); act.focusSibling(el, -1); }
        else if (e.key === "ArrowDown" && caretOnLastLine(el)) { e.preventDefault(); act.focusSibling(el, 1); }
      }}
    />
  );
}

/** An opaque `$yamloverLink` (a binary leaf) — the same descend hyperlink as the read-only view. */
export function LinkCell({ link }: { link: Link }) {
  const { onNavigate } = useYed();
  const label =
    link.kind === "binary" ? `< binary of ${link.size ?? 0} bytes >`
    : link.kind === "array" ? `[ array with ${link.count ?? 0} items ]`
    : link.kind === "scalar" ? String(link.value ?? "…")
    : `{ ${link.kind} with ${link.count ?? 0} entries }`;
  return (
    <a className="descend" href={link.path} onClick={(e) => { e.preventDefault(); onNavigate(link.path); }}>
      {link.title ?? label}
    </a>
  );
}

// --------------------------------------------------------------------------- //
// Rows and regions — the DOM nesting that mirrors the AST nesting
// --------------------------------------------------------------------------- //

/** The wrapping element of a node's indented block children — 2ch left padding = one YAML step. */
export function IndentRegion({ children }: { children: ReactNode }) {
  return <div className="yed-indent">{children}</div>;
}

function CommentLines({ bucket }: { bucket?: CommentBucket }) {
  if (!bucket?.leading?.length && !bucket?.blankBefore) return null;
  return (
    <>
      {bucket?.blankBefore && <div className="yed-row">{" "}</div>}
      {(bucket?.leading ?? []).map((t, i) => (
        <div key={i} className="yed-row"><span className="c"># {t.trim()}</span></div>
      ))}
    </>
  );
}

function TrailingComment({ bucket }: { bucket?: CommentBucket }) {
  const texts = [...(bucket?.trailing ?? []), ...(bucket?.valueTrailing ?? [])];
  if (!texts.length) return null;
  return <span className="c">{"  # " + texts.map((t) => t.trim()).join(" · ")}</span>;
}

function Anchors({ node }: { node: MNode }) {
  const anchors = node.bucket?.anchors ?? [];
  if (!anchors.length && !node.setTag) return null;
  return (
    <>
      {node.setTag && <span className="b">!!set </span>}
      {anchors.map((a, i) => <span key={i} className="anchor">{"&" + a + " "}</span>)}
    </>
  );
}

// --------------------------------------------------------------------------- //
// The COMPOSITIONAL projection: every entry is a HEAD (what continues on the current row —
// its marker plus its node's head, recursively) and a BODY (the rows below). Compact YAML
// (`- name: Rex`, `- - x`, `- scalar` with a grown body) EMERGES from one rule applied at
// every level, instead of being special-cased per shape.
// --------------------------------------------------------------------------- //

/** Whether an entry's head may ride an ANCESTOR's row (own leading-comment rows pin it down). */
function canInlineEntry(e: MEntry): boolean {
  return !e.bucket?.leading?.length && !e.bucket?.blankBefore;
}

/** What a node's INLINE HEAD is — the part drawn right after a marker on the same row.
 *  `chainFirst` — the owner is a DASH: compact YAML lets the container's first child ride the
 *  dash line (`- name: Rex`); after a `key:` only the omni self may share the row. */
function nodeHeadKind(node: MNode, chainFirst: boolean): "cell" | "self" | "first" | "empty" | "none" {
  if (node.kind !== "container" || node.flow) return "cell"; // hole/scalar/pointer/link/flow
  if (node.selfValue && node.selfAt === 0 && !node.selfValue.block) return "self";
  if (chainFirst && !node.selfValue && node.entries.length > 0 && canInlineEntry(node.entries[0])) return "first";
  if (node.entries.length === 0 && !node.selfValue) return "empty";
  return "none"; // value rows below (a keyed block, a mid-position or block self, …)
}

/** The node's inline head cells (recursing into the first child's head for compact forms). */
function NodeHead({ node, entry, chainFirst }: { node: MNode; entry: MEntry | null; chainFirst: boolean }) {
  switch (nodeHeadKind(node, chainFirst)) {
    case "cell":
      if (node.kind === "hole") return entry ? <HoleCell entry={entry} stage={entry.decided ? "value" : "entry"} /> : null;
      if (node.kind === "scalar") return <ScalarCell node={node} entryId={entry?.id ?? null} />;
      if (node.kind === "pointer") return <PointerCell node={node} entryId={entry?.id ?? null} />;
      if (node.kind === "link") return <LinkCell link={node.link!} />;
      return <FlowCells node={node} />;
    case "self":
      return <SelfValueCell node={node} />;
    case "first":
      return <EntryHead entry={node.entries[0]} />;
    case "empty":
      return <span className="punct">{"{}"}</span>;
    case "none":
      return null;
  }
}

/** An entry's head: its marker, its node's tag/anchors, then the node's head. */
function EntryHead({ entry }: { entry: MEntry }) {
  const node = entry.node;
  const marker = !entry.decided ? null
    : entry.key !== null
      ? <><span className="k">{keyToken(entry)}</span><span className="punct">{":"}</span>{" "}</>
      : <><span className="punct yaml-dash">-</span>{" "}</>;
  return (
    <>
      {marker}
      {node.metaTag !== null && <MetaTagCell node={node} />}
      <Anchors node={node} />
      <NodeHead node={node} entry={entry} chainFirst={entry.key === null} />
    </>
  );
}

/** Whether a node has BODY rows at all (so no empty indent regions clutter the DOM). */
function hasBody(node: MNode, chainFirst: boolean): boolean {
  if (node.kind !== "container" || node.flow) return false;
  switch (nodeHeadKind(node, chainFirst)) {
    case "self": return node.entries.length > 0;
    case "first": return node.entries.length > 1 || hasBody(node.entries[0].node, node.entries[0].key === null);
    case "none": return node.entries.length > 0 || !!node.selfValue;
    default: return false;
  }
}

/** The node's BODY rows — everything below its head row, indented one level (included here). */
function NodeBody({ node, chainFirst }: { node: MNode; chainFirst: boolean }) {
  if (node.kind !== "container" || node.flow) return null; // cell heads carry no body rows
  switch (nodeHeadKind(node, chainFirst)) {
    case "self":
      // the self rode the head row — every entry is a body row, one level in
      return node.entries.length > 0
        ? <IndentRegion>{node.entries.map((e) => <EntryRow key={e.id} entry={e} />)}</IndentRegion>
        : null;
    case "first": {
      // the first child's head rode the row — its OWN body sits one level deeper than the
      // siblings that follow (`- name: Rex` / name's children / then `age:` at name's level)
      const [first, ...rest] = node.entries;
      return (
        <>
          {hasBody(first.node, first.key === null) && (
            <IndentRegion><NodeBody node={first.node} chainFirst={first.key === null} /></IndentRegion>
          )}
          {rest.length > 0 && <IndentRegion>{rest.map((e) => <EntryRow key={e.id} entry={e} />)}</IndentRegion>}
        </>
      );
    }
    case "none":
      // nothing inlined — the full row set (self interleaved at selfAt), one level in
      return <IndentRegion><NodeCells node={node} /></IndentRegion>;
    default:
      return null;
  }
}

/** One entry: its head row (comments above, trailing after) and its node's body rows. */
export function EntryRow({ entry }: { entry: MEntry }) {
  return (
    <>
      <CommentLines bucket={entry.bucket} />
      <div className="yed-row">
        <EntryHead entry={entry} />
        <TrailingComment bucket={entry.bucket} />
      </div>
      <NodeBody node={entry.node} chainFirst={entry.key === null} />
    </>
  );
}

/** A flow container rendered inline: `{ k: v, … }` / `[ v, … ]` — the paired closer is projected,
 *  each element is its own cell, Enter inside adds the next element (while still uncommitted). */
export function FlowCells({ node }: { node: MNode }) {
  const open = node.flow === "seq" ? "[" : "{";
  const close = node.flow === "seq" ? "]" : "}";
  return (
    <>
      <span className="punct">{open}</span>
      {node.entries.map((e, i) => (
        <Fragment key={e.id}>
          {i > 0 && <span className="punct">{", "}</span>}
          {e.key !== null && <><span className="k">{keyToken(e)}</span><span className="punct">{": "}</span></>}
          <NodeHead node={e.node} entry={e} chainFirst={false} />
        </Fragment>
      ))}
      <span className="punct">{close}</span>
    </>
  );
}

/** A container's rows at the CURRENT level: entries in order with the omni self-value interleaved
 *  at `selfAt`. Used for the document ROOT (whose entries sit at column 0) and for `none`-head
 *  bodies; entry-level compaction happens in {@link EntryRow}/{@link NodeBody}. */
export function NodeCells({ node }: { node: MNode }) {
  const selfRow = node.selfValue ? (
    <div className="yed-row">
      <SelfValueCell node={node} />
      <TrailingComment bucket={node.bucket?.valueTrailing ? { trailing: node.bucket.valueTrailing } : undefined} />
    </div>
  ) : null;
  const at = node.selfValue ? Math.min(node.selfAt, node.entries.length) : 0;
  return (
    <>
      {node.entries.map((e, i) => (
        <Fragment key={e.id}>
          {i === at && selfRow}
          <EntryRow entry={e} />
        </Fragment>
      ))}
      {(node.entries.length === 0 || at >= node.entries.length) && selfRow}
    </>
  );
}

/** An EMPTY document's single hole — the whole grammar applies to the ROOT: a plain token /
 *  `"` / `|` becomes the root scalar, `*` the root pointer, `- ` / `k: ` the first entry,
 *  `!!<` the root meta tag. Registered under the ROOT node's id so focus carries over when the
 *  typed prefix morphs this cell into the root's value cell. */
export function RootHole({ node }: { node: MNode }) {
  const { act, registerCell } = useYed();
  const ref = useRef<HTMLElement | null>(null);
  const [error, setError] = useState(false);
  const classify = (enter: boolean): boolean => {
    const action = classifyHoleInput(ref.current?.textContent ?? "", true, enter);
    if (action && action.kind !== "text") { act.rootHole(action); return true; }
    return false;
  };
  return (
    <span
      ref={(el) => { ref.current = el; registerCell(node.id, el); }}
      data-yed-cell={node.id}
      className={"yed-hole editable" + (error ? " edit-error" : "")}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={() => { setError(false); classify(false); }}
      onBlur={() => {
        const text = (ref.current?.textContent ?? "").trim();
        if (text !== "" && !classify(false)) setError(!act.rootText(text));
      }}
      onKeyDown={(e) => {
        const text = ((e.currentTarget as HTMLElement).textContent ?? "").trim();
        if (e.key === "Enter") {
          e.preventDefault();
          if (classify(true) || text === "") return; // `empty` + Enter → nop
          // commit + straight to the first entry_hole (the machine's `enter: valid` transition)
          if (act.rootText(text)) act.enterInto(node.id);
          else setError(true);
        } else if (e.key === "Tab") {
          e.preventDefault(); // `empty` + Tab / Shift-Tab → nop (never leave the editor)
        }
      }}
    />
  );
}

