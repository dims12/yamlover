// THE CHAPTER ROLES — the ONE rule for what each entry of a chapter-mode node IS on the page.
// Read renderer (chapter-model.ts chapterFlow), the yed chapter cells (cells.tsx ChapterNode)
// and the caret walk (positions.ts walkChapter) all consult THIS module, so the two faces can
// never disagree about what a chapter shows (the face-parity gate pins it).
//
// The decision table (the Stage-5 unification — each row was a read/edit divergence):
//   1. a KEYED entry that is not title/description (a task planning field, a keyed-remainder
//      member) is BODY, shown with its key as the gutter label — in both faces;
//   2. the title's authored position (`meta.selfAt`) is honored in both faces;
//   3. the title test is hasSelfValue — ANY scalar self, not only a non-empty string;
//   4. a LEGACY keyed `title:` entry (an unmigrated file) is the heading in both faces;
//   5. a body-positioned MEMBER is body whatever its storage name — `anchorKey` is provenance,
//      not a field, so a member named `description` (or `title`) stays a chunk;
//   6. the annotation overlay keys are the annotation LAYER, hidden in both faces.

/** What one entry is on the chapter page. */
export type EntryRole = "body" | "title" | "description" | "hidden";

/** The face-independent view of an entry — each face maps its own shape onto this
 *  (the wire's `{key, keyNull, anchor}` or the IR's `{key, nullKey, meta.anchorKey}`). */
export interface RoleEntry {
  /** The authored key; null = a keyless positional entry. */
  key: string | null;
  /** The `~:` null-keyed entry — a keyed field whose key is the null value. */
  nullKey?: boolean;
  /** A body-positioned member (storage provenance rides the entry, not the text). */
  anchored?: boolean;
}

/** An ANNOTATION OVERLAY key — a tag application / fragment set laid OVER a value
 *  (docs/server/annotations). The overlay is the annotation layer's storage, never page content. */
export const isOverlayKey = (k: string | null): boolean =>
  k === "yamlover-annotations" || k === "yamlover-fragments";

export function entryRole(e: RoleEntry): EntryRole {
  if (e.anchored === true) return "body"; // row 5 — provenance, not a field
  if (e.key === null && e.nullKey !== true) return "body"; // a keyless positional entry
  if (isOverlayKey(e.key)) return "hidden"; // row 6
  if (e.key === "title") return "title"; // row 4 — the legacy keyed heading
  if (e.key === "description") return "description";
  return "body"; // row 1 — keyed fields are body with a key gutter (the null key included)
}

/** The gutter label of a BODY entry: a keyed one cites its KEY (the null key as `~`), a
 *  positional one composes the page-root index chain (`[...crumbs, index]`). */
export function bodyLabel(
  e: RoleEntry,
  crumbs: readonly (number | string)[],
  index: number,
): readonly (number | string)[] {
  if (e.anchored !== true && e.key !== null) return [e.key];
  if (e.nullKey === true) return ["~"];
  return [...crumbs, index];
}

/** WHERE the title row renders: before the entry at this index (`entryCount` = after the last
 *  entry), or -1 when the node has no self title. `selfAt` counts ENTRIES (all of them —
 *  the authored position among the lines), clamped like the serializer clamps it. */
export function titleSlot(hasTitle: boolean, selfAt: number | undefined, entryCount: number): number {
  return hasTitle ? Math.min(selfAt ?? 0, entryCount) : -1;
}
