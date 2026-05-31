import { NodeJson, TreeNode } from "../api";
import { ChapterView } from "./chapter";

/**
 * A renderer turns a node into a React element for the RHS pane. It is selected
 * by the node's **(type, format)** tuple — the same key the TOC icons use — so a
 * renderer can claim, say, every `string`/`text/markdown`, every
 * `array`/`x-yamlover-chapter`, or a bare `(type, None)` (a type with no format).
 * Our own custom formats are prefixed `x-yamlover-`.
 *
 * The registry is the single extension point: add an entry here to teach the UI a
 * new renderable shape. A renderer's `name` is also its representation key — the
 * label of its tab and the `?format=` value (e.g. `chapter`).
 *
 * A renderer may also own *which of its children show in the TOC* via
 * `tocChildren`: the default surfaces all of them (a passive renderer), but a
 * renderer can present some children as content rather than navigable structure.
 * The chapter renderer keeps only subchapters in the tree (prose is read on the
 * page, not browsed).
 */
export interface Renderer {
  name: string;
  /** The (type, format) tuples this renderer claims. A `null` format matches a
   *  node that carries no `format`; a string format matches that format exactly. */
  accepts: ReadonlyArray<readonly [type: string, format: string | null]>;
  /** The subset of a node's TOC children to surface as navigable structure
   *  (default: all). */
  tocChildren?: (children: TreeNode[]) => TreeNode[];
  render: (node: NodeJson, onNavigate: (path: string) => void) => JSX.Element;
}

const REGISTRY: Renderer[] = [
  {
    name: "chapter",
    accepts: [["array", "x-yamlover-chapter"]],
    // a chapter's structure is its subchapters; its prose is page content, not TOC
    tocChildren: (children) => children.filter((c) => c.format === "x-yamlover-chapter"),
    render: (node, onNavigate) => <ChapterView node={node} onNavigate={onNavigate} />,
  },
];

/** The renderer whose `accepts` covers `(type, format)`, or null when none does. */
export function rendererFor(type: string, format: string | null): Renderer | null {
  return REGISTRY.find((r) => r.accepts.some(([t, f]) => t === type && f === format)) ?? null;
}

/** The renderer for a node's (type, format), or null → the default tabbed view. */
export function getRenderer(node: NodeJson): Renderer | null {
  return rendererFor(node.type, node.format ?? null);
}

/** The name (= representation key / `?format=` value) of the renderer for
 *  `(type, format)`, or null when none claims it. */
export function rendererName(type: string, format: string | null): string | null {
  return rendererFor(type, format)?.name ?? null;
}

/** The TOC children a `(type, format)` exposes: its renderer's `tocChildren` view
 *  of `children`, or all of them when no renderer claims it (or it defines none). */
export function tocChildren(type: string, format: string | null, children: TreeNode[]): TreeNode[] {
  const r = rendererFor(type, format);
  return r?.tocChildren ? r.tocChildren(children) : children;
}
