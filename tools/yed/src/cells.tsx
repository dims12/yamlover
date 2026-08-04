// yed2 CELLS — the recursive projection of the IR. ONE closed set of cell components, the same at
// every depth (requirement 3): NodeCell dispatches on the IR node kind and recurses through
// EntryCell. EVERY cell is visibly framed and titled with its kind (this is the debug editor —
// debug styling is the default, not a mode), the active cell carries the accent frame, a refused
// edit rings it, and a GAP is a visible slot, never a zero-width span.
//
// Cells hold NO state and NO grammar: editable cells are controlled inputs over the cursor's
// text; every keystroke goes up through `ctx.onKey` (dispatch.ts decides), every text change
// through `ctx.onText`, every click through `ctx.onFocus` (the cursor moves to the clicked
// position). What you see is `state`, all of it.

import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { Cursor, Document, Entry, Node, Path, Value } from "./state";
import { anchorDecorations, blockRawOf, bracketOf, isFlow, isSpread, schemaTextOf } from "./state";
import { isPointer, type Comment, type Pointer } from "../../parser/ts/src/ir.ts";
import { blockBodyOf, blockTextFrom, type Position } from "./apply";
import { rankHints, type Hint, type HintProvider } from "./complete";

export interface CellCtx {
  cursor: Cursor;
  refused: boolean;
  /** The DOCUMENT — a registered cell needing ancestor context (a server pointer cell
   *  computing its wire address) reads it here; "what you see is state, all of it". */
  doc: Document;
  /** The cell REGISTRY the projection dispatches through — recursion re-enters it. */
  cells: CellRegistry;
  /** The mounted root's SERVER addresses, set by a server host (yed-editor; a chapter source
   *  chunk sets its own): `base` = this EditorView's doc root on the wire, `doc` = the
   *  enclosing DOCUMENT root (the `*:` spelling base). Absent in the pure/debug editor. */
  host?: { base: string; doc: string };
  /** PICK actions for a server pointer cell — dropdown/TOC commits that bypass the key
   *  routing. Thin wrappers over the pure apply layer, funneled through the same setState
   *  (page.tsx builds them); a false return is the refusal ring, the cell keeps its text. */
  pick?: {
    /** commit the HOLE's text as a pointer (`raw` carries no `*`); false = refused */
    commitHole(raw: string): boolean;
    /** commit a RETARGET at the pick cursor's path; false = refused */
    commitAt(path: Path, raw: string): boolean;
    /** abandon the pick edit — back onto the atom, the document untouched */
    cancel(path: Path): void;
    /** the hole's `*` decision undone — back to the plain empty hole */
    dismantle(): void;
    /** the EMPTIED reference removed (the kit's floor Backspace) — removeLevel at its path */
    removeAt(path: Path): void;
  };
  /** False for an EMBEDDED editor that does not hold focus (a chapter source chunk): the
   *  active cell renders but must not STEAL the caret. Absent ⇒ true. */
  plantCaret?: boolean;
  onKey: (e: React.KeyboardEvent, edges?: { atStart: boolean; atEnd: boolean; firstLine?: boolean; lastLine?: boolean; offset?: number }) => void;
  onText: (text: string) => void;
  onFocus: (pos: Position) => void;
  /** A click on an IDLE portion cell of the reference being entered (the ref cursor): move
   *  the active cell there (apply.ts focusPortion). Absent: the cell is not clickable. */
  onPortion?: (index: number) => void;
  /** COMPLETION hints for the active portion cell (complete.ts) - advisory only, never a
   *  gate on typing. Absent: the portion cells draw no dropdown (the grammar is unchanged). */
  hints?: HintProvider;
  /** Open a fresh entry hole at (path, index) — the ＋ tail affordance's click. Absent ⇒ the
   *  affordance is not drawn (embedded/test mounts that do not want the extra row). */
  onAppend?: (path: Path, index: number) => void;
}

// ---------------------------------------------------------------------------- //
// THE CELL REGISTRY — the plug point for other projections (prose, formats)
// ---------------------------------------------------------------------------- //

export interface ValueCellProps {
  node: Value; // Node | Pointer — pointers ride the same table
  path: Path;
  ctx: CellCtx;
  trailingComma?: boolean; // flow layout: the comma drawn inside a spread child's closer row
  lead?: ReactNode;        // the key fragment a spread child pulls into its first row
}
export type ValueCellComponent = (props: ValueCellProps) => ReactNode;

/** Lookup precedence: the node's derived FORMAT first (a math or prose format plugs a cell
 *  without touching kinds), then the IR kind, then the total fallback.
 *  THE CONTRACT (the never-locked laws): a registered cell MUST draw a focusable cell for
 *  every position `positionsOf` yields inside its subtree — a position no cell draws must
 *  not exist. Registered cells recurse by rendering `<NodeCell node={child} …/>`; the ctx
 *  carries this registry, so recursion re-enters the table. */
export interface CellRegistry {
  readonly byFormat: Readonly<Record<string, ValueCellComponent>>;
  readonly byKind: Partial<Readonly<Record<"scalar" | "mapping" | "blob" | "pointer", ValueCellComponent>>>;
  readonly fallback: ValueCellComponent;
  /** The HOLE's `*`-led face — a server registry mounts the PICK query kit here (candidates,
   *  the scope ladder, TOC insertion); absent ⇒ the plain input keeps accumulating the raw
   *  and commit parses-or-refuses (the pure face). Never consulted at the root-VALUE hole —
   *  a pointer cannot BE the document. */
  readonly holePick?: (props: { ctx: CellCtx }) => ReactNode;
}

export function cellFor(v: Value, reg: CellRegistry): ValueCellComponent {
  const fmt = !isPointer(v) ? (v.meta as { derivedFormat?: string } | undefined)?.derivedFormat : undefined;
  if (fmt !== undefined && reg.byFormat[fmt]) return reg.byFormat[fmt];
  return reg.byKind[isPointer(v) ? "pointer" : (v.kind as "scalar" | "mapping" | "blob")] ?? reg.fallback;
}

const pathEq = (a: Path, b: Path): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The scalar's TONE — the renderer's .s/.n/.b/.null color vocabulary, decided by the VALUE
 *  (the same classification render.tsx's scalarNode makes). Carried on the Cell wrapper so the
 *  active input inherits the token's color while editing. */
const toneOf = (v: unknown): "s" | "n" | "b" | "null" =>
  v === null ? "null" : typeof v === "boolean" ? "b" : typeof v === "number" ? "n" : "s";

/** The uniform cell wrapper: frame + kind caption; accent when active; ring when refused.
 *  EXPORTED — the CHAPTER projection's cells wrap through this same component, so the whole
 *  y2-debug/y2-plain CSS contract (frames, captions, accents, the ring) is one and shared.
 *  `pos` stamps data-at/data-path (the positions-law-in-DOM tests); `badge` rides inside the
 *  caption ("chapter · wrapped"); `block` marks display:block cells (titles, chunks, sections);
 *  `tone` is the scalar color class (`y2-s` …) the renderer's palette keys on. */
export function Cell({ kind, active, refused, pos, badge, block, tone, children }: {
  kind: string; active: boolean; refused: boolean;
  pos?: { at: string; path: Path };
  badge?: ReactNode;
  block?: boolean;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={"y2-cell y2-" + kind + (tone ? " y2-" + tone : "") + (block ? " y2-block" : "") + (active ? " y2-active" : "") + (active && refused ? " y2-refused" : "")}
      data-kind={kind}
      data-at={pos?.at}
      data-path={pos ? pos.path.join(".") : undefined}
    >
      <span className="y2-tag">{kind}{badge != null && <span className="y2-badge"> · {badge}</span>}</span>
      {children}
    </span>
  );
}

/** A controlled inline input sized to its content — native caret, selection, text copy/paste.
 *  `caret` places the caret on the side the cursor ARRIVED from (movement stamps it). */
function CellInput({ value, ctx, autoFocus, caret }: { value: string; ctx: CellCtx; autoFocus: boolean; caret?: "start" | "end" | number }) {
  return (
    <input
      className="y2-input"
      value={value}
      size={Math.max(1, value.length)}
      ref={(el) => {
        if (el && autoFocus && ctx.plantCaret !== false && document.activeElement !== el) {
          el.focus();
          if (caret !== undefined) {
            const n = caret === "end" ? el.value.length : caret === "start" ? 0 : Math.min(caret, el.value.length);
            el.setSelectionRange(n, n);
          }
        }
      }}
      onChange={(e) => ctx.onText(e.target.value)}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        ctx.onKey(e, { atStart: el.selectionStart === 0, atEnd: el.selectionEnd === el.value.length, offset: el.selectionStart ?? el.value.length });
      }}
    />
  );
}

/** The list DASH — the renderer's `.yaml-dash`: scaled in place, one-cell column kept. The
 *  outer span still reads `"- "` (tests and copy see the source text). */
const DashMark = () => <span className="y2-punct"><span className="y2-dash">-</span> </span>;

// ---- COMMENT CHROME — read-only rows/spans, the renderer's `.c` face. Plain DOM: no Cell
// wrapper, no pos stamps, no tabIndex — the caret walk cannot land here by construction. ---- //

const fmtComment = (t: string): string => "# " + t.trim(); // the renderer's spelling (render.tsx fmtComment)

/** Own-line `# …` rows (an entry's leading comments, a container's tail block). */
const CommentRows = ({ texts, rowClass, keyPrefix }: { texts: string[]; rowClass: string; keyPrefix: string }): ReactNode =>
  texts.map((t, i) => (
    <div key={`${keyPrefix}${i}`} className={rowClass + " y2-comment-row"}>
      <span className="y2-comment">{fmtComment(t)}</span>
    </div>
  ));

/** The blank source line kept as vertical rhythm. */
const BlankRow = ({ k }: { k: string }): ReactNode => <div key={k} className="y2-row y2-blankline" />;

const commentsOf = (meta: unknown, placement: "leading" | "trailing"): string[] =>
  (((meta ?? {}) as { comments?: Comment[] }).comments ?? []).filter((c) => c.placement === placement).map((c) => c.text);

/** A row's trailing `# …` remark — rides the row's end, offset toward the comment column. */
const TrailSpan = ({ texts }: { texts: string[] }): ReactNode =>
  texts.length === 0 ? null : <span className="y2-comment y2-trail">{texts.map(fmtComment).join(" ")}</span>;

/** The PORTION CELLS of a reference being entered (the cursor's RefEntry): the `*` sigil, the
 *  scope ladder's colons, then one cell per portion with `:` separators - the ACTIVE cell is
 *  the live input, the others focusable spans (a click moves the active cell there, the arrow
 *  walk crosses commitlessly). The same face serves the hole (a new reference) and the pick
 *  (a retarget); the grammar lives in dispatch.ts ("portion"), never here. */
function PortionCells({ ctx }: { ctx: CellCtx }) {
  const c = ctx.cursor;
  const r = (c.at === "hole" || c.at === "pick") ? c.ref : undefined;
  // COMPLETION over the active cell - advisory UI state, never document state (the hint list
  // and the highlight live here; picking one only replaces the cell's text via onText)
  const [items, setItems] = useState<Hint[]>([]);
  const [sel, setSel] = useState(-1);
  const active = r?.active ?? 0;
  const text = r !== undefined ? (c as { text: string }).text : "";
  const left = r !== undefined ? r.portions.slice(0, active).join("\u0000") : "";
  const holder = c.at === "pick" ? c.path.slice(0, -1) : c.at === "hole" ? c.path : [];
  useEffect(() => {
    setSel(-1);
    const clear = (): void => setItems((prev) => (prev.length === 0 ? prev : []));
    if (r === undefined || ctx.hints === undefined) { clear(); return; }
    let live = true;
    const q = { ladder: r.ladder, portions: r.portions.slice(0, active), prefix: text, path: holder, doc: ctx.doc, host: ctx.host };
    Promise.resolve(ctx.hints(q)).then((h) => { if (live) setItems(rankHints(h, text)); }, () => { if (live) clear(); });
    return () => { live = false; };
    // ctx.hints stays OUT of the deps deliberately: a host may pass an inline provider (a fresh
    // identity every render), and re-querying is only meaningful when the typed context moved
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, active, left, r?.ladder, r === undefined, holder.join(".")]);
  if ((c.at !== "hole" && c.at !== "pick") || !c.ref) return null;
  const pick = (h: Hint): void => { ctx.onText(h.insert); setSel(-1); };
  // the dropdown's keys ride BEFORE the grammar - only while a hint list is up, and only the
  // keys the list claims (vertical walk, Enter on a HIGHLIGHTED row, Escape); everything else
  // falls through to ctx.onKey untouched - hints never gate typing
  const hctx: CellCtx = items.length === 0 ? ctx : {
    ...ctx,
    onKey: (e, edges) => {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % items.length); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s <= 0 ? items.length - 1 : s - 1)); return; }
        if (e.key === "Enter" && sel >= 0) { e.preventDefault(); pick(items[sel]); return; }
        if (e.key === "Escape" && sel >= 0) { e.preventDefault(); setSel(-1); return; }
      }
      ctx.onKey(e, edges);
    },
  };
  return (
    <span className="y2-p y2-pick y2-portions">
      <span className="y2-punct">*</span>
      {r!.ladder > 0 && <span className="y2-punct y2-scope">{":".repeat(r!.ladder)}</span>}
      {r!.portions.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="y2-punct">: </span>}
          {i === r!.active
            ? <span className="y2-portionwrap">
                <CellInput value={text} ctx={hctx} autoFocus caret={c.caret} />
                {items.length > 0 && (
                  <span className="y2-hints" data-testid="y2-hints">
                    {items.map((h, j) => (
                      <span
                        key={j}
                        className={"y2-hint" + (j === sel ? " y2-hint-sel" : "")}
                        onMouseDown={(e) => { e.preventDefault(); pick(h); }}
                      >
                        <span className="y2-hint-insert">{h.label ?? h.insert}</span>
                        {h.detail !== undefined && <span className="y2-hint-detail">{h.detail}</span>}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            : <span
                className="y2-v y2-portion"
                tabIndex={0}
                onFocus={() => ctx.onPortion?.(i)}
              >{p === "" ? "\u00a0" : p}</span>}
        </Fragment>
      ))}
    </span>
  );
}

/** The HOLE — the entry being typed (it exists only in the cursor). Shows the named key when
 *  `k: ` already fixed it. */
function HoleCell({ ctx }: { ctx: CellCtx }) {
  const c = ctx.cursor;
  if (c.at !== "hole") return null;
  // the `*` decision made (the ref cursor): a REFERENCE entered as PORTION cells - a server
  // registry may project the PICK kit (completion hints) over the same cursor state instead
  if (c.ref) {
    if (ctx.cells.holePick) return <>{ctx.cells.holePick({ ctx })}</>;
    return (
      <Cell kind="pointer" active refused={ctx.refused}>
        {c.ordinal === true && <DashMark />}
        {c.key !== null && <span className="y2-k">{c.key}: </span>}
        <PortionCells ctx={ctx} />
      </Cell>
    );
  }
  return (
    <Cell kind="hole" active refused={ctx.refused}>
      {c.ordinal === true && <DashMark />}
      {c.key !== null && <span className="y2-k">{c.key}: </span>}
      <CellInput value={c.text} ctx={ctx} autoFocus caret={c.caret} />
    </Cell>
  );
}

/** A GAP — the position past a token's closer: a VISIBLE slot (▏), clickable and focusable. */
function GapCell({ path, ctx }: { path: Path; ctx: CellCtx }) {
  const active = ctx.cursor.at === "after" && pathEq(ctx.cursor.path, path);
  return (
    <Cell kind="gap" active={active} refused={ctx.refused}>
      <button
        className="y2-gapslot"
        ref={(el) => { if (el && active && ctx.plantCaret !== false && document.activeElement !== el) el.focus(); }}
        onFocus={() => { if (!active) ctx.onFocus({ at: "after", path }); }}
        onKeyDown={(e) => ctx.onKey(e)}
      >
        ▏
      </button>
    </Cell>
  );
}

/** The BLOCK body's textarea — native newlines, selection, paste; every keystroke still goes up
 *  through `ctx.onKey` with FULL edges (line edges included — vertical arrows leave the cell
 *  only from an edge line). The value is the DE-INDENTED body; the header is chrome. */
function BlockInput({ header, body, ctx, autoFocus, caret }: { header: string; body: string; ctx: CellCtx; autoFocus: boolean; caret?: "start" | "end" }) {
  const lines = body.split("\n");
  const cols = Math.max(8, ...lines.map((l) => l.length)) + 1;
  return (
    <textarea
      className="y2-blocktext"
      value={body}
      rows={Math.max(1, lines.length)}
      cols={cols}
      ref={(el) => {
        if (el && autoFocus && ctx.plantCaret !== false && document.activeElement !== el) {
          el.focus();
          if (caret) { const n = caret === "end" ? el.value.length : 0; el.setSelectionRange(n, n); }
        }
      }}
      onChange={(e) => ctx.onText(blockTextFrom(header, e.target.value))}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        const s = el.selectionStart ?? 0;
        const en = el.selectionEnd ?? el.value.length;
        ctx.onKey(e, {
          atStart: s === 0,
          atEnd: en === el.value.length,
          firstLine: !el.value.slice(0, s).includes("\n"),
          lastLine: !el.value.slice(en).includes("\n"),
        });
      }}
    />
  );
}

function TokenCell({ node, path, ctx, lead }: { node: Node; path: Path; ctx: CellCtx; lead?: ReactNode }) {
  const active = ctx.cursor.at === "token" && pathEq(ctx.cursor.path, path);
  const block = blockRawOf(node);
  // the ACTIVE block face keys on the CURSOR's spelling (an emptied body is a bare `|-` with no
  // newline; a plain scalar being retyped never flips — the node itself must be a block)
  const cursorText = active ? (ctx.cursor as { text: string }).text : null;
  const activeBlock = cursorText !== null && (cursorText.includes("\n") || block !== null) ? blockBodyOf(cursorText) : null;
  if (activeBlock !== null) {
    return (
      <Cell kind="token" active refused={ctx.refused} tone={toneOf((node as { value?: unknown }).value)}>
        <div className="y2-rows">
          <div className="y2-row">{lead}<span className="y2-punct">{activeBlock.header}</span></div>
          <div className="y2-row y2-indent y2-blockrow">
            <BlockInput header={activeBlock.header} body={activeBlock.body} ctx={ctx} autoFocus caret={(ctx.cursor as { caret?: "start" | "end" }).caret} />
          </div>
        </div>
      </Cell>
    );
  }
  if (!active && block !== null) {
    // the READ face of a `|` / `>` scalar — the renderer's shape: the authored header on the
    // owner's row, the body lines one step in (the ONE focusable is the header — the cell's
    // single position; a body click walks in through it)
    return (
      <Cell kind="token" active={false} refused={ctx.refused} tone={toneOf((node as { value?: unknown }).value)}>
        <div className="y2-rows">
          <div className="y2-row">
            {lead}
            <span className="y2-punct" tabIndex={0} onFocus={() => ctx.onFocus({ at: "token", path })}>{block.header}</span>
          </div>
          {block.lines.map((l, i) => (
            <div key={i} className="y2-row y2-indent" onMouseDown={() => ctx.onFocus({ at: "token", path })}>
              <span className="y2-v">{l === "" ? " " : l}</span>
            </div>
          ))}
        </div>
      </Cell>
    );
  }
  // a NULL value with no authored raw still shows its face — the renderer spells it `null`
  // (an invisible value would be a wall to the eye, if not to the caret)
  const raw = (node as { raw?: string }).raw;
  const value = (node as { value?: unknown }).value;
  const display = String(raw ?? (value === null ? "null" : value ?? ""));
  return (
    <Cell kind="token" active={active} refused={ctx.refused} tone={toneOf(value)}>
      {lead}
      {active
        ? <CellInput value={(ctx.cursor as { text: string }).text} ctx={ctx} autoFocus caret={(ctx.cursor as { caret?: "start" | "end" }).caret} />
        : <span className="y2-v" tabIndex={0} onFocus={() => ctx.onFocus({ at: "token", path })}>{display}</span>}
    </Cell>
  );
}

function KeyCell({ entry, path, ctx }: { entry: Entry; path: Path; ctx: CellCtx }) {
  const active = ctx.cursor.at === "key" && pathEq(ctx.cursor.path, path);
  return (
    <Cell kind="key" active={active} refused={ctx.refused}>
      {active
        ? <CellInput value={(ctx.cursor as { text: string }).text} ctx={ctx} autoFocus caret={(ctx.cursor as { caret?: "start" | "end" }).caret} />
        : <span className="y2-k" tabIndex={0} onFocus={() => ctx.onFocus({ at: "key", path })}>{String(entry.key)}</span>}
    </Cell>
  );
}

/** A pointer ATOM: walkable, focusable, deletable — typing into it rings; Enter opens the
 *  PICK face (the `pick` cursor), a plain input over the pointer's RAW that commits
 *  parses-or-refuses. The caret stands ON the atom, IN the pick input. */
function PointerCell({ node, path, ctx }: ValueCellProps) {
  const picking = ctx.cursor.at === "pick" && pathEq(ctx.cursor.path, path);
  const active = picking || (ctx.cursor.at === "ptr" && pathEq(ctx.cursor.path, path));
  const refCursor = picking && (ctx.cursor as { ref?: unknown }).ref !== undefined;
  return (
    <Cell kind="pointer" active={active} refused={ctx.refused} pos={{ at: "ptr", path }}>
      {refCursor
        ? <PortionCells ctx={ctx} />
        : picking
        ? <span className="y2-p y2-pick">
            <span className="y2-punct">*</span>
            <CellInput value={(ctx.cursor as { text: string }).text} ctx={ctx} autoFocus caret={(ctx.cursor as { caret?: "start" | "end" }).caret} />
          </span>
        : <span
            className="y2-p"
            tabIndex={0}
            ref={(el) => { if (el && active && ctx.plantCaret !== false && document.activeElement !== el) el.focus(); }}
            onFocus={() => { if (!active) ctx.onFocus({ at: "ptr", path }); }}
            onKeyDown={(e) => ctx.onKey(e)}
          >
            *{(node as Pointer as { raw?: string }).raw ?? ""}
          </span>}
    </Cell>
  );
}

/** The container: brackets, entries, the hole (when the cursor's hole lives here), the gap after.
 *  A SPREAD container (or one inside a spread — json5p expands everything) lays out one entry per
 *  row; a flow one stays inline; a BLOCK one is rows with `- ` / `k: ` markers. */
function ContainerCell({ node, path, ctx, trailingComma = false, lead, valueRow, indentEntries = false }: { node: Node; path: Path; ctx: CellCtx; trailingComma?: boolean; lead?: ReactNode; valueRow?: { at: number; el: ReactNode }; indentEntries?: boolean }) {
  const flow = isFlow(node);
  // PER-CONTAINER LAYOUT: a container spreads only by ITS OWN bit. A new token inside a spread
  // one defaults to ONE LINE; its own Enter spreads it (and spreading propagates UPWARD — apply
  // enforces that a one-liner never contains a multi-liner).
  const spread = isSpread(node);
  const entries = node.entries ?? [];
  const holeHere = ctx.cursor.at === "hole" && pathEq(ctx.cursor.path, path);
  const holeIndex = holeHere ? (ctx.cursor as { index: number }).index : -1;

  // Each item knows whether its separating comma must live INSIDE it: a MULTI-ROW child draws
  // the comma on its own closer row (`},` — K&R), because no parent-row alignment can put a
  // sibling span onto a nested block's last line. Single-line items take the parent's comma.
  const mkItems = (withCommas: boolean): { el: ReactNode; commaInside: boolean; entry?: number; hole?: boolean }[] => {
    const out: { el: ReactNode; commaInside: boolean; entry?: number; hole?: boolean }[] = [];
    const total = entries.length + (holeHere ? 1 : 0);
    let slot = 0;
    for (let i = 0; i <= entries.length; i++) {
      if (holeHere && i === holeIndex) { out.push({ el: <HoleCell key="hole" ctx={ctx} />, commaInside: false, entry: holeIndex, hole: true }); slot++; }
      if (i === entries.length) break;
      const e = entries[i];
      const p = [...path, i];
      const childSpread = !isPointer(e.value) && (e.value as Node).kind === "mapping" && isSpread(e.value as Node);
      const wantComma = withCommas && childSpread && slot < total - 1;
      // the entry's lead marker: `k: ` for a named entry, `- ` for a keyless one in BLOCK rows
      // (flow keyless entries take no marker — the commas separate them). A DERIVED-anchor
      // member (a dir-backed pointer array's positional entry — meta.anchorKey) shows its
      // wire name as a dimmed read-only chip: `- &key value`. Decoration, never a cell.
      const anchorKey = e.key == null ? (e.meta as { anchorKey?: string } | undefined)?.anchorKey : undefined;
      const keyFrag = e.key != null
        ? <><KeyCell entry={e} path={p} ctx={ctx} /><span className="y2-punct">: </span></>
        : !flow
          ? <><DashMark />{anchorKey !== undefined && <span className="y2-anchor-derived" data-yo-chrome>&{anchorKey} </span>}</>
          : null;
      // a KEYED entry holding a BLOCK container WRAPS: the key alone on its row, the child's
      // rows BELOW it, indented one step — `children:` / `  - name: Europe`. (A keyless `- `
      // entry keeps the compact form: the child's first row rides the dash.)
      const childBlock = !isPointer(e.value) && (e.value as Node).kind === "mapping" && !isFlow(e.value as Node);
      // an OMNI child (scalar with fields, or the hole descended into one) — and a BLOCK-SCALAR
      // child (`|` / `>`) — take the marker INTO their first row so their body rows sit one
      // step in: `key1: value1` / `  - sub`, `text: |` / `  line one` — the serializer's
      // columns, not a hang at the key's text column
      const childOmni = !flow && !isPointer(e.value) && (e.value as Node).kind === "scalar"
        && (((e.value as Node).entries ?? []).length > 0
          || (ctx.cursor.at === "hole" && pathEq(ctx.cursor.path, p))
          || blockRawOf(e.value) !== null);
      out.push({
        el: (
          <Fragment key={i}>
            {/* a SPREAD child takes the key INTO its first row (`children: [`) so its body rows
                come back to the container's own indent — K&R, not a hang at the key's column */}
            {childSpread || childOmni
              ? <NodeCell node={e.value as Node} path={p} ctx={ctx} trailingComma={wantComma} lead={keyFrag} />
              : childBlock && e.key != null && !flow
                ? <div className="y2-rows">
                    <div className="y2-row">{keyFrag}</div>
                    <div className="y2-row y2-indent"><NodeCell node={e.value as Node} path={p} ctx={ctx} /></div>
                  </div>
                : <>
                    {keyFrag}
                    <NodeCell node={e.value} path={p} ctx={ctx} trailingComma={wantComma} />
                  </>}
          </Fragment>
        ),
        commaInside: wantComma,
        entry: i,
      });
      slot++;
    }
    return out;
  };
  const items: ReactNode[] = mkItems(false).map((x) => x.el);

  if (!flow) {
    // BLOCK: one row per entry (marker drawn by position), the hole as its own row. An EMPTY
    // block container draws its PLACEHOLDER slot — a clickable, focusable way back into the
    // value (`children:` with nothing yet must never be a wall).
    const itemRows = mkItems(false);
    const rows: ReactNode[] = [];
    let placedValue = false;
    // the LEAD (a key/dash marker routed into this container) rides the FIRST content row — for
    // an omni that is its self row, so field rows can indent one step below it. Comment/blank
    // chrome rows never take it.
    let leadPlaced = lead == null;
    const takeLead = (): ReactNode => { if (leadPlaced) return null; leadPlaced = true; return lead; };
    const entryRowClass = "y2-row" + (indentEntries ? " y2-indent" : "");
    const selfTrail = <TrailSpan texts={commentsOf(node.meta, "trailing")} />;
    for (let i = 0; i < itemRows.length; i++) {
      const it = itemRows[i];
      // an OMNI's value line sits at its AUTHORED position among the rows (`meta.selfAt`)
      if (valueRow && !placedValue && it.entry !== undefined && it.entry >= valueRow.at) {
        rows.push(<div key="self" className="y2-row">{takeLead()}{valueRow.el}{selfTrail}</div>);
        placedValue = true;
      }
      // the entry's DECORATIONS — its blank separator, its own-line leading comments, its
      // trailing remark — read-only chrome around the entry's row
      const e = it.hole !== true && it.entry !== undefined ? entries[it.entry] : undefined;
      const em = e?.meta as { blankBefore?: boolean } | undefined;
      if (em?.blankBefore === true) rows.push(<BlankRow key={`blank${i}`} k={`blank${i}`} />);
      const leading = e !== undefined ? commentsOf(e.meta, "leading") : [];
      if (leading.length > 0) rows.push(<CommentRows key={`lc${i}`} texts={leading} rowClass={entryRowClass} keyPrefix={`lc${i}-`} />);
      const trailing = e !== undefined ? commentsOf(e.meta, "trailing") : [];
      const isLeadRow = !leadPlaced;
      rows.push(
        <div key={i} className={isLeadRow ? "y2-row" : entryRowClass}>
          {takeLead()}
          {trailing.length > 0 ? <span className="y2-rowmain">{it.el}</span> : it.el}
          <TrailSpan texts={trailing} />
        </div>,
      );
    }
    if (valueRow && !placedValue) rows.push(<div key="self" className="y2-row">{takeLead()}{valueRow.el}{selfTrail}</div>);
    // an EMPTY container keeps its PLACEHOLDER slot even when comment chrome exists — the way
    // back into the value must never be a wall
    const hasContent = itemRows.length > 0 || valueRow !== undefined;
    if (!hasContent) {
      rows.push(
        <div key="into" className="y2-row">
          <button
            className="y2-gapslot"
            onFocus={() => ctx.onFocus({ at: "into", path })}
            onKeyDown={(e) => ctx.onKey(e)}
          >
            ▏
          </button>
        </div>,
      );
    }
    // the container's TAIL block — comments after the last entry, the serializer's tail rule
    const tail = commentsOf(node.meta, "leading");
    if (tail.length > 0) rows.push(<CommentRows key="tail" texts={tail} rowClass={entryRowClass} keyPrefix="tail-" />);
    return (
      <Cell kind="block" active={false} refused={false}>
        <div className="y2-rows">{rows}</div>
      </Cell>
    );
  }
  const open = bracketOf(node);
  const close = open === "[" ? "]" : "}";
  const body = items.flatMap((it, i) => (i > 0 ? [<span key={"c" + i} className="y2-punct">, </span>, it] : [it]));
  // an EMPTY flow container draws its INNER slot — clickable, focusable, the way back between
  // the brackets (`{}` must never be a wall)
  const innerSlot = entries.length === 0 && !holeHere
    ? <button className="y2-gapslot y2-inner" onFocus={() => ctx.onFocus({ at: "into", path })} onKeyDown={(e) => ctx.onKey(e)}>▏</button>
    : null;
  return (
    <Cell kind={open === "[" ? "seq" : "map"} active={false} refused={false}>
      {spread ? (
        <div className="y2-rows">
          <div className="y2-row">{lead}<span className="y2-punct">{open}</span></div>
          {innerSlot && <div className="y2-row y2-indent">{innerSlot}</div>}
          {mkItems(true).map((it, i, all) => (
            <div key={i} className="y2-row y2-indent">
              {it.el}
              {i < all.length - 1 && !it.commaInside && <span className="y2-punct">,</span>}
            </div>
          ))}
          <div className="y2-row">
            <span className="y2-punct">{close}</span>
            {trailingComma && <span className="y2-punct">,</span>}
            <GapCell path={path} ctx={ctx} />
          </div>
        </div>
      ) : (
        <>
          <span className="y2-punct">{open}</span>
          {innerSlot}
          {body}
          <span className="y2-punct">{close}</span>
          {trailingComma && <span className="y2-punct">,</span>}
          <GapCell path={path} ctx={ctx} />
        </>
      )}
    </Cell>
  );
}

/** The SCALAR cell: a plain token, or — with fields or the descended-into hole — the OMNI form:
 *  the value line AT ITS AUTHORED POSITION (`meta.selfAt`) among the field rows; the hole among
 *  them stays VISIBLE, so the caret can never stand in a cell the projection does not draw. */
function ScalarCell({ node: v, path, ctx, lead }: ValueCellProps) {
  const node = v as Node;
  const holeHere = ctx.cursor.at === "hole" && pathEq(ctx.cursor.path, path);
  if ((node.entries ?? []).length === 0 && !holeHere) return <TokenCell node={node} path={path} ctx={ctx} lead={lead} />;
  return (
    <Cell kind="omni" active={false} refused={false}>
      <ContainerCell
        node={node}
        path={path}
        ctx={ctx}
        lead={lead}
        indentEntries={path.length > 0}
        valueRow={{ at: (node.meta as { selfAt?: number } | undefined)?.selfAt ?? 0, el: <TokenCell node={node} path={path} ctx={ctx} /> }}
      />
    </Cell>
  );
}

/** An opaque ATOM cell (blobs, unknown kinds): focusable and walkable like a pointer — never a
 *  wall — but with nothing to edit; the label names what it is. */
function OpaqueAtomCell({ node, path, ctx }: ValueCellProps) {
  const active = ctx.cursor.at === "ptr" && pathEq(ctx.cursor.path, path);
  const label = isPointer(node) ? "pointer" : node.kind;
  return (
    <Cell kind={String(label)} active={active} refused={ctx.refused}>
      <span
        className="y2-p"
        tabIndex={0}
        ref={(el) => { if (el && active && ctx.plantCaret !== false && document.activeElement !== el) el.focus(); }}
        onFocus={() => { if (!active) ctx.onFocus({ at: "ptr", path }); }}
        onKeyDown={(e) => ctx.onKey(e)}
      >
        ({String(label)})
      </span>
    </Cell>
  );
}

/** The default table — exactly the closed set the debug editor ships. */
export const defaultRegistry: CellRegistry = {
  byFormat: {},
  byKind: {
    scalar: ScalarCell,
    mapping: ({ node, path, ctx, trailingComma, lead }) =>
      <ContainerCell node={node as Node} path={path} ctx={ctx} trailingComma={trailingComma} lead={lead} />,
    pointer: PointerCell,
    blob: OpaqueAtomCell,
  },
  fallback: OpaqueAtomCell,
};

/** The node's editable `!!<…>` TAG cell — the KeyCell pattern over the tag's INNER text: the
 *  wrapper punctuation is chrome, the content is a controlled input while active, a focusable
 *  face otherwise. Rendered whenever the node HAS a tag — or while the cursor's PENDING tag
 *  (a typed `!!<`) stands on this node, the hole doctrine's "incompleteness lives in the cursor". */
function TagCell({ node, path, ctx }: { node: Value; path: Path; ctx: CellCtx }) {
  const active = ctx.cursor.at === "tag" && pathEq(ctx.cursor.path, path);
  const inner = schemaTextOf(node);
  if (inner === null && !active) return null;
  return (
    <Cell kind="tag" active={active} refused={ctx.refused} pos={{ at: "tag", path }}>
      <span className="y2-decor" data-yo-chrome>{"!!<"}</span>
      {active
        ? <CellInput value={(ctx.cursor as { text: string }).text} ctx={ctx} autoFocus caret={(ctx.cursor as { caret?: "start" | "end" }).caret} />
        : <span className="y2-v y2-tagtext" tabIndex={0} onFocus={() => ctx.onFocus({ at: "tag", path })}>{inner}</span>}
      <span className="y2-decor" data-yo-chrome>{"> "}</span>
    </Cell>
  );
}

/** The node's `!!yo` / `!!set` marks — read-only chrome (semantic, not text-editable here). */
function MarkChrome({ node }: { node: Value }) {
  if (isPointer(node)) return null;
  const m = ((node as Node).meta ?? {}) as { yo?: boolean; set?: boolean };
  const marks = [m.yo === true ? "!!yo" : null, m.set === true ? "!!set" : null].filter((x): x is string => x !== null);
  if (marks.length === 0) return null;
  return <span className="y2-decor" data-yo-chrome>{marks.join(" ")} </span>;
}

/** The node's `&` ANCHOR rows — ONE walk stop after the value (the canonical M3 side), each
 *  row an editable body (the `&` is chrome), plus a trailing dim ADD slot. The cursor's
 *  `index` names the active row; clicking any row moves it there. */
function AnchorsCell({ node, path, ctx }: { node: Value; path: Path; ctx: CellCtx }) {
  const bodies = anchorDecorations(node).map((t) => t.slice(1)); // tokens carry the `&`; rows edit the BODY
  const activeHere = ctx.cursor.at === "anchors" && pathEq(ctx.cursor.path, path);
  const activeIndex = activeHere ? (ctx.cursor as { index: number }).index : -1;
  if (bodies.length === 0 && !activeHere) return null;
  const row = (i: number, body: string | null): ReactNode => (
    <span key={i} className="y2-anchor-row">
      <span className="y2-decor" data-yo-chrome>{" &"}</span>
      {activeIndex === i
        ? <CellInput value={(ctx.cursor as { text: string }).text} ctx={ctx} autoFocus caret={(ctx.cursor as { caret?: "start" | "end" }).caret} />
        : <span className={body === null ? "y2-decor y2-anchor-add" : "y2-v"} tabIndex={0}
            onFocus={() => ctx.onFocus({ at: "anchors", path, index: i })}>{body ?? "+"}</span>}
    </span>
  );
  return (
    <Cell kind="anchors" active={activeHere} refused={ctx.refused} pos={{ at: "anchors", path }}>
      {bodies.map((b, i) => row(i, b))}
      {row(bodies.length, null) /* the ADD slot — commit a body here to append an anchor */}
    </Cell>
  );
}

/** THE closed set's root: dispatch through the REGISTRY (ctx.cells), recurse. Every node wears
 *  its identity cells/chrome here — ONE site, uniform across kinds and custom registry cells. */
export function NodeCell({ node, path, ctx, trailingComma = false, lead }: ValueCellProps) {
  const C = cellFor(node, ctx.cells);
  const decorated = (() => {
    if (isPointer(node)) return false;
    const meta = ((node as Node).meta ?? {}) as { schema?: unknown; yo?: boolean; set?: boolean; anchors?: unknown[] };
    const tagActiveHere = ctx.cursor.at === "tag" && pathEq(ctx.cursor.path, path);
    return meta.schema !== undefined || tagActiveHere || meta.yo === true || meta.set === true || (meta.anchors ?? []).length > 0;
  })();
  if (!decorated) return <C node={node} path={path} ctx={ctx} trailingComma={trailingComma} lead={lead} />;
  const chrome = (
    <>
      <TagCell node={node} path={path} ctx={ctx} />
      <MarkChrome node={node} />
    </>
  );
  // a ROUTED marker (`k: ` / `- ` in `lead`) keeps the source order — the identity chrome rides
  // AFTER it, inside the child's first row (`key: !!<tag> value`), exactly where the read
  // renderer's decoSpan puts it
  if (lead !== undefined) {
    return (
      <>
        <C node={node} path={path} ctx={ctx} trailingComma={trailingComma} lead={<>{lead}{chrome}</>} />
        <AnchorsCell node={node} path={path} ctx={ctx} />
      </>
    );
  }
  // THE ROOT DECO LAW (the renderer's RootDeco): at the VIEWED ROOT — and before any multi-row
  // cell — the chrome stands on ITS OWN LINE, and the value's rows return to the parent column.
  // Inline chrome before an inline-block of rows anchors EVERY row at the chrome's right edge:
  // the whole document body hung at the tag's column (the reported giant left margin).
  const n = node as Node;
  const blockShaped = n.kind === "mapping" ? !isFlow(n)
    : n.kind === "scalar" ? ((n.entries ?? []).length > 0 || blockRawOf(n) !== null || (ctx.cursor.at === "hole" && pathEq(ctx.cursor.path, path)))
    : false;
  if (path.length === 0 || blockShaped) {
    return (
      <>
        <div className="y2-row">{chrome}</div>
        <C node={node} path={path} ctx={ctx} trailingComma={trailingComma} />
        <AnchorsCell node={node} path={path} ctx={ctx} />
      </>
    );
  }
  return (
    <>
      {chrome}
      <C node={node} path={path} ctx={ctx} trailingComma={trailingComma} />
      <AnchorsCell node={node} path={path} ctx={ctx} />
    </>
  );
}

/** The document surface. */
export function DocCells({ doc, ctx }: { doc: Document; ctx: CellCtx }) {
  const root = doc.root as Node;
  const emptyBlock = root.kind === "mapping" && (root.entries ?? []).length === 0 && !isFlow(root);
  const holeAtRoot = ctx.cursor.at === "hole" && ctx.cursor.path.length === 0;
  // the FILE BANNER — head-of-file comments, set off from the body by the blank line they were
  // authored with (read-only chrome, like every comment row)
  const head = ((doc as { head?: Comment[] }).head ?? []).map((c) => c.text);
  return (
    <div className="y2-doc" data-testid="y2-doc">
      {head.length > 0 && (
        <div className="y2-rows">
          <CommentRows texts={head} rowClass="y2-row" keyPrefix="head-" />
          <BlankRow k="head-blank" />
        </div>
      )}
      {emptyBlock
        ? <>
            {/* an emptied data island keeps its FACE — the identity cells stand over the hole */}
            <TagCell node={root} path={[]} ctx={ctx} />
            <MarkChrome node={root} />
            {holeAtRoot ? <HoleCell ctx={ctx} /> : <span className="y2-empty">(empty document)</span>}
            <AnchorsCell node={root} path={[]} ctx={ctx} />
          </>
        : <NodeCell node={root} path={[]} ctx={ctx} />}
      {/* the ＋ TAIL — one click opens a fresh entry hole at the document's end (mouse-only
          chrome; the keyboard reaches the same hole through the walk). Hidden while that very
          hole is already open, and off flow roots (the token's own grammar appends). */}
      {ctx.onAppend !== undefined && !isFlow(root) && (root.entries ?? []).length > 0
        && !(holeAtRoot && (ctx.cursor as { index?: number }).index === (root.entries ?? []).length) && (
        <div className="y2-row">
          <button
            className="y2-tail"
            title="add an entry"
            onClick={() => ctx.onAppend!([], (root.entries ?? []).length)}
          >＋</button>
        </div>
      )}
    </div>
  );
}
