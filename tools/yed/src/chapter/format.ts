// What a block IS, in the CHAPTER projection over the parser IR — the port of the legacy
// chapter-editor/format.ts (same regexes, same fold; the input is `meta.schema`/`meta.derivedFormat`
// instead of the MNode sidecar).
//
// A block's format is DERIVED, never stored: it is read off the IR spine every time it is needed.
// The rule (MARKLOWER.md "Structure", CHAPTER.md):
//   - an explicit `!!<…$defs:X>` tag wins — table / bullets / numbered;
//   - otherwise the ENCLOSING format decides, because an untagged container INHERITS:
//       inside a table  → the level below is a ROW, below that a CELL (back to chapter rules);
//       inside a list   → a nested container is a SUBLIST of the same kind, at any depth;
//       inside a chapter→ a nested container is a SUBCHAPTER.
//   - a leaf is a chunk.
// "Normal chapter" is the UNTAGGED case: switching a block to it DROPS its tag.

import { isPointer } from "../../../parser/ts/src/ir.ts";
import { schemaText } from "../../../parser/ts/src/serialize-yamlover.ts";
import type { Node, Path, Value } from "../state";
import { nodeAt } from "../state";
import type { Document } from "../state";
import { isOverlayKey } from "./roles";

/** What a block is. `row` and `row-cell` are positions INSIDE a table, not tags of their own. */
export type BlockFormat = "chapter" | "table" | "bullets" | "numbered" | "chunk" | "row" | "row-cell";

/** The four a user can choose between (the format bar / Ctrl+Alt+1..4). */
export type ChosenFormat = "chapter" | "table" | "bullets" | "numbered";

const TAGGED: Record<string, BlockFormat> = {
  "x-yamlover-table": "table",
  "x-yamlover-bullets": "bullets",
  "x-yamlover-numbered": "numbered",
  "x-yamlover-chapter": "chapter",
  "x-yamlover-task": "chapter", // a task hosts subtasks the way a chapter hosts subchapters
};

/** The `$defs` name a tag's CONTENT points at, or null (colon spellings; slash is dead). */
export function schemaNameOfTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const m = /\$defs\s*:\s*([A-Za-z0-9_-]+)\s*$/.exec(tag);
  return m ? m[1] : null;
}

/** The format a tag declares (`x-yamlover-<name>`), or null when it names no `$defs`. */
export function formatFromMetaTag(tag: string | null | undefined): string | null {
  const name = schemaNameOfTag(tag);
  return name ? `x-yamlover-${name}` : null;
}

/** The PROSE format an inline-schema tag stamps on a chunk — `!!<format: text/x-latex>`. */
export function proseFormatOfTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const m = /(?:^|[,{\s])format\s*:\s*["']?([\w/+.-]+)/.exec(tag);
  return m ? m[1] : null;
}

type ChapterMeta = {
  schema?: Value;
  derivedFormat?: string;
  chapterWrapped?: boolean;
  link?: { path: string; title?: string; format?: string };
  selfAt?: number;
  style?: string;
  concrete?: string;
};
export const metaOf = (v: Value): ChapterMeta => (isPointer(v) ? {} : (((v as Node).meta ?? {}) as ChapterMeta));

/** The node's authored `!!<…>` CONTENT (from the parsed `meta.schema`), or null. */
export function tagContentOf(v: Value): string | null {
  const sch = metaOf(v).schema;
  if (sch === undefined) return null;
  try { return schemaText(sch); } catch { return null; }
}

/** The node's EXPLICIT format declaration: its authored tag's, else the stamped derived one. */
export function explicitFormatOf(v: Value): string | null {
  return formatFromMetaTag(tagContentOf(v)) ?? proseFormatOfTag(tagContentOf(v)) ?? metaOf(v).derivedFormat ?? null;
}

/** Whether a node HAS a self value — a title, when the node is reached as a chapter. The
 *  test is VALUE-based, never kind-based: the empty document parses as a scalar with a null
 *  self (`value: null, raw: ""`), and a null self is NO title (titles have no placeholders). */
export function hasSelfValue(v: Value): boolean {
  if (isPointer(v) || (v as Node).kind !== "scalar") return false;
  const n = v as Node & { value?: unknown; raw?: string };
  return (n.value ?? null) !== null || (n.raw ?? "") !== "";
}

/** A node the chapter draws as a CONTAINER: a mapping, an omni (scalar + entries), or a freshly
 *  Tab-wrapped title (IR-invisible — the wrap lives on `meta.chapterWrapped`). */
export function isChapterContainer(v: Value): boolean {
  if (isPointer(v)) return false;
  const n = v as Node;
  if (n.kind === "mapping") return true;
  if (n.kind !== "scalar") return false;
  return (n.entries ?? []).length > 0 || metaOf(n).chapterWrapped === true;
}

/** The BlockFormat a node DECLARES, or null when its context decides. */
export function declaredFormat(v: Value): BlockFormat | null {
  const declared = explicitFormatOf(v);
  return declared && TAGGED[declared] ? TAGGED[declared] : null;
}

/** What a node IS, ignoring where it sits (an untagged container reads as a chapter). */
export function formatOfNode(v: Value): BlockFormat {
  return declaredFormat(v) ?? (isChapterContainer(v) ? "chapter" : "chunk");
}

/** The format of the container an ENTRY at `path` lives in — the fold over the whole ancestor
 *  chain, outermost first (the legacy enclosingFormat, spine → path). */
export function enclosingFormat(doc: Document, path: Path): BlockFormat {
  if (path.length === 0) return "chapter";
  let fmt: BlockFormat = declaredFormat(doc.root) ?? "chapter";
  for (let i = 1; i < path.length; i++) {
    const anc = nodeAt(doc, path.slice(0, i));
    if (!anc) return fmt;
    const own = declaredFormat(anc);
    if (own) { fmt = own; continue; }
    fmt = fmt === "table" ? "row" : fmt === "row" ? "chapter" : fmt;
  }
  return fmt === "table" ? "row" : fmt === "row" ? "row-cell" : fmt;
}

/** The block a FORMAT command targets: a list item retags the LIST (a one-item list of its own
 *  would be nobody's intent), a table cell the TABLE, a chapter paragraph itself. */
export function formatTargetPath(doc: Document, path: Path): Path {
  const where = enclosingFormat(doc, path);
  if (where === "bullets" || where === "numbered") return path.slice(0, -1);
  if (where === "row-cell") return path.slice(0, -2);
  if (where === "row") return path.slice(0, -1);
  return path;
}

/** The target's CURRENT chosen format, collapsed to "chapter" for anything unchosen —
 *  the format bar's highlight, and the "re-choosing is idle" gate. */
export function currentChosenFormat(doc: Document, path: Path): ChosenFormat {
  const target = nodeAt(doc, formatTargetPath(doc, path));
  const fmt = target ? formatOfNode(target) : "chapter";
  return fmt === "table" || fmt === "bullets" || fmt === "numbered" ? fmt : "chapter";
}

/** The `!!<…>` CONTENT for `name`, spelled the way the edited document spells its OWN tag. */
export function tagFor(rootTag: string | null | undefined, name: ChosenFormat): string {
  if (rootTag) {
    const swapped = rootTag.replace(/(\$defs\s*:\s*)[A-Za-z0-9_-]+\s*$/, `$1${name}`);
    if (swapped !== rootTag || schemaNameOfTag(rootTag) === name) return swapped;
  }
  return `*:: yamlover: $defs: ${name}`;
}

/** How a BODY chunk renders and edits — derived per render, never stored (decision G of the
 *  port plan: an explicit non-chapter type makes a structured chunk a SOURCE chunk, edited as
 *  yamlover through the standard yed cells + grammar). */
export type ChunkMode =
  | "prose"      // marklower/markdown/untyped scalar — the WYSIWYG chunk editor
  | "latex"      // text/x-latex — the raw-source textarea
  | "chapter"    // subchapter — the recursive chapter cell
  | "bullets" | "numbered" // typographical lists
  | "table"      // the editable grid
  | "source"     // an explicitly non-chapter-typed structure — inline yamlover source cells
  | "readonly"   // a format with a renderer but no editor (csv, plantuml, images, …)
  | "atom";      // pointers / links / binaries — one walkable, non-editable stop

const PROSE_FORMATS = new Set([null, "text/marklower", "text/markdown"] as (string | null)[]);
const CHAPTERISH = new Set(["x-yamlover-chapter", "x-yamlover-task", "x-yamlover-bullets", "x-yamlover-numbered", "x-yamlover-table"]);

export function chunkModeOf(v: Value): ChunkMode {
  if (isPointer(v)) return "atom";
  const n = v as Node;
  if (n.kind === "blob") return "atom";
  // the `!!yo` PLAIN-YAMLOVER mark: the node opted out of the enclosing (chapter) schema —
  // never a subchapter, never prose; edited as inline yamlover source, whatever its shape
  if (n.meta?.yo === true) return "source";
  const explicit = explicitFormatOf(n);
  // an ANNOTATED scalar — a chunk whose only entries are the annotation OVERLAY keys — is
  // still the leaf it was (roles.ts row 6: the overlay is the layer's storage, never body);
  // without this it would read as an untagged container and fold into a spurious subchapter
  const overlayOnly =
    n.kind === "scalar" &&
    (n.entries ?? []).length > 0 &&
    (n.entries ?? []).every((e) => isOverlayKey(e.key)) &&
    metaOf(n).chapterWrapped !== true;
  if (isChapterContainer(n) && !overlayOnly) {
    const declared = declaredFormat(n);
    if (declared === "table") return "table";
    if (declared === "bullets") return "bullets";
    if (declared === "numbered") return "numbered";
    if (declared === "chapter") return "chapter";
    // an explicit type OUTSIDE the chapter family on a structure → the SOURCE chunk
    if (explicit !== null && !CHAPTERISH.has(explicit)) return "source";
    return "chapter"; // untagged containers keep folding as subchapters
  }
  // a leaf
  if (PROSE_FORMATS.has(explicit)) return "prose";
  if (explicit === "text/x-latex") return "latex";
  return "readonly";
}
