import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  BaseEdge,
  Controls,
  Handle,
  Position,
  MarkerType,
  getBezierPath,
  useNodesState,
  useEdgesState,
  useStore,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import "./dagflow.css";

const FONT = "12px ui-sans-serif, system-ui, -apple-system, sans-serif";
const PAD_X = 10; // must match .tight-node horizontal padding + border
const NODE_HEIGHT = 26;

type TightData = {
  label: string;
  sources: string[];
  targets: string[];
  width: number;
};

const rawNodes = [
  { id: "ingest", label: "Ingest" },
  { id: "validate", label: "Validate" },
  { id: "classify", label: "Classify" },
  { id: "enrich", label: "Enrich" },
  { id: "review", label: "Manual Review" },
  { id: "publish", label: "Publish" },
];

const rawEdges = [
  { id: "e1", source: "ingest", target: "validate", label: "raw doc" },
  { id: "e2", source: "validate", target: "classify", label: "valid" },
  { id: "e3", source: "validate", target: "enrich", label: "valid" },
  { id: "e4", source: "classify", target: "review", label: "labelled" },
  { id: "e5", source: "enrich", target: "review", label: "enriched" },
  { id: "e6", source: "review", target: "publish", label: "approved" },
];

/** Width of the label as it will actually be painted, so the frame hugs the text. */
const measure = (() => {
  const ctx = document.createElement("canvas").getContext("2d");
  return (text: string) => {
    if (!ctx) return text.length * 7;
    ctx.font = FONT;
    return Math.ceil(ctx.measureText(text).width);
  };
})();

/** Handles sit at evenly spaced fractions of the node's side, so parallel edges fan out. */
const handleOffset = (i: number, total: number) => `${((i + 1) / (total + 1)) * 100}%`;

function TightNode({ data }: NodeProps) {
  const { label, sources, targets, width } = data as TightData;
  return (
    <div className="tight-node" style={{ width }}>
      {targets.map((id, i) => (
        <Handle key={id} id={id} type="target" position={Position.Left} style={{ top: handleOffset(i, targets.length) }} />
      ))}
      {label}
      {sources.map((id, i) => (
        <Handle key={id} id={id} type="source" position={Position.Right} style={{ top: handleOffset(i, sources.length) }} />
      ))}
    </div>
  );
}

const nodeTypes = { tight: TightNode };

/** Bézier edge whose label rides the curve itself (SVG <textPath> anchored to the edge path). */
function CurvedLabelEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  label,
  style,
  markerEnd,
}: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {label ? (
        <text className="edge-label" dy={-5}>
          {/* startOffset trims the run so the glyphs never reach the arrowhead. */}
          <textPath href={`#${id}`} startOffset="45%" textAnchor="middle">
            {label}
          </textPath>
        </text>
      ) : null}
    </>
  );
}

const edgeTypes = { curved: CurvedLabelEdge };

function build(): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 34, ranksep: 110 });

  const widths = new Map(rawNodes.map((n) => [n.id, measure(n.label) + 2 * PAD_X]));
  rawNodes.forEach((n) => g.setNode(n.id, { width: widths.get(n.id)!, height: NODE_HEIGHT }));
  rawEdges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);

  // Fan handles out in the vertical order of the nodes they connect to, so parallel edges
  // leaving (or entering) one side never cross each other.
  const sources = new Map(rawNodes.map((n) => [n.id, [] as string[]]));
  const targets = new Map(rawNodes.map((n) => [n.id, [] as string[]]));
  for (const e of [...rawEdges].sort((a, b) => g.node(a.target).y - g.node(b.target).y)) {
    sources.get(e.source)!.push(e.id);
  }
  for (const e of [...rawEdges].sort((a, b) => g.node(a.source).y - g.node(b.source).y)) {
    targets.get(e.target)!.push(e.id);
  }

  const nodes: Node[] = rawNodes.map((n) => {
    const { x, y } = g.node(n.id);
    const width = widths.get(n.id)!;
    return {
      id: n.id,
      type: "tight",
      data: { label: n.label, sources: sources.get(n.id)!, targets: targets.get(n.id)!, width },
      // Dagre returns the node centre; React Flow expects the top-left corner.
      position: { x: x - width / 2, y: y - NODE_HEIGHT / 2 },
    };
  });

  const edges: Edge[] = rawEdges.map((e) => ({
    ...e,
    sourceHandle: e.id,
    targetHandle: e.id,
    type: "curved",
    style: { stroke: "#000", strokeWidth: 1.4 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#000", width: 16, height: 16 },
  }));

  return { nodes, edges };
}

/**
 * The Controls lock writes `nodesDraggable` into the store, but the node renderer reads the
 * ReactFlow *prop* instead — so without lifting the store value back up, the lock cannot
 * actually stop a drag.
 */
function LockSync({ onChange }: { onChange: (draggable: boolean) => void }) {
  const draggable = useStore((s) => s.nodesDraggable);
  useEffect(() => onChange(draggable), [draggable, onChange]);
  return null;
}

export default function DagFlow() {
  const initial = useMemo(build, []);
  const [draggable, setDraggable] = useState(true);
  // Dragging only sticks if the position changes are applied back; useNodesState does that.
  const [nodes, , onNodesChange] = useNodesState(initial.nodes);
  const [edges, , onEdgesChange] = useEdgesState(initial.edges);

  return (
    <div style={{ width: "100%", height: "600px" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={draggable}
        fitView
      >
        <LockSync onChange={setDraggable} />
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
