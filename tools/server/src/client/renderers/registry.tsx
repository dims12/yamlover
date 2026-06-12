import { lazy, Suspense } from "react";
import { NodeJson, TreeNode } from "../api";
import { ChapterView } from "./chapter";
import { TextView, TextChunk } from "./text";
import { MarklowerView, MarklowerChunk } from "./marklower";
import { LatexView, LatexChunk } from "./latex";
import { AsciidocView, AsciidocChunk } from "./asciidoc";
import { CsvView, CsvChunk, CsvControls } from "./csv";
import { PlaintextView, PlaintextChunk, EncodingControl } from "./plaintext";
import { RtfView, RtfChunk } from "./rtf";
import { DocView, DocChunk } from "./doc";
import { PlantumlView, PlantumlChunk } from "./plantuml";
import { ExplorerView, ExplorerViewControl } from "./explorer";
import { Fb2View } from "./fb2";
import { EpubView } from "./epub";
import { HtmlView } from "./media";
import { MarkupWidthControl } from "./markup";

// pdf.js and DjVu.js are heavy and browser-only (they reach for canvas globals at
// import time). Load them lazily so the registry — imported by the TOC and by
// tests — never pulls them in until a PDF/DjVu node is actually rendered.
const PdfView = lazy(() => import("./pdf").then((m) => ({ default: m.PdfView })));
const DjvuView = lazy(() => import("./djvu").then((m) => ({ default: m.DjvuView })));
const PsdView = lazy(() => import("./psd").then((m) => ({ default: m.PsdView })));
const TiffView = lazy(() => import("./tiff").then((m) => ({ default: m.TiffView })));
const HeicView = lazy(() => import("./heic").then((m) => ({ default: m.HeicView })));
// mammoth (.docx) and SheetJS (.xls/.xlsx) are heavy; load each on first use.
const DocxView = lazy(() => import("./docx").then((m) => ({ default: m.DocxView })));
const DocxChunk = lazy(() => import("./docx").then((m) => ({ default: m.DocxChunk })));
const SpreadsheetView = lazy(() => import("./spreadsheet").then((m) => ({ default: m.SpreadsheetView })));
const SpreadsheetChunk = lazy(() => import("./spreadsheet").then((m) => ({ default: m.SpreadsheetChunk })));
// Leaflet (KML/KMZ maps; and the pan/zoom image viewer) is heavy and browser-only; lazy-load.
const MapView = lazy(() => import("./map").then((m) => ({ default: m.MapView })));
const MapChunk = lazy(() => import("./map").then((m) => ({ default: m.MapChunk })));
const ImageView = lazy(() => import("./imagemap").then((m) => ({ default: m.ImageView })));
const ImageChunk = lazy(() => import("./imagemap").then((m) => ({ default: m.ImageChunk })));
const lazily = (el: JSX.Element) => <Suspense fallback={<div className="loading">…</div>}>{el}</Suspense>;

/** Synthesize a minimal `NodeJson` from a chunk so a file-backed renderer (which
 *  only needs the node's `path`/`value`) can be reused *inline* as a chapter
 *  chunk — the same view, addressed by the chunk's own node path. This is how a
 *  PDF / DjVu / PSD / TIFF / HEIC / FB2 / EPUB / HTML chunk renders in a chapter
 *  body, not just a full page. */
const chunkNode = (chunk: Chunk): NodeJson => ({
  path: chunk.path,
  type: chunk.type,
  format: chunk.format,
  concrete: null,
  title: null,
  description: null,
  value: chunk.value,
});

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
  /** The JSON-space path of the document this chunk belongs to (the enclosing
   *  chapter's `documentPath`) — the anchor a document-relative (`/…`) marklower
   *  link in the chunk resolves against. */
  documentPath?: string;
}

/** How a node appears in the TOC. `children` are the rows shown beneath it;
 *  `expandable` shows a chevron; `loaded` false means the children must be
 *  fetched (by `node.path`) on first expand. `loadDepth` is how many levels that
 *  expand fetch must pull (default 1) — more when a renderer's TOC rows live
 *  deeper than the node's direct children (a chapter surfaces its subchapters
 *  from *under* its `children` wrapper, and fetches one further level so each
 *  revealed subchapter's own chevron is accurate — so it needs 3). */
export interface TocView {
  children: TreeNode[];
  expandable: boolean;
  loaded: boolean;
  loadDepth?: number;
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
  /** An optional control shown in the tab bar beside this renderer's button (only while its
   *  view is active) — e.g. the markdown/asciidoc reading-width input. `rerender` refreshes
   *  the node view after the control changes a URL parameter. */
  config?: (rerender: () => void) => JSX.Element;
}

/**
 * The EXPLORER — a file-manager "small icons" grid of a node's members, uplinks first. It is
 * claimed two ways: by (type, format) for tags (a tag projects as `object` — fields only,
 * `variant` — description BODY + fields, `string` — a leaf tag that is just its description,
 * or `null` — a bare tag with neither, the shape the picker's create-on-miss writes;
 * the grid shows the tagged MATERIALS), and as the CONCRETE fallback for any node stored as a
 * filesystem directory (`dir`/`yamlover`) that no (type, format) renderer claims — see
 * {@link getRenderer}. Hoisted so the fallback can reference the same instance.
 */
const EXPLORER: Renderer = {
  name: "explorer",
  accepts: [
    ["object", "x-yamlover-tag"],
    ["variant", "x-yamlover-tag"],
    ["string", "x-yamlover-tag"],
    ["null", "x-yamlover-tag"],
  ],
  render: (node, onNavigate) => <ExplorerView node={node} onNavigate={onNavigate} />,
  config: (rerender) => <ExplorerViewControl rerender={rerender} />, // large/small icons (`?view=`)
};

/** A directory-stored node (`dir` = a plain folder, `yamlover` = a folder with `.yamlover/`). */
const isDirConcrete = (concrete: string | null | undefined): boolean => concrete === "dir" || concrete === "yamlover";

const REGISTRY: Renderer[] = [
  {
    name: "chapter",
    accepts: [["object", "x-yamlover-chapter"]],
    depth: 2, // reach the chunk/subchapter elements (arrays one level, items the next)
    tocView: chapterTocView,
    render: (node, onNavigate) => <ChapterView node={node} onNavigate={onNavigate} />,
  },
  {
    // Our default for a bare, format-less string: marklower, a markup language a
    // notch below Markdown. A chapter's prose chunks route here — both the bare
    // (string, null) form and the explicit `text/marklower` the chunk schema applies.
    name: "marklower",
    accepts: [
      ["string", null],
      ["string", "text/marklower"],
    ],
    render: (node, onNavigate) => <MarklowerView node={node} onNavigate={onNavigate} />,
    renderChunk: (chunk, onNavigate) => <MarklowerChunk chunk={chunk} onNavigate={onNavigate} />,
  },
  {
    // Markdown (the component file is text.tsx for historical reasons; the renderer —
    // its tab label and `?format=` key — is named for what it renders).
    name: "markdown",
    accepts: [["string", "text/markdown"]],
    render: (node) => <TextView node={node} />,
    renderChunk: (chunk) => <TextChunk chunk={chunk} />,
    config: (rerender) => <MarkupWidthControl rerender={rerender} />,
  },
  {
    name: "asciidoc",
    accepts: [["string", "text/asciidoc"]],
    render: (node) => <AsciidocView node={node} />,
    renderChunk: (chunk) => <AsciidocChunk chunk={chunk} />,
    config: (rerender) => <MarkupWidthControl rerender={rerender} />,
  },
  {
    // Delimited text (CSV/TSV, a string) shown as a table; its parsing options
    // (separator, header) ride in the URL query — see csv.tsx.
    name: "csv",
    accepts: [
      ["string", "text/csv"],
      ["string", "text/tab-separated-values"],
    ],
    render: (node) => <CsvView node={node} />,
    renderChunk: (chunk) => <CsvChunk chunk={chunk} />,
    config: (rerender) => <CsvControls rerender={rerender} />,
  },
  {
    // Plain text shown verbatim (no markup), with a node-bar encoding selector —
    // CP866 / Windows-1251 / KOI8-R / UTF-8 (see plaintext.tsx). Served as raw
    // bytes so the encoding is the client's to choose.
    name: "plaintext",
    accepts: [["binary", "text/plain"]],
    render: (node) => <PlaintextView node={node} />,
    renderChunk: (chunk) => <PlaintextChunk chunk={chunk} />,
    config: (rerender) => <EncodingControl rerender={rerender} />,
  },
  {
    // RTF — a dependency-free converter to HTML (see rtf.tsx).
    name: "rtf",
    accepts: [["binary", "application/rtf"]],
    render: (node) => <RtfView node={node} />,
    renderChunk: (chunk) => <RtfChunk chunk={chunk} />,
  },
  {
    // .docx (Office Open XML) via mammoth, lazily loaded.
    name: "docx",
    accepts: [["binary", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
    render: (node) => lazily(<DocxView node={node} />),
    renderChunk: (chunk) => lazily(<DocxChunk chunk={chunk} />),
  },
  {
    // Excel workbooks — .xlsx and legacy .xls — via SheetJS, lazily loaded.
    name: "spreadsheet",
    accepts: [
      ["binary", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["binary", "application/vnd.ms-excel"],
    ],
    render: (node) => lazily(<SpreadsheetView node={node} />),
    renderChunk: (chunk) => lazily(<SpreadsheetChunk chunk={chunk} />),
  },
  {
    // Legacy .doc (Word 97–2003 binary) — no in-browser parser; download fallback.
    name: "doc",
    accepts: [["binary", "application/msword"]],
    render: (node) => <DocView node={node} />,
    renderChunk: (chunk) => <DocChunk chunk={chunk} />,
  },
  {
    // KML / KMZ geographic overlays drawn on a Leaflet map (lazily loaded).
    name: "map",
    accepts: [
      ["binary", "application/vnd.google-earth.kml+xml"],
      ["binary", "application/vnd.google-earth.kmz"],
    ],
    render: (node) => lazily(<MapView node={node} />),
    renderChunk: (chunk) => lazily(<MapChunk chunk={chunk} />),
  },
  {
    // LaTeX math (a string) typeset with KaTeX, both whole and inline. marklower
    // reuses the same engine for its `$$…$$` spans.
    name: "latex",
    accepts: [["string", "text/x-latex"]],
    render: (node) => <LatexView node={node} />,
    renderChunk: (chunk) => <LatexChunk chunk={chunk} />,
  },
  {
    // PlantUML source (a string) shown as the diagram it compiles to, both as a
    // whole node and inline as a chapter chunk.
    name: "plantuml",
    accepts: [["string", "text/x-plantuml"]],
    render: (node) => <PlantumlView node={node} />,
    renderChunk: (chunk) => <PlantumlChunk chunk={chunk} />,
  },
  EXPLORER,
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
    render: (node) => lazily(<ImageView node={node} />),
    renderChunk: (chunk) => lazily(<ImageChunk chunk={chunk} />),
  },
  {
    name: "html",
    accepts: [["binary", "text/html"]],
    render: (node) => <HtmlView node={node} />,
    renderChunk: (chunk) => <HtmlView node={chunkNode(chunk)} />,
  },
  {
    name: "fb2",
    accepts: [["binary", "application/x-fictionbook+xml"]],
    render: (node) => <Fb2View node={node} />,
    renderChunk: (chunk) => <Fb2View node={chunkNode(chunk)} />,
  },
  {
    name: "epub",
    accepts: [["binary", "application/epub+zip"]],
    render: (node) => <EpubView node={node} />,
    renderChunk: (chunk) => <EpubView node={chunkNode(chunk)} />,
  },
  {
    name: "pdf",
    accepts: [["binary", "application/pdf"]],
    render: (node) => lazily(<PdfView node={node} />),
    renderChunk: (chunk) => lazily(<PdfView node={chunkNode(chunk)} />),
  },
  {
    name: "djvu",
    accepts: [["binary", "image/vnd.djvu"]],
    render: (node) => lazily(<DjvuView node={node} />),
    renderChunk: (chunk) => lazily(<DjvuView node={chunkNode(chunk)} />),
  },
  {
    name: "psd",
    accepts: [["binary", "image/vnd.adobe.photoshop"]],
    render: (node) => lazily(<PsdView node={node} />),
    renderChunk: (chunk) => lazily(<PsdView node={chunkNode(chunk)} />),
  },
  {
    name: "tiff",
    accepts: [["binary", "image/tiff"]],
    render: (node) => lazily(<TiffView node={node} />),
    renderChunk: (chunk) => lazily(<TiffView node={chunkNode(chunk)} />),
  },
  {
    name: "heic",
    accepts: [["binary", "image/heic"]],
    render: (node) => lazily(<HeicView node={node} />),
    renderChunk: (chunk) => lazily(<HeicView node={chunkNode(chunk)} />),
  },
];

/** The last path segment (a property key or `[index]`) of a colon-form client path. */
function basename(path: string): string {
  const i = path.lastIndexOf(":");
  return i < 0 ? path : path.slice(i + 1);
}

/** A chapter's TOC view: its subchapters (the items of its `children` array)
 *  surfaced directly, with its `chunks` kept off the tree. The `children` wrapper
 *  sits one level below the chapter, so its items are loaded one level deeper —
 *  expandability follows the wrapper's own `hasChildren`. */
function chapterTocView(node: TreeNode): TocView {
  // Subchapters live under the `children` wrapper, one level below the chapter, so
  // revealing them costs a level (chapter → children → subchapters). We fetch one
  // more (→ each subchapter's own `children` wrapper) so a revealed subchapter's
  // chevron is decided from its real subchapter list, not the generic `hasChildren`
  // hint (which is always true for a chapter — it has `chunks`/`children` arrays).
  // Hence 3, so a childless chapter (only chunks) shows no chevron from the start.
  const wrap = node.children.find((c) => basename(c.path) === "children");
  if (!wrap) {
    // the chapter itself is not loaded yet — defer to the server's hint
    return { children: [], expandable: node.hasChildren, loaded: node.children.length > 0, loadDepth: 3 };
  }
  // expandable iff the `children` wrapper actually holds subchapters (chunks-only
  // chapters have an empty wrapper → no chevron)
  return {
    children: wrap.children,
    expandable: wrap.hasChildren,
    loaded: wrap.children.length > 0 || !wrap.hasChildren,
    loadDepth: 3,
  };
}

/** The renderer whose `accepts` covers `(type, format)`, or null when none does. */
export function rendererFor(type: string, format: string | null): Renderer | null {
  return REGISTRY.find((r) => r.accepts.some(([t, f]) => t === type && f === format)) ?? null;
}

/** The renderer for a node: its (type, format) claim, else — for a node stored as a
 *  filesystem directory that no format renderer claims (a dir-backed chapter stays a
 *  chapter) — the explorer, else null → the default tabbed view. */
export function getRenderer(node: NodeJson): Renderer | null {
  const r = rendererFor(node.type, node.format ?? null);
  if (r) return r;
  return isDirConcrete(node.concrete) ? EXPLORER : null;
}

/** The name (= representation key / `?format=` value) of the renderer for
 *  `(type, format)` — with the same directory-concrete explorer fallback as
 *  {@link getRenderer} — or null when none claims it. */
export function rendererName(type: string, format: string | null, concrete?: string | null): string | null {
  const r = rendererFor(type, format);
  if (r) return r.name;
  return isDirConcrete(concrete) ? EXPLORER.name : null;
}

/** How `node` appears in the TOC: its renderer's `tocView`, or — when no renderer
 *  claims it — its own children, lazily loaded (the passive default). */
export function tocView(node: TreeNode): TocView {
  const r = rendererFor(node.type, node.format);
  if (r?.tocView) return r.tocView(node);
  const loaded = node.children.length > 0;
  return { children: node.children, expandable: loaded ? node.children.length > 0 : node.hasChildren, loaded };
}
