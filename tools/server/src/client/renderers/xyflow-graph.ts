// The GRAPH MODEL behind the xyflow renderer (format `x-yamlover-xyflow`): one depth-inf wire
// value walked into plain nodes and edges. Kept free of React and of @xyflow/react so the
// semantics — what becomes a node, what becomes an edge, how each is labelled — are unit
// testable without a canvas.
//
// The model is the language's own (docs/language/logical-graph): nodes carry a scalar SELF-VALUE and are
// joined by relations that carry an ORDINAL and, sometimes, a KEY. So every relation is labelled
// with both when it has both, and containment, `*` dereference and `&` anchor membership are three
// EDGE KINDS the view draws differently — a pointer is a graph edge, never a copy
// (docs/language/pointers/reference), so a `*` entry adds no node of its own: the parent's
// relation lands straight on the target.

import { asLink, asMixed, asRef } from "../render";
import { canonPath, displayPath, segsToStr, strToSegs, type Seg } from "../paths";
import { makeAnchor } from "../../../../parser/ts/src/pointer.ts";
import type { Step } from "../../../../parser/ts/src/ir.ts";
import type { CommentMap, NodeJson } from "../api";

/** `value` — a node with a scalar self-value; `empty` — a node whose value is null (drawn as a
 *  bare circle); `stub` — a `*`/`&` end that lies OUTSIDE the rendered subtree, or does not
 *  resolve at all. */
export type GraphNodeKind = "value" | "empty" | "stub";

/** A self-value's scalar type — the drawing inks it in the CODE palette (styles.css `.s .n .b`),
 *  so a value reads the same colour in the graph as in the source. */
export type ScalarKind = "string" | "number" | "boolean" | "null";

export interface GraphNode {
  id: string;
  /** The node's yamlover path — null for an unresolved stub, which names no node. */
  path: string | null;
  label: string;
  kind: GraphNodeKind;
  /** The type of the value inside the box; absent for an empty circle and for a stub. */
  valueType?: ScalarKind;
}

/** `contain` — the acyclic spine, a key or position holding its value; `deref` — an authored `*`
 *  pointer; `anchor` — an `&` membership, either authored on the target or derived by storage
 *  (docs/language/pointers/bookmarks). */
export type GraphEdgeKind = "contain" | "deref" | "anchor";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  key: string | null;
  ordinal: number | null;
  /** "2: pet" with both, "2" for a position-only relation, "pet" for a keyed anchor. */
  label: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A relation's title: the ordinal and the key when it has both, else whichever it carries. */
export function edgeLabel(ordinal: number | null, key: string | null): string {
  if (key !== null && ordinal !== null) return `${ordinal}: ${key}`;
  if (key !== null) return key;
  return ordinal !== null ? String(ordinal) : "";
}

const childPath = (path: string, seg: Seg): string => segsToStr([...strToSegs(path), seg]);

/** The fragment token of the i-th rendered entry — the key, `~` for the null key, else the
 *  position (derive-node.ts `ownEntriesOf` mints the comment keys this way, and the anchor
 *  bodies we need live in those buckets). */
const fragToken = (key: string | null, keyNull: boolean, i: number): string =>
  key !== null ? key : keyNull ? "~" : String(i);

/** Pointer steps as path segments, or null when the pointer is only resolvable against a host's
 *  own position (`[.±k]`, a mid-path `..`) — those anchors are left undrawn rather than guessed. */
function stepsToSegs(steps: Step[]): Seg[] | null {
  const out: Seg[] = [];
  for (const s of steps) {
    if (s.sel === "key") out.push(s.name);
    else if (s.sel === "index") out.push(s.n);
    else if (s.sel === "nullkey") out.push(null);
    else return null;
  }
  return out;
}

/** An `&` bookmark body (`P: k`, or `P: -` for a keyless membership) read as the MEMBERSHIP it
 *  declares: the container that gains the entry, and the key it gains it under. The bookmark's
 *  path resolves from the bookmarked node's CONTAINER, so the scope sigil decides the base
 *  (docs/language/pointers/scopes). `documentPath` is the graph's own root: the xyflow tag opens a
 *  document (the engine's boundary.ts), so a `:` bookmark lands inside the drawing.
 *  Parsing rides the shared makeAnchor — ONE grammar, no local suffix-stripping. */
function anchorMembership(body: string, selfPath: string, documentPath: string): { host: string; key: string | null } | null {
  let ordinal: boolean;
  let steps: Step[];
  let scope: string;
  try {
    const a = makeAnchor(body, (m) => { throw new Error(m); });
    ordinal = a.ordinal === true;
    steps = a.path.steps;
    scope = a.path.base.scope;
  } catch {
    return null;
  }
  const segs = stepsToSegs(steps);
  if (!segs) return null;
  const own = strToSegs(selfPath);
  const base =
    scope === "document" ? strToSegs(documentPath)
    : scope === "current" ? own.slice(0, -1)
    : scope === "parent" ? own.slice(0, -2)
    : null; // a project/world authority is not a tree path — let it fall through to a stub
  const full = base ? [...base, ...segs] : segs;
  if (!ordinal && full.length === 0) return null;
  return {
    host: segsToStr(ordinal ? full : full.slice(0, -1)),
    key: ordinal ? null : String(full[full.length - 1]),
  };
}

interface Entry {
  key: string | null;
  keyNull?: boolean;
  value: unknown;
  anchor?: boolean;
}

/** The node's entries and its own scalar self-value, whichever wire shape it arrived in. */
function shapeOf(value: unknown): { self: unknown; entries: Entry[] } {
  const mixed = asMixed(value);
  if (mixed) return { self: mixed.kind === "omni" ? mixed.value : undefined, entries: mixed.entries };
  if (Array.isArray(value)) return { self: undefined, entries: value.map((v) => ({ key: null, value: v })) };
  if (value !== null && typeof value === "object") {
    return { self: undefined, entries: Object.entries(value as Record<string, unknown>).map(([key, v]) => ({ key, value: v })) };
  }
  return { self: value, entries: [] };
}

/** The text drawn inside a node box, with the type that inks it. A null/absent self-value has
 *  none — the caller turns that into the empty circle. */
function labelOf(self: unknown): { text: string; type: ScalarKind } | null {
  if (self === null || self === undefined) return null;
  if (typeof self === "object") {
    // ±Infinity / NaN ride the wire as a marker (render.tsx) — still a number
    const num = (self as Record<string, unknown>).$yamloverNum;
    return typeof num === "string" ? { text: num, type: "number" } : null;
  }
  const type: ScalarKind = typeof self === "number" ? "number" : typeof self === "boolean" ? "boolean" : "string";
  return { text: String(self), type };
}

/** An edge whose far end is known only by path — resolved once the whole subtree is walked, so a
 *  pointer to a node we have not reached yet still lands on it rather than on a stub. */
interface Pending {
  source: string | null; // null ⇒ resolve the SOURCE by `sourcePath` (an anchor's host container)
  sourcePath?: string;
  target: string | null; // null ⇒ resolve the TARGET by `targetPath`
  targetPath?: string;
  text?: string; // an unresolved pointer's authored spelling — the stub's label
  kind: GraphEdgeKind;
  key: string | null;
  ordinal: number | null;
}

/** A membership an `&` anchor declares. The engine ALSO projects it as an entry on the host (the
 *  anchor is a real key, not a namespace — docs/language/pointers/bookmarks), and that entry is
 *  indistinguishable from a `*` by its value alone. So a claim RECLASSIFIES the edge already
 *  drawn for it, and only mints one of its own when the host lies outside the drawing. */
interface AnchorClaim {
  host: string;
  key: string | null;
  target: string;
}

/** Walk one depth-inf node (`fetchNode(path, null)`) into the graph the view draws. */
export function buildGraph(node: NodeJson): Graph {
  const nodes: GraphNode[] = [];
  const byId = new Map<string, GraphNode>();
  const byCanon = new Map<string, string>();
  const pending: Pending[] = [];
  const claims: AnchorClaim[] = [];
  const comments = (node.comments ?? {}) as CommentMap;
  const documentPath = node.path; // the tagged root IS the document a `:` reference resolves in

  const addNode = (path: string, self: unknown): string => {
    const id = path;
    const existing = byId.get(id);
    if (existing) return id;
    const label = labelOf(self);
    const n: GraphNode = label === null
      ? { id, path, label: "", kind: "empty" }
      : { id, path, label: label.text, kind: "value", valueType: label.type };
    nodes.push(n);
    byId.set(id, n);
    byCanon.set(canonPath(path), id);
    return id;
  };

  const visit = (value: unknown, path: string, frag: string): string => {
    const seen = byId.has(path);
    const { self, entries } = shapeOf(value);
    const id = addNode(path, self);
    if (seen) return id; // a cycle, or a node reached twice — draw the edge, walk it once

    const bucket = comments[frag];
    for (const body of (Array.isArray(bucket) ? undefined : bucket?.anchors) ?? []) {
      const m = anchorMembership(body, path, documentPath);
      if (m) claims.push({ host: m.host, key: m.key, target: id });
    }

    entries.forEach((e, i) => {
      const seg: Seg = e.key !== null ? e.key : e.keyNull === true ? null : i;
      const childFrag = `${frag}/${encodeURIComponent(fragToken(e.key, e.keyNull === true, i))}`;
      const key = e.key !== null ? e.key : e.keyNull === true ? "~" : null;
      // A DERIVED storage anchor (a dir-backed body consumed the `*key` pointer) is an anchor
      // membership as much as an authored `&` is — same dashed hand.
      const kind: GraphEdgeKind = e.anchor === true ? "anchor" : "contain";

      const ref = asRef(e.value);
      if (ref) {
        pending.push({
          source: id,
          target: null,
          targetPath: ref.path ?? undefined,
          text: ref.text,
          kind: "deref",
          key,
          ordinal: i,
        });
        return;
      }
      const link = asLink(e.value);
      if (link) {
        // a cut member (another document): it has no inlined content here, so it enters as a leaf
        const childId = addNode(link.path, link.value ?? link.title ?? null);
        pending.push({ source: id, target: childId, kind, key, ordinal: i });
        return;
      }
      const childId = visit(e.value, childPath(path, seg), childFrag);
      pending.push({ source: id, target: childId, kind, key, ordinal: i });
    });
    return id;
  };

  visit(node.value, node.path, "");

  /** A path that names no node we drew becomes a stub — kept navigable by its own path. */
  const resolve = (path: string | undefined, text: string | undefined): string | null => {
    if (path !== undefined) {
      const hit = byCanon.get(canonPath(path));
      if (hit) return hit;
      // spelled from the PROJECT root (`::…`): inside a tagged graph a single `:` names the graph
      // itself (the document boundary), so an outside end must say plainly that it is outside
      const stub: GraphNode = { id: path, path, label: ":" + displayPath(path), kind: "stub" };
      if (!byId.has(path)) {
        nodes.push(stub);
        byId.set(path, stub);
        byCanon.set(canonPath(path), path);
      }
      return path;
    }
    if (text === undefined) return null; // an anchor whose host we cannot name — drop the edge
    const id = `$unresolved:${text}`;
    if (!byId.has(id)) {
      const stub: GraphNode = { id, path: null, label: text, kind: "stub" };
      nodes.push(stub);
      byId.set(id, stub);
    }
    return id;
  };

  const edges: GraphEdge[] = [];
  pending.forEach((p, i) => {
    const source = p.source ?? resolve(p.sourcePath, undefined);
    const target = p.target ?? resolve(p.targetPath, p.text);
    if (source === null || target === null) return;
    edges.push({
      id: `e${i}`,
      source,
      target,
      kind: p.kind,
      key: p.key,
      ordinal: p.ordinal,
      label: edgeLabel(p.ordinal, p.key),
    });
  });

  for (const c of claims) {
    const host = canonPath(c.host);
    const drawn = edges.find((e) => e.target === c.target && e.key === c.key && canonPath(e.source) === host);
    if (drawn) {
      drawn.kind = "anchor"; // the entry the engine projected for this very anchor
      continue;
    }
    const source = resolve(c.host, undefined);
    if (source === null) continue;
    edges.push({ id: `a${edges.length}`, source, target: c.target, kind: "anchor", key: c.key, ordinal: null, label: edgeLabel(null, c.key) });
  }

  return { nodes, edges };
}
