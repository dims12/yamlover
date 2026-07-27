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

import { Fragment, type ReactNode } from "react";
import type { Cursor, Document, Entry, Node, Path } from "./state";
import { bracketOf, isFlow, isSpread } from "./state";
import { isPointer } from "../../../../parser/ts/src/ir.ts";
import type { Position } from "./apply";

export interface CellCtx {
  cursor: Cursor;
  refused: boolean;
  onKey: (e: React.KeyboardEvent, edges?: { atStart: boolean; atEnd: boolean }) => void;
  onText: (text: string) => void;
  onFocus: (pos: Position) => void;
}

const pathEq = (a: Path, b: Path): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The uniform cell wrapper: frame + kind caption; accent when active; ring when refused. */
function Cell({ kind, active, refused, children }: { kind: string; active: boolean; refused: boolean; children: ReactNode }) {
  return (
    <span className={"y2-cell y2-" + kind + (active ? " y2-active" : "") + (active && refused ? " y2-refused" : "")} data-kind={kind}>
      <span className="y2-tag">{kind}</span>
      {children}
    </span>
  );
}

/** A controlled inline input sized to its content — native caret, selection, text copy/paste. */
function CellInput({ value, ctx, autoFocus }: { value: string; ctx: CellCtx; autoFocus: boolean }) {
  return (
    <input
      className="y2-input"
      value={value}
      size={Math.max(1, value.length)}
      ref={(el) => { if (el && autoFocus && document.activeElement !== el) el.focus(); }}
      onChange={(e) => ctx.onText(e.target.value)}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        ctx.onKey(e, { atStart: el.selectionStart === 0, atEnd: el.selectionEnd === el.value.length });
      }}
    />
  );
}

/** The HOLE — the entry being typed (it exists only in the cursor). Shows the named key when
 *  `k: ` already fixed it. */
function HoleCell({ ctx }: { ctx: CellCtx }) {
  const c = ctx.cursor;
  if (c.at !== "hole") return null;
  return (
    <Cell kind="hole" active refused={ctx.refused}>
      {c.key !== null && <span className="y2-k">{c.key}: </span>}
      <CellInput value={c.text} ctx={ctx} autoFocus />
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
        ref={(el) => { if (el && active && document.activeElement !== el) el.focus(); }}
        onFocus={() => { if (!active) ctx.onFocus({ at: "after", path }); }}
        onKeyDown={(e) => ctx.onKey(e)}
      >
        ▏
      </button>
    </Cell>
  );
}

function TokenCell({ node, path, ctx }: { node: Node; path: Path; ctx: CellCtx }) {
  const active = ctx.cursor.at === "token" && pathEq(ctx.cursor.path, path);
  const display = String((node as { raw?: string }).raw ?? (node as { value?: unknown }).value ?? "");
  return (
    <Cell kind="token" active={active} refused={ctx.refused}>
      {active
        ? <CellInput value={(ctx.cursor as { text: string }).text} ctx={ctx} autoFocus />
        : <span className="y2-v" tabIndex={0} onFocus={() => ctx.onFocus({ at: "token", path })}>{display}</span>}
    </Cell>
  );
}

function KeyCell({ entry, path, ctx }: { entry: Entry; path: Path; ctx: CellCtx }) {
  const active = ctx.cursor.at === "key" && pathEq(ctx.cursor.path, path);
  return (
    <Cell kind="key" active={active} refused={ctx.refused}>
      {active
        ? <CellInput value={(ctx.cursor as { text: string }).text} ctx={ctx} autoFocus />
        : <span className="y2-k" tabIndex={0} onFocus={() => ctx.onFocus({ at: "key", path })}>{String(entry.key)}</span>}
    </Cell>
  );
}

function PointerCell({ text }: { text: string }) {
  return <Cell kind="pointer" active={false} refused={false}><span className="y2-p">*{text}</span></Cell>;
}

/** The container: brackets, entries, the hole (when the cursor's hole lives here), the gap after.
 *  A SPREAD container (or one inside a spread — json5p expands everything) lays out one entry per
 *  row; a flow one stays inline; a BLOCK one is rows with `- ` / `k: ` markers. */
function ContainerCell({ node, path, ctx, spreadInherited }: { node: Node; path: Path; ctx: CellCtx; spreadInherited: boolean }) {
  const flow = isFlow(node);
  const spread = spreadInherited || isSpread(node);
  const entries = node.entries ?? [];
  const holeHere = ctx.cursor.at === "hole" && pathEq(ctx.cursor.path, path);
  const holeIndex = holeHere ? (ctx.cursor as { index: number }).index : -1;

  const items: ReactNode[] = [];
  for (let i = 0; i <= entries.length; i++) {
    if (holeHere && i === holeIndex) items.push(<HoleCell key="hole" ctx={ctx} />);
    if (i === entries.length) break;
    const e = entries[i];
    const p = [...path, i];
    items.push(
      <Fragment key={i}>
        {e.key != null && <><KeyCell entry={e} path={p} ctx={ctx} /><span className="y2-punct">: </span></>}
        {isPointer(e.value)
          ? <PointerCell text={(e.value as { raw?: string }).raw ?? ""} />
          : <NodeCell node={e.value as Node} path={p} ctx={ctx} spreadInherited={spread && flow} />}
      </Fragment>,
    );
  }

  if (!flow) {
    // BLOCK: one row per entry (marker drawn by position), the hole as its own row
    return (
      <Cell kind="block" active={false} refused={false}>
        <div className="y2-rows">
          {items.map((it, i) => <div key={i} className="y2-row">{it}</div>)}
        </div>
      </Cell>
    );
  }
  const open = bracketOf(node);
  const close = open === "[" ? "]" : "}";
  const body = items.flatMap((it, i) => (i > 0 ? [<span key={"c" + i} className="y2-punct">, </span>, it] : [it]));
  return (
    <Cell kind={open === "[" ? "seq" : "map"} active={false} refused={false}>
      {spread ? (
        <div className="y2-rows">
          <div className="y2-row"><span className="y2-punct">{open}</span></div>
          {items.map((it, i) => <div key={i} className="y2-row y2-indent">{it}{i < items.length - 1 && <span className="y2-punct y2-comma">,</span>}</div>)}
          <div className="y2-row"><span className="y2-punct">{close}</span><GapCell path={path} ctx={ctx} /></div>
        </div>
      ) : (
        <>
          <span className="y2-punct">{open}</span>
          {body}
          <span className="y2-punct">{close}</span>
          <GapCell path={path} ctx={ctx} />
        </>
      )}
    </Cell>
  );
}

/** THE closed set's root: dispatch by IR node kind, recurse. */
export function NodeCell({ node, path, ctx, spreadInherited = false }: { node: Node; path: Path; ctx: CellCtx; spreadInherited?: boolean }) {
  if (node.kind === "scalar" && (node.entries ?? []).length === 0) return <TokenCell node={node} path={path} ctx={ctx} />;
  if (node.kind === "mapping") return <ContainerCell node={node} path={path} ctx={ctx} spreadInherited={spreadInherited} />;
  return <Cell kind="other" active={false} refused={false}><span>({node.kind})</span></Cell>; // omni/blob: D3
}

/** The document surface. */
export function DocCells({ doc, ctx }: { doc: Document; ctx: CellCtx }) {
  const root = doc.root as Node;
  const emptyBlock = root.kind === "mapping" && (root.entries ?? []).length === 0 && !isFlow(root);
  const holeAtRoot = ctx.cursor.at === "hole" && ctx.cursor.path.length === 0;
  return (
    <div className="y2-doc" data-testid="y2-doc">
      {emptyBlock
        ? (holeAtRoot ? <HoleCell ctx={ctx} /> : <span className="y2-empty">(empty document)</span>)
        : <NodeCell node={root} path={[]} ctx={ctx} />}
    </div>
  );
}
