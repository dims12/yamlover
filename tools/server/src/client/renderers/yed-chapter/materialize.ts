// THE DEFERRED MATERIALIZATION (CHAPTER.md §Attaching a chapter), as a FLUSH-TIME transformer
// over the diff channel: a freshly Tab-wrapped subchapter — an untagged, keyless, wrapped
// (`meta.chapterWrapped`) child of a document whose inheritance rule says "directory"
// (concrete-rules.ts subchapterMaterializes) — becomes its OWN SUBDIRECTORY the moment it
// gains body content. The transformer runs BEFORE diffToOps: it emits the legacy-exact
// `remove` + `insert{concrete, name, yamlover, meta}` batch itself, advances the committed
// snapshot over the born subtree (so the diff never re-emits it), and stamps the PREDICTED
// wire key as `meta.anchorKey` on the entry — yed-sync's segOf/keyOf already address by
// anchorKey, so every follow-up edit routes into the member by key with no special-casing.
//
// Materialization applies to DIRECT keyless children of a document: the mounted root, or a
// member THIS session just born (its entry carries `bornConcrete`) — the recursive ex-66
// `dogs/puppies` growth. Inline grandchildren of a plain subchapter never materialize.
//
// No refetch rides this (the yed mount has no SSE reconciliation): the member stays DRAWN
// inline as the wrapped node while being ADDRESSED by its key — the same posture the legacy
// editor holds between the flush and its refetch; navigation rebuilds from the server.

import type { Edit } from "../../api";
import { sourceOf, type Document, type Entry, type Node, type Path, type Value } from "../../../../../yed/src/state";
import { isPointer } from "../../../../../parser/ts/src/ir.ts";
import { withNode } from "../../../../../yed/src/apply";
import { hasSelfValue, metaOf, tagContentOf } from "../../../../../yed/src/chapter/format";
import { parsePointer } from "../../../../../parser/ts/src/pointer.ts";
import { segToken } from "../../../../../parser/ts/src/pathseg.ts";
import { pointerSafeName } from "../../../concrete";
import { defaultChildConcrete, nextMemberName, subchapterMaterializes } from "../../../concrete-rules";

export interface MaterializeResult {
  ops: Edit[];
  /** The committed snapshot advanced over the born subtrees (the diff skips them). */
  committed: Document;
  /** The next snapshot with `anchorKey`/`bornConcrete` stamped on the born entries. */
  next: Document;
  /** The entry paths that were born (the mount patches the LIVE doc with the same stamps). */
  born: { path: Path; anchorKey: string; bornConcrete: string }[];
}

const scalarText = (v: Value): string => String((v as Node & { value?: unknown }).value ?? "");
const entryMeta = (e: Entry): { anchorKey?: string; bornConcrete?: string } => ((e.meta ?? {}) as { anchorKey?: string; bornConcrete?: string });

/** The member name a sibling entry references: a session-born member's anchorKey, or the
 *  single-key document-scope name a loaded `- *: name` entry points at. */
function memberNameOfSibling(e: Entry): string | null {
  const m = entryMeta(e);
  if (m.anchorKey !== undefined) return m.anchorKey;
  if (isPointer(e.value)) {
    try {
      const p = parsePointer(String((e.value as { raw?: string }).raw ?? ""));
      const steps = (p as { base: { scope: string }; steps: { sel: string; name?: string }[] }).steps;
      const base = (p as { base: { scope: string } }).base;
      if (base.scope === "document" && steps.length === 1 && steps[0].sel === "key") return steps[0].name ?? null;
    } catch { /* not a member reference */ }
  }
  return null;
}

const appendIndex = (path: string, i: number): string => `${path === ":" ? "" : path}:${i}`;
const appendKey = (path: string, key: string): string => `${path === ":" ? "" : path}:${encodeURIComponent(segToken(key))}`;

/** A birth candidate: a session-born group (`meta.chapterWrapped`), untagged, that is now a
 *  TITLED chapter with body — the title names the member directory (a nameless group stays
 *  inline as `- - x`). Born when the committed counterpart wasn't titled-with-body yet. */
function isBirth(nextNode: Value, committedNode: Value | null): boolean {
  if (isPointer(nextNode)) return false;
  const n = nextNode as Node;
  if (metaOf(n).chapterWrapped !== true || tagContentOf(n) !== null) return false;
  if (!hasSelfValue(n)) return false;
  if ((n.entries ?? []).length === 0) return false;
  if (committedNode === null || isPointer(committedNode)) return true;
  const c = committedNode as Node;
  return !(hasSelfValue(c) && (c.entries ?? []).length > 0);
}

export function materializeSubchapters(
  basePath: string, committed: Document, next: Document, docConcrete: string | null, rootTag: string | null,
): MaterializeResult {
  const ops: Edit[] = [];
  const born: MaterializeResult["born"] = [];
  let outCommitted = committed;
  let outNext = next;

  const scanDocument = (docPath: Path, docServerPath: string, concrete: string | null): void => {
    if (!subchapterMaterializes(concrete)) return;
    const container = nodeAt(outNext.root, docPath);
    if (!container) return;
    const committedContainer = nodeAt(outCommitted.root, docPath);
    (container.entries ?? []).forEach((e, i) => {
      const m = entryMeta(e);
      if (m.anchorKey !== undefined && m.bornConcrete !== undefined) {
        // a member born THIS session — its own document grows recursively
        scanDocument([...docPath, i], appendKey(docServerPath, m.anchorKey), m.bornConcrete);
        return;
      }
      if (e.key !== null) return;
      const committedEntry = committedContainer?.entries?.[i] ?? null;
      if (!isBirth(e.value, committedEntry ? committedEntry.value : null)) return;

      const node = e.value as Node;
      const title = scalarText(node);
      const memberConcrete = defaultChildConcrete(concrete);
      const name = pointerSafeName(title || "subchapter");
      const sibNames: string[] = [];
      let prevName: string | undefined;
      let nextName: string | undefined;
      (container.entries ?? []).forEach((s, j) => {
        if (j === i) return;
        const n2 = memberNameOfSibling(s);
        if (n2 === null) return;
        sibNames.push(n2);
        if (j < i) prevName = n2;
        else if (nextName === undefined) nextName = n2;
      });
      const predicted = nextMemberName(sibNames, "title", { prevName, nextName, title: title || "subchapter" });

      if (committedEntry !== null) ops.push({ path: appendIndex(docServerPath, i), op: "remove" });
      ops.push({
        path: appendIndex(docServerPath, i), op: "insert", concrete: memberConcrete, name,
        yamlover: sourceOf({ root: stripWrap(node) } as Document).replace(/\n$/, ""),
        ...(rootTag !== null ? { meta: rootTag } : {}),
      });

      // stamp the born entry in BOTH snapshots: the diff pairs it by key and skips the subtree
      const p = [...docPath, i];
      const stamp = (doc: Document, withSubtree: boolean): Document =>
        withNode(doc, docPath, (c) => {
          const entries = [...(c.entries ?? [])];
          const src = withSubtree ? e : entries[i];
          entries[i] = { ...src, value: e.value, meta: { ...(src.meta ?? {}), anchorKey: predicted, bornConcrete: memberConcrete } } as Entry;
          return { ...c, entries } as Node;
        });
      outNext = stamp(outNext, false);
      outCommitted = stamp(outCommitted, true); // committed gains the WHOLE born subtree
      born.push({ path: p, anchorKey: predicted, bornConcrete: memberConcrete });
    });
  };

  scanDocument([], basePath, docConcrete);
  return { ops, committed: outCommitted, next: outNext, born };
}

/** The serialized member body must not carry the session-only wrap flag's meta. */
function stripWrap(n: Node): Node {
  const { chapterWrapped: _w, ...meta } = (n.meta ?? {}) as Record<string, unknown>;
  return { ...n, meta: Object.keys(meta).length ? meta : undefined } as Node;
}

/** Stamp the LIVE doc with the born entries' keys (the mount applies it to the current state,
 *  which may have advanced past the flushed snapshot — the paths still address the entries). */
export function stampBorn(doc: Document, born: MaterializeResult["born"]): Document {
  let out = doc;
  for (const b of born) {
    const parent = b.path.slice(0, -1);
    const i = b.path[b.path.length - 1];
    out = withNode(out, parent, (c) => {
      const entries = [...(c.entries ?? [])];
      if (!entries[i]) return c;
      entries[i] = { ...entries[i], meta: { ...(entries[i].meta ?? {}), anchorKey: b.anchorKey, bornConcrete: b.bornConcrete } } as Entry;
      return { ...c, entries } as Node;
    });
  }
  return out;
}

function nodeAt(root: Value, path: Path): Node | null {
  let v: Value = root;
  for (const i of path) {
    if (isPointer(v)) return null;
    const e = (v as Node).entries?.[i];
    if (!e) return null;
    v = e.value;
  }
  return isPointer(v) ? null : (v as Node);
}
