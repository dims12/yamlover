// THE SERVER CELL REGISTRY - yed's cell zoo grown with server awareness (EDITOR.md section 4).
// ONE registry serves both mounts - the source editor (yed-editor.tsx) and the chapter
// projection (adapter.sourceCells) - the architecture law: capability enters yed by
// EXTENDING the registry, never by forking the stack.
//
// - references: entry and retarget are the PURE editor's PORTION cells (yed cells.tsx /
//   grammar/portions.ts) - the server adds only COMPLETION over them: `treeHints` below is
//   the HintProvider a server mount passes to EditorView, answering each portion cell with
//   the context's REAL children over `GET /api/query` (query-complete.ts). Hints advise and
//   never gate typing (pointer-hints doctrine); with the wire down the cells work bare.
// - `byKind.pointer`: the idle atom face plus the go-to-target affordance.
// - `byKind.blob`: a `$yamloverLink` member draws its descend hyperlink (the read-only
//   view's affordance) while staying a walkable, deletable atom.

import { type ReactNode } from "react";
import { Cell, defaultRegistry, type CellRegistry, type ValueCellProps } from "../../../../yed/src/cells";
import type { Hint, HintProvider } from "../../../../yed/src/complete";
import { joinPortions } from "../../../../yed/src/grammar/portions";
import type { Node, Path } from "../../../../yed/src/state";
import type { Pointer } from "../../../../parser/ts/src/ir.ts";
import { treeCandidateProvider, type Candidate } from "../query-complete";
import { serverPathOf } from "./yed-sync";

const pathEq = (a: Path, b: Path): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The SERVER completion provider - ONE stable value for every mount. The bare scope's
 *  holder is the cursor's container spelled onto the wire (serverPathOf - the same
 *  addressing law the sync's ops use, so the hints and the ops can never disagree); the
 *  committed portions join to the context query and the wire answers with the context's
 *  real children (plus the query grammar's operator rows). A wire failure is an empty
 *  list - hints, never validators. */
export const treeHints: HintProvider = async (q): Promise<Hint[]> => {
  const holder = serverPathOf(q.host?.base ?? ":", q.doc, q.path);
  const cands: Candidate[] = await treeCandidateProvider(holder)(joinPortions(q.portions, q.ladder), q.prefix);
  return cands.map((c) =>
    c.kind === "key"
      ? { insert: c.insert, detail: c.node.label !== c.insert ? c.node.label : undefined }
      : { insert: c.insert, detail: c.detail });
};

/** The pointer VALUE cell: the pure face (idle atom / PICK portion cells) plus the server's
 *  go-to-target affordance on the idle atom. */
function ServerPointerCell(props: ValueCellProps & { navigate: (p: string) => void }) {
  const { node, path, ctx, navigate } = props;
  const picking = ctx.cursor.at === "pick" && pathEq(ctx.cursor.path, path);
  if (picking) return <>{defaultRegistry.byKind.pointer!(props)}</>;
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
        >&#8599;</a>
      )}
    </>
  );
}

/** A `$yamloverLink` blob - the descend hyperlink over the walkable atom. A linkless blob
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
  };
}
