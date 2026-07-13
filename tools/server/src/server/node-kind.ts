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

/** A node's display {@link Kind}. A scalar/blob carrying OWNED fields is `omni`; a mapping that
 *  mixes keyed and keyless OWNED entries is `mix`; otherwise object|array|scalar|binary. The
 *  `is_array` flag marks a pure-keyless container. Reverse (`~`) members never count — a tagged PDF
 *  is still a `binary`, not an `omni` (they are upstream relations, not owned content). */
export function displayKind(s: Store, p: string, row: NodeRow): Kind {
  const ents = ownedEntries(s, p);
  if (row.type === "blob") return ents.length ? "omni" : "binary";
  if (row.type === "scalar") return ents.length ? "omni" : "scalar";
  if (!ents.length) return row.is_array ? "array" : "object"; // empty container
  if (row.is_array) return "array";
  return ents.some((e) => e.label === null) ? "mix" : "object";
}

// Internal kind → the JSON-Schema-style `type:` name shown in the header/TOC and the schema view.
// The YAML-tag shapes `!!mix`/`!!var` get full-word schema names (cf. !!seq→array, !!map→object):
// `mix` → "mixed", `omni` → "variant". Scalars resolve to their JSON-ish primitive type.
export function typeName(s: Store, p: string, row: NodeRow): string {
  const k = displayKind(s, p, row);
  if (k === "scalar") return scalarType(row.value);
  if (k === "mix") return "mixed";
  if (k === "omni") return "variant";
  return k; // object | array | binary
}

export function scalarType(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return "string";
}

/** The three TYPE FACETS the client dispatches on (TYPES.md §1): the scalar self-VALUE's type
 *  (`null|boolean|integer|number|string|binary`, or null when there is no value facet), and
 *  whether the node OWNS any KEYED / ORDINAL (keyless) elements. Reverse `~` members are excluded
 *  (ownedEntries) — a tagged node keeps its facets, so a renderer can tolerate the extra keys. */
export function facetsOf(s: Store, p: string, row: NodeRow): { valueType: string | null; hasKeyed: boolean; hasOrdinal: boolean } {
  const ents = ownedEntries(s, p);
  return {
    valueType: row.type === "scalar" ? scalarType(row.value) : row.type === "blob" ? "binary" : null,
    hasKeyed: ents.some((e) => e.label !== null),
    hasOrdinal: ents.some((e) => e.label === null),
  };
}
