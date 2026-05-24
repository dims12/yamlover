This directory contains samples of yamlover entities. Each one demonstrates a
different **concrete representation** — a different way the same kind of data can
live on the filesystem, in a YAML file, or in a JSON file.

The early entities keep the data trivial (the value **30**, alone or under a key)
so the representations can be compared directly; the later ones use richer data —
a mapping, a binary image, an array — to show features a bare scalar can't.

# entity01

This entity is in the **file** concrete representation.

YAML concrete representation:

```yaml
30
```

JSON concrete representation:

```json
30
```

file concrete representation:

A regular text file named `entity01` with content `30`, which is valid YAML.

# entity02

This entity is in the **yamlover** concrete representation — a directory with a
`.yamlover/` subdirectory.

YAML concrete representation:

```yaml
30
```

JSON concrete representation:

```json
30
```

yamlover concrete representation:

A directory that contains a `.yamlover/schema.yaml` file. This file is a
Yamlover JSON Schema, expressed in YAML format. The schema (`const: 30`)
describes that the only possible value is 30.

# entity03

This entity is in the **dir** concrete representation — a directory
*without* a `.yamlover/` subdirectory.

YAML concrete representation:

```yaml
age: 30
```

JSON concrete representation:

```json
{
  "age": 30
}
```

dir concrete representation:

The directory contains one text file named `age`, whose content is the valid
YAML scalar `30`.

# entity04

This entity is in the **yamlover** concrete representation, but the scalar child
`age` is stored as a *binary* file rather than as inline text.

YAML concrete representation:

```yaml
age: !!binary HgAAAA==
```

JSON concrete representation:

```json5
// impossible
```

yamlover concrete representation:

A directory that contains:

- `age` — a 4-byte file holding `30` as a little-endian `int32` (`1e 00 00 00`).
- `.yamlover/schema.yaml` — a Yamlover JSON Schema, expressed in YAML, describing
  how to decode that file:

  ```yaml
  properties:
    age:
      type: binary
      format: int32/le
      x-yamlover:
        concrete: file/binary
  ```

`x-yamlover.concrete: file/binary` says the `age` child lives in its own file. The
suffix after the slash is the file's *encoding*: yamlover spells `concrete` as one
of `file/binary`, `file/yaml`, or `file/json` so a reader knows how to parse the
file before any schema `type`/`format` is applied. Here the encoding is
`file/binary` (raw bytes), and `format: int32/le` says how to read those bytes —
a little-endian 32-bit integer. `format` is a standard, open JSON Schema keyword
used here for a binary interpretation, while `type: binary` and the `x-yamlover`
namespace are yamlover extensions (a binary value has no JSON form — hence the
`// impossible` above — but YAML carries it via `!!binary`).

# entity05

This entity is in the **yamlover** concrete representation, but the scalar children
are stored as files in YAML format.

YAML concrete representation:

```yaml
name: Alice
age: 30
isAdmin: true
```

JSON concrete representation:

```json
{
  "name": "Alice",
  "age": 30,
  "isAdmin": true
}
```

yamlover concrete representation:

A directory that contains:

- `name` — a text file holding the YAML scalar `"Alice"`.
- `age` — a text file holding the YAML scalar `30`.
- `isAdmin` — a text file holding the YAML scalar `true`.
- `.yamlover/schema.yaml` — a Yamlover JSON Schema, expressed in YAML, describing
  each child:

  ```yaml
  type: object
  properties:
    name:
      type: string
      x-yamlover:
        concrete: file/yaml
    age:
      type: integer
      minimum: 0
      x-yamlover:
        concrete: file/yaml
    isAdmin:
      type: boolean
      x-yamlover:
        concrete: file/yaml
  ```

`x-yamlover.concrete: file/yaml` says each child lives in its own file, encoded as
YAML text. Unlike [entity04](#entity04)'s `file/binary`, the bytes are parsed as
YAML — the file content is itself a valid YAML scalar (`"Alice"`, `30`, `true`),
so no `format` is needed. The `type` of each property (`string`, `integer`,
`boolean`) is a standard JSON Schema keyword, while the `x-yamlover` namespace is
the yamlover extension that points the child at its own file.

# entity06

This entity is in the **yamlover** concrete representation, used here to
*overlay* an existing directory that already contains a YAML file.

YAML concrete representation:

```yaml
30
```

JSON concrete representation:

```json
30
```

yamlover concrete representation:

A directory that contains:

- `somefile.yaml` — a text file holding the YAML scalar `30`.
- `.yamlover/schema.yaml` — a Yamlover JSON Schema, expressed in YAML, describing
  the entity:

  ```yaml
  type: integer
  x-yamlover:
    concrete: file/yaml
    file-name: somefile.yaml
  ```

Here the whole entity is a *scalar* (an integer), so the schema sits at the root
rather than under `properties`. `x-yamlover.concrete: file/yaml` says the value
lives in its own file, encoded as YAML, and `x-yamlover.file-name: somefile.yaml`
names exactly which file.
That explicit `file-name` is what makes this an overlay: the data file can keep
any name it already had (`somefile.yaml`), and the `.yamlover/` schema is dropped
alongside it to describe how to read it — without renaming or moving the file.

# entity07

This entity is in the **yamlover** concrete representation. It is the *object*
counterpart of [entity06](#entity06): a whole mapping is collapsed into a single
overlaid file instead of being expanded into one file per child (as in
[entity05](#entity05)).

YAML concrete representation:

```yaml
name: Alice
age: 30
isAdmin: true
```

JSON concrete representation:

```json
{
  "name": "Alice",
  "age": 30,
  "isAdmin": true
}
```

yamlover concrete representation:

A directory that contains:

- `somefile.yaml` — a text file holding the whole object as a YAML mapping:

  ```yaml
  name: Alice
  age: 30
  isAdmin: true
  ```

- `.yamlover/schema.yaml` — a Yamlover JSON Schema, expressed in YAML, describing
  the entity:

  ```yaml
  type: object
  x-yamlover:
    concrete: file/yaml
    file-name: somefile.yaml
  ```

The node is an *object* (`type: object`), but rather than giving it `properties`
mapped to per-child files (as [entity05](#entity05) does), the schema declares
`x-yamlover.concrete: file/yaml` with `x-yamlover.file-name: somefile.yaml` — so the
entire mapping is stored *collapsed* inside one YAML file. Whereas
[entity05](#entity05) expands the same object into one file per child, here all
the keys live together in a single file. Per the spec, a file and a subdirectory
are equivalent ways to represent the same node; this is the collapsed-into-a-file
form, and `file-name` lets that file keep an arbitrary name while the `.yamlover/`
schema overlays it.

# entity08

This entity is in the **yamlover** concrete representation. It is a more
realistic mix: one child is a **binary file** (a PNG image), and a sibling child
is **structured data pinned inline in the schema** with `const:`. It models an
object-detection result — an image plus the bounding boxes marked up over it.

YAML concrete representation:

```yaml
object_detection.png: !!binary |
  iVBORw0KGgoAAAANSUhEUgAAAeQAAAJqCAYAAAD6/DPMAAAA…   # ~780 KB of PNG bytes
markup:
  - { x: 25, y: 40, dx: 25, dy: 40 }   # bus
  - { x: 25, y: 40, dx: 25, dy: 40 }   # car
```

JSON concrete representation:

```json5
// impossible
```

yamlover concrete representation:

A directory that contains:

- `object_detection.png` — a 780 KB PNG image file (484×618 RGBA).
- `.yamlover/schema.yaml` — a Yamlover JSON Schema, expressed in YAML, describing
  both children:

  ```yaml
  properties:
    object_detection.png:
      type: binary
      format: image/png
      x-yamlover:
        concrete: file/binary
    markup:
      type: array
      prefixItems:
        - type: object
          description: bus
          properties:
            x:
              const: 25
            y:
              const: 40
            dx:
              const: 25
            dy:
              const: 40
        - type: object
          description: car
          properties:
            x:
              const: 25
            y:
              const: 40
            dx:
              const: 25
            dy:
              const: 40
  ```

Two storage strategies sit side by side here:

- **`object_detection.png` lives in a file.** As in [entity04](#entity04),
  `type: binary` + `x-yamlover.concrete: file/binary` say the child is raw bytes in
  its own file; `format: image/png` is the standard JSON Schema keyword giving the binary
  interpretation (a real MIME type, rather than entity04's synthetic
  `int32/le`). Because it is binary, the entity has no JSON form — hence the
  `// impossible` above — though YAML can carry it via `!!binary`.
- **`markup` is pinned in the schema.** No `markup` file exists on disk; the whole
  array is fixed inline with `const:`, the same "pinned in the schema" path the
  spec describes for scalars (see [entity02](#entity02)), extended here to
  structured data. `prefixItems` validates the array position-by-position (a
  two-element tuple), and each item's `description` (`bus`, `car`) labels which
  detected object that box belongs to. The box coordinates `x`/`y`/`dx`/`dy` are
  the pinned values.

# entity09

This entity is in the **yamlover** concrete representation and shows how an
**array** (sequence) is encoded: the node is `type: array`, and each element is
stored in its own file. Whereas [entity08](#entity08)'s `markup` array is pinned
inline in the schema, here the elements live on disk.

YAML concrete representation:

```yaml
- Alice
- 42
- true
```

JSON concrete representation:

```json
["Alice", 42, true]
```

yamlover concrete representation:

A directory that contains:

- `anyfile01` — a text file holding the YAML scalar `Alice` (element 0).
- `alsoany02` — a text file holding the YAML scalar `42` (element 1).
- `andany03.json` — a text file holding the JSON scalar `true` (element 2).
- `.yamlover/schema.yaml` — a Yamlover JSON Schema, expressed in YAML, describing
  the array:

  ```yaml
  type: array
  prefixItems:
    - type: string
      x-yamlover:
        concrete: file/yaml
        file-name: anyfile01
    - type: integer
      x-yamlover:
        concrete: file/yaml
        file-name: alsoany02
    - type: boolean
      x-yamlover:
        concrete: file/json
        file-name: andany03.json
  items: false
  ```

The key problem an array poses on a filesystem is **order** — directory entries
have none. yamlover solves it with JSON Schema's `prefixItems`: the *position* of
each entry in that list is the element's index (0, 1, 2), and its
`x-yamlover.file-name` says which file on disk holds that element. So the file
names are arbitrary (`anyfile01`, `alsoany02`, `andany03.json`) — the schema, not
the filesystem ordering, fixes the sequence. (This is one concrete answer to the
*Sequences / ordering* open question in the top-level spec.)

Each element also carries its own `concrete` encoding, and they need not match:
`anyfile01` and `alsoany02` are `file/yaml`, while `andany03.json` is `file/json`
(its `true` is read by a strict JSON parser). Finally, `items: false` closes the
tuple — no elements beyond the three listed in `prefixItems` are allowed.
