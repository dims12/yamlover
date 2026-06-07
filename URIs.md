# Global JSON space and graph-like references

## Languages: json5p and yamlover

Two surface notations appear below; both denote the same data + pointer model.

**json5p** — *JSON5 + pointers*. JSON5 already adds comments, trailing commas,
unquoted keys and single-quoted strings to JSON; **json5p** further adds
**pointers** — the `*` dereference family and keys-as-pointers, `~` back-edges, and
`&` anchors. It is a strict superset:

    JSON  ⊂  JSON5  ⊂  json5p

**yamlover** — a *language* that is a superset of **YAML**. It adds the same
**pointers** (extended `*`; `&` stays a plain YAML anchor), and it supports
multiple **concretes** — concrete materializations of one logical document —
including the **filesystem** (a directory is a mapping, a file is a value / blob),
not only a single text file:

    YAML  ⊂  yamlover

So json5p is to JSON what yamlover is to YAML: the brace-notation surface and the
indentation / filesystem surface over one shared pointer model. Any of them can
be materialized into the others — including onto a filesystem tree — and back.

## Dictionary key

Key of json can be a string, for example, `"cat"`

```json5p
{
    "cat": "furry manager supervising humans life"
}
```

```yamlover
cat: furry manager supervising humans life
```

it is also a pointer, that can be dereferenced by asterisk `*`:

```json5p
{
    "cat": "furry manager supervising humans life",
    "feline": *"cat"
}
```

```yamlover
cat: furry manager supervising humans life
feline: *cat
```

## JSON Path

JSON path is also both string and pointer

```json5p
{
    "pets": [
         {
          "name": "Rex",
          "species": "dog",
          "breed": "German Shepherd",
          "age": 4,
          "weight_kg": 32.5,
          "vaccinated": true,
          "color": "black and tan"
      },
      {
          "name": "Whiskers",
          "species": "cat",
          "breed": "Maine Coon",
          "age": 2,
          "weight_kg": 6.8,
          "vaccinated": true,
          "color": "gray tabby"
      },
      {
          "name": "Bubbles",
          "species": "fish",
          "breed": "Goldfish",
          "age": 1,
          "weight_kg": 0.05,
          "vaccinated": false,
          "color": "orange"
      }
    ],
    "humans":  [
      {
          "name": "Alice Johnson",
          "age": 34,
          "gender": "female",
          "email": "alice.johnson@example.com",
          "height_cm": 168,
          "occupation": "Software Engineer",
          "married": true,
          "manager": *"../../pets[1]"
      },
      {
          "name": "Marcus Lee",
          "age": 28,
          "gender": "male",
          "email": "marcus.lee@example.com",
          "height_cm": 181,
          "occupation": "Graphic Designer",
          "married": false,
          "manager": *"../../pets[0]"
      },
      {
          "name": "Priya Patel",
          "age": 45,
          "gender": "female",
          "email": "priya.patel@example.com",
          "height_cm": 159,
          "occupation": "Pediatrician",
          "married": true,
          "manager": *"../../pets[2]"
      }
  ]
}
```

```yamlover
pets:
- name: Rex
  species: dog
  breed: German Shepherd
  age: 4
  color: black and tan
- name: Whiskers
  species: cat
  breed: Maine Coon
  age: 2
  color: gray tabby
- name: Bubbles
  species: fish
  breed: Goldfish
  age: 1
  color: orange
humans:
- name: Alice Johnson
  age: 34
  gender: female
  manager: *../../pets[1]
- name: Marcus Lee
  age: 28
  gender: male
  manager: *../../pets[0]
- name: Priya Patel
  age: 45
  gender: female
  manager: *../../pets[2]
```

The URIs are global and virtual, and are written like JSON-Schema `$id`/`$ref`
URIs — they are **identifiers, not fetch instructions**. A `*` never performs a
network request; the scheme is optional and ignored for resolution, and the
authority is a namespace tag resolved against the local mount table. Structure:

    [{scheme}://]{project-name}.{company.name}/json/space/path

e.g. `https://pet.store.com/pets` — scheme `https:` (ignored), authority
`pet.store.com` = `{project-name=pet}.{company.name=store.com}`, path `/pets`.

For example

```yamlover
pets: *https://pet.store.com/pets
humans:
- name: Alice Johnson
  age: 34
  gender: female
  manager: *../../pets[1]
- name: Marcus Lee
  age: 28
  gender: male
  manager: *../../pets[0]
- name: Priya Patel
  age: 45
  gender: female
  manager: *../../pets[2]
```

One can use a leading `/` to start from the current document root

```yamlover
pets: *//pet.store.com/pets
humans:
- name: Alice Johnson
  age: 34
  gender: female
  manager: */pets[1]
- name: Marcus Lee
  age: 28
  gender: male
  manager: */pets[0]
- name: Priya Patel
  age: 45
  gender: female
  manager: */pets[2]
```


## Lists and dicts are one ordered mapping

There is no separate list type. A mapping is **ordered**, and its **positions are
integer keys** added as pointers — so a "list" is just a mapping whose keys are
`0, 1, 2, …`. A keyless entry, written with a leading `:`, takes only its position.
This dict:

```yamlover
key0: value0
: value1
key2: value2
```

*means*:

```yamlover
key0: value0
0: *key0        # position 0 aliases the keyed entry
1: value1       # keyless entry — its value lives at its integer key
key2: value2
2: *key2
```

A **keyed** entry's position is a `*`-alias to it; a **keyless** entry's value lives
directly at its integer key. It is all one mapping with integer ∪ string keys —
"YAML with pointers." (A YAML `- value` sequence item is the same keyless entry; `:`
is just its mapping-style spelling.) Two access syntaxes keep the axes apart:

- **`[n]`** selects the **integer key** `n` (position).
- **`/x`** selects the **string key** `x`.

Ordering is data: in a file it follows text order; for a directory it is imposed by
the `body.yamlover` overlay (an array of `*`-pointers to the files), or left to the
filesystem if there is no overlay.

## Pointer grammar & resolution

Every key is a pointer. `*` **dereferences** a pointer (and is the only thing that
creates an edge); `&` is an ordinary **YAML anchor** that declares a name. Resolution
is lazy and yields a **graph edge, not a copy** — `*` shares the target node.

Containment (a key holding its value) is an **acyclic spine** — the tree. The `*` and
`~` edges laid on top of it may point anywhere, including back to an ancestor, so the
full structure is a **general graph, not a DAG**. Traversal is therefore cycle-safe,
and a `*` edge is never expanded inline to infinity.

### Where a pointer starts (the base)

A pointer with no leading scope sigil is resolved **against the current mapping**
— the object that contains the pointer:

- `*cat` → key `cat` of the current mapping (a sibling).
- `*../x` → `..` is the parent **node**; walk up, then descend.

There is **no implicit search up the ancestors**: a bare name is current-mapping
only. Reach outward explicitly with `..`, `/` (the document root), or a **link**
(a URI authority). (This avoids fragile dynamic-scope capture.)

### The scopes (the ladder)

| Form                            | Base                                                                  | Example                  |
|---------------------------------|-----------------------------------------------------------------------|--------------------------|
| `*name`, `*../…`                | current mapping / its parents                                         | `*cat`, `*../../pets[1]` |
| `*/…`                           | current **document** root                                             | `*/pets[1]`              |
| `*//auth/…`, `*scheme://auth/…` | a **link** — any *other* start (project, sibling doc, external graph) | `*//pet.store.com/pets`  |

A **link** is a URI authority; the scheme is optional and ignored (a link is an
identifier, not a fetch). Everything that is neither current-mapping-relative nor the
document root (`/`) is reached as a link — **including the project/tree root**. The
single leading `/` is the document root; a leading `//` introduces a link authority.
Well-known names: `*project` = the current project root (a link), `*yamlover` = the
yamlover project itself.

### Grammar (ABNF-ish)

```
deref    = "*" pointer            ; dereference → a graph edge to the target
define   = "&" name               ; anchor (intra-document, single name); yamlover & json5p
backedge = "~" name               ; key prefix: a back / non-owning edge (see below)
pointer  = scope *( "/" ( name / ".." ) / index )
scope    = link                   ; any OTHER start: project, sibling doc, external
         / "/"                    ; current document root  (a single leading "/")
         / ".."                   ; parent node
         / name                   ; STRING key in the current mapping
         / index                  ; INTEGER key (position) in the current mapping
link     = ( scheme "://" / "//" ) authority   ; scheme optional & ignored
index    = "[" 1*DIGIT "]"        ; selects the integer key n
name     = 1*( nchar / "\" CHAR ) ; selects a string key; "\" escapes a metachar
nchar    = <any char except unescaped  / [ ] * & # ~  or whitespace>
```

`[n]` selects the **integer key** `n` (a position); `/x` selects the **string key**
`x`. With one ordered container (see *Lists and dicts are one ordered mapping*), this
is the only distinction needed — the old worry of an integer key `1:` versus a string
key `"1":` is simply `[1]` versus `/1`.

### Literal characters (escaping)

A key may itself contain a metacharacter — `/ [ ] * & # ~ \` or the literal segment
`..`. Escape it with a **backslash**, which suppresses the pointer meaning of the next
character. Escaping is backslash-based, **not** quote-based: in JSON5 and YAML `'` and
`"` are interchangeable string delimiters, so they cannot carry a "literal vs.
interpreted" distinction — `*".."` and `*'..'` are the same string, both meaning
*parent*.

```yamlover
weird: *../cat\/dog/x    # second step is the literal key "cat/dog"
dots:  *\.\.             # the literal key ".." (not "parent")
star:  *\*boss           # the literal key "*boss"
```

(For JSON-Schema `$ref` interop a resolver may additionally accept JSON-Pointer
escaping: `~1`=`/`, `~0`=`~`.)

### `&` — plain YAML anchors

`&` declares a single name (anchor) for a node, within one document, and `*name`
reuses it. No paths — anything cross-position or cross-document is the job of the
extended `*` (paths, `/`, links). In **yamlover** it is exactly a YAML anchor; in
**json5p** it is the same idea added to JSON5 (`boss: &chief { … }`). The *definition*
side stays familiar in both surfaces; only `*` is extended.

```yamlover
boss: &chief
  name: Rex
  species: dog

team:
  lead: *chief        # same node, shared edge
```

**Relocation is just an edge** — there is no special `&` form for it; point a new
place at the existing node with `*`:

```yamlover
acting_boss: */pets[0]
```

**Precedence.** A bare `*name` could mean a declared anchor *or* a structural sibling
key, so the rule is: **a declared anchor wins; otherwise `*name` is a structural
pointer.** Real YAML docs thus behave identically — anchors shadow sibling keys.

### `~` — reverse edges

The key name always denotes the **forward** relation; a `~` prefix **reverses** it.
So `~X` on a node is "the source of the forward `X`-edge that lands here" — and it
works whether the forward `X` is a containment edge or a `*` reference:

```yamlover
eve:
  cain: */adam/cain      # forward:  eve --cain--> cain
adam:
  cain:
    ~cain: */eve         # reverse of eve's "cain" edge → eve
```

A `~` edge is **up / non-owning**: it is not part of the containment spine (so the
*tree* stays acyclic while the *graph* gains the back-link), is **never expanded
inline**, may point to an ancestor, and materializes on a filesystem as a **symlink**.

**Containment and `*` are the same relation kind, keyed by the child's name.** A
parent's child-edge is labelled by the child (`eve --cain--> cain`) whether it is drawn
by *containment* (the spine — the structural parent) or by a `*` pointer (a second parent
off the spine). So "two parents" is just **two same-named child-edges into one node** —
which is what makes a graph a DAG (see `examples/63-genealogy-dag`: the spine is the
paternal line, a `*` edge is the maternal one, both `descends` the child). `~name: *parent`
is then exactly the reverse view of `parent.name: *child` — "parent descends me, as
`name`".

The model is a **graph kept exactly as written.** Placement is yours (a node lives
where it is written inline and is reused elsewhere by `*` alias), and for any relation
you may author the forward edge, its `~` reverse, or **both** — valid as long as the
two do not contradict. Since `~X` is by definition the inverse of `X`, one side is
always derivable; the engine keeps what you wrote and offers a `normalize` command to
reduce a tree to a canonical **forwards-only** form (see `ENGINE.md`).

`~` is a single, dedicated sigil. Like `* & # /`, a `~` that is part of a literal key
must be backslash-escaped (`\~`).
