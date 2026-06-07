# META — the yamlover metadata schema

yamlover keeps a **schema** — but repurposed. It is a **JSON-Schema-equivalent for
YAML/yamlover**: the same/close vocabulary (`properties`, `type`, `format`, `prefixItems`,
`items`, …), itself written **in yamlover**, but its **primary purpose is metadata**
(typing, decoding, and presentation), with **validation as a secondary, optional use**.

This is the thing we did *not* drop. What we dropped is **schema-as-storage** — pinning
data with `const:` so the schema *is* the instance (the old `.yamlover/schema.yaml` model).
Data now lives in the instance (files and/or `body.yamlover`); the schema only *describes*
it. Companion specs: `URIs.md` (pointers), `IR.md` (instance graph), `YAMLOVER.md` /
`JSON5P.md` (surfaces).

## Where it lives — the `.yamlover/` contract

A directory's `.yamlover/` holds up to two complementary overlays, plus engine state:

```
.yamlover/
  body.yamlover   — the INSTANCE overlay (data values added over the directory)
  meta.yamlover   — the METADATA schema (types, formats, concrete, presentation)
  …               — engine cache / index (later; see ENGINE.md)
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

## Hosted schemas (`$defs`) — `chapter` & `chunk`

The yamlover project hosts reusable schema definitions under **`$defs`** (in the repo:
`$defs/`):

- **`$defs/chunk`** — one renderable content block: a typed value whose `(type, format)`
  selects the renderer; default `string`/`text/markdown` (prose), overridable per chunk.
- **`$defs/chapter`** — a document node: `title`, `chunks` (a sequence of `chunk`s — the
  body, read top to bottom) and `children` (a sequence of `chapter`s — the recursion).
  Inter-schema references use `*` pointers (`items: *yamlover/$defs/chunk`), not `$ref`.

This **replaces the old chapter encoding** (title from the schema concrete, chunks from the
instance): a `chapter` is now a normal schema with `title`/`chunks`/`children`, attachable
inline (`60-simple-chapter.yamlover`) or via a directory overlay.

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

- **`type`** adds **`binary`** (a blob) to the JSON types (`object`/`array`/`string`/
  `integer`/`number`/`boolean`/`null`). One ordered container: `object`/`array` are the
  same model, distinguished only for projection (see `IR.md`).
- **`format`** is open: a MIME type (`image/png`, `application/pdf`, `text/markdown`), a
  codec (`int32/le`), or a yamlover-defined view (`x-yamlover-chapter`).
- **`concrete`** (how/where stored: `file/binary` · `file/yaml` · `file/json` · `dir` · …)
  is **inferable from the filesystem** — state it only when ambiguous. Keep meta minimal.
- **References use `*` pointers, not `$ref`.** Reusable fragments go under a `$defs` (or
  `$defs`) key and are referenced with a normal pointer — `*/$defs/box` (document root) —
  so there is **one** reference mechanism across yamlover (`URIs.md`), not a second
  JSON-Pointer dialect.

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
