// THE SERVER CELL REGISTRY — yed's cell zoo grown with server awareness (EDITOR.md §4).
// ONE registry serves both mounts — the source editor (yed-editor.tsx) and the chapter
// projection (adapter.sourceCells) — the architecture law: capability enters yed by
// EXTENDING the registry, never by forking the stack.
//
// - `byKind.pointer` / `holePick`: the reference cells host the SHARED query-cell kit
//   (query-cells.tsx — the breadcrumb machinery in PICK mode): server-backed candidates at
//   the HOLDER (`GET /api/query`), the scope ladder (`*` bare / `*:` / `*::` / `*:::`),
//   live TOC filtering through the shared session, TOC-click insertion, Enter reducing the
//   query to a pointer. The kit is CELL-LOCAL (async, DOM); every commit funnels through
//   `ctx.pick` into the pure apply layer — yed's core never sees a promise.
// - `byKind.blob`: a `$yamloverLink` member draws its descend hyperlink (the read-only
//   view's affordance) while staying a walkable, deletable atom.

import { useEffect, type ReactNode } from "react";
import { Cell, defaultRegistry, type CellCtx, type CellRegistry, type ValueCellProps } from "../../../../yed/src/cells";
import type { Node, Path } from "../../../../yed/src/state";
import type { Pointer } from "../../../../parser/ts/src/ir.ts";
import { QueryCells, useQueryCellHost } from "../query-cells";
import { treeCandidateProvider } from "../query-complete";
import { pointerCells, spellCells, spellPointer } from "../pointer-spell";
import { useTocFilter } from "../toc-filter-session";
import { serverPathOf } from "./yed-sync";

const pathEq = (a: Path, b: Path): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The wire address of a CONTAINER (the holder a bare `*` resolves at) — the same addressing
 *  law the sync's ops use (serverPathOf), so the cell and the ops can never disagree. */
const containerAddr = (ctx: CellCtx, containerPath: Path): string =>
  serverPathOf(ctx.host?.base ?? ":", ctx.doc, containerPath);
const docAddr = (ctx: CellCtx): string => ctx.host?.doc ?? ctx.host?.base ?? ":";

/** The kit over ONE reference edit — shared by the hole face (entry) and the pick face
 *  (retarget). `raw` seeds the idle spelling; commits go up through the callbacks (the
 *  pure layer decides; false keeps the typed text with the ring — hints are never
 *  validators). Abandonment needs no wiring: clicking another cell moves the cursor and
 *  the un-committed edit simply never lands (the document was never touched). */
function PickKit({ ctx, raw, holder, onCommit, onEmptyBackspace }: {
  ctx: CellCtx;
  raw: string;
  holder: string;
  onCommit: (raw: string) => void;
  onEmptyBackspace: () => void;
}) {
  const session = useTocFilter();
  const docPath = docAddr(ctx);
  const host = useQueryCellHost({
    ctx: () => ({
      mode: "pick",
      ladder: pointerCells(raw).ladder,
      idlePortions: () => pointerCells(raw).portions,
      spell: (path, ladder) => spellCells(path, holder, ladder, docPath),
    }),
    provider: (q, prefix) => treeCandidateProvider(holder)(q, prefix),
    onSelect: (path, meta) => {
      if (meta && meta.query.trim() === "") return; // an empty query's Enter is a nop
      if (path !== null) onCommit(spellPointer(path, holder, meta?.ladder ?? 1, docPath));
      else if (meta) onCommit(meta.query); // free-typed: verbatim if the wire accepts it
    },
    session,
  });
  // the face mounted with the caret conceptually here — the kit claims the DOM focus (the
  // hole input / atom span just unmounted; the focus law forbids the caret falling to BODY)
  useEffect(() => {
    if (ctx.plantCaret !== false) host.dispatch({ type: "FOCUS_CELL", caret: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const editing = host.state.mode === "editing";
  const idle = pointerCells(raw);
  const ladder = editing && host.state.mode === "editing" ? host.state.ladder : idle.ladder;
  return (
    <span className="y2-p y2-pick">
      <span className="y2-punct">*</span>
      {ladder > 0 && <span className="y2-punct y2-scope">{":".repeat(ladder)}</span>}
      <span
        className="y2-ptrwrap"
        tabIndex={-1}
        onFocus={(e) => {
          // focus landing on the wrapper (the walk, a click on the frame) forwards into the
          // machine, which places the caret in a cell — the legacy PointerCell's rule
          if (e.target === e.currentTarget) host.dispatch({ type: "FOCUS_CELL", caret: "end" });
        }}
      >
        <QueryCells host={host} idlePortions={idle.portions} scopeKeys onEmptyBackspace={onEmptyBackspace} className="y2-ptrcells" />
      </span>
    </span>
  );
}

/** The `*`-led HOLE face — a reference being entered (YAMLOVER_EDITOR.yo pointer_entry). */
function ServerPointerHole({ ctx }: { ctx: CellCtx }) {
  const c = ctx.cursor;
  if (c.at !== "hole") return null;
  const raw = c.text.trimStart().replace(/^\*/, "");
  return (
    <Cell kind="pointer" active refused={ctx.refused}>
      {c.ordinal === true && <span className="y2-punct">- </span>}
      {c.key !== null && <span className="y2-k">{c.key}: </span>}
      <PickKit
        ctx={ctx}
        raw={raw}
        holder={containerAddr(ctx, c.path)}
        onCommit={(r) => void ctx.pick?.commitHole(r)}
        onEmptyBackspace={() => ctx.pick?.dismantle()}
      />
    </Cell>
  );
}

/** The pointer VALUE cell: idle = the pure atom face plus the ↗ target affordance; the
 *  `pick` cursor here = the kit seeded from the raw (retarget). */
function ServerPointerCell(props: ValueCellProps & { navigate: (p: string) => void }) {
  const { node, path, ctx, navigate } = props;
  const picking = ctx.cursor.at === "pick" && pathEq(ctx.cursor.path, path);
  if (!picking) {
    const refPath = (node as Pointer & { refPath?: string }).refPath;
    return (
      <>
        {defaultRegistry.byKind.pointer!(props)}
        {refPath !== undefined && (
          <a
            className="descend y2-refnav"
            href={refPath}
            title="go to the target"
            onClick={(e) => { e.preventDefault(); navigate(refPath); }}
          >↗</a>
        )}
      </>
    );
  }
  return (
    <Cell kind="pointer" active refused={ctx.refused} pos={{ at: "ptr", path }}>
      <PickKit
        ctx={ctx}
        raw={(ctx.cursor as { text: string }).text}
        holder={containerAddr(ctx, path.slice(0, -1))}
        onCommit={(r) => void ctx.pick?.commitAt(path, r)}
        onEmptyBackspace={() => ctx.pick?.removeAt(path)}
      />
    </Cell>
  );
}

/** A `$yamloverLink` blob — the descend hyperlink over the walkable atom. A linkless blob
 *  falls back to the opaque atom face. */
function LinkAtomCell(props: ValueCellProps & { navigate: (p: string) => void }) {
  const { node, path, ctx, navigate } = props;
  const link = ((node as Node).meta ?? {}) as { link?: { path: string; title?: string; format?: string } };
  if (!link.link) return defaultRegistry.byKind.blob!(props);
  const l = link.link;
  const active = ctx.cursor.at === "ptr" && pathEq(ctx.cursor.path, path);
  const label = l.title ?? decodeURIComponent(l.path.split(":").pop() ?? l.path);
  return (
    <Cell kind="blob" active={active} refused={ctx.refused} pos={{ at: "ptr", path }}>
      <span
        className="y2-p"
        tabIndex={0}
        ref={(el) => { if (el && active && ctx.plantCaret !== false && document.activeElement !== el) el.focus(); }}
        onFocus={() => { if (!active) ctx.onFocus({ at: "ptr", path }); }}
        onKeyDown={(e) => ctx.onKey(e)}
      >
        <a
          className="descend"
          href={l.path}
          tabIndex={-1}
          onClick={(e) => { e.preventDefault(); navigate(l.path); }}
        >{label}</a>
      </span>
    </Cell>
  );
}

/** The registry, closed over the mount's navigation. Build once per mount (useMemo). */
export function makeSourceCells({ navigate }: { navigate: (p: string) => void }): CellRegistry {
  return {
    ...defaultRegistry,
    byKind: {
      ...defaultRegistry.byKind,
      pointer: (props: ValueCellProps): ReactNode => <ServerPointerCell {...props} navigate={navigate} />,
      blob: (props: ValueCellProps): ReactNode => <LinkAtomCell {...props} navigate={navigate} />,
    },
    holePick: (props: { ctx: CellCtx }): ReactNode => <ServerPointerHole {...props} />,
  };
}
