// Chapter-shaped mutations over the projectional model — the same contract as model.ts: each
// MUTATES the model in place and RETURNS the surgical `/api/edit` ops that mirror it, for the host
// to enqueue. They are the chapter projection's verbs; the tree, the ops and the focus machinery
// underneath are the shared ones (model.ts, host.ts).

import * as M from "../yamlover-editor/model";
import { bareStringRoundTrips } from "../yamlover-editor/model";
import { escapeYamloverScalar } from "../chapter-model";
import type { Edit } from "../../api";
import { resolveTab, type TabIntent } from "./tab";
import { formatOfNode, tagFor, type ChosenFormat } from "./format";

/** A prose text as an MScalar that KEEPS the authored representation: a one-line text that reads
 *  back bare stays bare; a one-liner that would NOT (a trailing space, a leading sigil, a `key:`
 *  shape) is double-quoted rather than blocked — a `|-` for one line reads badly; only genuinely
 *  multi-line text becomes a block. The chapter twin of the source editor's representation rule:
 *  without it every edit would rewrite a bare chunk into a `|` block on the first keystroke. */
export function proseScalar(text: string): M.MScalar {
  if (!text.includes("\n")) {
    if (bareStringRoundTrips(text)) return { src: text, value: text };
    return { src: JSON.stringify(text), value: text }; // one line that can't go bare → quoted
  }
  return { src: escapeYamloverScalar(text), value: text, block: true };
}

/** Commit a prose paragraph's edited text (a coalescable emplace, or the subtree commit when the
 *  paragraph is not yet on the server). */
export function commitProse(rootPath: string, root: M.MNode, nodeId: string, text: string): Edit[] {
  return M.setNodeToken(rootPath, root, nodeId, proseScalar(text));
}

/** A brand-new committed prose entry — the tail of a split, or a fresh paragraph. */
function proseEntry(text: string): M.MEntry {
  const scalar = proseScalar(text);
  return {
    id: M.nid(), key: null, decided: true, committed: true,
    node: { id: M.nid(), rev: 0, kind: "scalar", scalar, entries: [], selfAt: 0, metaTag: null, setTag: false },
  };
}

/** The container + index of the entry named by `nodeId`'s owning entry, or null for the root. */
function ownerOf(root: M.MNode, entryId: string): { container: M.MNode; index: number; entry: M.MEntry } | null {
  const spine = M.findEntry(root, entryId);
  if (!spine) return null;
  const { container, index } = spine.parents[spine.parents.length - 1];
  return { container, index, entry: spine.entry };
}

/** Enter at the caret: the paragraph keeps `head`, a fresh sibling paragraph takes `tail`. Returns
 *  the ops and the new entry id (the caret follows it, at its start). */
export function splitProse(
  rootPath: string, root: M.MNode, entryId: string, head: string, tail: string,
): { edits: Edit[]; focusId: string } | null {
  const owner = ownerOf(root, entryId);
  if (!owner) return null;
  const { container, index, entry } = owner;
  const edits: Edit[] = [];
  // the head stays in place, keeping representation
  edits.push(...M.setNodeToken(rootPath, root, entry.node.id, proseScalar(head)));
  // the tail becomes a new committed sibling right after it
  const tailEntry = proseEntry(tail);
  container.entries.splice(index + 1, 0, tailEntry);
  const at = M.serverIndexOf(container, index + 1);
  const contPath = containerPath(rootPath, root, container);
  edits.push({ path: appendIndex(contPath, at), op: "insert", yamlover: M.serializeMNode(tailEntry.node) || '""' });
  return { edits, focusId: tailEntry.node.id };
}

/** Backspace at the start (`dir: "prev"`) or Delete at the end (`dir: "next"`): merge two adjacent
 *  editable prose paragraphs. The caret lands at the junction. */
export function joinProse(
  rootPath: string, root: M.MNode, entryId: string, dir: "prev" | "next",
  isEditable: (node: M.MNode) => boolean,
): { edits: Edit[]; focusId: string; caret: number } | null {
  const owner = ownerOf(root, entryId);
  if (!owner) return null;
  const { container, index } = owner;
  const keepIdx = dir === "prev" ? index - 1 : index;
  const dropIdx = dir === "prev" ? index : index + 1;
  if (keepIdx < 0 || dropIdx >= container.entries.length) return null;
  const keep = container.entries[keepIdx];
  const drop = container.entries[dropIdx];
  if (keep.key !== null || drop.key !== null) return null; // only body paragraphs merge
  if (!isEditable(keep.node) || !isEditable(drop.node)) return null;
  const keepText = String(keep.node.scalar?.value ?? "");
  const dropText = String(drop.node.scalar?.value ?? "");
  const junction = keepText.length;
  const edits: Edit[] = [];
  // remove the absorbed (later) entry FIRST, then emplace the survivor — the survivor's index is
  // unaffected by removing something after it, so both ops address correctly on the server's re-scan
  edits.push(...M.removeEntry(rootPath, root, drop.id));
  edits.push(...M.setNodeToken(rootPath, root, keep.node.id, proseScalar(keepText + dropText)));
  return { edits, focusId: keep.node.id, caret: junction };
}

/** Dispatch a Tab / Shift-Tab to its model effect (tab.ts decides which). The projection performs
 *  the caret-only cases itself; the structural cases return ops. */
export function tabEdits(
  rootPath: string, root: M.MNode, entryId: string, shift: boolean,
): { intent: TabIntent; edits: Edit[]; focusId?: string } {
  const intent = resolveTab(root, entryId, shift);
  if (intent.kind === "indent") {
    const spine = M.findEntry(root, entryId);
    const edits = M.indentEntry(rootPath, root, entryId);
    return { intent, edits, focusId: spine?.entry.node.id };
  }
  if (intent.kind === "dedent") {
    const spine = M.findEntry(root, entryId);
    const edits = M.dedentEntry(rootPath, root, entryId);
    return { intent, edits, focusId: spine?.entry.node.id };
  }
  if (intent.kind === "appendRow") {
    const { edits, focusId } = appendRow(rootPath, root, intent.tableId, intent.columns);
    return { intent, edits, focusId };
  }
  // "cell" / "nop": no ops; the projection moves the caret (cell) or swallows the key (nop)
  return { intent, edits: [] };
}

/** Append an empty row of `columns` cells to a table, returning the ops and the first cell's id. */
export function appendRow(rootPath: string, root: M.MNode, tableId: string, columns: number): { edits: Edit[]; focusId?: string } {
  const found = M.findNode(root, tableId);
  if (!found || found.node.kind !== "container") return { edits: [] };
  const table = found.node;
  const cells: M.MEntry[] = Array.from({ length: Math.max(columns, 1) }, () => proseEntry(""));
  const rowEntry: M.MEntry = {
    id: M.nid(), key: null, decided: true, committed: true,
    node: { id: M.nid(), rev: 0, kind: "container", entries: cells, selfAt: 0, metaTag: null, setTag: false },
  };
  table.entries.push(rowEntry);
  const at = M.serverIndexOf(table, table.entries.length - 1);
  const tablePath = containerPath(rootPath, root, table);
  const edits: Edit[] = [{ path: appendIndex(tablePath, at), op: "insert", yamlover: M.serializeMNode(rowEntry.node) || '- ""' }];
  return { edits, focusId: cells[0].node.id };
}

/** Set a block's format (format.ts / tab.ts decide the target). "chapter" DROPS the tag; a
 *  container gains a tag; a LEAF paragraph is wrapped into a one-item container of that kind. */
export function promoteFormat(rootPath: string, root: M.MNode, nodeId: string, chosen: ChosenFormat, rootTag: string | null): Edit[] {
  const found = M.findNode(root, nodeId);
  if (!found) return [];
  const { node, spine } = found;
  if (chosen === "chapter") {
    // untagged ≡ a subchapter. Drop the tag — but the node may carry a STAMPED tagged format with
    // no `!!<…>` in the model's sidecar, so `setMetaTag`'s "never-persisted" shortcut would emit
    // nothing while the file still has the tag. Force the drop when it currently reads as tagged.
    const wasTagged = node.metaTag !== null || formatOfNode(node) !== "chapter";
    node.metaTag = null;
    node.metaOnServer = false;
    node.format = null;
    node.rev++;
    if (!wasTagged) return [];
    const path = spine ? M.pathOfSpine(rootPath, spine) : rootPath;
    return [{ path, op: "emplace", meta: null }];
  }
  const tag = tagFor(rootTag, chosen);
  if (node.kind === "container") return M.setMetaTag(rootPath, root, nodeId, tag);
  // a leaf: wrap the prose as the sole item of a new tagged container. `replace` (not emplace)
  // drops the scalar facet the emplace would leave standing beside the new entries.
  const text = String(node.scalar?.value ?? "");
  const item = proseEntry(text);
  node.kind = "container";
  node.scalar = undefined;
  node.entries = [item];
  node.metaTag = tag;
  node.metaOnServer = true;
  node.rev++;
  const path = spine ? M.pathOfSpine(rootPath, spine) : rootPath;
  return [{ path, op: "replace", yamlover: M.serializeMNode(node), meta: tag }];
}

// --- path helpers ------------------------------------------------------------------------------ //

/** The node path of a container in the model (root, or its spine). */
function containerPath(rootPath: string, root: M.MNode, container: M.MNode): string {
  if (container.id === root.id) return rootPath;
  const found = M.findNode(root, container.id);
  return found?.spine ? M.pathOfSpine(rootPath, found.spine) : rootPath;
}

/** Append a positional `[i]` segment to a node path (root-safe). */
function appendIndex(path: string, index: number): string {
  return `${path === ":" ? "" : path}[${index}]`;
}
