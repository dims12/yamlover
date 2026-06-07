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
- **One ordered container.** No list type. A `Mapping` is an **ordered** list of entries;
  each entry has an *optional* string key. A "list" is a mapping of keyless entries.
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
  anchors: Map<string, Node>;       // & declarations in this document (intra-doc)
  source: SourceInfo;               // concrete + origin (for diagnostics & round-trip)
}

export interface SourceInfo {
  concrete: "json5p" | "yamlover" | "yaml" | "json" | "directory";
  uri: string;                      // file path or dir path, project-relative
}

// ---- Nodes -------------------------------------------------------------------
/** A value that a containment edge OWNS. Pointers are edges, not nodes (see Value). */
export type Node = Mapping | Scalar | Blob;

export interface NodeBase {
  meta?: NodeMeta;                  // optional; diagnostics, format, source span
}

export interface Mapping extends NodeBase {
  kind: "mapping";
  entries: Entry[];                 // ORDERED; index = the integer position (derived key)
}

export interface Scalar extends NodeBase {
  kind: "scalar";
  value: string | number | boolean | null;
  raw: string;                      // verbatim source token (lossless round-trip)
}

/** Opaque/foreign bytes — a file in a directory that is not itself yamlover/json5p. */
export interface Blob extends NodeBase {
  kind: "blob";
  format: string;                   // inferred concrete/MIME, e.g. "image/png", "pdf"
  contentHash: string;             // sha256 of bytes; bytes live in the store, not the IR
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
  base: PointerBase;
  steps: Step[];                    // walked after the base, in order
  raw: string;                      // verbatim text after `*` (round-trip + diagnostics)
}

export type PointerBase =
  | { scope: "current" }                          // bare name/index: current mapping
  | { scope: "document" }                         // "/"  — current document root
  | { scope: "parent" }                           // ".." — parent node (then steps)
  | { scope: "link"; authority: string };         // [scheme]"//"authority — any OTHER start
                                                  // (project root, sibling doc, external; virtual id)

export type Step =
  | { sel: "key"; name: string }                  // /x  — string key
  | { sel: "index"; n: number }                   // [n] — integer key (position)
  | { sel: "parent" };                            // ..  — up one node

// ---- Metadata ----------------------------------------------------------------
export interface NodeMeta  { span?: Span; }
export interface EntryMeta { span?: Span; anchor?: string; } // anchor = `&name` on the value
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

### `&` anchors
An anchor declaration is recorded both in `Document.anchors` (name → the owned node) and on
the owning entry as `EntryMeta.anchor`. A `*name` referencing an anchor stays a `Pointer`
with `base:{scope:"current"}` — the **resolver** applies the precedence rule from
`URIs.md` ("declared anchor wins, else structural sibling"). Anchors are intra-document, so
the parser *can* pre-resolve them, but keeping it in the resolver means one code path for
all name resolution.

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

A walk of the IR populates `node` and `edge` (path = identity, no ids):

- Each `Node` → one `node(path, type=kind, format, content_hash, meta)` row. `path` is the
  containment path from the document/project root.
- Each `Entry` with `edge:"contain"` → `edge(parent, child, label=key‖position, kind="contain")`.
- Each `Entry` with `edge:"ref"`  → `edge(owner, resolved-target, label=key, kind="ref")`.
- Each `Entry` with `edge:"back"` → `edge(owner, resolved-target, label=key, kind="back")`.
- `kind:"derived"` edges (inverse of a `*`, transitive closures) are **never** in the IR;
  the engine computes them from the above on demand.

## Worked example (genealogy, the canonical graph fixture)

The old schema-storage form (`examples/63-genealogy-dag/.yamlover/schema.yaml`,
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
