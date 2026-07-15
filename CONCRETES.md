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


| concrete   | meaning                                             |
|------------|-----------------------------------------------------|
| `json`     | a value inside a JSON document                      |
| `json5`    | a value inside a JSON5 document                     |
| `json5p`   | a value inside a json5p document (JSON5 + pointers) |
| `yaml`     | a value inside a YAML document                      |
| `yamlover` | a value inside a yamlover document                  |

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

## Scalar representation — the `yaml/…` styles

The concretes above answer *where / what language* a node is stored in. A **scalar**
node has a second, orthogonal concrete axis: *how its token is written*. YAML (and so
yamlover / json5p, which share the scalar syntax) allows one value to be spelled many
ways — `~`, `null` and an empty node are all null; `255`, `0xff` and `0o377` are all the
same integer; a string may be plain, quoted, or a block. These are **not different
values** — they decode identically — but they are different *representations*, and the
representation is worth keeping: it is what makes a string `"~"` distinguishable from a
null `~` on screen, and it is what a schema may want to pin (“this id is hex”, “this note
is a literal block”).

Because the scalar grammar is shared, the representation lives in a common **`yaml/…`**
namespace (not `yamlover/…`), independent of the container concrete a node also carries.
The exact source bytes are already preserved losslessly in the IR (`Scalar.raw`,
IR.md §Node); the `yaml/…` concrete is the *classification* of that raw token — the label a
renderer, schema, or style-picker reasons about.

The vocabulary is drawn from the YAML 1.2 spec (scalar **styles**, Ch. 7–8) and its core /
type-repository **content notations** (Ch. 10):

### String styles (how a string is delimited / laid out)

| concrete       | YAML term          | example                               |
|----------------|--------------------|---------------------------------------|
| `yaml/plain`   | plain (unquoted)   | `name: Rex`                           |
| `yaml/single`  | single-quoted      | `name: 'Rex'`                         |
| `yaml/double`  | double-quoted      | `name: "a\tb"`                        |
| `yaml/literal` | literal block `\|` | `note: \|` (newlines preserved)       |
| `yaml/folded`  | folded block `>`   | `note: >` (newlines folded to spaces) |

Block scalars carry two further modifiers from the spec, kept as sub-qualifiers of the
literal/folded concrete (they do not change the value, only trailing whitespace / layout):

- **chomping** (§8.1.1.2): *clip* (default), *strip* `-` (`\|-`/`>-`), *keep* `+` (`\|+`/`>+`);
- **indentation indicator** (§8.1.1.1): an explicit block indent, e.g. `\|2`.

### Null notations

| concrete     | form   | note                                     |
|--------------|--------|------------------------------------------|
| `yaml/tilde` | `~`    | the sigil form (the user's `yaml/tilda`) |
| `yaml/null`  | `null` | the word (also `Null`/`NULL` casings)    |
| `yaml/empty` |        | an empty node (`key:` with no value)     |

### Boolean notations

| concrete      | form                  | note                                |
|---------------|-----------------------|-------------------------------------|
| `yaml/bool`   | `true` / `false`      | core schema; casings `True`/`TRUE`… |
| `yaml/bool11` | `yes`/`no`/`on`/`off` | YAML 1.1 only — NOT core, opt-in    |

### Integer notations (all the same value, different base)

| concrete   | YAML term    | example                    |
|------------|--------------|----------------------------|
| `yaml/dec` | decimal      | `255`                      |
| `yaml/hex` | hexadecimal  | `0xff`                     |
| `yaml/oct` | octal        | `0o377` (YAML 1.1: `0377`) |
| `yaml/bin` | binary (1.1) | `0b11111111`               |

### Float notations

| concrete     | YAML term                | example          |
|--------------|--------------------------|------------------|
| `yaml/float` | fixed                    | `3.14`           |
| `yaml/exp`   | exponential / scientific | `6.022e23`       |
| `yaml/inf`   | infinity                 | `.inf` / `-.inf` |
| `yaml/nan`   | not-a-number             | `.nan`           |

A scalar's representation concrete is drawn from the sub-vocabulary of its **value type**:
a string picks a *style*, a null/int/float/bool picks a *notation*. (Sign, leading zeros,
and YAML 1.1 digit-separator `_` are finer still — recorded in `raw`, not yet given their
own concrete.)

> **Status.** Spec / terminology only. The IR already preserves `raw`; giving each scalar a
> `yaml/…` representation concrete (surfaced on `/api/json`, rendered faithfully, editable
> via a style-picker, and constrainable by schema/meta) is the next step. Fixes the "string
> `"~"` renders like null" ambiguity by rendering the classified representation, not a
> re-derived canonical one.

## Schema-pinned values

A value defined directly in a `.yamlover/schema.yaml` overlay (via `const`, or
built from `const` leaves, or otherwise instantiated from the schema) lives in
that YAML file, so its concrete is the inlined `yaml` of the schema document.

## Where it shows up

- The server (`concreteOf` in `tools/server/src/server/engine-api.ts`) derives
  a concrete for every node it serves — from a stat plus the enclosing
  document's language (the engine tracks no per-node concrete yet) — and
  forwards it on `/api/json` and `/api/tree`.
- The web UI shows it as a dim chip in the node header (`NodeView`), and uses it
  for folder icons (`dir` / `dir/yamlover`) and to offer the json5p data view
  (json-family concretes only).
- Predicates (`isFileConcrete`, `isDirConcrete`, `isJsonFamily`, `interiorOf`, …)
  are exported from `tools/server/src/concrete.ts`.
