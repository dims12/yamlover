# walker

Explore a yamlover tree with shell-style `cd` and `ls`.

A yamlover entity can be stored in several [concrete
representations](../../README.md#concrete-representations) — a plain file, a
plain directory, or a directory with a `.yamlover/schema.yaml` — yet they all
describe one **logical** node (a mapping, a sequence, or a scalar). `walker`
reads the schema, resolves where each value actually lives, and lets you move
around that logical tree as if it were an ordinary filesystem.

It abstracts over the physical layout, so the same commands work whether a value
is pinned in the schema (`const`), stored in its own file
(`file/yaml` · `file/json` · `file/binary`), collapsed into a single file, or
expanded into a subdirectory.

## Requirements

- Python 3.10+
- [PyYAML](https://pypi.org/project/PyYAML/) — `pip install pyyaml`

## Usage

```console
$ python walker.py PATH        # PATH defaults to the current directory
```

`PATH` is any yamlover entity — for example one of the `examples/` directories.

| command       | what it does                                            |
|---------------|---------------------------------------------------------|
| `ls [path]`   | list a node's children — name, JSON-Schema type, concrete representation |
| `cd <path>`   | move to a node — JSON-path style: `..`, `/a/b`, `a[0]/b`  |
| `pwd`         | print the current logical path                          |
| `cat [path]`  | print the value at a node                               |
| `tree [path]` | print the subtree                                       |
| `json [path]` | print the subtree as JSON                               |
| `yaml [path]` | print the subtree as YAML                               |
| `help`        | show the command list                                   |
| `exit`/`quit` | leave                                                   |

The prompt and `pwd` show the current location in **JSON-path** form, so object
keys and array indices are distinguishable — e.g. `yamlover:/examples/10-array-of-files[0]>`
(index `[0]`) versus `.../10-array-of-files` (key). The same syntax works as a `cd`
argument.

`json` and `yaml` serialize the subtree at the current node (or `[path]`) into
that one concrete representation, regardless of how the data is physically stored —
so a tree spread across per-child files, a collapsed file, and `const`-pinned
schema values all print as a single document. A binary leaf becomes `!!binary` in
`yaml`; since binary has no JSON form, `json` reports an error on such a subtree.

Commands can also be piped in for scripting:

```console
$ printf 'cd markup[0]\nls\ncat x\n' | python walker.py ../../examples/11-image-with-markup
```

Each row of `ls` reports the node's JSON-Schema **type** (`object`, `array`,
`string`, `integer`, `boolean`, …) and its **concrete** representation — how it
is stored:

| concrete | meaning |
|----------|---------|
| `yamlover` | a directory with a `.yamlover/schema.yaml` |
| `dir` | a plain directory (no `.yamlover/`) |
| `file` | a plain file (no schema) |
| `file/yaml` · `file/json` · `file/binary` | a value in its own file, with that encoding |
| `yaml` · `json` | a value *inside* a parent's collapsed document file — the file's interior |
| `yaml-schema/instantiate` | a value pinned or defined **in the schema**, which is YAML (`const`, or a structure built from `const` leaves) — would be `json-schema/instantiate` for a JSON schema, and `file/{yaml,json}-schema/instantiate` for a standalone schema file |

For an object node, `ls` lists both the schema-described properties **and** any
ordinary files/directories that physically exist but aren't described (a stray
`README.md`, say). Hidden entries (`.git`, `.yamlover`, …) and files already
claimed by a property are omitted.

## Example

Listing `examples/` shows the filesystem-level representations side by side — a
plain file, a plain directory, and yamlover nodes:

```console
$ printf 'ls\n' | python walker.py ../../examples
walking 'examples'  (dir, object)
...
NAME                    TYPE     CONCRETE
01-object-in-schema     object   yamlover
...
05-scalar-as-file       integer  file
06-plain-dir            object   dir
...
10-array-of-files       array    yamlover
README.md               string   file
```

Walking into `examples/10-array-of-files` — an array whose elements live in files named
`anyfile01`, `alsoany02`, `andany03.json` — shows the per-element encodings and
the order fixed by `prefixItems`:

```console
$ printf 'ls\ntree\n' | python walker.py ../../examples/10-array-of-files
walking '10-array-of-files'  (yamlover, array)
...
NAME  TYPE     CONCRETE
[0]   string   file/yaml
[1]   integer  file/yaml
[2]   boolean  file/json
├── [0]: Alice  [file/yaml]
├── [1]: 42  [file/yaml]
└── [2]: true  [file/json]
```
