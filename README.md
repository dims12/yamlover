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

The first three live on the filesystem; the last two live *inside* a file. The
`.yamlover/` subdirectory is what promotes a plain **dir** into a
**yamlover** node — it is the marker that makes a directory "speak YAML".

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
   *physical layout* — how each child is stored (its `concrete`), ordering, links —
   grouped under an `x-yamlover` keyword (the standard vendor-extension
   convention). A schema
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
  `const:` — then no separate file is needed. (See `examples/entity02`, whose
  whole schema is `const: 30`.)
- **Stored in a file.** The value lives in its own file, and the matching schema
  entry gives its type and how to interpret it. That entry carries an
  `x-yamlover.concrete` keyword naming the file's **encoding** — how to parse the
  bytes, applied before any JSON Schema `type`/`format`:

  - `file/yaml` — parse the file as YAML. Because YAML is a superset of JSON,
    JSON-style content is read here too. (See `examples/entity05`–`entity07`.)
  - `file/json` — parse the file as strict JSON.
  - `file/binary` — the file is raw bytes; the standard JSON Schema `format`
    keyword then gives their interpretation (e.g. `int32/le`, `image/png`). (See
    `examples/entity04` and `examples/entity08`.)

  By default the file is named after the key. `x-yamlover.path` overrides
  that, letting the schema *overlay* a file that already has some other name (see
  `examples/entity06`–`entity07`, which describe an existing `somefile.yaml`).

**Structured values** (mappings and sequences) are materialized as named
subdirectories or sibling files, each its own node — or collapsed into a single
file via `concrete`/`path`, as `examples/entity07` does for a whole mapping.

**Sequences** need an explicit order, since directory entries have none. The
schema's `prefixItems` list *is* that order: an element's position in the list is
its index, and its `x-yamlover.path` binds it to a file — whose name on disk
is therefore arbitrary. See `examples/entity09`, an array `["Alice", 42, true]`
whose elements live in files named `anyfile01`, `alsoany02`, and `andany03.json`.
Because the schema alone defines the sequence, a file the schema does not describe
is simply a schema violation — `entity09`'s `items: false` forbids a fourth
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

## Open questions

These were not yet settled and need a decision before this is a complete spec:

- **DAG edges / shared nodes.** What lifts this above a plain tree is that a node
  may be reached from more than one parent, and nodes may cross-reference each
  other. Candidates: filesystem symlinks, or a reference syntax inside the YAML
  resolved by `.yamlover`. Undecided.