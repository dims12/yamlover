import { lazy, Suspense } from "react";
import { isDirConcrete, isJsonFamily, isYamlFamily, isFileConcrete } from "../../concrete";
import { scalarValue } from "../render";
import { NodeJson, TreeNode } from "../api";
import { ChapterView } from "./chapter";
import { isSubchapter } from "./chapter-model";
import { TaskView } from "./task";
import { TextView, TextChunk } from "./text";
import { MarklowerView, MarklowerChunk } from "./marklower";
import { LatexView, LatexChunk } from "./latex";
import { AsciidocView, AsciidocChunk } from "./asciidoc";
import { CsvView, CsvChunk, CsvControls } from "./csv";
import { PlaintextView, PlaintextChunk, EncodingControl } from "./plaintext";
import { RtfView, RtfChunk } from "./rtf";
import { DocView, DocChunk } from "./doc";
import { PlantumlView, PlantumlChunk } from "./plantuml";
import { ExplorerView, ViewMode } from "./explorer";
import { isBoardNode } from "./board";
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
  valueType?: string | null; // renderer dispatch facets (TYPES.md §9) — so a tagged chunk still routes
  hasKeyed?: boolean;
  hasOrdinal?: boolean;
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

/** The three TYPE FACETS a renderer dispatches on (TYPES.md §9): the scalar self-VALUE's type,
 *  the node's `format`, and whether it owns keyed/ordinal elements. */
export interface TypeFacets {
  valueType: string | null;
  format: string | null;
  hasKeyed: boolean;
  hasOrdinal: boolean;
}
/** A renderer's acceptance predicate — a hand-coded type formula. What it does NOT test, it
 *  TOLERATES: a `byFormat("text/markdown")` matcher ignores the keyed/ordinal facets, so a
 *  markdown chunk that gained `yamlover-annotations` keys (an omni node) still matches. */
export type Accepts = (f: TypeFacets) => boolean;

/** Any projected node/chunk/link shape carrying the facet fields. */
type FacetSource = { type?: string; format?: string | null; valueType?: string | null; hasKeyed?: boolean; hasOrdinal?: boolean };
const facetsFrom = (n: FacetSource): TypeFacets => ({ valueType: n.valueType ?? null, format: n.format ?? null, hasKeyed: !!n.hasKeyed, hasOrdinal: !!n.hasOrdinal });
/** The common matcher: claims a node whose `format` is one of `fmts` — tolerant of all structure. */
const byFormat = (...fmts: string[]): Accepts => (f) => f.format !== null && fmts.includes(f.format);

export interface Renderer {
  name: string;
  /** The human name — the tab button's hover tooltip. Defaults to {@link name}; lets a
   *  renderer whose `name` (= `?format=` slug) is hyphenated (e.g. `large-icons`) read spaced. */
  label?: string;
  /** The tab button's icon glyph. Matches the TOC icon for the format where one exists
   *  (icons.ts), so the tab reads as the same thing the tree shows. */
  icon?: string;
  /** Whether this renderer claims a node, from its {@link TypeFacets}. */
  accepts: Accepts;
  /** Tie-break among matches — the highest wins. Format matchers are 2; the bare-string
   *  default (marklower) is 1. */
  specificity: number;
  /** Value depth `NodeView` must fetch for this renderer (default 1). A chapter
   *  needs 2: its `chunks`/`children` arrays one level, their elements the next. */
  depth?: number;
  /** This node's TOC presentation (default: its own children, lazily loaded). */
  tocView?: (node: TreeNode) => TocView;
  render: (node: NodeJson, onNavigate: (path: string) => void) => JSX.Element;
  /** This renderer's inline form, for embedding a single value in another page. */
  renderChunk?: (chunk: Chunk, onNavigate: (path: string) => void) => JSX.Element;
  /** An optional control shown in the tab bar beside this renderer's button (only while its
   *  view is active) — e.g. the markdown/asciidoc reading-width input, or the CSV options.
   *  `rerender` refreshes the node view after the control changes a URL parameter; `node` is
   *  the node being shown. */
  config?: (rerender: () => void, node: NodeJson) => JSX.Element;
}

/**
 * The EXPLORER VIEW FAMILY — a file-manager over a node's members (uplinks first), in one of
 * several layouts, each its OWN renderer tab: `large-icons`, `thumbnails`, `small-icons`,
 * `details`, and `tag-board`. They are claimed two ways: by (type, format) for tags (a tag
 * projects as `object` — fields only, `variant` — description BODY + fields, `string` — a leaf
 * tag, or `null` — a bare tag; the grid shows the tagged MATERIALS) and a BOARD directory
 * (x-yamlover-board), and as the CONCRETE fallback for any node stored as a filesystem
 * directory (`dir`/`yamlover`) that no (type, format) renderer claims — see {@link getRenderer}.
 *
 * They are NOT registered in the specificity loop (so `rendererFor` stays single-valued for the
 * TOC / chunks / `depth`); {@link renderersFor} expands them into the tab list, and {@link EXPLORER}
 * (the `large-icons` view) is the single REPRESENTATIVE the loop and the dir-concrete fallback use.
 */
const explorerView = (name: string, label: string, icon: string, view: ViewMode): Renderer => ({
  name,
  label,
  icon,
  accepts: byFormat("x-yamlover-tag", "x-yamlover-board"),
  specificity: 2,
  render: (node, onNavigate) => <ExplorerView node={node} view={view} onNavigate={onNavigate} />,
});

// Order = tab order. `tag-board` leads, but only for board nodes (renderersFor filters it).
const TAG_BOARD = explorerView("tag-board", "tag board", "▥", "board");
const ICON_VIEWS: Renderer[] = [
  explorerView("thumbnails", "thumbnails", "🖼️", "thumbnails"),
  explorerView("large-icons", "large icons", "⊞", "large"),
  explorerView("small-icons", "small icons", "∷", "small"),
  explorerView("details", "details", "☰", "details"),
];
// The representative for the single-valued paths (rendererFor / getRenderer / rendererName / depth):
// the DEFAULT view, large icons — independent of the tab order above (thumbnails leads the bar, but a
// directory still OPENS on large icons). Exactly this one entry sits in REGISTRY.
const EXPLORER = ICON_VIEWS.find((v) => v.name === "large-icons")!;

const REGISTRY: Renderer[] = [
  {
    name: "chapter",
    icon: "§",
    accepts: byFormat("x-yamlover-chapter"),
    specificity: 2,
    depth: 1, // the body elements are the chapter's own children now → one level reaches them as link markers
    tocView: chapterTocView,
    render: (node, onNavigate) => <ChapterView node={node} onNavigate={onNavigate} />,
    config: (rerender) => <MarkupWidthControl rerender={rerender} />, // reading width, shared with markdown/asciidoc
  },
  {
    // A task / ticket (TICKETS.md): a chapter body (title + interleaved chunks/subtasks) plus a
    // planning strip; its lifecycle state is a tag application. Same TOC shape as a chapter (subtasks
    // are the subchapter-format body elements); depth 1 reaches the body elements as link markers.
    name: "task",
    icon: "☑",
    accepts: byFormat("x-yamlover-task"),
    specificity: 2,
    depth: 1,
    tocView: chapterTocView,
    render: (node, onNavigate) => <TaskView node={node} onNavigate={onNavigate} />,
    config: (rerender) => <MarkupWidthControl rerender={rerender} />, // reading width, shared with markdown/asciidoc
  },
  {
    // Prose: marklower, a markup language a notch below Markdown (MARKLOWER.md). It is the format a
    // chapter's chunks carry — `$defs/chunk` says `format: text/marklower`, and `chunkOf` stamps an
    // inline one that reached the client unstamped. It is asked for BY NAME: a format-less string is
    // data, not prose, and a plain `name: Alice` must not open in a prose renderer.
    name: "marklower",
    icon: "✍",
    accepts: byFormat("text/marklower"),
    specificity: 2,
    render: (node, onNavigate) => <MarklowerView node={node} onNavigate={onNavigate} />,
    renderChunk: (chunk, onNavigate) => <MarklowerChunk chunk={chunk} onNavigate={onNavigate} />,
  },
  {
    // Markdown (the component file is text.tsx for historical reasons; the renderer —
    // its tab label and `?format=` key — is named for what it renders).
    name: "markdown",
    icon: "📝",
    accepts: byFormat("text/markdown"),
    specificity: 2,
    render: (node, onNavigate) => <TextView node={node} onNavigate={onNavigate} />,
    renderChunk: (chunk, onNavigate) => <TextChunk chunk={chunk} onNavigate={onNavigate} />,
    config: (rerender) => <MarkupWidthControl rerender={rerender} />,
  },
  {
    name: "asciidoc",
    icon: "📃",
    accepts: byFormat("text/asciidoc"),
    specificity: 2,
    render: (node, onNavigate) => <AsciidocView node={node} onNavigate={onNavigate} />,
    renderChunk: (chunk, onNavigate) => <AsciidocChunk chunk={chunk} onNavigate={onNavigate} />,
    config: (rerender) => <MarkupWidthControl rerender={rerender} />,
  },
  {
    // Delimited text (CSV/TSV, a string) shown as a table; its parsing options
    // (separator, header) ride in the URL query — see csv.tsx.
    name: "csv",
    icon: "▦",
    accepts: byFormat("text/csv", "text/tab-separated-values"),
    specificity: 2,
    render: (node) => <CsvView node={node} />,
    renderChunk: (chunk) => <CsvChunk chunk={chunk} />,
    config: (rerender) => <CsvControls rerender={rerender} />,
  },
  {
    // Plain text shown verbatim (no markup), with a node-bar encoding selector —
    // CP866 / Windows-1251 / KOI8-R / UTF-8 (see plaintext.tsx). Served as raw
    // bytes so the encoding is the client's to choose.
    name: "plaintext",
    icon: "🗒️",
    accepts: byFormat("text/plain"),
    specificity: 2,
    render: (node) => <PlaintextView node={node} />,
    renderChunk: (chunk) => <PlaintextChunk chunk={chunk} />,
    config: (rerender) => <EncodingControl rerender={rerender} />,
  },
  {
    // RTF — a dependency-free converter to HTML (see rtf.tsx).
    name: "rtf",
    icon: "📄",
    accepts: byFormat("application/rtf"),
    specificity: 2,
    render: (node) => <RtfView node={node} />,
    renderChunk: (chunk) => <RtfChunk chunk={chunk} />,
  },
  {
    // .docx (Office Open XML) via mammoth, lazily loaded.
    name: "docx",
    icon: "📄",
    accepts: byFormat("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    specificity: 2,
    render: (node) => lazily(<DocxView node={node} />),
    renderChunk: (chunk) => lazily(<DocxChunk chunk={chunk} />),
  },
  {
    // Excel workbooks — .xlsx and legacy .xls — via SheetJS, lazily loaded.
    name: "spreadsheet",
    icon: "▦",
    accepts: byFormat("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"),
    specificity: 2,
    render: (node) => lazily(<SpreadsheetView node={node} />),
    renderChunk: (chunk) => lazily(<SpreadsheetChunk chunk={chunk} />),
  },
  {
    // Legacy .doc (Word 97–2003 binary) — no in-browser parser; download fallback.
    name: "doc",
    icon: "📄",
    accepts: byFormat("application/msword"),
    specificity: 2,
    render: (node) => <DocView node={node} />,
    renderChunk: (chunk) => <DocChunk chunk={chunk} />,
  },
  {
    // KML / KMZ geographic overlays drawn on a Leaflet map (lazily loaded).
    name: "map",
    icon: "🗺️",
    accepts: byFormat("application/vnd.google-earth.kml+xml", "application/vnd.google-earth.kmz"),
    specificity: 2,
    render: (node) => lazily(<MapView node={node} />),
    renderChunk: (chunk, onNavigate) => lazily(<MapChunk chunk={chunk} onNavigate={onNavigate} />),
  },
  {
    // LaTeX math (a string) typeset with KaTeX, both whole and inline. marklower
    // reuses the same engine for its `$$…$$` spans.
    name: "latex",
    icon: "∑",
    accepts: byFormat("text/x-latex"),
    specificity: 2,
    render: (node) => <LatexView node={node} />,
    renderChunk: (chunk) => <LatexChunk chunk={chunk} />,
  },
  {
    // PlantUML source (a string) shown as the diagram it compiles to, both as a
    // whole node and inline as a chapter chunk.
    name: "plantuml",
    icon: "📊",
    accepts: byFormat("text/x-plantuml"),
    specificity: 2,
    render: (node) => <PlantumlView node={node} />,
    renderChunk: (chunk) => <PlantumlChunk chunk={chunk} />,
  },
  EXPLORER,
  {
    // File-backed binaries the server tags with an inferred image format.
    name: "image",
    icon: "🖼️",
    accepts: byFormat("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/svg+xml"),
    specificity: 2,
    render: (node) => lazily(<ImageView node={node} />),
    renderChunk: (chunk, onNavigate) => lazily(<ImageChunk chunk={chunk} onNavigate={onNavigate} />),
  },
  {
    name: "html",
    icon: "🌐",
    accepts: byFormat("text/html"),
    specificity: 2,
    render: (node) => <HtmlView node={node} />,
    renderChunk: (chunk) => <HtmlView node={chunkNode(chunk)} />,
  },
  {
    name: "fb2",
    icon: "📘",
    accepts: byFormat("application/x-fictionbook+xml"),
    specificity: 2,
    render: (node) => <Fb2View node={node} />,
    renderChunk: (chunk) => <Fb2View node={chunkNode(chunk)} />,
  },
  {
    name: "epub",
    icon: "📗",
    accepts: byFormat("application/epub+zip"),
    specificity: 2,
    render: (node) => <EpubView node={node} />,
    renderChunk: (chunk) => <EpubView node={chunkNode(chunk)} />,
  },
  {
    name: "pdf",
    icon: "📕",
    accepts: byFormat("application/pdf"),
    specificity: 2,
    render: (node) => lazily(<PdfView node={node} />),
    renderChunk: (chunk) => lazily(<PdfView node={chunkNode(chunk)} />),
  },
  {
    name: "djvu",
    icon: "📓",
    accepts: byFormat("image/vnd.djvu"),
    specificity: 2,
    render: (node) => lazily(<DjvuView node={node} />),
    renderChunk: (chunk) => lazily(<DjvuView node={chunkNode(chunk)} />),
  },
  {
    name: "psd",
    icon: "🎨",
    accepts: byFormat("image/vnd.adobe.photoshop"),
    specificity: 2,
    render: (node) => lazily(<PsdView node={node} />),
    renderChunk: (chunk, onNavigate) => lazily(<PsdView node={chunkNode(chunk)} chunk={{ onNavigate }} />),
  },
  {
    name: "tiff",
    icon: "🖼️",
    accepts: byFormat("image/tiff"),
    specificity: 2,
    render: (node) => lazily(<TiffView node={node} />),
    renderChunk: (chunk, onNavigate) => lazily(<TiffView node={chunkNode(chunk)} chunk={{ onNavigate }} />),
  },
  {
    name: "heic",
    icon: "🖼️",
    accepts: byFormat("image/heic"),
    specificity: 2,
    render: (node) => lazily(<HeicView node={node} />),
    renderChunk: (chunk, onNavigate) => lazily(<HeicView node={chunkNode(chunk)} chunk={{ onNavigate }} />),
  },
];

/** A chapter's TOC view: its subchapters — the body elements whose (type, format) is a nested
 *  chapter/subtask — surfaced directly, with prose chunks kept off the tree. Subchapters are now
 *  DIRECT children of the chapter (no `children` wrapper), so revealing them costs a single level.
 *  We fetch one more (→ each subchapter's own body) so a revealed subchapter's chevron is decided
 *  from its real subchapter list, not the generic `hasChildren` hint (always true for a chapter —
 *  it has a body). Hence loadDepth 2, so a chunks-only chapter shows no chevron once loaded. */
function chapterTocView(node: TreeNode): TocView {
  if (node.children.length === 0) {
    // the chapter itself is not loaded yet — defer to the server's hint
    return { children: [], expandable: node.hasChildren, loaded: false, loadDepth: 2 };
  }
  const subs = node.children.filter((c) => isSubchapter(c.format));
  return { children: subs, expandable: subs.length > 0, loaded: true, loadDepth: 2 };
}

/** The renderer that claims `src`'s facets, or null when none does: of the matchers that accept
 *  it, the most SPECIFIC (highest `specificity`) wins (TYPES.md §9). */
export function rendererFor(src: FacetSource): Renderer | null {
  const f = facetsFrom(src);
  let best: Renderer | null = null;
  for (const r of REGISTRY) if (r.accepts(f) && (best === null || r.specificity > best.specificity)) best = r;
  return best;
}

/** The renderer for a node: its facet claim, else — for a node stored as a filesystem directory
 *  that no format renderer claims (a dir-backed chapter stays a chapter) — the explorer, else
 *  null → the default tabbed view. */
export function getRenderer(node: NodeJson): Renderer | null {
  // The explorer is the DEFAULT only for a container DIRECTORY (a data file defaults to its data
  // view; a scalar-bodied dir to its scalar). The explorer TAB is still offered more widely
  // (renderersFor) — this is only the landing/default renderer.
  return rendererFor(node) ?? (isDirConcrete(node.concrete) && isContainerNode(node) ? EXPLORER : null);
}

/** The explorer view family for a node, tab order: the four icon views, led by `tag-board`
 *  only on a board node (its overlay/format marks it — board.tsx `isBoardNode`). */
function explorerViews(node: NodeJson): Renderer[] {
  return isBoardNode(node) ? [TAG_BOARD, ...ICON_VIEWS] : ICON_VIEWS;
}

/** Every selectable rendered representation for a node, best first: its format renderer (when any),
 *  PLUS — for a tag / board / any node stored as a directory — the EXPLORER VIEW FAMILY (large
 *  icons / thumbnails / small icons / details, and tag board on a board dir), each its own tab.
 *  So a dir-backed chapter offers its chapter view then the directory views; a bare directory just
 *  the views. */
export function renderersFor(node: NodeJson): Renderer[] {
  const out: Renderer[] = [];
  const primary = rendererFor(node);
  if (primary && primary !== EXPLORER) out.push(primary); // a non-explorer primary (chapter/task) leads
  // The explorer family is offered for a CONTAINER directory AND a json/yaml CONTAINER (a data
  // document or sub-object/array) — so a json/yaml file browses its members as icons just like a
  // folder. A SCALAR (incl. a scalar-bodied directory) gets no icon tabs (they would be empty).
  if (primary === EXPLORER || explorerEligible(node)) out.push(...explorerViews(node));
  return out;
}

// A node whose members are worth browsing as icons: object / array / mixed / variant (a `variant`
// is a scalar-PLUS-fields, so it has members). A plain scalar or a binary leaf has none.
const CONTAINER_TYPES = new Set(["object", "array", "mixed", "variant"]);
const isContainerNode = (src: FacetSource): boolean => !!src.type && CONTAINER_TYPES.has(src.type);

/** Eligible for the explorer TAB family: a directory or a json/yaml-family node, AND a container. */
function explorerEligible(node: NodeJson): boolean {
  const c = node.concrete;
  return (isDirConcrete(c) || isJsonFamily(c) || isYamlFamily(c)) && isContainerNode(node);
}

/** The registry's plaintext renderer (raw-source view), reused as a TRAILING tab. */
export const PLAINTEXT = REGISTRY.find((r) => r.name === "plaintext")!;

/** The trailing `plaintext` (raw-source) tab a TEXTUAL node offers, or null. Textual = a data
 *  language (json/json5/json5p/yaml/yamlover) or markdown/asciidoc. It is renderable as text when
 *  the node is file-backed (raw bytes via /api/blob) or its value is an inline string. A directory,
 *  a non-string inline container, or a node already led by plaintext (a `.txt`) gets none. */
export function plaintextTab(node: NodeJson): Renderer | null {
  if (isDirConcrete(node.concrete)) return null;
  if (rendererFor(node) === PLAINTEXT) return null; // a text/plain node already leads with it
  const textual =
    isJsonFamily(node.concrete) || isYamlFamily(node.concrete) ||
    node.format === "text/markdown" || node.format === "text/asciidoc";
  if (!textual) return null;
  const renderable = isFileConcrete(node.concrete) || typeof scalarValue(node.value) === "string";
  return renderable ? PLAINTEXT : null;
}

/** The name (= representation key / `?format=` value) of the renderer that claims `src` — with the
 *  same directory-concrete explorer fallback as {@link getRenderer} — or null when none claims it.
 *  This is the facet-only path (no `node.value`), so a board is recognized by its FORMAT alone: a
 *  board detected only via overlay value defaults to `large-icons` (its tag-board tab is present). */
export function rendererName(src: FacetSource, concrete?: string | null): string | null {
  const r = rendererFor(src);
  if (r && r !== EXPLORER) return r.name;
  // a container directory defaults to its explorer; a data file (or a scalar-bodied dir) → null →
  // the data view (yamlover). So "only the default differs": dir → large icons, data file → yamlover.
  if (r === EXPLORER || (isDirConcrete(concrete) && isContainerNode(src))) return src.format === "x-yamlover-board" ? TAG_BOARD.name : EXPLORER.name;
  return null;
}

/** How `node` appears in the TOC: its renderer's `tocView`, or — when no renderer
 *  claims it — its own children, lazily loaded (the passive default). */
export function tocView(node: TreeNode): TocView {
  const r = rendererFor(node);
  if (r?.tocView) return r.tocView(node);
  const loaded = node.children.length > 0;
  return { children: node.children, expandable: loaded ? node.children.length > 0 : node.hasChildren, loaded };
}
