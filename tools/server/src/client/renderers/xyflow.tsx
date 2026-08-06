// The renderer for a node tagged `!!<*yamlover: $defs: xyflow>` (format `x-yamlover-xyflow`): the
// subtree drawn as the GRAPH it is (docs/language/model/graph), laid out left to right by dagre and
// painted by React Flow.
//
// What the drawing says: a node's box holds its scalar self-value, a valueless node is a bare
// circle, every relation is titled by its ordinal and its key, and the three edge kinds — the
// containment spine, a `*` dereference, an `&` anchor membership — each get their own stroke.
// The model itself lives in xyflow-graph.ts; this file is layout and paint.

import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import { fetchNode, type NodeJson } from "../api";
import { useSubtreeDiffBump } from "../live";
import { asMixed } from "../render";
import { buildGraph, type GraphEdge, type GraphNode } from "./xyflow-graph";
import type { Chunk } from "./registry";

const FONT = "12px ui-sans-serif, system-ui, -apple-system, sans-serif";
const PAD_X = 10; // matches .xyflow-node's horizontal padding + border
const NODE_HEIGHT = 26;
const EMPTY_SIZE = 12; // the bare circle a valueless node draws as

/** The width the label will actually paint at, so the frame hugs the text. */
const measure = (() => {
  let ctx: CanvasRenderingContext2D | null | undefined;
  return (text: string): number => {
    if (ctx === undefined) ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return text.length * 7; // no canvas (jsdom) — an estimate keeps the layout sane
    ctx.font = FONT;
    return Math.ceil(ctx.measureText(text).width);
  };
})();

const nodeWidth = (n: GraphNode): number => (n.kind === "empty" ? EMPTY_SIZE : measure(n.label) + 2 * PAD_X);
const nodeHeight = (n: GraphNode): number => (n.kind === "empty" ? EMPTY_SIZE : NODE_HEIGHT);

interface FlowNodeData extends Record<string, unknown> {
  node: GraphNode;
  width: number;
  height: number;
  sources: string[];
  targets: string[];
  onNavigate: (path: string) => void;
}

/** Handles sit at evenly spaced fractions of the side, so relations leaving (or entering) one
 *  node fan out instead of piling onto a single point. */
const handleOffset = (i: number, total: number) => `${((i + 1) / (total + 1)) * 100}%`;

/** A value's token class in the code palette (styles.css `.s .n .b`) — the same ink the source
 *  view gives it, so a green string stays green wherever it is read. A stub is a pointer end, so
 *  it takes the reference colour. */
const tokenClass = (n: GraphNode): string =>
  n.kind === "stub" ? "ref" : n.valueType === "number" ? "n" : n.valueType === "boolean" ? "b" : "s";

function GraphNodeBox({ data }: NodeProps) {
  const { node, width, height, sources, targets, onNavigate } = data as FlowNodeData;
  const navigable = node.path !== null;
  return (
    <div
      className={`xyflow-node xyflow-node-${node.kind}${navigable ? " xyflow-node-nav" : ""}`}
      style={{ width, height }}
      title={node.path ?? node.label}
      data-node-path={node.path ?? undefined}
      onClick={navigable ? () => onNavigate(node.path!) : undefined}
    >
      {targets.map((id, i) => (
        <Handle key={id} id={id} type="target" position={Position.Left} style={{ top: handleOffset(i, targets.length) }} />
      ))}
      {node.kind === "empty" ? null : <span className={tokenClass(node)}>{node.label}</span>}
      {sources.map((id, i) => (
        <Handle key={id} id={id} type="source" position={Position.Right} style={{ top: handleOffset(i, sources.length) }} />
      ))}
    </div>
  );
}

const nodeTypes = { yamlover: GraphNodeBox };

/** A bézier edge whose title rides the curve itself (an SVG `<textPath>` bound to the edge path),
 *  so a relation is read along the line it names. */
function GraphEdgeLine({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data }: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const d = (data ?? {}) as { kind?: string; key?: string | null; ordinal?: number | null };
  const kind = d.kind ?? "contain";
  const key = d.key ?? null;
  const ordinal = d.ordinal ?? null;
  if (key === null && ordinal === null) return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <text className={`xyflow-edge-label xyflow-edge-${kind}${key === null ? " xyflow-edge-ordinal" : ""}`} dy={-5}>
        {/* just short of half, so the glyphs never reach the arrowhead. The relation is written
            in the code palette: its position a number, its key a key. */}
        <textPath href={`#${id}`} startOffset="45%" textAnchor="middle">
          {ordinal !== null ? <tspan className="n">{ordinal}</tspan> : null}
          {ordinal !== null && key !== null ? <tspan className="punct">: </tspan> : null}
          {key !== null ? <tspan className="k">{key}</tspan> : null}
        </textPath>
      </text>
    </>
  );
}

const edgeTypes = { yamlover: GraphEdgeLine };

/** Dash pattern per edge kind: the containment spine is solid, a `*` dereference and an `&`
 *  anchor membership are dashed — each its own rhythm. */
const strokeOf = (e: GraphEdge): { strokeDasharray?: string; strokeWidth: number; stroke: string } => {
  if (e.kind === "deref") return { strokeDasharray: "6 3", strokeWidth: 1.4, stroke: "var(--fg)" };
  if (e.kind === "anchor") return { strokeDasharray: "1 3 5 3", strokeWidth: 1.4, stroke: "var(--fg)" };
  // a position-only relation carries no name of its own — drawn lighter than a keyed one
  return e.key === null
    ? { strokeWidth: 0.9, stroke: "var(--dim)" }
    : { strokeWidth: 1.4, stroke: "var(--fg)" };
};

/**
 * Re-seat each column so a node's relations leave it TOP TO BOTTOM, in their own order.
 *
 * Dagre orders a rank to minimise edge crossings and thinks nothing of handing relation 0 the
 * bottom slot and the last relation the top — so a fan reads upwards, against the document. Order
 * IS data here (docs/language/principles/order-is-data): a node's relations are a sequence, and the
 * drawing should be read in it.
 *
 * The rule is the classic tidy-tree one, applied column by column from the left: seat a node under
 * the parent that holds it, and siblings among themselves by ordinal. Sorting by the parent's
 * (already seated) y keeps whole subtrees in the vertical order their parents have — which is what
 * kept the crossings down in the first place — while the ordinal tiebreak, which is the only say
 * dagre had, now runs downwards. A node whose parent is not to its left (the root, a `*`/`&` stub)
 * keeps the seat dagre gave it.
 *
 * Only the y values dagre already chose are permuted, never invented, so the room it reserved for
 * long edges threading through a rank survives. That also cannot crowd anything: dagre spaces
 * neighbours by `nodesep` (30) plus their half-heights, more than the tallest box (26) needs even
 * in the tightest slot it can inherit.
 */
const COLUMN_TOL = 20; // x spread that still counts as one rank (ranks sit `ranksep` = 150 apart)

export function reseatInRelationOrder(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, place: Map<string, { x: number; y: number }>): void {
  const parent = new Map<string, string>();
  const ordinal = new Map<string, number>();
  graph.edges.forEach((e, i) => {
    if (e.kind !== "contain" || parent.has(e.target)) return; // containment is the spine — one parent
    parent.set(e.target, e.source);
    ordinal.set(e.target, e.ordinal ?? i);
  });

  // Nodes of one rank can land a pixel apart (dagre centres each by its own width), so columns are
  // CLUSTERED, not keyed by an exact x — two real ranks are `ranksep` apart, never a hair.
  const xs = [...new Set(graph.nodes.map((n) => place.get(n.id)!.x))].sort((a, b) => a - b);
  const columnOf = new Map<number, number>();
  let index = 0;
  xs.forEach((x, i) => {
    if (i > 0 && x - xs[i - 1] > COLUMN_TOL) index++;
    columnOf.set(x, index);
  });
  const columns = new Map<number, string[]>();
  graph.nodes.forEach((n) => {
    const c = columnOf.get(place.get(n.id)!.x)!;
    const col = columns.get(c) ?? [];
    if (col.length === 0) columns.set(c, col);
    col.push(n.id);
  });

  const seated = new Set<string>(); // columns already re-seated, so a parent's y is final
  for (const c of [...columns.keys()].sort((a, b) => a - b)) {
    const col = columns.get(c)!;
    const anchorY = (id: string): number => {
      const p = parent.get(id);
      return p !== undefined && seated.has(p) ? place.get(p)!.y : place.get(id)!.y;
    };
    const slots = col.map((id) => place.get(id)!.y).sort((a, b) => a - b);
    const order = new Map(col.map((id, i) => [id, i])); // dagre's own order, the last tiebreak
    const seats = [...col].sort(
      (a, b) => anchorY(a) - anchorY(b) || (ordinal.get(a) ?? 0) - (ordinal.get(b) ?? 0) || order.get(a)! - order.get(b)!,
    );
    seats.forEach((id, i) => { place.get(id)!.y = slots[i]; });
    for (const id of col) seated.add(id);
  }
}

function layout(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, onNavigate: (path: string) => void): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // ranksep buys the room a title riding the curve needs; nodesep keeps a wide fan legible
  g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 150 });

  const size = new Map(graph.nodes.map((n) => [n.id, { width: nodeWidth(n), height: nodeHeight(n) }]));
  graph.nodes.forEach((n) => g.setNode(n.id, { ...size.get(n.id)! }));
  graph.edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);

  const place = new Map(graph.nodes.map((n) => [n.id, { x: g.node(n.id)?.x ?? 0, y: g.node(n.id)?.y ?? 0 }]));
  reseatInRelationOrder(graph, place);
  const y = (id: string): number => place.get(id)?.y ?? 0;

  // Fan the handles out in the vertical order of the nodes at the far end, so parallel relations
  // never cross each other on their way out of (or into) one node.
  const sources = new Map(graph.nodes.map((n) => [n.id, [] as string[]]));
  const targets = new Map(graph.nodes.map((n) => [n.id, [] as string[]]));
  for (const e of [...graph.edges].sort((a, b) => y(a.target) - y(b.target))) sources.get(e.source)?.push(e.id);
  for (const e of [...graph.edges].sort((a, b) => y(a.source) - y(b.source))) targets.get(e.target)?.push(e.id);

  const nodes: Node[] = graph.nodes.map((n) => {
    const { width, height } = size.get(n.id)!;
    const pos = place.get(n.id)!;
    return {
      id: n.id,
      type: "yamlover",
      data: { node: n, width, height, sources: sources.get(n.id) ?? [], targets: targets.get(n.id) ?? [], onNavigate },
      // dagre returns the node centre; React Flow expects the top-left corner
      position: { x: pos.x - width / 2, y: pos.y - height / 2 },
    };
  });

  const edges: Edge[] = graph.edges.map((e) => {
    const stroke = strokeOf(e);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.id,
      targetHandle: e.id,
      type: "yamlover",
      data: { kind: e.kind, key: e.key, ordinal: e.ordinal },
      style: stroke,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke.stroke, width: 14, height: 14 },
    };
  });

  return { nodes, edges };
}

function Canvas({ node, onNavigate, className }: { node: NodeJson; onNavigate: (path: string) => void; className: string }) {
  const { nodes, edges } = useMemo(() => layout(buildGraph(node), onNavigate), [node, onNavigate]);
  if (nodes.length === 0) return <p className="csv-empty">nothing to draw</p>;
  return (
    <div className={className}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesDraggable={false} fitView>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/** The full-page view. */
export function XyflowView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  return <Canvas node={node} onNavigate={onNavigate} className="xyflow-view" />;
}

/** The inline (chapter body) form. A chapter fetches at depth 1, so the graph arrives as a link
 *  marker — fetch the whole subtree by path (the ListChunk/TableChunk precedent). */
export function XyflowChunk({ chunk, onNavigate }: { chunk: Chunk; onNavigate: (path: string) => void }) {
  const [node, setNode] = useState<NodeJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inline = asMixed(chunk.value) != null || Array.isArray(chunk.value);
  const bump = useSubtreeDiffBump(inline ? null : chunk.path);
  useEffect(() => {
    if (inline) return;
    let cancelled = false;
    fetchNode(chunk.path, null)
      .then((n) => !cancelled && setNode(n))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [chunk.path, inline, bump]);

  if (inline) {
    const synthetic: NodeJson = {
      path: chunk.path,
      type: chunk.type,
      format: chunk.format,
      concrete: null,
      documentPath: chunk.documentPath,
      title: null,
      description: null,
      value: chunk.value,
    } as NodeJson;
    return <Canvas node={synthetic} onNavigate={onNavigate} className="xyflow-chunk" />;
  }
  if (error) return <p className="csv-empty">graph failed to load: {error}</p>;
  if (!node) return <p className="csv-empty">…</p>;
  return <Canvas node={node} onNavigate={onNavigate} className="xyflow-chunk" />;
}
