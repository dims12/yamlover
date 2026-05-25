# yamlover

`yamlover` is a materialization "language", that supersedes `YAML` and `JSON` and
supports both file and filesystem storage of tree- and DAG-like data structeres.

**yamlover** stands for **YAML Overlay** — not "Yam lover". It means YAML layer
laid *over* the filesystem.

The project has the following goals

- define a way to store JSON-like data structures in a filesystem trees
- be able to validate directory content by JSON schema
- extend JSON schema for YAML and directories
- support not only trees, but also directed acyclic graphs (DAGs)
- support mind mapping storage
- support metadata and tagging software
- support control of LLM agents
- support reference management for scientific paper research
- define a way to navigate JSONs and YAMLs in cd/ls manner

> **Status:** design / specification. No implementation yet — this document
> describes the model.

## Isomorphisms briefly

### YAML vs JSON

YAML is a superset of JSON, denoting principally the same data structure

### directory vs YAML or JSON

Directory is a dictionary of BLOBs

### JSON schema vs JSON instance

A JSON Schema whose every leaf is `const:` *is* the JSON instance it validates —
so the schema can hold the data itself. See *[Schema ↔ instance
correspondence](#schema--instance-correspondence)*.

## Concrete representations

A node of the DAG, and the structure around it, can be rendered as any of the
following concrete representations. They are interchangeable: a tool may convert
freely between them without changing what the data means.

1. **file** — a regular filesystem file. Its content may be YAML, JSON, or
   binary — the `file/yaml`, `file/json`, and `file/binary` encodings (see *The
   schema, and where values live*).
2. **dir** — a regular filesystem directory *without* a `.yamlover/`
   subdirectory.
3. **yamlover** — a filesystem directory *with* a `.yamlover/` subdirectory,
   which contains the metadata describing this entity.
4. **yaml** — the interior of a YAML file, written in YAML syntax.
5. **json** — the interior of a JSON file, or the interior of a YAML file
   written in JSON syntax (YAML is a superset of JSON).
6. **yaml-schema/instantiate** · **json-schema/instantiate** — a value that is
   *instantiated from the schema itself*, pinned with `const:` (or built from
   `const:` leaves), rather than stored separately. The suffix before `-schema`
   names the schema's own encoding — yamlover's `.yamlover/schema.yaml` is YAML,
   so a value pinned there is `yaml-schema/instantiate`. This is the *[Schema ↔
   instance correspondence](#schema--instance-correspondence)* made concrete: a
   `const:`-only schema *is* its instance.
7. **file/yaml-schema/instantiate** · **file/json-schema/instantiate** — the same
   instantiation, but the schema lives in its own standalone file rather than
   inline in `.yamlover/`.

The first three live on the filesystem; representations 4–5 live *inside* a
document file; representations 6–7 live *inside a schema* — the value is the
single instance that schema admits. The `.yamlover/` subdirectory is what
promotes a plain **dir** into a **yamlover** node — it is the marker that makes a
directory "speak YAML".

## The core idea

There is one data model — a DAG whose nodes are mappings and scalars — with
several equivalent concrete representations. The two big families are the
**filesystem** view (representations 1–3) and the **document** view
(representations 4–5):

- **A node (mapping)** → a *yamlover* directory / a *YAML or JSON* file.
- **A child with a structured value** → a *subdirectory or file* / a nested key.
- **A child with a scalar value** → a file (typed by the schema), or a `const:`
  pinned in the schema / a scalar key.

These representations are **seamlessly equivalent**: a directory can be
*collapsed* into a single file, and a file can be *expanded* into a directory,
without changing what the data means. Because the model is a DAG and not merely
a tree, a node may also be reached from more than one place (shared children,
cross-references) — see *Open questions* below.

## Equivalence rules

1. **A directory is a YAML mapping.** Its children are the keys of that mapping.
2. **A file is equivalent to a subdirectory** — both represent the same node. A
   structured child may be stored either as `child.yaml` (collapsed) or as
   `child/` (expanded). Tools may convert freely between the two.
3. **The equivalence is described by a hidden `.yamlover/` directory.** Its
   presence is what turns a plain *dir* into a *yamlover* node — what makes
   a directory "speak YAML."
4. **`.yamlover/schema.yaml` is a JSON Schema, written in YAML, describing the
   node** that the containing directory represents. yamlover adds metadata about
   *physical layout* — how each child is stored (its `concrete`), its filesystem
   facts (`os`: path, size, mtime), ordering, links — grouped under an
   `x-yamlover` keyword (the standard vendor-extension convention). A schema
   may pin a value inline with `const:`, but need not: a value may instead live
   in its own file, with the matching schema entry giving its type and how to
   interpret it.
5. **Input is JSON or YAML; the canonical normal form is YAML.** Examples below
   are written in JSON for brevity, but `{...}` and its YAML equivalent are
   interchangeable on the way in and normalized to YAML.

## The schema, and where values live

`.yamlover/schema.yaml` is a **JSON Schema written in YAML** that describes the
node. yamlover extends standard JSON Schema with metadata about *physical layout*,
so the one file says both *what is valid* and *where the bytes are*.

A node's value can be supplied in either of two ways:

- **Pinned in the schema.** A scalar can be fixed directly with JSON Schema's
  `const:` — then no separate file is needed. (See `examples/07-scalar-in-schema`, whose
  whole schema is `const: 30`.)
- **Stored in a file.** The value lives in its own file, and the matching schema
  entry gives its type and how to interpret it. That entry carries an
  `x-yamlover.concrete` keyword naming the file's **encoding** — how to parse the
  bytes, applied before any JSON Schema `type`/`format`:

  - `file/yaml` — parse the file as YAML. Because YAML is a superset of JSON,
    JSON-style content is read here too. (See `examples/04-object-in-dir`,
    `08-scalar-file-overlay`, and `02-object-in-yaml`.)
  - `file/json` — parse the file as strict JSON.
  - `file/binary` — the file is raw bytes; the standard JSON Schema `format`
    keyword then gives their interpretation (e.g. `int32/le`, `image/png`). (See
    `examples/09-scalar-as-binary` and `examples/12-image-with-markup`.)

  By default the file is named after the key. **`x-yamlover.os`** records that
  file's filesystem facts — `path` (the name on disk, relative to the container),
  and optionally portable metadata like `size` (bytes) and `mtime` (ISO 8601,
  UTC). `os.path` overrides the default name, letting the schema *overlay* a file
  that already has some other name (see `examples/08-scalar-file-overlay` and
  `02-object-in-yaml`, which describe an existing `somefile.yaml`). Everything
  filesystem- or OS-specific lives under `os`, leaving the rest of `x-yamlover`
  portable.

**Structured values** (mappings and sequences) are materialized as named
subdirectories or sibling files, each its own node — or collapsed into a single
file via `concrete`/`os.path`, as `examples/02-object-in-yaml` does for a whole
mapping.

**Sequences** need an explicit order, since directory entries have none. The
schema's `prefixItems` list *is* that order: an element's position in the list is
its index, and its `x-yamlover.os.path` binds it to a file — whose name on disk
is therefore arbitrary. See `examples/10-array-of-files`, an array `["Alice", 42, true]`
whose elements live in files named `anyfile01`, `alsoany02`, and `andany03.json`.
Because the schema alone defines the sequence, a file the schema does not describe
is simply a schema violation — `10-array-of-files`'s `items: false` forbids a fourth
element. The bare filesystem has no order; yamlover supplies it.

So this document:

```json
{
  "name": "Alice",
  "age": 30,
  "address": { "city": "NYC", "zip": "10001" }
}
```

...maps to this filesystem layout (one of several equivalent forms):

```
person/
├── .yamlover/
│   └── schema.yaml        # properties:
│                          #   name: {type: string}
│                          #   age:  {type: integer}
├── name                   # Alice
├── age                    # 30
└── address/               # structured → its own yamlover node
    ├── .yamlover/
    │   └── schema.yaml    # properties:
    │                      #   city: {type: string}
    │                      #   zip:  {type: string}
    ├── city               # NYC
    └── zip                # 10001
```

`name` and `age` are scalars stored as plain files, with their schema entries
declaring the types; `address`, being structured, becomes its own yamlover
subdirectory. Equivalently, the scalars could be pinned in the schema with
`const:` (dropping the `name`/`age` files), or `address` could be collapsed into
a sibling `address.yaml`.

## Schema ↔ instance correspondence

yamlover rests on three equivalences. Two are introduced above — *YAML ↔ JSON*
(same data, two syntaxes) and *directory ↔ document* (same node, expanded on the
filesystem or collapsed into a file). The third is the one between a **JSON
Schema** and the **instance** it validates, and it is what lets the schema double
as a place to *store* data, not just describe it.

A JSON Schema normally constrains a whole *set* of instances. Pin every leaf with
`const:` and that set collapses to exactly one member — at which point the schema
and the instance are the same data wearing different hats. The `const:`-only
schema on the left admits only the instance on the right:

```yaml
# schema (.yamlover/schema.yaml)        # instance (the data it admits)
properties:                             name: Alice
  name:    {const: Alice}               age: 30
  age:     {const: 30}                  isAdmin: true
  isAdmin: {const: true}
```

The correspondence is **partial** — total in one direction only:

- **instance → schema** is always defined: any instance has a `const:`-only
  schema admitting it and nothing else (replace each value `v` with `{const:
  v}`). So *every* datum can be pushed into a schema.
- **schema → instance** is defined *only* for `const:`-only schemas. A schema
  with `type: integer`, a `minimum`, or any open `properties` describes many
  instances, so there is no single instance to collapse to.

This third equivalence is why the same object can be materialized **three** ways.
[`examples/04-object-in-dir`], [`examples/02-object-in-yaml`], and [`examples/01-object-in-schema`] draw that
triangle over one datum, `{name: Alice, age: 30, isAdmin: true}`:

| where the bytes live | form | example |
|----------------------|------|---------|
| one file per child | expanded **directory** | `examples/04-object-in-dir` |
| a single collapsed file | one **YAML/JSON file** | `examples/02-object-in-yaml` |
| the schema itself, via `const:` | the **schema** | `examples/01-object-in-schema` |

All three are the **yamlover** concrete representation; only the location of the
bytes differs. `examples/07-scalar-in-schema` (`const: 30`) is the same move for a bare
scalar — `01-object-in-schema` is its object-sized generalization.

Because a schema and its instance are two faces of one datum, **whatever one face
can express, the other must be able to express too** — and that includes
*references*. A YAML/JSON instance carries its own reference mechanism (YAML's
`&anchor` / `*alias`), while a JSON Schema carries a different one (`$anchor` /
`$ref` / `$defs`). Since yamlover treats schema and instance as equivalent, it
must honor **both** anchor systems and keep them consistent across concretes.
That pair of mechanisms is how the tree becomes a DAG (shared and
cross-referenced nodes); how each anchor is spelled in each concrete is specified
next.

[`examples/04-object-in-dir`]: examples/README.md#04-object-in-dir
[`examples/02-object-in-yaml`]: examples/README.md#02-object-in-yaml
[`examples/01-object-in-schema`]: examples/README.md#01-object-in-schema

## Schema-coordinate references: `$defs` and `$ref`

The first of the two anchor systems is the **schema-side** one — standard JSON
Schema `$defs` and `$ref`, resolved entirely in **schema coordinates**:

- **`$defs`** holds reusable schema fragments. It is a sibling of `properties`,
  not a property itself, so it never appears in the materialized data — it lives
  purely in schema space.
- **`$ref`** is a same-document **JSON Pointer** (`#/...`). It may target *any*
  location in the schema, not only `#/$defs/...` —
  `#/properties/markup/prefixItems/0` is just as valid. These are schema
  coordinates, never filesystem paths (which live under `x-yamlover.os`).
- Per JSON Schema 2020-12, a `$ref` may sit beside other keywords: the referenced
  fragment and the local keywords are **merged**, so a shared *shape* and locally
  inlined `const` values both apply.

`examples/13-defs-and-refs` mirrors `examples/12-image-with-markup`, but each
markup region is pulled in by `$ref` to a `$defs/rectangular-area` shape with its
coordinates inlined as `const` — and materializes to the very same value. The
*instance-side* anchor system (YAML's `&anchor` / `*alias`) is still to come; see
*Open questions*.

## Open questions

These were not yet settled and need a decision before this is a complete spec:

- **DAG edges / shared nodes.** What lifts this above a plain tree is that a node
  may be reached from more than one parent, and nodes may cross-reference each
  other. The chosen direction follows from *[Schema ↔ instance
  correspondence](#schema--instance-correspondence)*: because schema and instance
  are equivalent, yamlover carries **both** anchor systems. The schema-side one —
  JSON Schema `$ref` / `$defs` — is now in place (see *[Schema-coordinate
  references](#schema-coordinate-references-defs-and-ref)*). Still open: the
  instance-side `&anchor` / `*alias`, whether the two need to stay in sync across
  concretes, and whether a filesystem symlink is an additional equivalent form.