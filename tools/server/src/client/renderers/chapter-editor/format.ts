// What a block IS, in the chapter projection — and therefore how it draws and what TAB does in it.
//
// A block's format is DERIVED, never stored: it is read off the model spine every time it is
// needed. There is no "current format" state to keep in sync with the caret, and no way for the
// two to disagree.
//
// The rule (MARKLOWER.md "Structure", CHAPTER.md):
//   - an explicit `!!<…$defs:X>` tag wins — table / bullets / numbered;
//   - otherwise the ENCLOSING format decides, because an untagged container INHERITS:
//       inside a table  → the level below it is a ROW, and the level below that a CELL,
//                         which switches back to chapter rules (tables are exactly two deep);
//       inside a list   → a nested container is a SUBLIST of the same kind, at any depth;
//       inside a chapter→ a nested container is a SUBCHAPTER.
//   - a leaf is a chunk.
//
// "Normal chapter" is therefore the UNTAGGED case, and switching a block to it means DROPPING its
// tag rather than stamping `$defs:chapter`. That is not just economy: `$defs/task` narrows its body
// to subtasks, so stamping a chapter tag inside a task would assert something false.

import type { MNode } from "../yamlover-editor/model";
import { findEntry } from "../yamlover-editor/model";

/** What a block is. `row` and `row-cell` are positions INSIDE a table, not tags of their own. */
export type BlockFormat = "chapter" | "table" | "bullets" | "numbered" | "chunk" | "row" | "row-cell";

/** The four a user can choose between (the format bar / Ctrl+Alt+1..4). */
export type ChosenFormat = "chapter" | "table" | "bullets" | "numbered";

const TAGGED: Record<string, BlockFormat> = {
  "x-yamlover-table": "table",
  "x-yamlover-bullets": "bullets",
  "x-yamlover-numbered": "numbered",
  "x-yamlover-chapter": "chapter",
  "x-yamlover-task": "chapter", // a task hosts subtasks the same way a chapter hosts subchapters
};

/** The `$defs` name a `!!<…>` tag's CONTENT points at, or null. Accepts every spelling the corpus
 *  uses — `*yamlover: $defs: table`, `*:: yamlover: $defs: table`, `*yamlover/$defs/table`. */
export function schemaNameOfTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const m = /\$defs\s*[:/]\s*([A-Za-z0-9_-]+)\s*$/.exec(tag);
  return m ? m[1] : null;
}

/** The format a `!!<…>` tag declares (`x-yamlover-<name>`), or null when it names no `$defs`.
 *  The client twin of the server's `formatFromMeta` pointer branch — needed because a tag the USER
 *  just set has no stamped format yet (that only arrives on the next fetch). */
export function formatFromMetaTag(tag: string | null | undefined): string | null {
  const name = schemaNameOfTag(tag);
  return name ? `x-yamlover-${name}` : null;
}

/** The format a node DECLARES for itself — its tag, else its stamped format — or null when it
 *  declares none and its format is therefore its context's to decide. */
function declaredFormat(node: MNode): BlockFormat | null {
  const declared = formatFromMetaTag(node.metaTag) ?? node.format ?? null;
  return declared && TAGGED[declared] ? TAGGED[declared] : null;
}

/** What a node IS, ignoring where it sits: its own tag, else its stamped format, else its SHAPE.
 *  Context-free — an untagged container reads as a chapter here, which is right at the top level
 *  and is refined by {@link enclosingFormat} anywhere an enclosing tag applies. */
export function formatOfNode(node: MNode): BlockFormat {
  return declaredFormat(node) ?? (node.kind === "container" ? "chapter" : "chunk");
}

/** The format of the container an entry lives IN — the one that decides what TAB means there.
 *
 *  Resolved by walking the WHOLE container chain, because an untagged container inherits and the
 *  inheritance compounds: a sublist three deep is still a list, and a container below a table's two
 *  levels is a chapter again. Looking only at the immediate parent gets the first level right and
 *  every level after it wrong. */
export function enclosingFormat(root: MNode, entryId: string): BlockFormat {
  const spine = findEntry(root, entryId);
  if (!spine) return "chapter";
  const parents = spine.parents;
  // fold down the chain, outermost first: each untagged container takes what its parent implies
  let fmt: BlockFormat = declaredFormat(parents[0].container) ?? "chapter";
  for (let i = 1; i < parents.length; i++) {
    const own = declaredFormat(parents[i].container);
    if (own) { fmt = own; continue; } // an explicit tag always switches
    // untagged: under a table it is a ROW; under a row it is a CELL, which is chapter rules again
    // ($defs/table is exactly two levels); under a list it is a SUBLIST of the same kind; under a
    // chapter it is a SUBCHAPTER.
    fmt = fmt === "table" ? "row" : fmt === "row" ? "chapter" : fmt;
  }
  // …and the ENTRY's own position inside that container
  return fmt === "table" ? "row" : fmt === "row" ? "row-cell" : fmt;
}

/** The `!!<…>` CONTENT for `name`, spelled the way the edited document spells its OWN tag — the
 *  corpus writes both `*yamlover: $defs: chapter` and `*:: yamlover: $defs: chapter`, and a
 *  document should stay internally consistent. Falls back to the project-scoped ladder form. */
export function tagFor(rootTag: string | null | undefined, name: ChosenFormat): string {
  if (rootTag) {
    const swapped = rootTag.replace(/(\$defs\s*[:/]\s*)[A-Za-z0-9_-]+\s*$/, `$1${name}`);
    if (swapped !== rootTag || schemaNameOfTag(rootTag) === name) return swapped;
  }
  return `*:: yamlover: $defs: ${name}`;
}
