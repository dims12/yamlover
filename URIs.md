# Global JSON space and graph-like references

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

One can use # to startfrom current document root

```yamlover
pets: *https://pet.store.com/pets
humans:
- name: Alice Johnson
  age: 34
  gender: female
  manager: *#/pets[1]
- name: Marcus Lee
  age: 28
  gender: male
  manager: *#/pets[0]
- name: Priya Patel
  age: 45
  gender: female
  manager: *#/pets[2]
```


## Pointer grammar & resolution

Every key is a pointer. `*` **dereferences** a pointer; `&` **defines / relocates**
one. Resolution is lazy and yields a **graph edge, not a copy** — `*` shares the
target node, so a YAMLOVER tree is really a DAG.

### Where a pointer starts (the base)

A pointer with no leading scope sigil is resolved **against the current mapping**
— the object that contains the pointer:

- `*cat` → key `cat` of the current mapping (a sibling).
- `*../x` → `..` is the parent **node**; walk up, then descend.

There is **no implicit search up the ancestors**: a bare name is current-mapping
only. Reach outward explicitly with `..`, `#`, `/`, or a URI. (This avoids
fragile dynamic-scope capture.)

### Four scopes (the ladder)

| Form               | Base                          | Example                          |
|--------------------|-------------------------------|----------------------------------|
| `*name`, `*../…`   | current mapping / its parents | `*cat`, `*../../pets[1]`          |
| `*#/…`             | current **document** root     | `*#/pets[1]`                     |
| `*/…`              | current **project/tree** root | `*/config/db`                    |
| `*scheme://auth/…` | external graph (virtual id)   | `*https://pet.store.com/pets`    |

Well-known names: `*project` = current project root (≡ `/`), `*yamlover` = the
yamlover project itself.

### Grammar (ABNF-ish)

```
deref    = "*" pointer
define   = "&" pointer            ; binds a node so *pointer resolves to it
pointer  = scope *( "/" step )
scope    = authority              ; scheme://proj.company   (external)
         / "#"                    ; current document root
         / "/"                    ; project / tree root
         / step                   ; relative to current mapping (name or "..")
step     = ( name / ".." ) [ "[" index "]" ]
index    = 1*DIGIT
name     = bareword / "'" literal "'"
```

`[n]` is array indexing, kept distinct from `/n` on purpose: in YAMLOVER an
integer key `1:` and a string key `"1":` can both live in one mapping, so `/1`
would be ambiguous while `[1]` never is.

### Literal segments (escaping)

A key may itself contain `/`, `..`, `*`, brackets, etc. Wrap a segment in single
quotes to take it **literally**, with no metacharacter interpretation:

```yamlover
weird: *../'cat/dog'/x   # second step is the literal key "cat/dog"
dots:  *'..'             # the literal key ".." (not "parent")
```

`''` inside a quoted segment is a literal quote. (For JSON-Schema `$ref` interop
a resolver may additionally accept JSON-Pointer escaping: `~1`=`/`, `~0`=`~`.)

### `&` — define / relocate by path

`&` is the write-side twin of `*`. `&name value` is the familiar anchor (binds
`name` in the current mapping). With a **path**, `&<pointer> value` publishes the
node at that location in the graph — so a node can be defined in one place and
live (logically) in another:

```yamlover
# define Rex once; publish him at the project path /managers/boss
boss: &/managers/boss
  name: Rex
  species: dog

# elsewhere, reach him through that path (same node, shared edge)
team:
  lead: */managers/boss
```

Because edges are shared, anchoring a `*` edge under a `&` path **relocates** what
that path points to:

```yamlover
acting_boss: &/managers/boss */pets[0]   # /managers/boss now resolves to pets[0]
```

> **Open:** conflict policy when two `&` bind the same path — last-wins vs. error.
```
