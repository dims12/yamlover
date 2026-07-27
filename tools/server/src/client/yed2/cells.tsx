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

/** A controlled inline input sized to its content — native caret, selection, text copy/paste.
 *  `caret` places the caret on the side the cursor ARRIVED from (movement stamps it). */
function CellInput({ value, ctx, autoFocus, caret }: { value: string; ctx: CellCtx; autoFocus: boolean; caret?: "start" | "end" }) {
  return (
    <input
      className="y2-input"
      value={value}
      size={Math.max(1, value.length)}
      ref={(el) => {
        if (el && autoFocus && document.activeElement !== el) {
          el.focus();
          if (caret) { const n = caret === "end" ? el.value.length : 0; el.setSelectionRange(n, n); }
        }
      }}
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
      {c.ordinal === true && <span className="y2-punct">- </span>}
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

function PointerCell({ text }: { text: string }) {
  return <Cell kind="pointer" active={false} refused={false}><span className="y2-p">*{text}</span></Cell>;
}

/** The container: brackets, entries, the hole (when the cursor's hole lives here), the gap after.
 *  A SPREAD container (or one inside a spread — json5p expands everything) lays out one entry per
 *  row; a flow one stays inline; a BLOCK one is rows with `- ` / `k: ` markers. */
function ContainerCell({ node, path, ctx, trailingComma = false, lead, valueRow }: { node: Node; path: Path; ctx: CellCtx; trailingComma?: boolean; lead?: ReactNode; valueRow?: { at: number; el: ReactNode } }) {
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
  const mkItems = (withCommas: boolean): { el: ReactNode; commaInside: boolean; entry?: number }[] => {
    const out: { el: ReactNode; commaInside: boolean; entry?: number }[] = [];
    const total = entries.length + (holeHere ? 1 : 0);
    let slot = 0;
    for (let i = 0; i <= entries.length; i++) {
      if (holeHere && i === holeIndex) { out.push({ el: <HoleCell key="hole" ctx={ctx} />, commaInside: false, entry: holeIndex }); slot++; }
      if (i === entries.length) break;
      const e = entries[i];
      const p = [...path, i];
      const childSpread = !isPointer(e.value) && (e.value as Node).kind === "mapping" && isSpread(e.value as Node);
      const wantComma = withCommas && childSpread && slot < total - 1;
      // the entry's lead marker: `k: ` for a named entry, `- ` for a keyless one in BLOCK rows
      // (flow keyless entries take no marker — the commas separate them)
      const keyFrag = e.key != null
        ? <><KeyCell entry={e} path={p} ctx={ctx} /><span className="y2-punct">: </span></>
        : !flow ? <span className="y2-punct">- </span> : null;
      // a KEYED entry holding a BLOCK container WRAPS: the key alone on its row, the child's
      // rows BELOW it, indented one step — `children:` / `  - name: Europe`. (A keyless `- `
      // entry keeps the compact form: the child's first row rides the dash.)
      const childBlock = !isPointer(e.value) && (e.value as Node).kind === "mapping" && !isFlow(e.value as Node);
      out.push({
        el: (
          <Fragment key={i}>
            {/* a SPREAD child takes the key INTO its first row (`children: [`) so its body rows
                come back to the container's own indent — K&R, not a hang at the key's column */}
            {childSpread
              ? <NodeCell node={e.value as Node} path={p} ctx={ctx} trailingComma={wantComma} lead={keyFrag} />
              : childBlock && e.key != null && !flow
                ? <div className="y2-rows">
                    <div className="y2-row">{keyFrag}</div>
                    <div className="y2-row y2-indent"><NodeCell node={e.value as Node} path={p} ctx={ctx} /></div>
                  </div>
                : <>
                    {keyFrag}
                    {isPointer(e.value)
                      ? <PointerCell text={(e.value as { raw?: string }).raw ?? ""} />
                      : <NodeCell node={e.value as Node} path={p} ctx={ctx} trailingComma={wantComma} />}
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
    for (let i = 0; i < itemRows.length; i++) {
      const it = itemRows[i];
      // an OMNI's value line sits at its AUTHORED position among the rows (`meta.selfAt`)
      if (valueRow && !placedValue && it.entry !== undefined && it.entry >= valueRow.at) {
        rows.push(<div key="self" className="y2-row">{valueRow.el}</div>);
        placedValue = true;
      }
      rows.push(<div key={i} className="y2-row">{it.el}</div>);
    }
    if (valueRow && !placedValue) rows.push(<div key="self" className="y2-row">{valueRow.el}</div>);
    return (
      <Cell kind="block" active={false} refused={false}>
        <div className="y2-rows">
          {rows.length === 0
            ? <div className="y2-row">
                <button
                  className="y2-gapslot"
                  onFocus={() => ctx.onFocus({ at: "into", path })}
                  onKeyDown={(e) => ctx.onKey(e)}
                >
                  ▏
                </button>
              </div>
            : rows}
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
          <div className="y2-row">{lead}<span className="y2-punct">{open}</span></div>
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
          {body}
          <span className="y2-punct">{close}</span>
          {trailingComma && <span className="y2-punct">,</span>}
          <GapCell path={path} ctx={ctx} />
        </>
      )}
    </Cell>
  );
}

/** THE closed set's root: dispatch by IR node kind, recurse. */
export function NodeCell({ node, path, ctx, trailingComma = false, lead }: { node: Node; path: Path; ctx: CellCtx; trailingComma?: boolean; lead?: ReactNode }) {
  if (node.kind === "scalar") {
    const holeHere = ctx.cursor.at === "hole" && pathEq(ctx.cursor.path, path);
    if ((node.entries ?? []).length === 0 && !holeHere) return <TokenCell node={node} path={path} ctx={ctx} />;
    // OMNI (value-plus-fields), or a scalar the cursor DESCENDED into (Enter's LEVEL RULE):
    // the value line AT ITS AUTHORED POSITION (`meta.selfAt`) among the field rows — the hole
    // among them stays VISIBLE, so the caret can never stand in a cell the projection not draw
    return (
      <Cell kind="omni" active={false} refused={false}>
        <ContainerCell
          node={node}
          path={path}
          ctx={ctx}
          valueRow={{ at: (node.meta as { selfAt?: number } | undefined)?.selfAt ?? 0, el: <TokenCell node={node} path={path} ctx={ctx} /> }}
        />
      </Cell>
    );
  }
  if (node.kind === "mapping") return <ContainerCell node={node} path={path} ctx={ctx} trailingComma={trailingComma} lead={lead} />;
  return <Cell kind="other" active={false} refused={false}><span>({node.kind})</span></Cell>; // blob: later
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
