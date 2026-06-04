This directory contains samples of yamlover entities. Each one demonstrates a
different **concrete representation** — a different way the same kind of data can
live on the filesystem, in a YAML file, or in a JSON file. They are numbered so
they sort into reading order.

The first four (`01`–`04`) hold the **same object** `{name, age, isAdmin}` in the
four core concretes — pinned in the schema, collapsed into a YAML file, collapsed
into a JSON file, and expanded into a directory — so the representations can be
compared directly. The rest (`05`–`18`) use trivial data (the value **30**, alone
or under a key) or richer data — a binary value, an array, a mid-tree concrete
switch, an image with markup, `$ref`/`$defs`, a two-parent genealogy DAG, a
catalogue of every renderable format (as object properties and as chapter chunks),
a recursive document tree, a tagged library of papers — to isolate one further
feature each.

# 01-object-in-schema

This entity is in the **yamlover** concrete representation. It is the *schema*
counterpart of [04-object-in-dir](#04-object-in-dir) and [02-object-in-yaml](#02-object-in-yaml): the **same**
object is stored entirely **inside the schema**, pinned value-by-value with
`const:`, so no data file exists at all.

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

A directory that contains *only*:

- `.yamlover/schema.yaml` — a Yamlover JSON Schema, expressed in YAML, that pins
  every property to a constant:

  ```yaml
  properties:
    name:
      const: Alice
    age:
      const: 30
    isAdmin:
      const: true
  ```

There are no `name`, `age`, or `isAdmin` files (as in [04-object-in-dir](#04-object-in-dir)), and
no collapsed `somefile.yaml` (as in [02-object-in-yaml](#02-object-in-yaml)) either — the directory
holds nothing but its `.yamlover/`. Every value lives in the schema. This is the
object-sized version of [07-scalar-in-schema](#07-scalar-in-schema), which pins a bare scalar with
`const: 30`: where 07-scalar-in-schema pins one value, 01-object-in-schema pins a whole mapping.

The three entities close a triangle over the *same* data
`{name: Alice, age: 30, isAdmin: true}` — three ways to materialize one object:

| entity | where the values live | form |
|--------|----------------------|------|
| [04-object-in-dir](#04-object-in-dir) | one file per child (`name`, `age`, `isAdmin`) | expanded **directory** |
| [02-object-in-yaml](#02-object-in-yaml) | a single collapsed file (`somefile.yaml`) | one **YAML file** |
| **01-object-in-schema** | the schema itself (`const:` per property) | the **schema** |

All three are the **yamlover** concrete representation; what differs is *where the
bytes sit*. Because a JSON Schema whose leaves are all `const:` **is** the
instance it validates (see the top-level spec, *[Schema ↔ instance
correspondence](../README.md#schema--instance-correspondence)*), the schema can
carry the data outright — the limiting case where the description and the thing
described coincide.

# 02-object-in-yaml

This entity is in the **yamlover** concrete representation. It is the *object*
counterpart of [08-scalar-file-overlay](#08-scalar-file-overlay): a whole mapping is collapsed into a single
overlaid file instead of being expanded into one file per child (as in
[04-object-in-dir](#04-object-in-dir)).

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
    os:
      path: somefile.yaml
  ```

The node is an *object* (`type: object`), but rather than giving it `properties`
mapped to per-child files (as [04-object-in-dir](#04-object-in-dir) does), the schema declares
`x-yamlover.concrete: file/yaml` with `x-yamlover.os.path: somefile.yaml` — so the
entire mapping is stored *collapsed* inside one YAML file. Whereas
[04-object-in-dir](#04-object-in-dir) expands the same object into one file per child, here all
the keys live together in a single file. Per the spec, a file and a subdirectory
are equivalent ways to represent the same node; this is the collapsed-into-a-file
form, and `os.path` lets that file keep an arbitrary name while the `.yamlover/`
schema overlays it.

# 03-object-in-json

This entity is in the **yamlover** concrete representation. It is the JSON-file
twin of [02-object-in-yaml](#02-object-in-yaml): the same mapping is collapsed into a single
overlaid file, but that file is **JSON** (`somefile.json`) rather than YAML.

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

- `somefile.json` — a text file holding the whole object as strict JSON:

  ```json
  {
    "name": "Alice",
    "age": 30,
    "isAdmin": true
  }
  ```

- `.yamlover/schema.yaml` — a Yamlover JSON Schema, expressed in YAML, describing
  the entity:

  ```yaml
  type: object
  x-yamlover:
    concrete: file/json
    os:
      path: somefile.json
  ```

The only difference from [02-object-in-yaml](#02-object-in-yaml) is the data file's encoding:
`x-yamlover.concrete` is `file/json` rather than `file/yaml`, so the collapsed file
is read by a strict JSON parser. Everything *inside* that file is therefore in the
**json** concrete representation (the interior of a JSON file), just as
[02-object-in-yaml](#02-object-in-yaml)'s keys are in the **yaml** concrete — the walker reports
`json` for `name`/`age`/`isAdmin` here and `yaml` there. The schema stays YAML
(`.yamlover/schema.yaml`); only the encoding of the overlaid data file changes.

# 04-object-in-dir

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
YAML text. Unlike [09-scalar-as-binary](#09-scalar-as-binary)'s `file/binary`, the bytes are parsed as
YAML — the file content is itself a valid YAML scalar (`"Alice"`, `30`, `true`),
so no `format` is needed. The `type` of each property (`string`, `integer`,
`boolean`) is a standard JSON Schema keyword, while the `x-yamlover` namespace is
the yamlover extension that points the child at its own file.

# 05-scalar-as-file

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

A regular text file named `05-scalar-as-file` with content `30`, which is valid YAML.

# 06-plain-dir

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

# 07-scalar-in-schema

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

# 08-scalar-file-overlay

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
    os:
      path: somefile.yaml
  ```

Here the whole entity is a *scalar* (an integer), so the schema sits at the root
rather than under `properties`. `x-yamlover.concrete: file/yaml` says the value
lives in its own file, encoded as YAML, and `x-yamlover.os.path: somefile.yaml`
names exactly which file.
That explicit `os.path` is what makes this an overlay: the data file can keep
any name it already had (`somefile.yaml`), and the `.yamlover/` schema is dropped
alongside it to describe how to read it — without renaming or moving the file.

# 09-scalar-as-binary

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

# 10-array-of-files

This entity is in the **yamlover** concrete representation and shows how an
**array** (sequence) is encoded: the node is `type: array`, and each element is
stored in its own file. Whereas [12-image-with-markup](#12-image-with-markup)'s `markup` array is pinned
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
  ```

The key problem an array poses on a filesystem is **order** — directory entries
have none. yamlover solves it with JSON Schema's `prefixItems`: the *position* of
each entry in that list is the element's index (0, 1, 2), and its
`x-yamlover.os.path` says which file on disk holds that element. So the file
names are arbitrary (`anyfile01`, `alsoany02`, `andany03.json`) — the schema, not
the filesystem ordering, fixes the sequence. (This is one concrete answer to the
*Sequences / ordering* open question in the top-level spec.)

Each element also carries its own `concrete` encoding, and they need not match:
`anyfile01` and `alsoany02` are `file/yaml`, while `andany03.json` is `file/json`
(its `true` is read by a strict JSON parser). Finally, `items: false` closes the
tuple — no elements beyond the three listed in `prefixItems` are allowed.

# 11-switch-schema-file-yaml

This entity shows that the **concrete can change partway down the tree** — the
model continues from the middle in a *different* representation. Most of it is
pinned in the schema (`yaml-schema/instantiate`), but one node, `user.contact`,
switches to `file/yaml`: its value isn't in the schema, it *continues* in a
separate file (`continuation.yaml`).

YAML concrete representation:

```yaml
user:
  name: Alice
  contact:
    email: alice@example.com
    phone: 123-456-7890
settings:
  theme: dark
  notifications: true
```

yamlover concrete representation:

A directory that contains:

- `continuation.yaml` — where `user.contact` continues:

  ```yaml
  email: alice@example.com
  phone: 123-456-7890
  ```

- `.yamlover/schema.yaml` — pins everything *except* `user.contact`, which only
  says "from here, read that file":

  ```yaml
  properties:
    user:
      properties:
        name:
          const: Alice
        contact:
          x-yamlover:
            concrete: file/yaml
            os:
              path: continuation.yaml
    settings:
      properties:
        theme:
          const: dark
        notifications:
          const: true
  ```

Walking in shows the switch on a single child:

```console
$ printf 'cd user\nls\n' | python ../../tools/walker/walker.py 11-switch-schema-file-yaml
NAME     TYPE    CONCRETE
name     string  yaml-schema/instantiate
contact  object  file/yaml
```

`name` is `yaml-schema/instantiate` (its value lives in the schema), while
`contact` is `file/yaml` (its value lives in `continuation.yaml`) — two concretes
side by side, one level down. Because `continuation.yaml` is *claimed* by
`user.contact`, it is not also listed as a stray file at the root. This is the
hand-off point where a schema-pinned tree resumes as on-disk data, in either
direction.

# 12-image-with-markup

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

- **`object_detection.png` lives in a file.** As in [09-scalar-as-binary](#09-scalar-as-binary),
  `type: binary` + `x-yamlover.concrete: file/binary` say the child is raw bytes in
  its own file; `format: image/png` is the standard JSON Schema keyword giving the binary
  interpretation (a real MIME type, rather than 09-scalar-as-binary's synthetic
  `int32/le`). Because it is binary, the entity has no JSON form — hence the
  `// impossible` above — though YAML can carry it via `!!binary`.
- **`markup` is pinned in the schema.** No `markup` file exists on disk; the whole
  array is fixed inline with `const:`, the same "pinned in the schema" path the
  spec describes for scalars (see [07-scalar-in-schema](#07-scalar-in-schema)), extended here to
  structured data. `prefixItems` validates the array position-by-position (a
  two-element tuple), and each item's `description` (`bus`, `car`) labels which
  detected object that box belongs to. The box coordinates `x`/`y`/`dx`/`dy` are
  the pinned values.

# 13-defs-and-refs

This entity is the **`$ref`/`$defs`** version of
[12-image-with-markup](#12-image-with-markup): the same image-plus-markup data,
but each region's *shape* is pulled in by a `$ref` to a shared definition rather
than spelled out twice. `$ref` and `$defs` live in **schema coordinates** — they
are JSON Pointers within the schema document, never filesystem paths.

It materializes to exactly the same value as
[12-image-with-markup](#12-image-with-markup):

```yaml
markup:
  - { x: 25, y: 40, dx: 25, dy: 40 }   # bus
  - { x: 25, y: 40, dx: 25, dy: 40 }   # car
# object_detection.png omitted here — a 1×1 placeholder PNG stands in for 12's image
```

yamlover concrete representation:

A directory that contains:

- `object_detection.png` — a minimal 1×1 placeholder PNG (the example is about
  the markup; 12's real 780 KB image isn't duplicated).
- `.yamlover/schema.yaml` — a Yamlover JSON Schema defining the region shape once,
  under the standard JSON Schema `$defs`, and referencing it per region:

  ```yaml
  $defs:
    rectangular-area:
      type: object
      properties:
        x: { type: integer }
        y: { type: integer }
        dx: { type: integer }
        dy: { type: integer }
  properties:
    object_detection.png:
      type: binary
      format: image/png
      x-yamlover:
        concrete: file/binary
    markup:
      type: array
      prefixItems:
        - description: bus
          $ref: '#/$defs/rectangular-area'
          properties:
            x: { const: 25 }
            y: { const: 40 }
            dx: { const: 25 }
            dy: { const: 40 }
        - description: car
          $ref: '#/$defs/rectangular-area'
          properties:
            x: { const: 25 }
            y: { const: 40 }
            dx: { const: 25 }
            dy: { const: 40 }
  ```

How it resolves:

- **`$defs`** holds reusable schema fragments. It is a sibling of `properties`,
  not a property itself, so it never appears in the materialized data — it lives
  purely in schema space.
- **`$ref: '#/$defs/rectangular-area'`** is a JSON Pointer into the same document.
  It can point at *any* location in schema coordinates, not only under `$defs`
  (e.g. `#/properties/markup/prefixItems/0`).
- Per JSON Schema 2020-12, a `$ref` may carry sibling keywords: the referenced
  shape (`type: object` with integer `x`/`y`/`dx`/`dy`) and the locally inlined
  `const` coordinates are **merged** — both apply, so each region is an integer
  rectangle pinned to `(25, 40, 25, 40)`. The walker resolves the `$ref` while
  reading the tree, so `ls`/`cat`/`yaml` show the fully expanded regions.

# 14-genealogy-dag

This entity is a **DAG**: every person has *two* parents — a `father` and a
`mother` — so a node is reached from more than one place. The trick is that one
relation, **containment**, carries the tree backbone and the other is an explicit
cross-edge:

- the **containment tree is the paternal line** — a person's dict children *are*
  his offspring (`/adam/cain/enoch`);
- the **maternal edge** is declared under `x-yamlover.rel` and followed with the
  `^` (ascend) operator.

Because dict children are the *paternal* relation, **females never have dict
children** — they appear as leaves and are pointed *at* as mothers. So `eve` and
`azura` are childless in the containment tree, while `azura` is simultaneously a
child of `adam` and the mother of `enoch` (the shared node that makes this a DAG,
not a tree). To give mothers their children back, a `rel` key prefixed with `.`
declares a **virtual child** — a down-edge that `ls`/`cd` follow but that does not
nest into the value (see below).

Its **value** is just the paternal backbone — relations (maternal edges, virtual
children) don't nest. The leaves are typeless, so they materialize to `~` (null);
`eve` keeps `type: object`, so it is an empty object:

```yaml
adam:
  cain:
    enoch: ~
  seth: ~
  azura: ~
eve: {}
```

yamlover concrete representation — `.yamlover/schema.yaml` pins the people inline
and records each one's parents under `x-yamlover.rel`:

```yaml
properties:
  adam:                       # root male — no parents, so no rel
    properties:
      cain:
        x-yamlover:
          rel:
            father: ".."      # main (containment) parent, named "father"
            mother: "/eve"    # second parent — a cross-edge
        properties:
          enoch:
            x-yamlover:
              rel:
                father: ".."          # → /adam/cain
                mother: "/adam/azura" # the DAG edge: enoch's mother is adam's daughter
      seth:
        x-yamlover: { rel: { father: "..", mother: "/eve" } }
      azura:                  # adam's daughter; also enoch's mother
        x-yamlover:
          rel:
            father: ".."
            mother: "/eve"
            .enoch: "/adam/cain/enoch"   # virtual child (down-edge)
  eve:                        # root female; childless in containment, given
    type: object              # her children back as virtual down-edges
    x-yamlover:
      rel:
        .cain: "/adam/cain"
        .seth: "/adam/seth"
        .azura: "/adam/azura"
```

How the relations read:

- **`rel` is a node's table of up-edges**, keyed by relation name. The entry
  pointing at the containment parent (`..`) is the **main-parent slug** — here
  named `father`; it is **optional** (the containment parent is implicit, and
  defaults to the node's own key), spelled out only to give it the name `father`.
- **`mother`** is an additional parent, its value a path to that node:
  `..`-relative or `/…`-absolute from the entity root (a `*anchor` would be the
  move-stable form).
- **A `.`-prefixed key is a *virtual child*** — a *down*-edge (the dual of a
  parent edge). It is **listed by `ls` and followed by `cd`, but never nested
  into the value**. That is how `eve`, childless in the containment tree, gets her
  children back, and how `azura` claims `enoch`.
- **Navigation:** `/name` descends a child, **`^name` ascends a named parent** —
  `^father` undoes the last descent, `^mother` jumps to the mother. `..` is sugar
  for the primary (paternal) parent; in a DAG you name the rest. The walker
  resolves these, anchoring an absolute `rel` pointer at the enclosing entity:

  ```console
  $ printf 'cd adam/cain/enoch\ncd ^mother\npwd\n' | python ../../tools/walker/walker.py 14-genealogy-dag
  /adam/azura

  $ printf 'cd eve\nls\n' | python ../../tools/walker/walker.py 14-genealogy-dag
  NAME   TYPE    CONCRETE
  cain   object  rel → /adam/cain
  seth   null    rel → /adam/seth
  azura  null    rel → /adam/azura
  ```

# 15-all-formats-object

This entity is a **catalogue of every renderable format**, laid out as a plain
object with **one property per `(type, format)`** the web viewer knows how to show.
It is the breadth counterpart to the single-format examples above: where each of
those isolates one feature, this one puts the whole renderer registry side by side.

Three properties are **string** formats pinned inline with `const` — `markdown`
(`text/markdown`), `asciidoc` (`text/asciidoc`), and `plantuml` (`text/x-plantuml`).
The remaining eleven are **binary** sample files in the directory, each a
`concrete: file/binary` node tagged with the MIME `format` that keys its renderer:

| property | format | renderer |
|----------|--------|----------|
| `png` `svg` `gif` `bmp` `ico` | `image/png`, `image/svg+xml`, `image/gif`, `image/bmp`, `image/x-icon` | native `<img>` |
| `tiff` | `image/tiff` | UTIF → canvas |
| `psd` | `image/vnd.adobe.photoshop` | ag-psd → canvas |
| `html` | `text/html` | sandboxed `<iframe>` |
| `pdf` | `application/pdf` | pdf.js |
| `fb2` | `application/x-fictionbook+xml` | FictionBook XML |
| `epub` | `application/epub+zip` | unzip + spine |

How it reads:

- **Every value is reached the same way** — navigate into a property and it renders
  through the renderer its `(type, format)` selects. The object view itself is the
  ordinary one-level YAML/JSON representation, each property a link to descend.
- **Storage is mixed, deliberately.** The three text formats live in the schema
  (`const`), the rest are real files claimed by `x-yamlover.os.path` — the same
  "described, not duplicated" pattern as [12-image-with-markup](#12-image-with-markup),
  scaled to the whole format set.
- It doubles as a **smoke test for the registry**: if a renderer regresses, the
  property for its format stops rendering. Its sibling
  [16-all-formats-chunks](#16-all-formats-chunks) puts the identical set into a
  chapter's `chunks`.

# 16-all-formats-chunks

This entity is the **same format catalogue as a readable page**: a single
**chapter** whose numbered `chunks` are one of each renderable format, top to
bottom. Where [15-all-formats-object](#15-all-formats-object) hangs the formats off
object keys, here they flow down a chapter body — proving the chapter renderer
delegates **every** chunk to the renderer for *its own* `(type, format)`, not just
prose.

The mechanism is the chunks array's `items` base, `string`/`text/markdown`: a bare
`const:` string is prose, and a chunk **overrides** `format`/`type` to become
anything else — an AsciiDoc block, a PlantUML diagram, or any of the eleven binary
files (image, html, pdf, fb2, epub, psd, tiff, …). Each binary chunk reuses its
full-page renderer **inline**, addressed by the chunk's own node path:

```yaml
chunks:
  prefixItems:
    - const: "# Markdown chunk\n…"           # the items base — prose
    - { format: text/asciidoc,   const: "== AsciiDoc chunk\n…" }
    - { format: text/x-plantuml, const: "@startuml\nAlice -> Bob : hello\n@enduml" }
    - { type: binary, format: image/png, x-yamlover: { concrete: file/binary, os: { path: sample.png } } }
    - { type: binary, format: application/pdf, x-yamlover: { concrete: file/binary, os: { path: sample.pdf } } }
    # … svg, gif, bmp, ico, tiff, html, fb2, epub, psd …
```

How it reads:

- **One delegation rule, every format.** The chapter prefixes each chunk with its
  zero-based index (a hyperlink to the chunk's own node) and renders the body via
  `rendererFor(type, format).renderChunk` — the text renderer for Markdown, the
  PlantUML renderer for the diagram, and each file-backed renderer (PDF, FB2, EPUB,
  PSD, TIFF, HTML, …) reused inline. This is the general form of the mixed media in
  [17-doc-tree](#17-doc-tree), taken to the full format set.
- **The `chapter` shape is reused verbatim** from [17-doc-tree](#17-doc-tree) — the
  recursive `$defs/chapter` — but here it carries only `chunks` (no subchapters).
- It is the **end-to-end test** that the registry and the chapter compose: the same
  fourteen formats as [15-all-formats-object](#15-all-formats-object), now rendered
  one after another on a single page.

# 17-doc-tree

This entity is a **recursive document tree** — a help/book structure (here, a small
pet-keeping handbook), the kind of thing you might otherwise keep as a folder of
Markdown or AsciiDoc files. A **chapter** is an object with two arrays: **`chunks`**
(its body, read as numbered blocks) and **`children`** (its subchapters —
the recursion). The two are deliberately *separate*: a chapter is heading + body +
subchapters, and subchapters are **terminal** — there is no returning to a parent's
prose after one, the way real documents read. The recursion is expressed once, in
`$defs`, and pulled in by `$ref` — the same schema-coordinate mechanism as
[13-defs-and-refs](#13-defs-and-refs), here pointing at *itself*.

A chapter's body is **not prose-only**. Each chunk routes by its own `(type, format)`,
so the same numbered body interleaves three kinds of block: a Markdown paragraph
(`string`/`text/markdown`), a **PlantUML diagram** (`string`/`text/x-plantuml`,
rendered as the picture its source compiles to), and an **image** (`binary`/`image/png`,
a real PNG file in the directory). The chunks' `items` base declares
`string`/`text/markdown`, so a bare `const:` string is prose; a chunk overrides
`format`/`type` only when it is a diagram or an image.

The prose and the diagrams are **pinned inline with `const`** (concrete
`yaml-schema/instantiate`) — they live in the schema, no `.md` or `.puml` files
exist. The only files on disk are the five illustration PNGs (`cover-paw.png`,
`dog-bone.png`, `puppy-paw.png`, `cat-face.png`, `fish-tank.png`), each a
`concrete: file/binary` chunk. Because a text chunk is just a `const` value, any one
of them could equally be externalized to a `file` with no change to the logical
tree — self-containment is a per-chunk choice, not a global mode.

YAML concrete representation (the materialized value — a chapter object, abbreviated):

```yaml
chunks:
  - Pets share our homes, our routines, and a surprising amount of our furniture.
  - This handbook collects what every keeper learns sooner or later, one species at a time.
  - Read the chapter for your companion, but the first rule is universal: watch, listen, and be patient.
children:
  - chunks:
      - A dog is a social animal that adopts your family as its pack.
      - Daily walks are not optional; they are how a dog reads the news of the neighbourhood.
      - Consistency matters more than severity: the same word should always mean the same thing.
    children:
      - chunks:
          - Puppies sleep most of the day and chew most of the rest.
          - Begin house training the day they arrive, and reward every success generously.
          - Early, gentle exposure to people and places shapes a calm adult dog.
  # … Cats and Fish chapters follow, each three prose chunks …
```

yamlover concrete representation — `.yamlover/schema.yaml` defines the recursive
`chapter` shape once and pins the content inline (abbreviated):

```yaml
x-yamlover:
  concrete: yamlover
$ref: '#/$defs/chapter'
title: The Pet Keeper's Handbook            # book heading  (schema annotation)
description: A friendly guide to living with animals   # subtitle
properties:
  chunks:
    prefixItems:
      - const: "**Pets share our homes…** This handbook collects what every keeper learns."   # markdown
      - const: "Read the chapter for your companion, but the first rule is universal: *watch, listen, and be patient.*"
      - type: binary                         # an image chunk — overrides the markdown base
        format: image/png
        x-yamlover: { concrete: file/binary, os: { path: cover-paw.png } }
      - format: text/x-plantuml              # a diagram chunk — overrides only the format
        const: |
          @startmindmap
          * Pet keeping
          ** Dogs
          ** Cats
          ** Fish
          @endmindmap
  children:
    prefixItems:
      - title: Dogs                          # a subchapter (the $defs/chapter base is merged in via `items`)
        description: Loyal, loud, and endlessly hopeful
        properties:
          chunks:
            prefixItems:
              - const: "A dog is a social animal that adopts your family as its pack."
              - const: "Daily walks are not optional; they are how a dog reads the news of the neighbourhood."
              - const: "Consistency matters more than severity: the same word should always mean the same thing."
          children:
            prefixItems:
              - title: Puppies               # a sub-subchapter
                description: The first few months
                properties:
                  chunks:
                    prefixItems:
                      - const: "Puppies sleep most of the day and chew most of the rest."
                      - const: "Begin house training the day they arrive, and reward every success generously."
                      - const: "Early, gentle exposure to people and places shapes a calm adult dog."
      # … Cats and Fish chapters follow, each three prose chunks …

$defs:
  chapter:
    type: object
    format: x-yamlover-chapter            # keys the server's `chapter` renderer
    properties:
      chunks:                              # body, read as numbered blocks
        type: array
        items:
          type: string
          format: text/markdown            # the base chunk (type, format); a chunk overrides
                                           # it to be a text/x-plantuml diagram or an image
      children:                            # subchapters — the recursion
        type: array
        items:
          $ref: '#/$defs/chapter'
```

How it reads:

- **`$defs/chapter` is the recursive *type*** — an object of `chunks` (strings) and
  `children` (chapters), to any depth. Each concrete chapter supplies its content by
  overriding the two arrays' `prefixItems`. An array's `items` schema is the base each
  `prefixItems` entry overlays, so the element type is declared once: chunks inherit
  `string`/`text/markdown`, and each `children` entry inherits the `$ref` to `chapter`
  (which is why the entries below only carry their `title`/content, not the `$ref`).
- **`title` / `description` are JSON-Schema annotations**, attached to each chapter,
  carrying its heading and subtitle. They describe the node rather than living in the
  prose — a clean split from the `const` content.
- **`format: x-yamlover-chapter`** is a custom format on the `chapter` type. The web
  server's renderer registry keys on the `(type, format)` tuple `("object",
  "x-yamlover-chapter")` to present a chapter as a readable **page** — its chunks as
  **numbered** paragraphs (each number a hyperlink to that chunk's own node) and its
  subchapters as title hyperlinks. In the TOC it surfaces the subchapters *directly*
  (unwrapping the `children` array, hiding `chunks`) so the tree reads as a table of
  contents.
- **Renderers compose by `(type, format)`** — the chapter doesn't render its body
  itself; it delegates each chunk to the renderer for that chunk's tuple. A
  `string`/`text/markdown` chunk routes to the **text** renderer, a
  `string`/`text/x-plantuml` chunk to the **PlantUML** renderer (its source shown as
  the diagram it compiles to), a `binary`/`image/png` chunk to the **image** renderer —
  all in one body, no change to the chapter. The same tuple that selects a node's
  full-page view also selects its inline form.
- **Ordering is free** — the `prefixItems` order *is* the reading order, the natural
  answer to sequencing a document.

Walking in shows the structure — the `Dogs` chapter (`children[0]`) holds its own
`chunks` and `children`:

```console
$ printf 'cd children[0]\nls\ncat chunks[0]\n' | python ../../tools/walker/walker.py 17-doc-tree
NAME      TYPE   CONCRETE
chunks    array  yaml-schema/instantiate
children  array  yaml-schema/instantiate
A dog is a social animal that adopts your family as its pack.
```

A planned next step is **hyperlinks** between chunks: a leaf carrying a JSON-path
pointer in `x-yamlover` (resolved against the enclosing entity, like
[14-genealogy-dag](#14-genealogy-dag)'s `rel` pointers and the `^`/virtual-child
navigation). Inline-`const` self-containment is what lets those links resolve within
one document instead of chasing files.

# 18-pdf-tags

This entity is a small **library of papers, classified by tags** — and the tags
live in the *same document* as the things they classify. It is built in three
layers, bottom-up:

1. **a tree of tags** (the taxonomy), pinned inline in the schema;
2. **each file on disk described as a node** — the real PDFs and HTML already in
   the directory, given a `concrete: file/binary` declaration and a human title;
3. **classification by `rel`** — each paper carries `x-yamlover.rel` edges that
   point at tag nodes, the same up-edge mechanism as
   [14-genealogy-dag](#14-genealogy-dag)'s `mother`, here used to mean "is tagged".

The six papers are real, and all famously short or deadpan: Lander & Parkin's
two-sentence *Counterexample to Euler's Conjecture*; Upper's entirely blank *The
Unsuccessful Self-Treatment of a Case of "Writer's Block"*; Goldberg &
Chemjobber's blank *Comprehensive Overview of Chemical-Free Consumer Products*;
Berry et al.'s *Can Apparent Superluminal Neutrino Speeds…?* (abstract: "Probably
not."); Gardner & Knopoff's *Is the Sequence of Earthquakes… Poissonian?*
(abstract: "Yes."); and the Fermat's Library annotated edition of the first.

The **tag tree** has two independent axes — **`field`** (what a paper is about)
and **`genre`** (how it is short). Every tag is an object, so it can carry a
`description` and still nest sub-tags; the leaves are simply tags with no children:

```yaml
properties:
  tags:
    type: object
    properties:
      field:                                  # axis 1 — subject
        type: object
        properties:
          mathematics:
            type: object
            properties:
              number-theory: { type: object, description: Diophantine equations, sums of powers }
          physics:
            type: object
            properties:
              quantum:  { type: object, description: Quantum mechanics and measurement }
              particle: { type: object, description: Neutrinos and the like }
          earth-science:
            type: object
            properties:
              seismology: { type: object, description: Earthquakes and their statistics }
          chemistry: { type: object }
          psychology:
            type: object
            properties:
              behavior-analysis: { type: object }
      genre:                                  # axis 2 — how it is short
        type: object
        properties:
          brevity:
            type: object
            properties:
              shortest-paper:  { type: object, description: Famously the shortest in its journal }
              one-word-answer: { type: object, description: A title that is a question; a one-word abstract }
              empty-body:      { type: object, description: The body is (almost) entirely blank }
          humor:
            type: object
            properties:
              deadpan: { type: object, description: Plays it completely straight }
              satire:  { type: object, description: Mocks its target }
          annotation: { type: object, description: A derivative edition of another paper }
```

Each **paper is the file on disk** — `concrete: file/binary` names the encoding,
and `x-yamlover.os.path` carries the real (space- and apostrophe-laden) filename,
while the schema layers a readable `title`/`description` over the bytes. The
**`rel` table classifies it**, one named edge per tag, each an absolute pointer
into the tag tree:

```yaml
  papers:
    type: object
    properties:
      superluminal-neutrino:
        type: binary
        format: application/pdf
        title: Can Apparent Superluminal Neutrino Speeds Be Explained as a Quantum Weak Measurement?
        description: Berry et al., J. Phys. A, 2011 — abstract in full, "Probably not."
        x-yamlover:
          concrete: file/binary
          os:
            path: 1110.2832v2.pdf            # the actual file in this directory
          rel:                               # ↓ classification — each edge a tag
            quantum:         /tags/field/physics/quantum
            particle:        /tags/field/physics/particle
            one-word-answer: /tags/genre/brevity/one-word-answer
            deadpan:         /tags/genre/humor/deadpan

      fermat-library-annotated:
        type: binary
        format: text/html
        title: "Fermat's Library: the Lander–Parkin paper, annotated"
        x-yamlover:
          concrete: file/binary
          os:
            path: "Fermat's Library _ Shortest paper ever … annotated_explained version..html"
          rel:
            number-theory: /tags/field/mathematics/number-theory
            annotation:    /tags/genre/annotation
            source:        /papers/euler-counterexample   # not a tag — a paper→paper edge
```

How it reads:

- **A tag is just a node, and tagging is just a `rel` edge.** There is no special
  "tag" machinery — the taxonomy is ordinary containment, and classification reuses
  the same up-edge table as [14-genealogy-dag](#14-genealogy-dag). A paper can carry
  as many edges as it has tags; the edge *name* is the tag's own name, so the
  relation reads off the schema (`one-word-answer: /tags/genre/brevity/one-word-answer`).
- **The pointers are absolute (`/…`), anchored at the enclosing entity** — here the
  root — so every edge resolves to a location **inside the current document**. The
  server renders each one as a hyperlink to the tag node it names.
- **`rel` is not tags-only.** The Fermat's Library entry is an annotated edition of
  the Lander–Parkin paper, so alongside its tags it carries a `source` edge to that
  paper — a plain paper-to-paper relation, distinct from classification.
- **The files are described, not duplicated.** Each paper node *is* the file already
  sitting in the directory; `os.path` claims it, so it is presented through its
  schema-given title rather than surfaced as a stray entry.

This "absolute pointer = inside the current document" reading is the seed of a
larger idea: letting a `rel` edge also be written as a full URI — a tree-wide scope
(`https://<tree>/tags/…`) or a built-in, universal tag vocabulary
(`https://schemas.yamlover.org/…`) — without changing what a paper→tag edge *is*.

# 19-math-chapter

A small chapter that shows the **two ways math appears**, side by side in one
body — the same KaTeX engine behind both.

1. **Inline math, in *marklower* prose.** marklower is the default chunk format: a
   bare `string` with no `format`. The chunks' `items` base declares only
   `type: string` (no `format:`), so a plain `const:` routes to the marklower
   renderer, which typesets any `$$…$$` span inline and passes the rest of the text
   through. Euler's identity $$e^{i\pi} + 1 = 0$$ sits *inside* a sentence this way.
2. **Whole standalone formulas, as LaTeX chunks.** A chunk that overrides
   `format: text/x-latex` is typeset *in its entirety* as one display block by the
   LaTeX renderer (e.g. the Gaussian integral, a summation). No `$$` delimiters —
   the whole string is the formula.

```yaml
$ref: '#/$defs/chapter'
title: A Pinch of Math
properties:
  chunks:
    prefixItems:
      - const: >-                            # marklower: inline $$…$$ in prose
          … Euler's identity $$e^{i\pi} + 1 = 0$$ ties together five constants …
      - format: text/x-latex                 # a whole standalone formula
        const: \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$defs:
  chapter:
    type: object
    format: x-yamlover-chapter
    properties:
      chunks:
        type: array
        items: { type: string }              # no `format:` → marklower default
```

How it reads:

- **marklower is the floor, not a format you opt into.** Any chunk that names no
  format lands here, so prose is the path of least resistance and inline math comes
  for free. Reaching for `text/x-latex` is the deliberate act — it says "this
  formula is the whole chunk."
- **One math engine, two entry points.** marklower's inline `$$…$$` and the
  `text/x-latex` renderer both call the same KaTeX path, so an inline fragment and a
  standalone block render identically — only the surrounding context differs.

# 20-marklower-links

A documentation tree that is **about its own links**: nested subchapters, each
demonstrating one flavour of marklower link. Links live in the app's **JSON
instance space** — the same space the tree, breadcrumbs, and URL navigate — and
take their addressing from how an `x-yamlover` `rel` pointer is written:

Resolving against the repo served as root (so this guide is at
`/examples/20-marklower-links`):

| marklower            | anchor                                   | example resolves to                       |
| -------------------- | ---------------------------------------- | ----------------------------------------- |
| `[t](/path)`         | **document** root (nearest yamlover entity) | `/examples/20-marklower-links/path`    |
| `[t](//path)`        | **project** root (served directory)      | `/path`                                   |
| `[t](https://…)` `mailto:` | external                           | opens in a new tab                        |

The links use the path itself as the visible label, so the marklower code is on
display: `document-relative links at [/children[0]](/children[0])`.

```yaml
$ref: '#/$defs/chapter'
title: A Tour of marklower Links
properties:
  chunks:
    prefixItems:
      - const: >-
          Jump to document-relative links at [/children[0]](/children[0]) …, or
          leave for the KaTeX project at [https://katex.org](https://katex.org).
  children:
    prefixItems:
      - title: Project-root links
        properties:
          chunks:
            prefixItems:
              - const: "… a sibling example at [//examples/19-math-chapter](//examples/19-math-chapter)."
$defs:
  chapter:
    type: object
    format: x-yamlover-chapter
    properties:
      chunks:   { type: array, items: { type: string } }  # marklower
      children: { type: array, items: { $ref: '#/$defs/chapter' } }
```

How it reads:

- **"Document" means the literal document — the entity, not the page you are on.**
  A `/…` link resolves the same from a chunk three subchapters deep as from the top:
  `[the guide's intro](/chunks[0])` always lands on the document's first chunk,
  never on a local one. The anchor is the nearest yamlover entity, reported by the
  server as the node's `documentPath` (the same `entityRootSegs` an absolute `/…`
  rel pointer already uses).
- **`//` reaches across documents, and counts from the served root.** A sibling
  example is `//examples/19-math-chapter` *when the repo is served* — a single `/`
  would have stayed inside this guide. The catch: the prefix depends on where
  yamlover was launched (serve `examples/` directly and it is just
  `//19-math-chapter`), so `//` links are only as portable as the mount point.
  Document-relative `/…` links, anchored at the entity, are mount-independent.
- **One link interpreter, shared.** Every marklower link goes through the same
  `resolveLink` seam, the place refs and rels are expected to adopt later (gaining
  the full pointer grammar — `..`, `^name`, virtual children) without each renderer
  re-deciding what a target means.

# 21-office-docs

A **plain directory of office documents**, one per supported binary format, served
without a schema (like [06-plain-dir](#06-plain-dir)) — each file's renderer is
chosen from its extension-inferred `(type, format)`:

| file          | format                                                                     | renderer                                  |
| ------------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| `sample.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`   | `docx` — [mammoth](https://github.com/mwilliamson/mammoth.js) → HTML |
| `sample.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`         | `spreadsheet` — [SheetJS](https://sheetjs.com), sheet tabs + table |
| `sample.xls`  | `application/vnd.ms-excel`                                                  | `spreadsheet` (legacy BIFF, same renderer) |
| `sample.rtf`  | `application/rtf`                                                           | `rtf` — a small dependency-free converter |

Legacy `.doc` (Word 97–2003) has its own `doc` renderer, but the old binary format
has no reliable in-browser parser, so it is shown as a download link rather than a
(broken) conversion — faithful rendering would need a server-side step (LibreOffice).
