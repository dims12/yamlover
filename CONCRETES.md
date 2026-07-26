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

## Representation — the `yaml/…` styles

The concretes above answer *where / what language* a node is stored in. Every node has a
second, orthogonal concrete axis: *how it is written*. A **container** picks a
[collection style](#collection-style-flow-vs-block); a **scalar** picks a token style. YAML (and so
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

### Collection style (flow vs block)

A container is written on ONE line (flow) or over many (block) — YAML's two collection
styles, Ch. 7 and Ch. 8. JSON is valid YAML, so a JSON-looking value inside a `.yamlover`
file is simply a flow container; the LANGUAGE is still yamlover (no `json5p` switch).

| concrete     | YAML term | example              |
|--------------|-----------|----------------------|
| `yaml/flow`  | flow      | `b: [12, 13, 14]`    |
| `yaml/block` | block     | `b:` then `  - 12` … |

Block is the default and carries no marker. Flow is recorded by the parser
(`NodeMeta.style`, IR.md) and re-emitted by the serializer, so an authored `{x: 1, y: 2}`
comes back as `{x: 1, y: 2}` instead of being flattened to block form. A json-family
document (`json`/`json5`/`json5p`) is flow END TO END by language, so its nodes need no
per-node marker — `collectionRepr` derives it from the concrete.

Formatting is NORMALIZED, not preserved byte-for-byte: `[1,2]` and `[ 1, 2 ]` are both
`yaml/flow` and both re-emit as `[1, 2]`. The concrete is the classification, not the bytes.

Flow cannot hold everything. A container carrying a path anchor, a `!!<…>` tag, a `!!set`,
a `~` back-edge, a leading comment, a multi-line scalar, a blob, or a keyed+keyless mixture
**falls back to block form** — silently and losslessly, never a throw and never a drop.
The refusal list lives once, in the serializer's `flowTextOrNull`, and the projectional
editor's `flowFits` mirrors it so the screen and the file agree.

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

> **Status.** The vocabulary and the classifier are IMPLEMENTED — `tools/server/src/repr.ts`,
> a pure module beside `concrete.ts`. Every node is classified (`classifyScalar` from the
> authored `Scalar.raw`, `collectionRepr` from `NodeMeta.style` + the language) and the result
> rides `/api/json`'s comment sidecar as `repr`, carried only when it is NOT the default for
> the value — so an ordinary `Rex`/`42`/block mapping costs nothing on the wire. `yaml/flow`
> round-trips end to end (parser → serializer → index → wire → editor).
>
> Still open: a **style-picker** UI, and **schema/meta pinning** ("this id is hex", "this note
> is a literal block"). Note that `yaml/oct`, `yaml/bin` and `yaml/bool11` are vocabulary the
> core reader does not yet decode — it follows the YAML 1.2 CORE schema, where `0o377`,
> `0b1111` and `yes` are ordinary strings; `repr.ts` classifies them the moment a reader does.

## Schema-pinned values

A value defined directly in a `.yamlover/schema.yaml` overlay (via `const`, or
built from `const` leaves, or otherwise instantiated from the schema) lives in
that YAML file, so its concrete is the inlined `yaml` of the schema document.

## Inheritance rules — `concrete-rules.ts`

ALL composition rules — which concretes a new child MAY take, which one it takes by
DEFAULT, and which language its content MUST speak — live in the single pure module
`tools/server/src/concrete-rules.ts`, shared by client and server:

- **Default (inheritance)**: an unspecified concrete inherits the storage family —
  a directory-concrete parent keeps its children directory-concrete (`dir/yamlover`;
  a subchapter of a dir chapter becomes a subdirectory member, the ex-66 shape);
  everything else stays inline in the parent's source. An explicit `concrete:`
  always wins.
- **Obligatory (language lock)**: content inside a file document speaks that file's
  language — the interior of a `.json5p` cannot switch to yaml; an existing node
  never changes concrete through an edit (a conversion is a move).
- **Member encoding** (the server-side face of the same inheritance, for edits that
  name no concrete):
  - a **keyed container** child → a nested real directory named by the key, recursively;
  - an **untagged ordinal container** child → a real directory under an order-numbered
    generated name (`item01`, `item02`, …) plus a `- *: itemNN` pointer-array element in
    the parent's `body.yamlover` granting its position — the `examples/56-array-of-files`
    shape. A *tagged* ordinal container (a table, a typographical list) is content and
    stays inline;
  - everything else (scalars, flow one-liners) → the parent's `body.yamlover` overlay.

**Birth order does not matter — the derivation is re-evaluated on the scalar→container
transition, not only at a child's birth.** A node built the incremental way (a `world: World`
title typed first, its children added after) is born a scalar → the body overlay; the
moment it gains CONTAINER content — the omni first-child commit *emplaces* the whole node
(self + child), or a child is *inserted* under the still-scalar member — it lifts OUT of the
enclosing body into its own real member, and its old inline line is spliced away
(`deriveMemberEncoding`'s promotion, `engine-api.ts`; gated by `subchapterMaterializes` so it
only fires when the enclosing document is directory-backed). So `world: World`-then-grow lands
in the SAME directory shape as a `world` born already populated — no birth-order asymmetry. A
pure scalar emplace (a title edit, no entries) is not a transition and stays inline; an
inline-tagged member is left inline (its `!!<…>` schema is not yet carried across the move).

**The promotion asks `deriveMemberEncoding` for the member's SHAPE, exactly as a birth does** —
so both halves of the vocabulary are covered. A KEYED node becomes a directory named by its key
and its inline line is removed. An untagged ORDINAL element becomes a sequentially-named member
(`item01`) and *keeps its position*: its inline line is replaced by the `- *: itemNN` pointer
that grants it. A *tagged* ordinal container is content and stays inline, at growth as at birth.
This is why a list nested by typing (`- World`, then `- Eurasia` under it, then `- Europe`) puts
each level in its own directory instead of accumulating in one body file.

Both surfaces read the enclosing body WITH the current batch's pending ops folded in, and resolve
the enclosing document filesystem-first — a member born a moment ago in the same batch (fast
typing) is invisible to the still-stale index, and neither its body nor its concrete may be read
from there.

**Generated member names carry ORDER NUMBERS** (`nextMemberName`, concrete-rules.ts) so a
plain directory listing sorts roughly in body order — item members as `item01`, `item02`,
title-born subchapters as `01-Введение`, `02-Обзор`. The numbers are COSMETIC: order is the
body pointer-array's data, never the filesystem's, and an existing member is **never
renamed** — an insert between neighbors slots a *sub-number* instead (`item01` … `item01-1`
… `item02`; `01-A` … `01-1-C` … `02-B`; an insert before `01` degrades to `00`). Uniqueness
is guaranteed in-scheme (the key deepens), so a collision suffix never appears.

Removing the positional element splices only the pointer line; the item directory is
orphaned (never destroyed) and resurfaces as a keyed-only member.

## Layout invariants — `validate.ts`

The rules above say where a value SHOULD live. `tools/server/src/validate.ts` — a pure module
beside `concrete-rules.ts` — asserts that a write actually PUT it there. It restates no policy:
each rule re-asks `deriveMemberEncoding` / `requiredChildLanguage` / `dataFileConcrete` /
`nextMemberName`'s naming scheme and only checks that the plan obeyed the answer.

These hold with **no schema at all**, so they protect a directory from the first keystroke.

| code | invariant |
| --- | --- |
| `layout/nested-overlay` | a `.yamlover/` never sits inside another `.yamlover/` |
| `layout/reserved-overlay-name` | a `.yamlover/` holds only `body`/`meta`/`settings.yamlover`, `index.db`, and the `fragments`/`thumbnails` sidecar dirs |
| `layout/escapes-root` | a written path stays inside the served root |
| `layout/unsafe-member-name` | a member name is non-empty, unpadded, not hidden, and carries no path metacharacter |
| `layout/inline-collection` | a child that derived to `dir`/`dir-seq` is written as a REAL directory, never spliced into the parent's body |
| `layout/duplicate-member` | a keyed member's key does not already name a child (the key names the node — there is no rename to fall back on) |
| `layout/language-switch` | content spliced into a file document speaks that document's language |
| `layout/off-scheme-name` | *(warning)* a generated member carries its family's order key |
| `layout/orphan-overlay` | every `.yamlover/` has a directory to mark and holds at least one format file |
| `layout/concrete-mismatch` | the concrete agrees with the shape backing it (`dir/yamlover` owns its marker, a plain `dir` does not, a `file/<lang>` matches its extension) |

Enforcement is at the WRITE chokepoints, before any bytes land: `writeInside` and `mkdirInside`
gate every file and directory this server creates, and the directory-target route in `applyEdits`
runs the encoding rules once the routing decision is made. Dev and test **throw** (corruption
turns the suite red); production **refuses** the write and logs. `YAMLOVER_VALIDATE` overrides
(`throw` | `refuse` | `report` | `off`).

`GET /api/doctor` sweeps a whole served tree after the fact — a FILESYSTEM walk, not an index
walk, because the walker skips what it does not understand and so cannot see a buried overlay.
Every `examples/` fixture is asserted clean by `test/validate-doctor.test.ts`, which is what keeps
a new rule from becoming over-eager.

The `value/*` codes and `compileMeta()` in the same module are the seam for `meta.yamlover`
schema validation (META.md); today `compileMeta` returns `[]`.

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
