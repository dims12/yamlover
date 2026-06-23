# CONCRETES — the storage taxonomy

A **concrete** records *how and where* a node's value is physically stored. Every
materialized node carries exactly one. It is orthogonal to a node's **type**
(object/array/scalar/binary) and to its **format** (the renderer key, e.g.
`text/markdown`): a `string` node may be stored inline in a yaml document
(`yaml`), in its own file (`file/yaml`), or pinned in a schema — same type,
different concrete.

This is the **per-node** vocabulary. The document-level `SourceInfo.concrete`
(IR.md) is the narrower "what language was this whole file/stream parsed from"
tag. The canonical TypeScript definition lives in
`tools/server/src/concrete.ts`; this file is its prose.

## yamlover is not a YAML superset

yamlover is a **separate language**, close to YAML but not a strict superset of
it (see `YAMLOVER.md`). It can switch to **json5p** mid-stream; it can **never**
switch to pure yaml. Likewise `yaml` can switch to `json` (JSON is a subset of
YAML). After a switch, descendants take the switched language.

## The vocabulary

### Inlined — a portion of a text file, in a given language

The value lives *inside* an enclosing document, written in one of these
languages. Descendants inherit the language unless the syntax switches.

| concrete  | meaning |
|-----------|---------|
| `json`    | a value inside a JSON document |
| `json5`   | a value inside a JSON5 document |
| `json5p`  | a value inside a json5p document (JSON5 + pointers) |
| `yaml`    | a value inside a YAML document |
| `yamlover`| a value inside a yamlover document |

Switches: `yaml → json`, `yamlover → json5p`.

### Files — a whole text file of a given language

The node *is* a file in the outer block. Its interior nodes are usually the same
language **without** the `file/` prefix (the inlined forms above).

| concrete       | meaning |
|----------------|---------|
| `file/json`    | a whole `.json` file |
| `file/json5`   | a whole `.json5` file |
| `file/json5p`  | a whole `.json5p` file |
| `file/yaml`    | a whole `.yaml`/`.yml` file |
| `file/yamlover`| a whole `.yamlover` file |

A non-data **text material** (markdown, asciidoc, csv, plantuml, …) is modeled as
a `file/yaml` scalar: its single value is the raw text, kept verbatim and rendered
by its `format`. The `format` chip (e.g. `text/markdown`) carries the real
material type; the concrete only records "a text file holding one scalar".

### Binary file

| concrete      | meaning |
|---------------|---------|
| `file/binary` | opaque bytes — an image, a pdf, a djvu, an unknown/large blob. Read lazily, never parsed as yamlover data. |

### Directories

| concrete       | meaning |
|----------------|---------|
| `dir`          | a plain OS directory: filenames are keys, entries are blobs or nested documents. May host yamlover-concrete entries. |
| `dir/yamlover` | a directory carrying a `.yamlover/` marker (`.yamlover/schema.yaml` etc.); the directory itself *is* a yamlover node and its described children resolve from the overlay. |

### Multi-document — RESERVED (Phase 2c)

One file holding several `---`-separated documents; each document is an element
of the singular concrete (`multi-yaml` ⇒ elements are `yaml`).

| concrete         | meaning |
|------------------|---------|
| `multi-yaml`     | a multi-document YAML stream |
| `multi-yamlover` | a multi-document yamlover stream |

> **Not yet implemented.** The parser rejects `---`/`...` document streams
> (Phase 2c). These concretes are defined and reserved, but no node carries one
> today.

## Schema-pinned values

A value defined directly in a `.yamlover/schema.yaml` overlay (via `const`, or
built from `const` leaves, or otherwise instantiated from the schema) lives in
that YAML file, so its concrete is the inlined `yaml` of the schema document.

## Where it shows up

- The server (`tools/server/src/server/yamlover.ts`) assigns a concrete onto
  every `YNode` during materialization and forwards it on `/api/json` and
  `/api/tree`.
- The web UI shows it as a dim chip in the node header (`NodeView`), and uses it
  for folder icons (`dir` / `dir/yamlover`) and to offer the json5p data view
  (json-family concretes only).
- Predicates (`isFileConcrete`, `isDirConcrete`, `isJsonFamily`, `interiorOf`, …)
  are exported from `tools/server/src/concrete.ts`.
