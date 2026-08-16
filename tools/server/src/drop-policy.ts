// Drop POLICY — the rules deciding whether a drag-drop operation is possible and, when it
// is, WHAT it will do. This module is deliberately tiny and pure (no I/O, no DOM): like
// concrete-rules.ts it is the part meant to be refined over time (per-schema rules, new
// operation kinds, …) while the mechanics (HTML5 DnD wiring, /api/mv, /api/paste) stay in
// the client surfaces and engine-api.ts.
//
// Every drop surface asks for a plan; a `DropPlan`'s `description` is exactly what the
// confirmation popup shows the user before the operation runs.
//
// Known refinement hook: a name collision at the move target is NOT checked here (the
// target's children may not be loaded) — the server rejects with `mv: target already
// exists` and the surface alerts. A later version could take `targetChildNames`.

import { isDirConcrete, isFileConcrete } from "./concrete";
import { strToSegs, segsToStr, isAncestorPath } from "./client/paths";
import { isReadOnly } from "./client/base";
import type { CompartmentAt } from "./board-model";

/** The facets a drop decision needs — a TreeNode, an explorer Link, or a NodeJson projects
 *  onto this. `concrete` is the docs/language/concretes value ("dir", "file/yaml", "yamlover", …). */
export interface DropNode {
  path: string; // canonical colon path
  concrete: string | null;
  label?: string; // display name; falls back to the last path segment
}

/** What a confirmed drop WILL DO — one variant per operation kind. */
export type DropPlan =
  | { kind: "move-node"; from: string; to: string; description: string }
  | { kind: "upload-files"; target: string; files: string[]; description: string }
  | { kind: "board-move"; task: string; from: CompartmentAt; to: CompartmentAt; untag: string[]; tag: string[]; description: string };

export type DropVerdict = { allowed: true; plan: DropPlan } | { allowed: false; reason: string };

const no = (reason: string): DropVerdict => ({ allowed: false, reason });

/** A node's display name: its label, else its last path segment, else the root `:`. */
function nameOf(n: DropNode): string {
  if (n.label) return n.label;
  const segs = strToSegs(n.path);
  return segs.length ? String(segs[segs.length - 1]) : ":";
}

/** Dropping `source` INSIDE directory `target` — an engine-mediated move (POST /api/mv:
 *  relocates the FS object and rewrites inbound pointers). The rules mirror what the
 *  engine's mv and the /api/mv route enforce, so a refused drop never even offers a popup. */
export function planNodeMove(source: DropNode, target: DropNode): DropVerdict {
  if (isReadOnly()) return no("server is read-only");
  if (!isDirConcrete(target.concrete)) return no(`target is not a directory (${target.concrete ?? "unknown"})`);
  if (!isFileConcrete(source.concrete) && !isDirConcrete(source.concrete))
    return no(`only file- or directory-backed nodes can be moved (this one is inlined ${source.concrete ?? "unknown"})`);
  const srcSegs = strToSegs(source.path);
  if (!srcSegs.length) return no("cannot move the root");
  const tgtSegs = strToSegs(target.path);
  // mv is FS-level: keyed segments only (engine-api /api/mv), and `.`-overlay parts stay put (engine mv).
  if ([...srcSegs, ...tgtSegs].some((s) => typeof s === "number")) return no("positional paths cannot be moved");
  if ([...srcSegs, ...tgtSegs].some((s) => typeof s === "string" && s.startsWith("."))) return no("hidden/overlay paths cannot be moved");
  if (target.path === source.path || isAncestorPath(source.path, target.path)) return no("cannot move a node into itself");
  if (segsToStr(srcSegs.slice(0, -1)) === segsToStr(tgtSegs)) return no("already there");
  const to = segsToStr([...tgtSegs, srcSegs[srcSegs.length - 1]]);
  return {
    allowed: true,
    plan: { kind: "move-node", from: source.path, to, description: `Move "${nameOf(source)}" into "${nameOf(target)}"` },
  };
}

/** Dropping OS files onto the page at `target` — the existing /api/paste upload, now
 *  described and confirmed like every other drop. The server routes the landing spot
 *  (chapter chunk vs nearest enclosing directory), so any target is acceptable. */
export function planFileUpload(target: DropNode, fileNames: string[]): DropVerdict {
  if (isReadOnly()) return no("server is read-only");
  if (!fileNames.length) return no("nothing to upload");
  const shown = fileNames.slice(0, 3).join(", ") + (fileNames.length > 3 ? ", …" : "");
  const noun = fileNames.length === 1 ? "file" : `${fileNames.length} files`;
  return {
    allowed: true,
    plan: { kind: "upload-files", target: target.path, files: fileNames, description: `Upload ${noun} onto "${nameOf(target)}": ${shown}` },
  };
}

/** Dropping a board card onto a COMPARTMENT (or the backlog, `to === null`) — the tag board's
 *  move gesture (POST /api/board op:"move"): untag the source compartment's shared tags, tag the
 *  destination's missing ones (board-model.ts moveDeltas — the caller computes the deltas from
 *  the resolved board so the popup can spell them; the server recomputes authoritatively). */
export function planBoardMove(
  task: { path: string; title?: string },
  from: CompartmentAt,
  to: CompartmentAt,
  deltas: { untag: { path: string; name: string }[]; tag: { path: string; name: string }[] },
  toLabel: string | null, // the destination compartment's display name; null = the backlog
): DropVerdict {
  if (isReadOnly()) return no("server is read-only");
  if (from === null && to === null) return no("already in the backlog");
  if (from !== null && to !== null && from.lane === to.lane && from.comp === to.comp) return no("already in this compartment");
  const name = task.title || task.path;
  const delta = [...deltas.tag.map((t) => `+${t.name}`), ...deltas.untag.map((t) => `−${t.name}`)].join(", ");
  return {
    allowed: true,
    plan: {
      kind: "board-move",
      task: task.path,
      from,
      to,
      untag: deltas.untag.map((t) => t.path),
      tag: deltas.tag.map((t) => t.path),
      description: `Move "${name}" to ${to === null ? "the backlog" : `"${toLabel ?? "compartment"}"`}${delta ? ` (${delta})` : ""}`,
    },
  };
}
