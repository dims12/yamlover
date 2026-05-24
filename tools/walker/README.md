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
| `help`        | show the command list                                   |
| `exit`/`quit` | leave                                                   |

The prompt and `pwd` show the current location in **JSON-path** form, so object
keys and array indices are distinguishable — e.g. `yamlover:/examples/entity09[0]>`
(index `[0]`) versus `.../entity09` (key). The same syntax works as a `cd`
argument.

Commands can also be piped in for scripting:

```console
$ printf 'cd markup[0]\nls\ncat x\n' | python walker.py ../../examples/entity08
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
| `const` | a value pinned inline in the schema |
| `inline` | structure defined in the schema, or living inside a parent's collapsed file |

## Example

Listing `examples/` shows the filesystem-level representations side by side — a
plain file, a plain directory, and yamlover nodes:

```console
$ printf 'ls\n' | python walker.py ../../examples
walking 'examples'  (dir, object)
...
NAME       TYPE     CONCRETE
README.md  string   file
entity01   integer  file
entity02   integer  yamlover
entity03   object   dir
entity04   object   yamlover
...
entity09   array    yamlover
```

Walking into `examples/entity09` — an array whose elements live in files named
`anyfile01`, `alsoany02`, `andany03.json` — shows the per-element encodings and
the order fixed by `prefixItems`:

```console
$ printf 'ls\ntree\n' | python walker.py ../../examples/entity09
walking 'entity09'  (yamlover, array)
...
NAME  TYPE     CONCRETE
[0]   string   file/yaml
[1]   integer  file/yaml
[2]   boolean  file/json
├── [0]: Alice  [file/yaml]
├── [1]: 42  [file/yaml]
└── [2]: true  [file/json]
```
