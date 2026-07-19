# META — the yamlover metadata schema

yamlover keeps a **schema** — but repurposed. It is a **JSON-Schema-equivalent for
YAML/yamlover**: the same/close vocabulary (`properties`, `type`, `format`, `prefixItems`,
`items`, …), itself written **in yamlover**, but its **primary purpose is metadata**
(typing, decoding, and presentation), with **validation as a secondary, optional use**.

This is the thing we did *not* drop. What we dropped is **schema-as-storage** — pinning
data with `const:` so the schema *is* the instance (the old `.yamlover/schema.yaml` model).
Data now lives in the instance (files and/or `body.yamlover`); the schema only *describes*
it. Companion specs: `URIs.md` (pointers), `QUERY.md` (queries), `IR.md` (instance
graph), `YAMLOVER.md` / `JSON5P.md` (surfaces), `CHAPTER.md` / `MARKLOWER.md` /
`MARKLOWER.md` (the document model, its default prose format `text/marklower`, and its
table node).

## Where it lives — the `.yamlover/` contract

A directory's `.yamlover/` holds up to two complementary overlays, plus engine state:

```
.yamlover/
  body.yamlover     — the INSTANCE overlay (data values added over the directory)
  meta.yamlover     — the METADATA schema (types, formats, concrete, presentation)
  settings.yamlover — PROJECT CONFIGURATION (root .yamlover/ only; §Settings below)
  index.db          — engine cache / index (derived; see ENGINE.md)
```

Both are keyed by node path, but with different shapes:

- **`body.yamlover`** mirrors the instance directly (`name: Alice`).
- **`meta.yamlover`** nests under JSON-Schema keywords (`properties:`, `prefixItems:`),
  so the engine maps a **meta-path → instance-path** (`properties/age` annotates the
  instance node `age`).

Either overlay is optional: a plain directory has neither; `50-object-in-overlay` has only
`body.yamlover`; `55-scalar-as-binary` has only `meta.yamlover` (the data is the on-disk
file, the meta says how to read it).

## Two ways to attach a schema

1. **Directory overlay** — `.yamlover/meta.yamlover` (above), keyed by node path.
2. **Inline tag** (yamlover files) — the **`!!<…>`** tag attaches a schema to a node, no
   overlay needed. Its contents are **themselves yamlover**, so they are either a **pointer**
   to a hosted schema (`!!<*yamlover/$defs/chapter>`) or an **inline schema literal**
   (`!!<format: text/x-plantuml>` — a one-line yamlover/meta document). The latter means a
   one-off chunk format needs no named `$defs` entry. See `YAMLOVER.md`; in the IR it is
   `NodeMeta.schema`, a `Value` (Pointer *or* Node), unresolved. json5p has no tags → overlay only.

## Hosted schemas (`$defs`) — `chapter`, `chunk` & `table`

The yamlover project (URI `::: yamlover.inthemoon.net`, SEPARATOR.md §2) hosts reusable
schema definitions at its project root, under **`$defs/`** — a project's tree IS its URI's
tree (layout restructured 2026-06-13; previously a `yamlover/` wrapper dir). The engine
grafts the **self-import key `yamlover`** → {`$defs`, `tags`} into every served root —
including the yamlover project itself, where `//X` ≡ `//yamlover/X` — so
`!!<*yamlover/$defs/chapter>` tag pointers resolve from any project. The taxonomy ships
as package data, so even a detached tree resolves it (the self-import is bundled — see
IMPORTS.md §4):

- **`$defs/chunk`** — one renderable content block: a typed value whose `(type, format)`
  selects the renderer; default `string`/`text/marklower` (prose), overridable per chunk;
  `type: [string, binary]` so an image/pdf/… pointer chunk fits too.
- **`$defs/chapter`** — a document node, a **fully omni (`variant`)** shape: the node's scalar
  **self-value is the title** (declared as the `value:` facet — no `title:` key), an optional
  keyed `description`, then a **positional body** whose elements are each a nested
  chapter (the recursion), an explicitly tagged table, or a chunk — one interleaved stream,
  read top to bottom (no `chunks`/`children` arrays). The body element type is a **union**,
  `items: {anyOf: [*chapter, *table, *chunk]}`. Inter-schema references use `*` pointers, not
  `$ref`. Full model: **`CHAPTER.md`**.
- **`$defs/table`** — a grid node, also omni: keyless entries are the **rows** (each an array
  of cells), a row keyed `header` is the header, optional `title` the caption; cells are
  marklower chunks or nested tables, and merged cells are `*` pointers with **relative
  indexes** (`*[.-1]` colspan, `*..[.-1][.]` rowspan — URIs.md §Relative indexes). Derives
  `format: x-yamlover-table`. Full model: **`MARKLOWER.md`**.

This **replaces the old chapter encoding** (title/description + two keyed arrays `chunks` and
`children`): a `chapter` is now a fully omni node — the self-value title, a keyed `description`,
and a positional `anyOf[chapter, chunk]` body — attachable inline (`60-simple-chapter.yamlover`)
or via a directory overlay. **`$defs/task`** (TICKETS.md) EXTENDS it with `allOf: [*chapter]` — the
(provisional) JSON-Schema mechanism for "a task IS-A chapter plus planning fields".

## Settings — project configuration (`settings.yamlover`)

The served **root**'s `.yamlover/` may also hold `settings.yamlover` — the **project
configuration** (added 2026-06-10). It is yamlover like everything else, read by the engine
at startup; a missing file means all defaults.

The governing rule: **settings are defaults, never constraints.** A graph node is identified
by what it *is* (its schema), not by where it sits — so the project maintainer may move, say,
an annotation into any directory and it keeps working (it is found through its edges). A
setting only tells the server where to *create* things when the user doesn't say.

Current vocabulary:

```yamlover
# .yamlover/settings.yamlover (served root)
annotations:
  location: /annotations   # project path where NEW annotations are created (the default)
```

Planned: when nodes become freely movable (`ENGINE.md` `mv`), the last location a node of a
kind was moved to is remembered (here) and becomes the creation default for that kind.

## Why metadata-first (not validation-first)

The metadata is what the system *acts on*:

- **Decoding** — a leaf's `type`/`format` says how to turn bytes into a value: `type:
  binary` + `format: int32/le` decodes a 4-byte file; `format: image/png` marks an image.
  `format` also names a **sub-document encoding** — how to parse a file's text into a node:
  `yamlover` / `yaml` / `json` / `json5p` for an instance, and a `…/meta` variant for a
  **schema** doc (`yamlover/meta`, like `json/schema`). E.g. `$defs/.yamlover/meta.yamlover`
  declares its `chapter`/`chunk` entries `{type: string, format: yamlover/meta}`, so those
  extensionless files parse as yamlover schema docs (their keys must match the
  `*yamlover/$defs/chapter` pointer; the dot is just a character — extensions are *allowed* in
  keys, they just aren't required).
- **Format resolution order:** (1) the meta `format:` if present; else (2) a **recognized file
  extension** (a known set — `.png`→`image/png`, `.yaml`→`yaml`, `.yamlover`→`yamlover`, …);
  else (3) no meta **and** no extension → **`binary`** by default. (`$defs` schema files drop
  the `.yamlover` extension to keep pointer paths short, and declare `format` in meta instead.)
- **Rendering** — the web viewer's renderer registry keys on the `(type, format)` tuple
  (see `tools/server`); `format: text/markdown`, `x-yamlover-chapter`, etc. select a view.
- **Presentation** — `title`, `description` annotate a node without living in its data.

Validation (does the instance conform?) uses the *same* document and may run later, but it
is not the reason the schema exists.

## Vocabulary (close to JSON Schema)

Reused as-is: `properties`, `prefixItems`, `items`, `type`, `format`, `title`,
`description`, `const` (still allowed, e.g. to fix a value), `minimum`/`maximum`/… (for
the optional validation use).

yamlover specifics:

- **`type`** adds **`binary`** (a blob), **`mixed`**, and **`variant`** to the JSON types
  (`object`/`array`/`string`/`integer`/`number`/`boolean`/`null`). One ordered container:
  `object`/`array` are the same model, distinguished only for projection (see `IR.md`).
  - **`mixed`** — the schema name for the **`!!mix`** shape: one ordered container whose
    entries are **both** keyless/positional (array-like) and keyed/named (object-like). It
    is the union of `object` and `array` (cf. the YAML-tag/JSON-Schema pairs `!!seq`/`array`,
    `!!map`/`object`).
  - **`variant`** — the schema name for the **`!!var`** shape: a node that carries a scalar
    (or `binary`) **self-value** *and* fields (positional and/or keyed) at once. The self-value
    is given as `value:` (alongside `properties:`), the most general node shape.
- **`format`** is open: a MIME type (`image/png`, `application/pdf`, `text/markdown`), a
  codec (`int32/le`), or a yamlover-defined view (`x-yamlover-chapter`).
- **`uniqueItems: true`** marks a container as a **set** — membership is by identity, so
  duplicate memberships (forward+forward, forward+`~-` reverse, reverse+reverse) collapse
  to one (`URIs.md` §`~-`). In yamlover files the inline spelling is the **`!!set`** tag;
  this keyword is the route for json5p and directory overlays, which have no tags.
- **`concrete`** (how/where stored: `file/binary` · `file/yaml` · `file/json` · `dir` ·
  `dir/yamlover` · …; full taxonomy in `CONCRETES.md`) is **inferable from the
  filesystem** — state it only when ambiguous. Keep meta minimal.
- **References use `*` pointers, not `$ref`.** Reusable fragments go under a `$defs` (or
  `$defs`) key and are referenced with a normal pointer — `*/$defs/box` (document root) —
  so there is **one** reference mechanism across yamlover (`URIs.md`), not a second
  JSON-Pointer dialect.
- **Combinators** (`anyOf`, `oneOf`, `allOf`, `not`, `type: [ … ]`) are kept from JSON Schema
  (TYPES.md §7): union/intersection/negation of subschemas. Two current uses worth naming:
  `items: {anyOf: [*chapter, *chunk]}` gives a container a **heterogeneous positional body**
  (CHAPTER.md), and `allOf: [*chapter]` is the (provisional) way to say a schema **extends**
  another (`$defs/task` IS-A `$defs/chapter`, TICKETS.md). The engine's schema propagation
  understands both.

### Describing an omni node's entries — `properties` + `items` today, `elements` (proposed)

An **omni** node (`variant`/`mixed`) has ONE ordered entry stream where an entry may be *keyed
or unkeyed* — and, in the general model, even both (a key **and** an ordinal index). JSON Schema
splits this into `properties`/`additionalProperties` (the **keyed** facet) and
`prefixItems`/`items` (the **ordinal**, keyless facet), so no single keyword describes the omni
stream. **For now the schemas use that JSON-Schema encoding** — e.g. a chapter is `value:` (the
self-value title) + `properties:` (description) alongside `items:` (the body). **Proposed**
(provisional — "we'll see", not
yet adopted): a native pair **`elements` / `additionalElements`** — the ordinal analogue of
`properties`/`additionalProperties` — that describes the ordered entry stream regardless of
whether each element carries a key. Under it a chapter's body reads naturally as
`additionalElements: {anyOf: [chapter, chunk]}`. Not used in any schema or the engine this pass.

## Built-in schemas: tags and annotations

The repo hosts two schemas the server acts on (and a built-in instance tree):

- **`$defs/tag`** — a node in a tag taxonomy (`type: variant`): its description is its **BODY**
  (the node's own scalar value — `name: <text>` with the sub-tags in the deeper block; no
  `!!var` needed, YAMLOVER.md §4), an optional explicit **`color`** (`"#rrggbb"` — a *pure
  color tag*; absent ⇒ the UI derives a stable hue from the tag's name), and every other key a
  sub-tag (`additionalProperties` recurses). Applied to a target via an **annotation** entry
  (see `ANNOTATIONS.md`).
- **`$defs/annotation`** — **one tag application** (`type: variant`; the model in
  `ANNOTATIONS.md`, which supersedes the old separate-node/`target`-pointer form): an element
  of the target's **`yamlover-annotations`** sequence — either a bare **tag pointer**
  (`- *::tags:…`) or an object carrying **`tag:`** plus parameters (e.g. `description`).
  Region selection lives in **`$defs/fragment`** (`yamlover-fragments`): the selector (text
  quote / rect / page-rect / map box) plus an optional sidecar image crop; an annotation
  targets the whole node or one fragment. Display color always comes from the applied tag.
  Two tags on the same region = two annotations.
- **`tags/colors`** (reachable everywhere as `//yamlover/tags/colors`) — the built-in pure
  color tags (the annotation palette), living at the yamlover project root beside `$defs/`
  and grafted into every served root via the `yamlover` self-import key.

## Examples

`55-scalar-as-binary` — the on-disk file `age` is the instance; meta decodes it:

```yamlover
# .yamlover/meta.yamlover
properties:
  age:
    type: binary
    # format: int32/le      # how to decode the bytes
    # concrete: file/binary  # inferable from the FS — omit unless ambiguous
```

An array whose elements live in files (cf. `56-array-of-files`) — `prefixItems` gives the
per-element type/format/order; the values are the files:

```yamlover
# .yamlover/meta.yamlover
prefixItems:
  - { type: string,  concrete: file/yaml }
  - { type: integer, concrete: file/yaml }
  - { type: boolean, concrete: file/json }
```

## Status

Decided 2026-06-07 (replaces the earlier "schema deferred / instance-only" framing — schema
was never about storage; this is its real role). The precise **overlay-merge precedence**
(directory ∪ `body.yamlover`, and how `meta.yamlover` attaches) is the Phase 1c spec
(`PLAN.md`); `<<:` (YAML-1.1 merge key, extended to `<<: *pointer`) is the explicit
mapping-merge tool. The validation semantics are a later, optional pass.

**Provisional:** the exact *authoring* shape of the meta schema — keyword set, how reuse /
definitions / cross-refs work (the old `$defs`/`$ref`; here leaning toward `*` pointers) —
is still being designed and may change. The `62-defs-and-refs` example (the old
`$defs`/`$ref` demo) was dropped pending that rethink.
