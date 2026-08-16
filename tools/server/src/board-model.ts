// BOARD MODEL — the pure policy of the tag board (TICKETS.md §3). Like drop-policy.ts /
// concrete-rules.ts this module is deliberately tiny and pure (no I/O, no DOM, no Store):
// the board's STRUCTURE (`yo: lanes:` — lanes of compartments, each compartment a tagged
// container of chapter refs) is data both the server (engine-api.ts, which reads/writes it)
// and the client (board.tsx, which previews a gesture's tag deltas for the confirm popup)
// reason about, so the rules live here once.
//
// All paths are CANONICAL client colon-paths (the shape projectTag / segsToStr emit); the
// module compares them as plain strings and never parses them.
//
// The two invariants every function preserves:
//   • RECONCILE never changes tags — it only moves refs between compartments/backlog.
//   • Only an explicit MOVE GESTURE retags (moveDeltas), and only by the source/destination
//     compartments' tags — a chapter merely sitting in a compartment is never touched.

/** One element of a compartment — a ref to a chapter (or any node), optionally keyed. */
export interface BoardItem {
  path: string;
  key?: string;
}

/** One compartment: a container tagged by `&…:-` bookmarks, holding item refs. A compartment
 *  with NO tags is manual-only — reconcile never moves anything in or out of it. */
export interface Compartment {
  tags: string[];
  items: BoardItem[];
}

/** One lane: a stack of one or more compartments. */
export type BoardLane = Compartment[];

/** The whole `yo: lanes:` value: the board's lanes in order. */
export type BoardStructure = BoardLane[];

/** A compartment's coordinates in the structure; null = the backlog. */
export type CompartmentAt = { lane: number; comp: number } | null;

const supersetOf = (tags: ReadonlySet<string>, wanted: readonly string[]): boolean => wanted.every((t) => tags.has(t));

/** Look a compartment up; null for backlog or out-of-range coordinates. */
export function compartmentAt(structure: BoardStructure, at: CompartmentAt): Compartment | null {
  if (!at) return null;
  return structure[at.lane]?.[at.comp] ?? null;
}

/**
 * FIX THE RELATIONS (structure ← tags): every direct-member chapter whose tag set is a
 * SUPERSET of a compartment's tags belongs in that compartment (possibly several, even in
 * one lane); a chapter listed where it no longer matches is dropped. `chapters` maps every
 * direct member of the board to its current tag set, in the board's member order — newcomers
 * are appended (unkeyed) in that order. Manual labor survives: item order and keys are kept,
 * duplicates collapse to the first occurrence, a ref that is NOT a direct member (a foreign
 * ref the user authored) is never touched, and a zero-tag compartment is left verbatim.
 * Pure and idempotent; never changes tags. The backlog needs no reconciling — it is DERIVED
 * (members referenced by no compartment).
 */
export function reconcile(structure: BoardStructure, chapters: ReadonlyMap<string, ReadonlySet<string>>): { structure: BoardStructure; changed: boolean } {
  let changed = false;
  const out = structure.map((lane) =>
    lane.map((comp) => {
      if (comp.tags.length === 0) return comp; // manual-only
      const kept: BoardItem[] = [];
      const seen = new Set<string>();
      let compChanged = false;
      for (const item of comp.items) {
        if (seen.has(item.path)) { compChanged = true; continue; } // duplicate — first wins
        const tags = chapters.get(item.path);
        if (tags && !supersetOf(tags, comp.tags)) { compChanged = true; continue; } // no longer matches
        kept.push(item);
        seen.add(item.path);
      }
      for (const [p, tags] of chapters) {
        if (seen.has(p) || !supersetOf(tags, comp.tags)) continue;
        kept.push({ path: p });
        seen.add(p);
        compChanged = true;
      }
      if (!compChanged) return comp;
      changed = true;
      return { tags: comp.tags, items: kept };
    }),
  );
  return changed ? { structure: out, changed } : { structure, changed };
}

/**
 * The TAG DELTAS of a move gesture (the only retagging verb). From a compartment: remove the
 * tags the chapter SHARES with it — except any the destination also wants (a tag in both
 * compartments must survive the move). Into a compartment: add every destination tag the
 * chapter does not already carry. Backlog is tagless on both sides (from-backlog removes
 * nothing, to-backlog adds nothing).
 */
export function moveDeltas(chapterTags: ReadonlySet<string>, from: Compartment | null, to: Compartment | null): { untag: string[]; tag: string[] } {
  const toTags = new Set(to?.tags ?? []);
  const untag = (from?.tags ?? []).filter((t) => chapterTags.has(t) && !toTags.has(t));
  const tag = (to?.tags ?? []).filter((t) => !chapterTags.has(t));
  return { untag, tag };
}

/**
 * The STRUCTURE half of a move gesture: pull `task` out of the source compartment only (other
 * instances stand — the follow-up {@link reconcile} relocates them if their tags now differ)
 * and append it to the destination (backlog destination = just the removal). The moved item's
 * key travels with it. Pure — returns a new structure.
 */
export function applyMove(structure: BoardStructure, task: string, from: CompartmentAt, to: CompartmentAt): BoardStructure {
  let moved: BoardItem = { path: task };
  const out = structure.map((lane, li) =>
    lane.map((comp, ci) => {
      let items = comp.items;
      if (from && from.lane === li && from.comp === ci) {
        const i = items.findIndex((it) => it.path === task);
        if (i >= 0) { moved = items[i]; items = [...items.slice(0, i), ...items.slice(i + 1)]; }
      }
      return items === comp.items ? comp : { tags: comp.tags, items };
    }),
  );
  if (to) {
    const dest = out[to.lane]?.[to.comp];
    if (dest && !dest.items.some((it) => it.path === task)) {
      out[to.lane] = out[to.lane].map((c, ci) => (ci === to.comp ? { tags: c.tags, items: [...c.items, moved] } : c));
    }
  }
  return out;
}

/** Seed a structure from a `workflow:` board's states — one single-compartment lane per state,
 *  the INITIAL state included (the backlog SECTION is the structural orphan set, a different
 *  thing). Items start empty; the first reconcile populates them. */
export function seedFromWorkflow(statePaths: readonly string[]): BoardStructure {
  return statePaths.map((p) => [{ tags: [p], items: [] }]);
}

/** Seed a structure from the RETIRED top-level `lanes:` config (lanes × tag paths): each old
 *  lane becomes one lane, its former sublane tags one compartment each (a tagless old lane
 *  becomes one manual compartment). Items start empty; the first reconcile populates them. */
export function seedFromOldLanes(lanes: readonly (readonly string[])[]): BoardStructure {
  return lanes.map((laneTags) => (laneTags.length === 0 ? [{ tags: [], items: [] }] : laneTags.map((t) => ({ tags: [t], items: [] }))));
}
