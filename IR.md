# IR — the instance-graph contract (parsers ↔ engine)

The **IR** is the in-memory instance graph that every surface parser emits and the
engine consumes. It is the real interface between Phase 2 (parsers/serializers) and
Phase 3 (engine). Companion to `URIs.md` (pointer model), `ENGINE.md` (storage/API),
`PLAN.md` (roadmap). Normative types are the TypeScript block below; prose explains the
decisions.

## Principles (what the IR is and is not)

- **Instance-only.** The IR carries *data + pointers*, never schema. Validation is a
  separate layer over the resolved graph (deferred — see `PLAN.md` Phase 6).
- **Kept exactly as written.** The IR is a faithful transcription of one concrete, not a
  resolved/normalized view. `*`/`~` edges are stored **unresolved**; the engine resolves
  lazily and derives inverses on demand. A parser never chases a pointer, never inlines a
  target, never invents the reverse of a `~` edge.
- **One ordered container, and a node is *value + fields*.** No list type: entries are an
  **ordered** list, each with an *optional* string key, so keyless (positional) and keyed
  entries can **mix** in one node. And `entries` lives on `NodeBase`, so a `Scalar` or `Blob`
  may *also* carry entries — a single node can be at once a scalar value, partially positioned,
  and partially keyed. A pure list/dict/scalar is just the degenerate case. (The *surface*
  gates these: yamlover requires an explicit `!!mix` / `!!var` tag to write a mixture — see
  `YAMLOVER.md` — but the IR itself just represents the result.)
- **Positions are derived, not stored.** The integer-key aliases (`[n]`, the `0: *key0`
  expansion in `URIs.md`) are a *view* the engine materializes from entry order. The IR
  stores order (the array) once; it does **not** double-store integer keys.
- **`*` is the only edge-creator** beyond containment; `~` marks a back/non-owning edge;
  `&` is a plain intra-document anchor. Containment is the acyclic spine; `*`/`~` lay a
  general graph on top.
- **Concrete-agnostic.** json5p, yamlover, and a directory+`body.yamlover` all parse to
  the *same* IR. The originating concrete is recorded in metadata, not in the shape.

## Normative types

```ts
// ---- Documents ---------------------------------------------------------------
/** One parse of one concrete (a file, or a directory tree) → one root. */
export interface Document {
  root: Node;                       // usually a Mapping
  source: SourceInfo;               // concrete + origin (for diagnostics & round-trip)
  head?: Comment[];                 // head-of-file banner (blank-line-separated from the body)
}

/** A retained source comment — TYPOGRAPHY, not graph identity: parsers capture it for
 *  round-trip, canonical IR-equality ignores it. */
export interface Comment {
  text: string;                     // body with sigils stripped
  span: Span;
  placement: "leading" | "trailing";
  style: "line" | "block";
  blankBefore?: boolean;
}

export interface SourceInfo {
  // The DOCUMENT's source language (the whole file/stream). The richer PER-NODE storage
  // taxonomy (file/…, dir/yamlover, inlined languages) lives on the materialized nodes —
  // see CONCRETES.md. `multi-*` is reserved for multi-document streams (Phase 2c).
  concrete: "json" | "json5" | "json5p" | "yaml" | "yamlover" | "directory" | "multi-yaml" | "multi-yamlover";
  uri: string;                      // file path or dir path, project-relative
}

// ---- Nodes -------------------------------------------------------------------
/** A value that a containment edge OWNS. Pointers are edges, not nodes (see Value). */
export type Node = Mapping | Scalar | Blob;

export interface NodeBase {
  // ANY node may carry ordered fields — so a Scalar/Blob can have fields too (value + fields).
  entries?: Entry[];                // ORDERED; index = the integer position (derived key)
  array?: boolean;                  // projection hint: true ⇒ all-keyless (a pure sequence)
  meta?: NodeMeta;                  // optional; diagnostics, format, source span
}

export interface Mapping extends NodeBase {
  kind: "mapping";
  entries: Entry[];                 // a mapping always has the container (narrows NodeBase)
}

export interface Scalar extends NodeBase {
  kind: "scalar";
  value: string | number | boolean | null;
  raw: string;                      // verbatim source token (lossless round-trip)
  // may ALSO carry `entries` (inherited) — a scalar with fields
}

/** Opaque/foreign bytes — a file in a directory that is not itself yamlover/json5p. */
export interface Blob extends NodeBase {
  kind: "blob";
  format: string;                   // inferred concrete/MIME, e.g. "image/png", "pdf"
  contentHash: string | null;       // `xxh64:…` of bytes (null until the background hasher
                                    // reaches a large blob); bytes live in the store, not the IR
  size: number;
}

// ---- Entries & edges ---------------------------------------------------------
/** One key→value pair (or keyless value) in a Mapping, in source order. */
export interface Entry {
  key: string | null;              // string key, or null for a keyless ( ":" / "- " ) entry
  edge: EdgeKind;                  // how the value attaches (see below)
  value: Value;
  meta?: EntryMeta;
}

/**
 * - "contain": value is an OWNED Node (the tree spine; acyclic).
 * - "ref":     value is a Pointer (`*…`)  — a shared, forward, non-owning edge.
 * - "back":    value is a Pointer, and the key carried a `~` prefix — the reverse of
 *              the forward relation named by `key` (up / non-owning; FS symlink).
 */
export type EdgeKind = "contain" | "ref" | "back";

export type Value = Node | Pointer; // Node iff edge==="contain"; Pointer iff ref/back

// ---- Pointers (unresolved `*` expressions) -----------------------------------
/** Parsed `*` target. NOT resolved — the engine resolves against the graph, lazily. */
export interface Pointer {
  kind: "pointer";
  base: PointerBase;
  steps: Step[];                    // walked after the base, in order
  raw: string;                      // verbatim text after `*` (round-trip + diagnostics)
  span?: Span;                      // the whole deref token — `mv` rewrites exactly this range
}

export type PointerBase =
  | { scope: "current" }                          // bare name/index: current mapping
  | { scope: "document" }                         // ":"  (legacy "/") — current document root
  | { scope: "parent" }                           // ".." — parent node (then steps)
  | { scope: "link"; authority: string; world?: boolean };
      // "::" — project scope: authority = an internal key at the served root (import /
      // mounted authority); a miss is a DANGLING typo. `world: true` marks the ":::"
      // WORLD scope (SEPARATOR.md §2) — the only form that stays external on a miss.

export type Step =
  | { sel: "key"; name: string }                  // :x  — string key
  | { sel: "index"; n: number }                   // [n] — integer key (position)
  | { sel: "relindex"; k: number }                // [.±k] — the host's own position ± k
                                                  //   (URIs.md §Relative indexes)
  | { sel: "parent" };                            // ..  — up one node

// ---- Metadata ----------------------------------------------------------------
export interface NodeMeta {
  span?: Span;
  anchors?: Anchor[];               // `&P/k` / `&P[]` path anchors on this node (URIs.md §`&`)
  schema?: Value;                   // the authored `!!<…>` tag: Pointer to a hosted schema or inline Node
  derivedFormat?: string;           // engine-derived format (extension / meta / resolved tag); never authored
  documentRoot?: boolean;           // a self-contained instance; the `/`-scope target
  set?: boolean;                    // `!!set` / uniqueItems — survives into the graph
  hidden?: boolean;                 // resolvable but omitted from TOC/listings (`.yamlover` sidecars)
  comments?: Comment[];             // comments with no entry to attach to
  head?: Comment[];                 // a document root's banner, carried onto the node
  selfAt?: number;                  // omni: display position of the scalar self-value line
}

/** One `&` path-anchor declaration: this node ALSO lives at that path — the container at
 *  the path's parent gains a ref edge to this node. Realized by the resolver. */
export interface Anchor {
  path: Pointer;
  ordinal?: boolean;                // true for `&path[]` — keyless appended membership
}

export interface EntryMeta {
  span?: Span;                      // the whole entry, key through value (post-strip)
  comments?: Comment[];
  blankBefore?: boolean;
}
export interface Span { uri: string; start: number; end: number; }
```

## Notes on the contract

### Entries, keys, positions
An `Entry` stores at most a **string** key; the **integer** position is its index in
`entries`. A keyless entry (`: value` in yamlover, `- value` in a YAML sequence, a bare
element in a json5p array) has `key: null`. The `URIs.md` expansion — `0: *key0`,
`1: value1` — is the engine's *derived* positional view; the IR never writes those alias
entries. So `[1]` resolves to `entries[1]`; `/x` resolves to the entry whose `key === "x"`.

### Pointers are edges, never nodes
`feline: *cat` is an `Entry { key:"feline", edge:"ref", value: Pointer }`. The pointer is
unresolved — `base:{scope:"current"}, steps:[{sel:"key",name:"cat"}]`. The engine turns it
into an `edge(from, to, label="feline", kind="ref")` row only when asked. This is what
keeps the IR faithful and resolution lazy/cycle-safe.

### `~` back-edges
A `~`-prefixed key produces `edge:"back"` with `key` holding the **forward** relation name
(the `~` is not part of the key). `~cain: */eve` ⇒ `Entry { key:"cain", edge:"back",
value: Pointer(document-root → eve) }`. The IR records the back-edge as written; it does **not**
synthesize the matching forward edge (that's `normalize`/`derive` in the engine).

The **keyless** form — yamlover `~- *…`, json5p `~*'…'` (reverse positional membership,
`URIs.md` §`~-`) — is `Entry { key: null, edge:"back", value: Pointer }`: the same nullable
`key` a keyless forward entry uses, with `edge:"back"`. The value is always a `Pointer`
(the `Value` contract already requires it for `ref`/`back`). Unlike `!!mix`/`!!var` —
parse *permissions* whose effect is visible in the node's shape — `!!set` (≡
`uniqueItems: true`) must survive into the graph, so it is recorded as `NodeMeta.set`.

### `&` anchors
An anchor is a **path**, not a name (`ANCHOR_REFACTOR.md` / URIs.md §`&`): `&P/k value`
declares that the value *also* lives at `P/k`. The parser records it on the anchored node
as `NodeMeta.anchors: Anchor[]` — anchors are not entries and never count toward the node's
kind. There is **no anchor namespace and no precedence rule**: a `*name` is pure path
lookup, and the **resolver** realizes each anchor as a ref edge from the target container
(the push side of `*`'s pull; `resolve.ts realizeAnchors`).

### Scalars keep `raw`
`Scalar.raw` is the verbatim token so serializers round-trip `1.0` vs `1`, quoting style,
etc. `value` is the decoded JS value for the engine/consumers.

### Blobs externalize bytes
A directory's foreign files become `Blob` nodes: the IR holds `format` + `contentHash` +
`size`; the bytes live in the store and are served via the engine's `blob` API. A file that
*is* yamlover/json5p is parsed into a sub-tree (a `Mapping`/`Scalar`), not a `Blob`.

### Metadata (type/format) comes from the schema layer
The IR carries *data*. A node's **`type`/`format`/presentation** metadata lives in the
separate **metadata schema** (`.yamlover/meta.yamlover`, see `META.md`) — a JSON-Schema-
equivalent whose meta-path maps to an instance-path. The engine attaches it to nodes (e.g.
to drive decoding a `Blob` via `format`, or rendering by `(type, format)`); the parser does
not require it. A `Blob`'s `format` may thus be filled from `meta` rather than inferred.

## Mapping IR → engine tables (`ENGINE.md`)

A walk of the IR populates `node` and `edge` (path = identity, no ids; the full as-built
schema — including the `file` manifest and `dangling` side tables — is in `ENGINE.md`
§Data model / `store.ts`):

- Each `Node` → one `node(path, type=kind, format, value, content_hash, size, is_array, meta)`
  row. `path` is the containment path from the document/project root; `value` is the JSON-
  encoded scalar self-value; `is_array` is the all-keyless projection hint.
- Each `Entry` with `edge:"contain"` → `edge(parent, child, label=key, kind="contain", pos)` —
  `pos` is the entry's index in its holder (stable source order).
- Each `Entry` with `edge:"ref"`  → `edge(owner, resolved-target, label=key, kind="ref", pos)`.
- Each `Entry` with `edge:"back"` → `edge(owner, resolved-target, label=key, kind="back", pos)`.
- A pointer that does not resolve → a `dangling` row (reported, never silently dropped);
  the walk's file manifest → `file` rows (the hash cache / diff base).
- `kind:"derived"` edges (inverse of a `*`, transitive closures) are **never** in the IR;
  the engine computes them from the above on demand.

## Worked example (genealogy, the canonical graph fixture)

The old schema-storage form (`examples/58-genealogy-dag/.yamlover/schema.yaml`,
`properties:`/`x-yamlover.rel`) becomes instance yamlover with `*`/`~`:

```yamlover
adam:
  cain:
    ~cain: */eve           # back-edge: eve --cain--> here
  seth: {}
eve:
  cain: */adam/cain        # forward containment-alias by reference
```

`eve.cain` → `Entry{ key:"cain", edge:"ref", value: Pointer(base:document, steps:[key adam,
key cain]) }`. `adam.cain.~cain` → `Entry{ key:"cain", edge:"back", value:
Pointer(base:document, steps:[key eve]) }`. Neither side is auto-completed; `normalize`
reduces the pair to a single forwards-only edge.

## Open items (resolve before/with the json5p parser)

- **Integer-looking string keys** — `/1` is the string key `"1"`; ensure the parser keeps
  `key:"1"` distinct from position `1`. (Covered by `[n]` vs `/x`; flag in tests.)
- **Blob inlining threshold** — when (if ever) a small blob's bytes are carried inline vs
  always externalized by hash. Default: always externalize.
- **Comment/whitespace retention** — `raw`/`span` cover round-trip of values; decide whether
  comments are preserved in IR (json5p/yamlover have them) or dropped. Default v1: dropped,
  spans kept; revisit if a formatting-preserving serializer is needed.
- **Tag/typed scalars** — yamlover may inherit YAML tags (`!!str`); v1 treats scalars as
  plain typed values, defer custom tags.
```
