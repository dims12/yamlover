// Chapter-shaped mutations over the projectional model — the same contract as model.ts: each
// MUTATES the model in place and RETURNS the surgical `/api/edit` ops that mirror it, for the host
// to enqueue. They are the chapter projection's verbs; the tree, the ops and the focus machinery
// underneath are the shared ones (model.ts, host.ts).

import * as M from "../yamlover-editor/model";
import { bareStringRoundTrips } from "../yamlover-editor/model";
import { parsePointer } from "../../../../../parser/ts/src/pointer.ts";
import { pointerSafeName } from "../../../concrete";
import { defaultChildConcrete, subchapterMaterializes, nextMemberName } from "../../../concrete-rules";
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

/** The member name a sibling entry references, for birth-name prediction: a session-born
 *  member's wireKey, or the single-key document-scope name a loaded `- *: name` entry points
 *  at. Null for anything else (inline content, cross-document pointers). */
function memberNameOfSibling(e: M.MEntry): string | null {
  if (e.wireKey !== undefined) return e.wireKey;
  if (e.node.kind === "pointer" && e.node.pointer) {
    try {
      const p = parsePointer(e.node.pointer.raw);
      if (p.base.scope === "document" && p.steps.length === 1 && p.steps[0].sel === "key") return p.steps[0].name;
    } catch {
      /* not a pointer token */
    }
  }
  return null;
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
  // the head stays in place, keeping representation. WE change its text (the cell's DOM still
  // shows the whole paragraph), so its rev must bump — that is the cell's reset gate; without it
  // the head keeps showing the un-truncated text (setNodeToken never bumps: in the source view
  // the cell itself typed the token, so its DOM already matches).
  edits.push(...M.setNodeToken(rootPath, root, entry.node.id, proseScalar(head)));
  entry.node.rev++;
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
  keep.node.rev++; // programmatic text change — the survivor's cell must reset to the merged text
  return { edits, focusId: keep.node.id, caret: junction };
}

/** Tab on a chunk: the CURRENT chunk becomes a subchapter title — a container whose self line is
 *  the text. On disk this is STILL the same one line (`- A` is both a scalar and a title-only
 *  chapter), so there are no ops — but the server holds a scalar entry, which cannot be descended
 *  into, so the first body commit must re-emplace the whole omni (commitSpine's omniPending path). */
export function wrapAsChapter(rootPath: string, root: M.MNode, entryId: string): { edits: Edit[]; focusId: string } | null {
  const spine = M.findEntry(root, entryId);
  if (!spine) return null;
  const node = spine.entry.node;
  if (node.kind !== "scalar" || node.scalar?.block || String(node.scalar?.value ?? "").includes("\n")) return null;
  node.selfValue = node.scalar!;
  node.selfAt = 0;
  node.scalar = undefined;
  node.kind = "container";
  if (spine.entry.committed) node.omniPending = true;
  node.rev++;
  return { edits: [], focusId: node.id };
}

/** Shift-Tab on a title — the wrap's inverse: the title becomes a plain chunk and its body splices
 *  out after it, in order. Children leave LAST-FIRST (each dedent lands right after this entry, so
 *  the order holds), a keyed description dissolves into an ordinal chunk first so it can move, and
 *  emptying the container demotes it back to the scalar it serializes as. */
export function unwrapChapter(rootPath: string, root: M.MNode, entryId: string): { edits: Edit[]; focusId: string } | null {
  const spine = M.findEntry(root, entryId);
  if (!spine) return null;
  // a MATERIALIZED (linked) subchapter does not unwrap — v1 has no verb for inlining a linked
  // document back into the parent body (a cross-file destructive move); Shift-Tab nops
  if (spine.entry.derivedKey) return null;
  const node = spine.entry.node;
  if (node.kind !== "container" || !node.selfValue || node.flow) return null;
  const edits: Edit[] = [];
  const desc = node.entries.find((e) => e.key === "description");
  if (desc) {
    const out = demoteDescription(rootPath, root, desc.id);
    if (out) edits.push(...out.edits);
  }
  for (let guard = node.entries.length; guard > 0 && node.entries.length > 0; guard--) {
    const last = node.entries[node.entries.length - 1];
    const before = node.entries.length;
    edits.push(...M.dedentEntry(rootPath, root, last.id));
    if (node.entries.length === before) break; // an immovable entry (an unknown key) — stop
  }
  // childless from the start (a freshly wrapped title): nothing moved, demote directly
  M.demoteIfEmptied(node, root);
  return { edits, focusId: node.id };
}

/** Dispatch a Tab / Shift-Tab to its model effect (tab.ts decides which). The projection performs
 *  the caret-only cases itself; the structural cases return ops. */
export function tabEdits(
  rootPath: string, root: M.MNode, entryId: string, shift: boolean,
): { intent: TabIntent; edits: Edit[]; focusId?: string } {
  const intent = resolveTab(root, entryId, shift);
  if (intent.kind === "wrap") {
    const out = wrapAsChapter(rootPath, root, entryId);
    return out ? { intent, edits: out.edits, focusId: out.focusId } : { intent: { kind: "nop" }, edits: [] };
  }
  if (intent.kind === "unwrap") {
    const out = unwrapChapter(rootPath, root, entryId);
    return out ? { intent, edits: out.edits, focusId: out.focusId } : { intent: { kind: "nop" }, edits: [] };
  }
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

/** Create the chapter's keyed `description` as its FIRST entry (the conventional position, right
 *  under the title line). Already present (a race) → a plain emplace. */
export function createDescription(rootPath: string, root: M.MNode, nodeId: string, text: string): { edits: Edit[]; focusId: string } {
  const found = M.findNode(root, nodeId);
  const node = found?.node ?? root;
  const existing = node.entries.find((e) => e.key === "description");
  if (existing) return { edits: commitProse(rootPath, root, existing.node.id, text), focusId: existing.node.id };
  const entry: M.MEntry = {
    id: M.nid(), key: "description", decided: true, committed: true,
    node: { id: M.nid(), rev: 0, kind: "scalar", scalar: { src: JSON.stringify(text), value: text }, entries: [], selfAt: 0, metaTag: null, setTag: false },
  };
  node.entries.splice(0, 0, entry);
  const contPath = found?.spine ? M.pathOfSpine(rootPath, found.spine) : rootPath;
  return { edits: [{ path: appendIndex(contPath, 0), op: "insert", key: "description", yamlover: JSON.stringify(text) }], focusId: entry.node.id };
}

// --- roles: any chunk can BECOME the title or the description, and back --------------------- //
// A chapter's title and description are OPTIONAL — there are no placeholder cells for them. The
// format bar's T / D buttons apply the role to the focused chunk, and applied to a cell that
// already HOLDS the role, take it away (the text survives as a plain chunk).

/** The focused chunk's text becomes the enclosing chapter's TITLE (its self line); the chunk
 *  entry is removed. Refused when a title already exists — edit that one instead. */
export function makeTitle(rootPath: string, root: M.MNode, entryId: string): { edits: Edit[]; focusId: string } | null {
  const spine = M.findEntry(root, entryId);
  if (!spine || spine.entry.key !== null) return null;
  const { container } = spine.parents[spine.parents.length - 1];
  if (container.selfValue || container.flow) return null;
  const node = spine.entry.node;
  if (node.kind !== "scalar" || node.scalar?.block || String(node.scalar?.value ?? "").includes("\n")) return null;
  const text = String(node.scalar?.value ?? "");
  const edits = [...M.removeEntry(rootPath, root, entryId)];
  edits.push(...M.setSelfValue(rootPath, root, container.id, proseScalar(text)));
  return { edits, focusId: container.id };
}

/** The title steps down: its text becomes the first body chunk (after a description when there is
 *  one) and the self line is dropped. A title-only subchapter IS one line on disk, so dissolving
 *  it is the wrap's model-only inverse — no ops. */
export function demoteTitle(rootPath: string, root: M.MNode, nodeId: string): { edits: Edit[]; focusId: string } | null {
  const found = M.findNode(root, nodeId);
  const self = found?.node.selfValue;
  if (!found || found.node.kind !== "container" || !self) return null;
  const node = found.node;
  const text = String(self.value ?? "");
  if (node !== root && node.entries.length === 0) {
    M.demoteIfEmptied(node, root);
    return { edits: [], focusId: node.id };
  }
  const edits = [...M.setSelfValue(rootPath, root, nodeId, null)];
  const descIdx = node.entries.findIndex((e) => e.key === "description");
  const pos = descIdx >= 0 ? descIdx + 1 : 0;
  const chunk = proseEntry(text);
  node.entries.splice(pos, 0, chunk);
  const at = M.serverIndexOf(node, pos);
  edits.push({ path: appendIndex(containerPath(rootPath, root, node), at), op: "insert", yamlover: M.serializeMNode(chunk.node) || '""' });
  node.rev++;
  return { edits, focusId: chunk.node.id };
}

/** The focused chunk's text becomes the enclosing chapter's DESCRIPTION. Created FIRST, chunk
 *  removed second — the other order could empty the container and demote it out from under us. */
export function makeDescription(rootPath: string, root: M.MNode, entryId: string): { edits: Edit[]; focusId: string } | null {
  const spine = M.findEntry(root, entryId);
  if (!spine || spine.entry.key !== null) return null;
  const { container } = spine.parents[spine.parents.length - 1];
  if (container.entries.some((e) => e.key === "description")) return null;
  const text = String(spine.entry.node.scalar?.value ?? "");
  const created = createDescription(rootPath, root, container.id, text);
  const edits = [...created.edits, ...M.removeEntry(rootPath, root, entryId)];
  return { edits, focusId: created.focusId };
}

/** The description steps down into a plain chunk in its place. */
export function demoteDescription(rootPath: string, root: M.MNode, entryId: string): { edits: Edit[]; focusId: string } | null {
  const spine = M.findEntry(root, entryId);
  if (!spine || spine.entry.key !== "description") return null;
  const { container, index } = spine.parents[spine.parents.length - 1];
  const text = String(spine.entry.node.scalar?.value ?? "");
  // the chunk takes the description's place: insert right after it, then remove the keyed entry
  const chunk = proseEntry(text);
  container.entries.splice(index + 1, 0, chunk);
  const at = M.serverIndexOf(container, index + 1);
  const edits: Edit[] = [{ path: appendIndex(containerPath(rootPath, root, container), at), op: "insert", yamlover: M.serializeMNode(chunk.node) || '""' }];
  edits.push(...M.removeEntry(rootPath, root, entryId));
  return { edits, focusId: chunk.node.id };
}

/** A committed empty chapter's FIRST paragraph — born from the bootstrap cell's first text, or
 *  from Enter walking out of the title. Goes through the commit machinery, so a freshly wrapped
 *  title (whose entry is a scalar server-side) re-emplaces the whole omni instead of descending.
 *
 *  THE DEFERRED MATERIALIZATION (CHAPTER.md §Attaching a chapter): a freshly Tab-wrapped
 *  subchapter — an omniPending keyless child of a document whose inheritance rule says
 *  "directory" (concrete-rules.ts {@link subchapterMaterializes}) — materializes as its OWN
 *  SUBDIRECTORY the moment it gains body content: the inline line is removed and re-inserted
 *  with the rules' default concrete, named by its title and tagged with the enclosing
 *  chapter's schema (`rootTag`) so the born document reads as a chapter on its own. The
 *  enclosing document is the edited ROOT (`docConcrete`), or — deeper, mid-session — a member
 *  THIS session just materialized (its entry carries `wireKey` + `bornConcrete`), so a
 *  recursive tree (ex-66 `dogs/puppies`) grows subdirectory-by-subdirectory without waiting
 *  for refetches. A title-only wrap stays a model-only transform (nothing to materialize;
 *  Shift-Tab before typing remains a zero-op round-trip). Same-batch follow-up edits route
 *  into the member via its keyed path (on disk from birth); after the flush the SSE refetch
 *  rebuilds the model with the member as a linked subchapter. */
export function createFirstChunk(
  rootPath: string, root: M.MNode, containerId: string, text: string,
  docConcrete: string | null = null, rootTag: string | null = null,
): { edits: Edit[]; focusId: string; entryId: string } | null {
  const found = containerId === root.id ? null : M.findNode(root, containerId);
  const node = containerId === root.id ? root : found?.node;
  if (!node || node.kind !== "container") return null;
  const entry: M.MEntry = {
    id: M.nid(), key: null, decided: true, committed: false,
    node: { id: M.nid(), rev: 0, kind: "scalar", scalar: proseScalar(text), entries: [], selfAt: 0, metaTag: null, setTag: false },
  };
  node.entries.push(entry);
  const ownSpine = found?.spine;
  // the wrapped subchapter's enclosing DOCUMENT — its concrete is what the inheritance rule
  // is asked with, its path is where the member insert lands. Null: not a wrap that derives.
  const doc = (() => {
    if (!ownSpine || ownSpine.entry.key !== null || !node.omniPending || node.metaTag !== null) return null;
    const parents = ownSpine.parents;
    if (parents.length === 1) return { concrete: docConcrete, path: rootPath };
    const holder = parents[parents.length - 2];
    const holderEntry = holder.container.entries[holder.index];
    if (holderEntry.wireKey === undefined) return null; // an inline ancestor — commitSpine's territory
    return { concrete: holderEntry.bornConcrete ?? null, path: M.pathOfSpine(rootPath, { entry: holderEntry, parents: parents.slice(0, -1) }) };
  })();
  if (doc !== null && ownSpine && subchapterMaterializes(doc.concrete)) {
    const memberConcrete = defaultChildConcrete(doc.concrete); // the rules' pick — dir/yamlover
    const { container: holderC, index } = ownSpine.parents[ownSpine.parents.length - 1];
    const at = M.serverIndexOf(holderC, index);
    const edits: Edit[] = [];
    if (ownSpine.entry.committed) edits.push({ path: appendIndex(doc.path, at), op: "remove" });
    node.omniPending = false;
    const title = String(node.selfValue?.value ?? "");
    // the wire carries the TITLE-derived name; the server derives the member's on-disk name
    // from it — an order-numbered `NN-Title` slotted between the neighboring linked members'
    // numbers (nextMemberName is SHARED, so the prediction below computes the same name for
    // keyed follow-up addressing). The prediction sees the MODEL's members, not the disk —
    // an orphan (unreferenced) numbered dir can bump the server's pick past ours, the same
    // divergence class as a duplicate-title uniqueName rename; the refetch reconciles.
    const name = pointerSafeName(title || "subchapter");
    const sibNames: string[] = [];
    let prevName: string | undefined;
    let nextName: string | undefined;
    holderC.entries.forEach((s, i) => {
      if (i === index) return; // ourselves
      const n = memberNameOfSibling(s);
      if (n === null) return;
      sibNames.push(n);
      if (i < index) prevName = n;
      else if (nextName === undefined) nextName = n;
    });
    const predicted = nextMemberName(sibNames, "title", { prevName, nextName, title: title || "subchapter" });
    edits.push({
      path: appendIndex(doc.path, at), op: "insert", concrete: memberConcrete,
      name, yamlover: M.serializeMNode(node),
      ...(rootTag !== null ? { meta: rootTag } : {}),
    });
    M.markCommitted(ownSpine.entry);
    // linked from here on: addressed by its predicted WIRE KEY (shift-immune — the member
    // sorts as a keyed entry before the body entries once indexed, so `[i]` would drift)
    // while still DRAWN as a body element; structural ops nop until the refetch rebuilds the
    // model with the member as a proper linked subchapter
    ownSpine.entry.wireKey = predicted;
    ownSpine.entry.bornConcrete = memberConcrete;
    ownSpine.entry.derivedKey = true;
    return { edits, focusId: entry.node.id, entryId: entry.id };
  }
  const edits = M.commitSpine(rootPath, root, entry.id);
  return { edits, focusId: entry.node.id, entryId: entry.id };
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
