import { lazy, Suspense } from "react";
import { NodeJson, TreeNode } from "../api";
import { ChapterView } from "./chapter";
import { TextView, TextChunk } from "./text";
import { AsciidocView, AsciidocChunk } from "./asciidoc";
import { TagView } from "./tag";
import { Fb2View } from "./fb2";
import { EpubView } from "./epub";
import { ImageView, HtmlView } from "./media";

// pdf.js and DjVu.js are heavy and browser-only (they reach for canvas globals at
// import time). Load them lazily so the registry — imported by the TOC and by
// tests — never pulls them in until a PDF/DjVu node is actually rendered.
const PdfView = lazy(() => import("./pdf").then((m) => ({ default: m.PdfView })));
const DjvuView = lazy(() => import("./djvu").then((m) => ({ default: m.DjvuView })));
const lazily = (el: JSX.Element) => <Suspense fallback={<div className="loading">…</div>}>{el}</Suspense>;

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
  {
    name: "asciidoc",
    accepts: [["string", "text/asciidoc"]],
    render: (node) => <AsciidocView node={node} />,
    renderChunk: (chunk) => <AsciidocChunk chunk={chunk} />,
  },
  {
    name: "tag",
    accepts: [["object", "x-yamlover-tag"]],
    render: (node, onNavigate) => <TagView node={node} onNavigate={onNavigate} />,
  },
  {
    // File-backed binaries the server tags with an inferred image format.
    name: "image",
    accepts: [
      ["binary", "image/png"],
      ["binary", "image/jpeg"],
      ["binary", "image/gif"],
      ["binary", "image/webp"],
      ["binary", "image/avif"],
      ["binary", "image/bmp"],
      ["binary", "image/x-icon"],
      ["binary", "image/svg+xml"],
    ],
    render: (node) => <ImageView node={node} />,
  },
  {
    name: "html",
    accepts: [["binary", "text/html"]],
    render: (node) => <HtmlView node={node} />,
  },
  {
    name: "fb2",
    accepts: [["binary", "application/x-fictionbook+xml"]],
    render: (node) => <Fb2View node={node} />,
  },
  {
    name: "epub",
    accepts: [["binary", "application/epub+zip"]],
    render: (node) => <EpubView node={node} />,
  },
  {
    name: "pdf",
    accepts: [["binary", "application/pdf"]],
    render: (node) => lazily(<PdfView node={node} />),
  },
  {
    name: "djvu",
    accepts: [["binary", "image/vnd.djvu"]],
    render: (node) => lazily(<DjvuView node={node} />),
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
