// THE YED SYNC — parser-IR tree diff → per-node /api/edit ops. The editor stays CONCRETE-
// AGNOSTIC: it says WHAT changed at WHICH node; the backend's concrete-inheritance rules
// (concrete-rules.ts) decide where each write lands (inline body line, member directory,
// materialized overlay, promotion). Because the ops touch only the changed regions, comments
// and authored spellings elsewhere survive on disk — the text surgery leaves untouched lines
// alone.
//
// The addressing laws (engine-api.ts assignAt/chapterEntries):
// - ONE absolute index space per container, keyed and keyless entries together, source order;
//   the self-value line and the `!!<…>` tag line consume no index.
// - FLOW/K&R token interiors have no addresses — any change inside one is ONE whole-token
//   emplace at the OUTERMOST flow node (its serialized text carries the layout).
// - Within one backing file ops apply PROGRESSIVELY in emission order, so this emitter uses
//   then-current addresses: recursions first (no shifts), then removals LAST-FIRST, then
//   insertions FORWARD (the diffChapter pattern, chapter-model.ts).
// - A KEY RENAME is not an edit op: the caller flushes the ops, then POST /api/rekey.
// - `remove` never deletes disk storage (orphaning is deliberate, "never destroy user data").
//
// Whatever the walk cannot express falls back to ONE whole-node emplace at the mount path —
// today's whole-document behavior, counted and warned so the fallback ledger only shrinks.

import type { Edit } from "../api";
import { isFlow, isSpread, sourceOf, type Document, type Entry, type Node, type Value } from "../../../../yed/src/state";
import { isPointer } from "../../../../parser/ts/src/ir.ts";

export interface DiffResult {
  ops: Edit[];
  /** Pure key renames — applied AFTER the ops flush, via POST /api/rekey (storage-routed). */
  renames: { path: string; key: string }[];
  /** The walk could not express the change and fell back to a whole-node emplace. */
  fallback: boolean;
  /** The change cannot be persisted at all (a blob inside a wholesale rewrite). */
  unserializable: boolean;
}

const appendSeg = (path: string, seg: string | number): string => {
  const base = path === ":" ? "" : path;
  return typeof seg === "number" ? `${base}[${seg}]` : `${base}:${encodeURIComponent(seg)}`;
};

const isNode = (v: Value): v is Node => !isPointer(v);
const flowLike = (v: Value): boolean => isNode(v) && (isFlow(v) || isSpread(v));
const hasBlob = (v: Value): boolean => {
  if (isPointer(v)) return false;
  if ((v as Node).kind === "blob") return true;
  return ((v as Node).entries ?? []).some((e) => hasBlob(e.value));
};

/** Deep equality over the parts the diff cares about (value, raw, entries, layout meta). */
const canon = (v: Value): unknown => {
  if (isPointer(v)) return { ptr: (v as { raw?: string }).raw ?? "" };
  const n = v as Node & { value?: unknown; raw?: string; array?: boolean };
  const meta = (n.meta ?? {}) as { style?: string; concrete?: string; selfAt?: number };
  return {
    k: n.kind,
    v: n.kind === "scalar" ? (Number.isNaN(n.value as number) ? "NaN" : n.value) : undefined,
    r: n.raw,
    a: n.array === true,
    st: meta.style, c: meta.concrete, sa: meta.selfAt,
    e: (n.entries ?? []).map((e) => ({ key: e.key, v: canon(e.value) })),
  };
};
const eq = (a: Value, b: Value): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const entryEq = (a: Entry, b: Entry): boolean => a.key === b.key && eq(a.value, b.value);

/** A value as an op payload: one line for pointers/scalars, the serialized subtree for nodes
 *  (its text carries flow/K&R layout). Throws on a blob — the caller falls back or refuses. */
function payloadOf(v: Value): string {
  if (isPointer(v)) return "*" + ((v as { raw?: string }).raw ?? "");
  if ((v as Node).kind === "blob" || hasBlob(v)) throw new Error("a blob has no op payload");
  return sourceOf({ root: v } as Document).replace(/\n$/, "");
}

/** The entry's address segment: its key (stable under sibling churn), the derived anchor key of
 *  an anchored positional member, else its ABSOLUTE index. */
const segOf = (e: Entry, absIndex: number): string | number =>
  e.key ?? ((e.meta as { anchorKey?: string } | undefined)?.anchorKey ?? absIndex);

class Bail extends Error {}

export function diffToOps(basePath: string, prev: Document, next: Document): DiffResult {
  const ops: Edit[] = [];
  const renames: { path: string; key: string }[] = [];
  try {
    diffValue(prev.root, next.root, basePath, true, ops, renames);
    return { ops, renames, fallback: false, unserializable: false };
  } catch (e) {
    if (!(e instanceof Bail)) throw e;
  }
  // THE FALLBACK: one whole-node emplace at the mount path (the previous architecture's whole-
  // document flush). Counted and warned — this ledger only shrinks.
  try {
    const yamlover = payloadOf(next.root);
    console.warn(`yed-sync: falling back to a whole-node emplace at ${basePath} (inexpressible diff)`);
    return { ops: [{ path: basePath, op: "emplace", yamlover }], renames: [], fallback: true, unserializable: false };
  } catch {
    return { ops: [], renames: [], fallback: true, unserializable: true };
  }
}

function diffValue(prev: Value, next: Value, path: string, isRoot: boolean, ops: Edit[], renames: DiffResult["renames"]): void {
  if (eq(prev, next)) return;

  // THE FLOW BOUNDARY: any difference at or under a flow/K&R node is ONE whole-token emplace —
  // interiors have no addresses, and the token's text carries the layout (spread toggles too).
  // An EMPTY payload is a defined CLEAR only at the root (the "document emptied" flush); a
  // non-root node emptied this way has no honest op — fall back rather than no-op.
  if (flowLike(prev) || flowLike(next)) {
    const yamlover = payloadOf(next);
    if (yamlover === "" && !isRoot) throw new Bail("a non-root node emptied across a flow boundary");
    ops.push({ path, op: "emplace", yamlover });
    return;
  }
  if (isPointer(prev) || isPointer(next)) {
    // a retargeted pointer (or a value↔pointer swap) — one emplace of the new spelling
    ops.push({ path, op: "emplace", yamlover: payloadOf(next) });
    return;
  }
  const p = prev as Node;
  const n = next as Node;
  if (p.kind === "blob" || n.kind === "blob") throw new Bail("blob");

  // the node's OWN scalar value (a leaf, or an omni's self line — which consumes no index)
  const pv = p.kind === "scalar" ? { value: (p as { value?: unknown }).value, raw: (p as { raw?: string }).raw } : null;
  const nv = n.kind === "scalar" ? { value: (n as { value?: unknown }).value, raw: (n as { raw?: string }).raw } : null;
  const pSelfAt = ((p.meta ?? {}) as { selfAt?: number }).selfAt ?? 0;
  const nSelfAt = ((n.meta ?? {}) as { selfAt?: number }).selfAt ?? 0;
  const selfChanged = JSON.stringify(pv) !== JSON.stringify(nv);
  if (selfChanged) {
    if (nv === null) {
      if ((n.entries ?? []).length === 0) throw new Bail("value dropped, nothing left"); // an emptied node — inexpressible surgically
      ops.push({ path, op: "emplace", yamlover: '""' }); // the server drops the self line
    } else {
      const token = payloadOf({ kind: "scalar", value: nv.value, ...(nv.raw !== undefined ? { raw: nv.raw } : {}) } as unknown as Value);
      // `at` places a FRESH self line at its authored row; replacing an existing one keeps its row
      ops.push({ path, op: "emplace", yamlover: token, ...(pv === null && nSelfAt > 0 ? { at: nSelfAt } : {}) });
    }
  } else if (pSelfAt !== nSelfAt) {
    throw new Bail("selfAt moved"); // the self line's row cannot be moved surgically
  }

  diffEntries(p.entries ?? [], n.entries ?? [], path, ops, renames);
}

function diffEntries(prev: Entry[], next: Entry[], parentPath: string, ops: Edit[], renames: DiffResult["renames"]): void {
  // trim the equal head and tail — the typical flush window touches ONE region
  let head = 0;
  while (head < prev.length && head < next.length && entryEq(prev[head], next[head])) head++;
  let pTail = prev.length, nTail = next.length;
  while (pTail > head && nTail > head && entryEq(prev[pTail - 1], next[nTail - 1])) { pTail--; nTail--; }
  const pWin = prev.slice(head, pTail);
  const nWin = next.slice(head, nTail);
  if (pWin.length === 0 && nWin.length === 0) return;

  // KEYED entries pair by key across the window (stable addresses, no index bookkeeping);
  // KEYLESS ones pair in order. What pairs recurses; the rest removes/inserts.
  const keyOf = (e: Entry): string | null => e.key ?? ((e.meta as { anchorKey?: string } | undefined)?.anchorKey ?? null);
  const nByKey = new Map<string, { e: Entry; wi: number }>();
  nWin.forEach((e, wi) => { const k = keyOf(e); if (k !== null && !nByKey.has(k)) nByKey.set(k, { e, wi }); });

  const removedKeyed: { e: Entry; abs: number }[] = [];
  const pairedN = new Set<number>();
  const pKeyless: { e: Entry; abs: number }[] = [];
  pWin.forEach((e, wi) => {
    const abs = head + wi;
    const k = keyOf(e);
    if (k === null) { pKeyless.push({ e, abs }); return; }
    const m = nByKey.get(k);
    if (m && !pairedN.has(m.wi)) {
      pairedN.add(m.wi);
      diffValue(e.value, m.e.value, appendSeg(parentPath, segOf(e, abs)), false, ops, renames);
    } else {
      removedKeyed.push({ e, abs });
    }
  });
  const nKeyless: { e: Entry; wi: number }[] = [];
  const insertedKeyed: { e: Entry; wi: number }[] = [];
  nWin.forEach((e, wi) => {
    if (pairedN.has(wi)) return;
    if (keyOf(e) === null) nKeyless.push({ e, wi });
    else insertedKeyed.push({ e, wi });
  });

  // PURE RENAME: one keyed leaves, one arrives, values deep-equal → /api/rekey after the flush
  if (removedKeyed.length === 1 && insertedKeyed.length === 1 && eq(removedKeyed[0].e.value, insertedKeyed[0].e.value)) {
    renames.push({ path: appendSeg(parentPath, segOf(removedKeyed[0].e, removedKeyed[0].abs)), key: insertedKeyed[0].e.key! });
    removedKeyed.length = 0;
    insertedKeyed.length = 0;
  }

  // keyless pairs recurse in order; the overhang removes/inserts
  const zip = Math.min(pKeyless.length, nKeyless.length);
  for (let i = 0; i < zip; i++) {
    diffValue(pKeyless[i].e.value, nKeyless[i].e.value, appendSeg(parentPath, pKeyless[i].abs), false, ops, renames);
  }

  // REMOVALS, last-first (prev-side absolute addresses stay valid in descending order)…
  const removals = [
    ...removedKeyed.map((r) => ({ seg: segOf(r.e, r.abs), abs: r.abs })),
    ...pKeyless.slice(zip).map((r) => ({ seg: r.abs as string | number, abs: r.abs })),
  ].sort((a, b) => b.abs - a.abs);
  for (const r of removals) ops.push({ path: appendSeg(parentPath, r.seg), op: "remove" });

  // …then INSERTIONS forward at their NEXT-side absolute rows (each lands before the next)
  const inserts = [
    ...insertedKeyed.map((i) => ({ e: i.e, abs: head + i.wi })),
    ...nKeyless.slice(zip).map((i) => ({ e: i.e, abs: head + i.wi })),
  ].sort((a, b) => a.abs - b.abs);
  for (const i of inserts) {
    ops.push({
      path: appendSeg(parentPath, i.abs),
      op: "insert",
      yamlover: payloadOf(i.e.value),
      ...(i.e.key != null ? { key: i.e.key } : {}),
    });
  }
}
