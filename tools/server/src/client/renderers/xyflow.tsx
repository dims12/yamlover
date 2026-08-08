// The renderer for a node tagged `!!<*yamlover: $defs: xyflow>` (format `x-yamlover-xyflow`): the
// subtree drawn as the GRAPH it is (docs/language/model/graph), laid out left to right by dagre and
// painted by React Flow.
//
// What the drawing says: a node's box holds its scalar self-value, a valueless node is a bare
// circle, every relation is titled by its ordinal and its key, and the three edge kinds — the
// containment spine, a `*` dereference, an `&` anchor membership — each get their own stroke.
// The model itself lives in xyflow-graph.ts; this file is layout and paint.
//
// Gestures follow the unified model (panzoom.ts / the UI guide): a plain drag moves the PRIMARY
// thing — here a NODE (rearranging the drawing); ctrl/alt-drag and right-button drag pan the
// canvas; a plain wheel pans vertically; ctrl/alt-wheel zooms around the cursor. A DOUBLE-click
// on a node navigates to its element. A chapter chunk is inert (the page keeps scrolling over
// it); double-clicking its canvas opens the graph alone.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import { fetchNode, type NodeJson } from "../api";
import { useSubtreeDiffBump } from "../live";
import { asMixed } from "../render";
import { buildGraph, type GraphEdge, type GraphNode } from "./xyflow-graph";
import { useFillHeight } from "./paged";
import type { Chunk } from "./registry";

// The modifier keys that switch a drag/wheel from its primary meaning to pan/zoom — the same set
// panzoom.ts's `hasMod` honours (ctrl or alt, plus cmd on a Mac).
const MODS = ["Control", "Alt", "Meta"];
const hasMod = (e: React.MouseEvent): boolean => e.ctrlKey || e.altKey || e.metaKey;

const FONT = "12px ui-sans-serif, system-ui, -apple-system, sans-serif";
const PAD_X = 10; // matches .xyflow-node's horizontal padding + border
const NODE_HEIGHT = 26;
const LINE_H = 16; // one wrapped line (the 12px font with its leading)
const PAD_Y = (NODE_HEIGHT - LINE_H) / 2; // so a single-line box stays exactly NODE_HEIGHT
const EMPTY_SIZE = 12; // the bare circle a valueless node draws as
const WRAP_MIN = 180; // a label narrower than this stays one line — only LONG strings wrap
const RATIO = 4 / 3; // the box a wrapped label sits in tends to 4:3 (w:h)

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

/** A LONG label broken into balanced lines so its box tends to a 4:3 (w:h) ratio; a short one —
 *  or a single unbreakable word — stays a single line. The line count n solves
 *  `W/n + 2·PAD_X = RATIO · (n·LINE_H + 2·PAD_Y)` (the ideal balanced wrap of a text W wide);
 *  the greedy fill then wraps to that ideal line width, never below the longest word. */
export function wrapLabel(label: string): string[] {
  const W = measure(label);
  if (W <= WRAP_MIN) return [label];
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [label];
  const b = 2 * RATIO * PAD_Y - 2 * PAD_X;
  const n = Math.max(1, Math.round((-b + Math.sqrt(b * b + 4 * RATIO * LINE_H * W)) / (2 * RATIO * LINE_H)));
  const fill = (target: number): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const grown = line === "" ? w : line + " " + w;
      if (line !== "" && measure(grown) > target) {
        lines.push(line);
        line = w;
      } else line = grown;
    }
    if (line !== "") lines.push(line);
    return lines;
  };
  // The greedy fill loses part of every line to a word boundary, so at the ideal width it runs
  // over n lines — and the box comes out taller than 4:3. Widen the target until n lines hold
  // the text (bounded: at `target = W` everything is one line).
  let target = Math.max(W / n, ...words.map(measure));
  let lines = fill(target);
  while (lines.length > n) {
    target *= 1.15;
    lines = fill(target);
  }
  return lines;
}

const nodeWidth = (n: GraphNode, lines: string[]): number =>
  n.kind === "empty" ? EMPTY_SIZE : Math.max(...lines.map(measure)) + 2 * PAD_X;
const nodeHeight = (n: GraphNode, lines: string[]): number =>
  n.kind === "empty" ? EMPTY_SIZE : lines.length * LINE_H + 2 * PAD_Y;

interface FlowNodeData extends Record<string, unknown> {
  node: GraphNode;
  /** The label's wrapped lines (wrapLabel) — one entry for a short label, none for an empty node. */
  lines: string[];
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
  const { node, lines, width, height, sources, targets, onNavigate } = data as FlowNodeData;
  const navigable = node.path !== null;
  return (
    <div
      className={`xyflow-node xyflow-node-${node.kind}${navigable ? " xyflow-node-nav" : ""}`}
      style={{ width, height }}
      title={node.path ? `${node.path} — double-click to open` : node.label}
      data-node-path={node.path ?? undefined}
      // DOUBLE-click navigates; a single click is free for grabbing the node (nodesDraggable).
      // stopPropagation so a chunk's canvas-level double-click (open the graph alone) stays put.
      onDoubleClick={navigable ? (e) => { e.stopPropagation(); onNavigate(node.path!); } : undefined}
    >
      {targets.map((id, i) => (
        <Handle key={id} id={id} type="target" position={Position.Left} style={{ top: handleOffset(i, targets.length) }} />
      ))}
      {node.kind === "empty" ? null : (
        // explicit <br/>s, not CSS wrapping: the lines are the very ones the box was measured for
        <span className={tokenClass(node)} style={{ lineHeight: `${LINE_H}px`, textAlign: "center" }}>
          {lines.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {l}
            </Fragment>
          ))}
        </span>
      )}
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
 * long edges threading through a rank survives. With uniform heights that could not crowd anything
 * (dagre spaces neighbours by `nodesep` plus their half-heights); a WRAPPED label's box is taller
 * than the slot a short neighbour vacated, though, so when `height` is given, a relief sweep walks
 * each re-seated column downwards and pushes apart any pair the permutation crowded — downward
 * only, so the order just chosen survives, and only when actually crowded, so an uncrowded column
 * keeps dagre's slots to the pixel.
 */
const COLUMN_TOL = 20; // x spread that still counts as one rank (ranks sit `ranksep` = 150 apart)
const RELIEF_GAP = 12; // the least edge-to-edge room after a swap (under dagre's nodesep, 30)

export function reseatInRelationOrder(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  place: Map<string, { x: number; y: number }>,
  height?: (id: string) => number,
): void {
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
    if (height) {
      let bottom = -Infinity; // seats hold the column top to bottom — walk down, relieving crowding
      for (const id of seats) {
        const p = place.get(id)!;
        const h = height(id);
        if (p.y - h / 2 < bottom + RELIEF_GAP) p.y = bottom + RELIEF_GAP + h / 2;
        bottom = p.y + h / 2;
      }
    }
    for (const id of col) seated.add(id);
  }
}

function layout(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, onNavigate: (path: string) => void): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // ranksep buys the room a title riding the curve needs; nodesep keeps a wide fan legible
  g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 150 });

  const lines = new Map(graph.nodes.map((n) => [n.id, n.kind === "empty" ? [] : wrapLabel(n.label)]));
  const size = new Map(graph.nodes.map((n) => [n.id, { width: nodeWidth(n, lines.get(n.id)!), height: nodeHeight(n, lines.get(n.id)!) }]));
  graph.nodes.forEach((n) => g.setNode(n.id, { ...size.get(n.id)! }));
  graph.edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);

  const place = new Map(graph.nodes.map((n) => [n.id, { x: g.node(n.id)?.x ?? 0, y: g.node(n.id)?.y ?? 0 }]));
  reseatInRelationOrder(graph, place, (id) => size.get(id)!.height);
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
      data: { node: n, lines: lines.get(n.id)!, width, height, sources: sources.get(n.id) ?? [], targets: targets.get(n.id) ?? [], onNavigate },
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

function Canvas({ node, onNavigate, className, interactive = false, openPath }: {
  node: NodeJson;
  onNavigate: (path: string) => void;
  className: string;
  /** The full-page view: nodes drag, the canvas pans/zooms (unified gestures), the frame fills to
   *  the window bottom. Off for a chapter chunk — it sits inert in the page's own scroll flow. */
  interactive?: boolean;
  /** Chunk only: the graph's own node — double-clicking the canvas opens it alone. */
  openPath?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  useFillHeight(wrapRef, 14, interactive); // the full view fills down to the window bottom
  const graph = useMemo(() => layout(buildGraph(node), onNavigate), [node, onNavigate]);
  // Node positions live in React Flow state so a plain drag REARRANGES the drawing; a fresh
  // layout (the value changed, a live refresh) re-seats everything.
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  useEffect(() => setNodes(graph.nodes), [graph, setNodes]);

  // Ctrl/alt-drag PANS, from anywhere — a node included — matching the Leaflet viewers
  // (panzoom.ts). Done by hand because React Flow's d3 filter rejects ctrl+mousedown outright
  // (its `panActivationKeyCode` can never be Control); captured before React Flow so a modifier
  // drag never starts a node drag.
  const onModPanStart = (e: React.MouseEvent) => {
    const flow = flowRef.current;
    if (!flow || e.button !== 0 || !hasMod(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const from = { x: e.clientX, y: e.clientY };
    const v = flow.getViewport();
    const move = (ev: MouseEvent) =>
      flow.setViewport({ x: v.x + ev.clientX - from.x, y: v.y + ev.clientY - from.y, zoom: v.zoom });
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  if (graph.nodes.length === 0) return <p className="csv-empty">nothing to draw</p>;
  return (
    <div
      ref={wrapRef}
      className={className}
      onMouseDownCapture={interactive ? onModPanStart : undefined}
      onDoubleClick={openPath ? () => onNavigate(openPath) : undefined}
      title={openPath ? "Double-click to open the graph on its own page" : undefined}
    >
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        onNodesChange={interactive ? onNodesChange : undefined}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        nodesDraggable={interactive}
        elementsSelectable={interactive}
        zoomOnDoubleClick={false} // double-click means NAVIGATE here, never zoom
        {...(interactive
          ? {
              // the unified gestures (panzoom.ts): ctrl/alt-drag (onModPanStart above) or
              // right-drag pans, plain wheel pans vertically, ctrl/alt-wheel zooms at the cursor
              onInit: (flow: ReactFlowInstance) => { flowRef.current = flow; },
              panOnDrag: [2],
              panOnScroll: true,
              zoomOnScroll: false,
              zoomActivationKeyCode: MODS,
              onPaneContextMenu: (e: React.MouseEvent | MouseEvent) => e.preventDefault(),
            }
          : {
              // a chunk is INERT: no pan, no zoom, and the wheel scrolls the chapter page
              panOnDrag: false,
              panOnScroll: false,
              zoomOnScroll: false,
              zoomOnPinch: false,
              preventScrolling: false,
            })}
      >
        {interactive && <Controls position="top-left" showInteractive={false} />}
      </ReactFlow>
    </div>
  );
}

/** The full-page view. */
export function XyflowView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  return <Canvas node={node} onNavigate={onNavigate} className="xyflow-view" interactive />;
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
    return <Canvas node={synthetic} onNavigate={onNavigate} className="xyflow-chunk" openPath={chunk.path} />;
  }
  if (error) return <p className="csv-empty">graph failed to load: {error}</p>;
  if (!node) return <p className="csv-empty">…</p>;
  return <Canvas node={node} onNavigate={onNavigate} className="xyflow-chunk" openPath={chunk.path} />;
}
