# collector

> ⚠️ **DEPRECATED (2026-06-07).** Superseded by `tools/parser/` + `tools/engine/`. It builds
> a **Yamlover JSON Schema** (the old schema-as-storage model), which the instance-only
> design retired. Kept for reference only — do not extend. See [`../LEGACY.md`](../LEGACY.md).

Assemble a yamlover tree into a single **Yamlover JSON Schema**.

Where [`walker`](../walker/) materializes the *values* of a yamlover tree,
`collector` materializes the *schema*. It walks an entity tree, merges every
per-directory `.yamlover/schema.yaml` into one document — inlining the schema of
each nested node — and infers a schema for any plain file or plain directory
that has none. The result is one schema describing the whole tree, printed as
YAML (default) or JSON.

Every node is annotated with its concrete representation under
`x-yamlover.concrete`:

| concrete | the node is… |
|----------|--------------|
| `yamlover` | a directory with a `.yamlover/schema.yaml` (its own schema is inlined) |
| `dir` | a plain directory (object of its entries) |
| `file` | a plain file with no schema (type inferred from its contents) |
| `file/yaml` · `file/json` · `file/binary` | a value stored in its own file, per the owning schema |

> Canonical taxonomy (and the TypeScript server's normalized strings — e.g.
> `dir/yamlover`, `file/<lang>`): see [`CONCRETES.md`](../../CONCRETES.md).

A node's own schema is preserved verbatim (including `const`, `format`,
`prefixItems`, `os`, …); parent context such as `description` and
`x-yamlover.os` is folded in, and undescribed non-hidden files are surfaced as
extra properties (hidden entries like `.git` / `.yamlover` are skipped).

## Requirements

- Python 3.10+
- [PyYAML](https://pypi.org/project/PyYAML/) — `pip install pyyaml`

## Usage

```console
$ python collector.py [PATH] [-f yaml|json]      # PATH defaults to .
```

- `-f yaml` (default) — print the collected schema as YAML
- `-f json` — print it as JSON

## Example

Collecting `examples/10-array-of-files` — an array whose elements live in separate files
— yields a single self-contained schema:

```console
$ python collector.py ../../examples/10-array-of-files -f yaml
type: array
prefixItems:
- type: string
  x-yamlover:
    concrete: file/yaml
    os:
      path: anyfile01
- type: integer
  x-yamlover:
    concrete: file/yaml
    os:
      path: alsoany02
- type: boolean
  x-yamlover:
    concrete: file/json
    os:
      path: andany03.json
items: false
x-yamlover:
  concrete: yamlover
```

Pointed at a directory, it inlines every child. `collector.py ../../examples`
produces one `object` schema whose `properties` are the example entities, each
with its own inlined schema and `concrete` annotation.
