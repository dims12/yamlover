// Node-KIND classification — how a Store node is presented (the `type:` the client routes on). Kept
// in its own module (no http/fs/gitignore deps) so it can be unit-tested under `node --test` against
// a Store, independently of the HTTP layer (engine-api.ts), which only Vite can load (node:sqlite).
import type { NodeRow, Store } from "../../../engine/ts/src/index.ts";

// One ordered container, classified for display: a pure-keyed mapping is `object`, a pure-keyless
// one `array`; a mapping mixing keyed + keyless OWNED entries is `mix`; a scalar/blob that ALSO
// carries OWNED fields is `omni` (the `!!mix`/`!!var` shapes); plain scalars/blobs are
// `scalar`/`binary`.
export type Kind = "object" | "array" | "scalar" | "binary" | "omni" | "mix";

/** One of a node's owned entries: an edge row, or an UNREALIZED pointer entry (a `*` ref whose
 *  target is dangling or external — no edge exists, `to` is empty and `raw` carries the authored
 *  pointer text so the projection can still show it in place). */
export type OwnedEntry = ReturnType<Store["entries"]>[number] & { raw?: string };

/** A node's OWNED entries — the ones it authors, that constitute its content: containment children
 *  and forward `*` refs, INCLUDING pointer entries with no local target (dangling / external —
 *  authored content must not vanish from the node's shape just because it does not resolve). A `~`
 *  back-edge (a REVERSE member, e.g. tag membership) is an upstream relation the node does NOT own,
 *  so it is excluded — it must not change the node's type. */
export function ownedEntries(s: Store, p: string): OwnedEntry[] {
  const own: OwnedEntry[] = s.entries(p).filter((e) => e.kind !== "back");
  const unrealized = s.unrealizedRefs(p).filter((u) => u.edge !== "back");
  if (unrealized.length === 0) return own;
  for (const u of unrealized) own.push({ to: "", label: u.label, pos: u.pos, kind: "ref", raw: u.raw });
  return own.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
}

/** The members whose POSITION came from the node's `body.yo` (walk.ts applyBody): the body
 *  named each by a `*` pointer, which consumed it, so its key is storage PROVENANCE — shown as a
 *  derived `&` anchor — and it counts as ORDINAL, not keyed. Empty for every other node; a member
 *  the body never named keeps its key and stays part of the keyed remainder. */
export function anchoredOf(row: NodeRow): ReadonlySet<string> {
  const a = (row.meta as { anchored?: unknown } | null)?.anchored;
  return Array.isArray(a) ? new Set(a.filter((x): x is string => typeof x === "string")) : EMPTY;
}
const EMPTY: ReadonlySet<string> = new Set<string>();

/** Whether an entry belongs to the node's ORDINAL facet: a keyless element, or a member the body
 *  positioned by pointer ({@link anchoredOf}). */
export function isOrdinalEntry(anchored: ReadonlySet<string>, label: string | null): boolean {
  return label === null || anchored.has(label);
}

/** A node's display {@link Kind}. A scalar/blob carrying OWNED fields is `omni`; a mapping that
 *  mixes keyed and keyless OWNED entries is `mix`; otherwise object|array|scalar|binary. The
 *  `is_array` flag marks a pure-keyless container. A node with BODY-ANCHORED members
 *  ({@link anchoredOf}) and a keyed remainder is a `mix` — the anchored ones are ordinal, the
 *  remainder keyed. Reverse (`~`) members never count — a tagged PDF is still a `binary`, not an
 *  `omni` (they are upstream relations, not owned content). */
export function displayKind(s: Store, p: string, row: NodeRow): Kind {
  const ents = ownedEntries(s, p);
  if (row.type === "blob") return ents.length ? "omni" : "binary";
  if (row.type === "scalar") return ents.length ? "omni" : "scalar";
  if (!ents.length) return row.is_array ? "array" : "object"; // empty container
  if (row.is_array) return "array";
  const anchored = anchoredOf(row);
  if (anchored.size) return ents.some((e) => !isOrdinalEntry(anchored, e.label)) ? "mix" : "array";
  return ents.some((e) => e.label === null) ? "mix" : "object";
}

/** The cube corner from actual presence — the LOWER BOUND (docs/meta/facets). An untagged
 *  node is never promoted to `omni` (the top) just because it has a self-value; self+keyed
 *  is `vmap`, self+ordinal is `vseq`, both member kinds + self is `omni`. Empty containers
 *  keep the `{}` / `[]` serialization hint. */
export function cubeName(
  f: { valueType: string | null; hasKeyed: boolean; hasOrdinal: boolean },
  empty: "map" | "seq",
): string {
  const v = f.valueType !== null;
  if (v && f.hasKeyed && f.hasOrdinal) return "omni";
  if (v && f.hasKeyed) return "vmap";
  if (v && f.hasOrdinal) return "vseq";
  if (f.hasKeyed && f.hasOrdinal) return "kseq";
  if (f.hasKeyed) return "map";
  if (f.hasOrdinal) return "seq";
  return empty;
}

// Internal kind → the `type:` name shown in the header/TOC and the schema view — the ruled
// yamlover spellings (docs/meta/facets). Scalars resolve to their JSON-ish primitive type.
// Untagged containers use {@link cubeName} (lower bound); `object`/`array` are no longer emitted.
export function typeName(s: Store, p: string, row: NodeRow): string {
  const k = displayKind(s, p, row);
  if (k === "scalar") return scalarType(row.value);
  if (k === "binary") return "binary";
  return cubeName(facetsOf(s, p, row), row.is_array ? "seq" : "map");
}

export function scalarType(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return "string";
}

/** The three TYPE FACETS the client dispatches on (docs/meta/facets): the scalar self-VALUE's type
 *  (`null|boolean|integer|number|string|binary`, or null when there is no value facet), and
 *  whether the node OWNS any KEYED / ORDINAL (keyless) elements. Reverse `~` members are excluded
 *  (ownedEntries) — a tagged node keeps its facets, so a renderer can tolerate the extra keys. */
export function facetsOf(s: Store, p: string, row: NodeRow): { valueType: string | null; hasKeyed: boolean; hasOrdinal: boolean } {
  const ents = ownedEntries(s, p);
  // a BODY-ANCHORED member ({@link anchoredOf}) counts as ORDINAL (its key is storage provenance,
  // not an authored key); only the remainder the body never named counts as KEYED.
  const anchored = anchoredOf(row);
  return {
    valueType: row.type === "scalar" ? scalarType(row.value) : row.type === "blob" ? "binary" : null,
    hasKeyed: ents.some((e) => e.label !== null && !isOrdinalEntry(anchored, e.label)),
    hasOrdinal: ents.some((e) => isOrdinalEntry(anchored, e.label)),
  };
}
