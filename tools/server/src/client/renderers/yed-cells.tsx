// THE SERVER CELL REGISTRY - yed's cell zoo grown with server awareness (docs/server/editor/pick-kit).
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
import type { Hint, HintProvider, RecentEntry, RecentsProvider } from "../../../../yed/src/complete";
import { joinPortions, portionsOfRaw } from "../../../../yed/src/grammar/portions";
import type { Node, Path } from "../../../../yed/src/state";
import type { RefCommit } from "../../../../yed/src/apply";
import type { Pointer } from "../../../../parser/ts/src/ir.ts";
import { treeCandidateProvider, type Candidate } from "../query-complete";
import { canonPath, displayPath, strToSegs, urlOfPath } from "../paths";
import { resolveSpelledPath, spellPointer } from "../pointer-spell";
import { projectOntos } from "../ontos";
import { forgetRecent, readRecents, recordRecent } from "../recents";
import { serverPathOf } from "./yed-sync";

const pathEq = (a: Path, b: Path): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The SERVER completion provider - ONE stable value for every mount. The bare scope's
 *  holder is the cursor's container spelled onto the wire (serverPathOf - the same
 *  addressing law the sync's ops use, so the hints and the ops can never disagree); the
 *  committed portions join to the context query and the wire answers with the context's
 *  real children. Of the query grammar's operator rows only the POINTER-VALID pair rides
 *  along (`..` parent, `-` the keyless segment), marked `op` so it never ARMS - the rest
 *  (`?`, `...`, `-..`, comparisons, type tests) are query matchers parsePointer refuses,
 *  and with arm-by-default an armed `-..` stole the Enter that meant "commit the trailing
 *  `-`" (the reported anchor-face trap). A wire failure is an empty list - hints, never
 *  validators. */
const POINTER_OPS = new Set(["..", "-"]);
export const treeHints: HintProvider = async (q): Promise<Hint[]> => {
  const holder = serverPathOf(q.host?.base ?? ":", q.doc, q.path);
  const cands: Candidate[] = await treeCandidateProvider(holder)(joinPortions(q.portions, q.ladder), q.prefix);
  return cands
    .filter((c) => c.kind === "key" || POINTER_OPS.has(c.insert))
    .map((c) =>
      c.kind === "key"
        ? { insert: c.insert, detail: c.node.label !== c.insert ? c.node.label : undefined }
        : { insert: c.insert, detail: c.detail, op: true });
};

/** The RECENTS BAG provider - the per-project remembered targets (recents.ts) spelled for
 *  the asking cell's context: the `&` face reads the `bookmarks` list (position-bearing
 *  paths dropped - a bookmark may not claim a position, makeAnchor refuses them - and the
 *  MEMBERSHIP form offered: the trailing `-` rides along, the dominant `&tag:-` gesture),
 *  the `*` face reads `references`. ONE stable value for every mount, like treeHints. */
const BAG_ROWS = 6; // the bag advises — it must never dwarf the candidate list above it
export const treeRecents: RecentsProvider = async (q): Promise<RecentEntry[]> => {
  const kind = q.anchor ? "bookmarks" : "references";
  const recents = await readRecents(kind);
  // THE `&` FACE ALSO OFFERS THE VOCABULARY (ontos.ts — the same tags the picker chips show):
  // a bookmark IS a tag application, and an empty bag on a fresh project would leave the
  // bookmark face with nothing to suggest while the picker looked rich. Remembered targets
  // lead; the taxonomy fills the rest. A `*` reference has no vocabulary — any node is a
  // legitimate target — so it stays pure recents.
  const seen = new Set(recents.map((r) => canonPath(r.path)));
  const vocabulary = q.anchor
    ? (await projectOntos().catch(() => [])).filter((t) => !seen.has(canonPath(t.path)))
    : [];
  const holder = serverPathOf(q.host?.base ?? ":", q.doc, q.path);
  return [...recents, ...vocabulary]
    .filter((r) => !q.anchor || !strToSegs(r.path).some((s) => typeof s === "number"))
    .slice(0, BAG_ROWS)
    .map((r) => ({
      raw: spellPointer(r.path, holder, q.ladder, q.host?.doc ?? ":") + (q.anchor ? ": -" : ""),
      label: r.name,
      detail: displayPath(r.path),
      key: r.path, // the remembered target itself — the handle a `forget` needs
    }));
};

/** Forget one remembered target from the bag a cell is showing (its right-click). The kind
 *  follows the FACE: a `&` row came from the bookmarks list, a `*` row from the references. */
export function forgetRecentEntry(entry: RecentEntry, anchor: boolean): void {
  if (entry.key !== undefined) forgetRecent(anchor ? "bookmarks" : "references", entry.key);
}

/** File a COMMITTED reference edit (page.tsx's onRefCommit) among the per-project recents:
 *  the raw resolves back to its target's client path (a trailing `-` membership portion is
 *  dropped first - the remembered thing is the TARGET), the root and unresolvable spellings
 *  are skipped. Recording is a convenience - any failure (a stale address, an exotic
 *  spelling) just skips it, never a gate on the edit. */
export function recordRefCommit(c: RefCommit, host: { base: string; doc: string }): void {
  try {
    const holder = serverPathOf(host.base, c.doc, c.holder);
    const { ladder, portions } = portionsOfRaw(c.raw);
    const named = portions[portions.length - 1] === "-" ? portions.slice(0, -1) : portions;
    const target = resolveSpelledPath(joinPortions(named, ladder), holder, host.doc);
    if (target === null || canonPath(target) === ":") return;
    const segs = strToSegs(target);
    const last = segs[segs.length - 1];
    recordRecent(c.anchor ? "bookmarks" : "references", { path: target, name: last === null ? "~" : String(last), color: null });
  } catch { /* recording is never a gate */ }
}

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
          href={urlOfPath(refPath)} // the slash-transport URL — see NavLink
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
          href={urlOfPath(l.path)} // the slash-transport URL — see NavLink
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
