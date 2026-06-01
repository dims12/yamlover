import { NodeJson, TreeNode } from "../api";
import { ChapterView } from "./chapter";
import { TextView, TextChunk } from "./text";

/**
 * A renderer turns a node into a React element for the RHS pane. It is selected
 * by the node's **(type, format)** tuple — the same key the TOC icons and the
 * link markers carry — so a renderer can claim, say, every `string`/`text/markdown`,
 * every `object`/`x-yamlover-chapter`, or a bare `(type, None)`. Our own custom
 * formats are prefixed `x-yamlover-`.
 *
 * The registry is the single extension point: add an entry here to teach the UI a
 * new renderable shape. A renderer's `name` is also its representation key — the
 * label of its tab and the `?format=` value (e.g. `chapter`).
 *
 * A renderer participates in the UI three ways, all keyed by the same tuple:
 *   - `render` — the full RHS page.
 *   - `renderChunk` — its *inline* form, when embedded in another renderer's page
 *     (a chapter renders each chunk by routing to the chunk's own renderer here).
 *   - `tocView` — how the node appears in the TOC: which children are navigable,
 *     whether it expands, and whether they are loaded. The chapter unwraps its
 *     `children` array (subchapters become its direct TOC entries) and keeps its
 *     `chunks` off the tree (prose is read on the page, not browsed).
 */

/** A single chunk handed to a renderer's `renderChunk` — its value plus the
 *  (type, format) it was routed on and its JSON path (the anchor target). */
export interface Chunk {
  value: unknown;
  path: string;
  type: string;
  format: string | null;
}

/** How a node appears in the TOC. `children` are the rows shown beneath it;
 *  `expandable` shows a chevron; `loaded` false means the children must be
 *  fetched (by `node.path`) on first expand. */
export interface TocView {
  children: TreeNode[];
  expandable: boolean;
  loaded: boolean;
}

export interface Renderer {
  name: string;
  /** The (type, format) tuples this renderer claims. A `null` format matches a
   *  node that carries no `format`; a string format matches that format exactly. */
  accepts: ReadonlyArray<readonly [type: string, format: string | null]>;
  /** Value depth `NodeView` must fetch for this renderer (default 1). A chapter
   *  needs 2: its `chunks`/`children` arrays one level, their elements the next. */
  depth?: number;
  /** This node's TOC presentation (default: its own children, lazily loaded). */
  tocView?: (node: TreeNode) => TocView;
  render: (node: NodeJson, onNavigate: (path: string) => void) => JSX.Element;
  /** This renderer's inline form, for embedding a single value in another page. */
  renderChunk?: (chunk: Chunk, onNavigate: (path: string) => void) => JSX.Element;
}

const REGISTRY: Renderer[] = [
  {
    name: "chapter",
    accepts: [["object", "x-yamlover-chapter"]],
    depth: 2, // reach the chunk/subchapter elements (arrays one level, items the next)
    tocView: chapterTocView,
    render: (node, onNavigate) => <ChapterView node={node} onNavigate={onNavigate} />,
  },
  {
    name: "text",
    accepts: [["string", "text/markdown"]],
    render: (node) => <TextView node={node} />,
    renderChunk: (chunk) => <TextChunk chunk={chunk} />,
  },
];

/** The last path segment (a property key or `[index]`). */
function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** A chapter's TOC view: its subchapters (the items of its `children` array)
 *  surfaced directly, with its `chunks` kept off the tree. The `children` wrapper
 *  sits one level below the chapter, so its items are loaded one level deeper —
 *  expandability follows the wrapper's own `hasChildren`. */
function chapterTocView(node: TreeNode): TocView {
  const wrap = node.children.find((c) => basename(c.path) === "children");
  if (!wrap) {
    // the chapter itself is not loaded yet — defer to the server's hint
    return { children: [], expandable: node.hasChildren, loaded: node.children.length > 0 };
  }
  return {
    children: wrap.children,
    expandable: wrap.hasChildren,
    loaded: wrap.children.length > 0 || !wrap.hasChildren,
  };
}

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

/** How `node` appears in the TOC: its renderer's `tocView`, or — when no renderer
 *  claims it — its own children, lazily loaded (the passive default). */
export function tocView(node: TreeNode): TocView {
  const r = rendererFor(node.type, node.format);
  if (r?.tocView) return r.tocView(node);
  const loaded = node.children.length > 0;
  return { children: node.children, expandable: loaded ? node.children.length > 0 : node.hasChildren, loaded };
}
