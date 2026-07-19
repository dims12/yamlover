# Global JSON space and graph-like references

> **Rewritten to the COLON grammar (SEPARATOR.md, 2026-06-13).** The path separator
> is `:` — the same character that means "key leads to value" everywhere in the
> family — and the scope ladder is "more colons, wider scope" (`:` document, `::`
> project, `:::` world). The old `/` separator and the `//authority` link form are
> DEPRECATED: parsers still accept them through the migration window, serializers
> emit colon only. Canonical styling writes `: ` (colon + space) in block positions;
> machine surfaces (store keys, API paths) use the compact form (`:team:alice:age`).

## Languages: json5p and yamlover

Two surface notations appear below; both denote the same data + pointer model.

**json5p** — *JSON5 + pointers*. JSON5 already adds comments, trailing commas,
unquoted keys and single-quoted strings to JSON; **json5p** further adds
**pointers** — the `*` dereference family and keys-as-pointers, `~` back-edges, and
`&` anchors. It is a strict superset:

    JSON  ⊂  JSON5  ⊂  json5p

**yamlover** — a *language* close to **YAML** but NOT a superset: it shares the
surface syntax yet diverges on links/anchors (YAMLOVER.md §3; `&`/`*` are pointer-model
constructs, read concrete-aware). It adds the same **pointers** (extended `*`), and it
supports multiple **concretes** — concrete materializations of one logical document —
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

JSON path is also both string and pointer. (This section is about *paths as
pointers* — single-target addressing. Multi-match *querying* — wildcards, descent,
graph axes — is `QUERY.md`, which extends this same grammar.)

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
          "manager": *"..:..:pets[1]"
      },
      {
          "name": "Marcus Lee",
          "age": 28,
          "gender": "male",
          "email": "marcus.lee@example.com",
          "height_cm": 181,
          "occupation": "Graphic Designer",
          "married": false,
          "manager": *"..:..:pets[0]"
      },
      {
          "name": "Priya Patel",
          "age": 45,
          "gender": "female",
          "email": "priya.patel@example.com",
          "height_cm": 159,
          "occupation": "Pediatrician",
          "married": true,
          "manager": *"..:..:pets[2]"
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
  manager: *..: ..: pets[1]
- name: Marcus Lee
  age: 28
  gender: male
  manager: *..: ..: pets[0]
- name: Priya Patel
  age: 45
  gender: female
  manager: *..: ..: pets[2]
```

The URIs are global and virtual — **identities, not fetch instructions** — like an
AWS ARN (`arn:aws:s3:::bucket`): a pure colon-chained name. A `*` never performs a
network request; the world authority is a namespace tag resolved against the local
mount table. Structure:

    ::: {project-name}.{company.name}: json: space: path

e.g. `::: pet.store.com: pets` — authority `pet.store.com` =
`{project-name=pet}.{company.name=store.com}`, then the path portions. Schemes,
ports, and paths-with-slashes are gone from the identifier: how an engine *reaches*
that project — https, ssh, a local checkout, sync mirrors — is engine
configuration, never part of the name. (The old `scheme://authority/path` link form
is retired with the slash; parsers accept it through the migration window.)

For example

```yamlover
pets: *::: pet.store.com: pets
humans:
- name: Alice Johnson
  age: 34
  gender: female
  manager: *..: ..: pets[1]
- name: Marcus Lee
  age: 28
  gender: male
  manager: *..: ..: pets[0]
- name: Priya Patel
  age: 45
  gender: female
  manager: *..: ..: pets[2]
```

A **leading `:`** starts from the current document root (one rung down the ladder;
`..` chains are usually better spelled this way):

```yamlover
pets: *::: pet.store.com: pets
humans:
- name: Alice Johnson
  age: 34
  gender: female
  manager: *: pets[1]
- name: Marcus Lee
  age: 28
  gender: male
  manager: *: pets[0]
- name: Priya Patel
  age: 45
  gender: female
  manager: *: pets[2]
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
- **`: x`** selects the **string key** `x` (a colon portion).

Ordering is data: in a file it follows text order; for a directory it is imposed by
the `body.yamlover` overlay (an array of `*`-pointers to the files), or left to the
filesystem if there is no overlay.

## Pointer grammar & resolution

Every key is a pointer. `*` **dereferences** a pointer (and is the only thing that
creates an edge); `&` is an ordinary **YAML anchor** that declares a name. Resolution
is lazy and yields a **graph edge, not a copy** — `*` shares the target node.
Pointers are the **singleton fragment of the query language** — every pointer is a
query with at most one result; see `QUERY.md`.

Containment (a key holding its value) is an **acyclic spine** — the tree. The `*` and
`~` edges laid on top of it may point anywhere, including back to an ancestor, so the
full structure is a **general graph, not a DAG**. Traversal is therefore cycle-safe,
and a `*` edge is never expanded inline to infinity.

### Where a pointer starts (the base)

A pointer with no leading scope sigil is resolved **against the current mapping**
— the object that contains the pointer:

- `*cat` → key `cat` of the current mapping (a sibling).
- `*..: x` → `..` is the parent **node**; walk up, then descend.

There is **no implicit search up the ancestors**: a bare name is current-mapping
only. Reach outward explicitly with `..`, or a wider rung of the ladder — `:` (the
document root), `::` (the project root), `:::` (the world). (This avoids fragile
dynamic-scope capture.)

### The scopes (the ladder) — more colons, wider scope

| Form               | Base                                                     | Example                        |
|--------------------|----------------------------------------------------------|--------------------------------|
| `*name`, `*..: …`  | current mapping / its parents                            | `*cat`, `*..: ..: pets[1]`     |
| `*: …`             | current **document** root                                | `*: pets[1]`                   |
| `*:: …`            | current **project** root                                 | `*:: $defs: tag`               |
| `*::: auth: …`     | the **world** — an ARN-like identity, never fetched      | `*::: pet.store.com: pets`     |

A **world** base names a project by its authority (`{project}.{company}` DNS name);
resolution goes through the local mount table — a link is an identifier, not a
fetch. Imports are root-level keys whose value is a world-scoped link
(`yamlover: *::: yamlover.inthemoon.net`); inside this project the self-import
makes `:: $defs: tag` ≡ `:: yamlover: $defs: tag`. (Deprecated, accepted through
the migration window: `/`-separated paths, a single leading `/` for the document
root, and `//auth` / `scheme://auth` links.)

### Grammar (ABNF-ish)

```
deref    = "*" pointer            ; dereference → a graph edge to the target (pull)
define   = "&" pointer [ "[]" ]   ; PATH anchor: this node is ALSO at that path (push);
                                  ;   trailing "[]" = ordinal membership (append)
backedge = "~" name               ; DEPRECATED key prefix (see §~): ~key: *P ≡ &P: key
pointer  = scope *( ":" portion )
scope    = ":::" ws authority     ; the world — an ARN-like project identity
         / "::"                   ; current project root
         / ":"                    ; current document root
         / ".."                   ; parent node
         / portion                ; STRING key / position in the current mapping
portion  = ( name / ".." ) *( index / relindex )
         / 1*( index / relindex ) ; a bare position, e.g. *[1], *[.-1]
index    = "[" 1*DIGIT "]"        ; selects the integer key n
relindex = "[" "." [ ("+" / "-") 1*DIGIT ] "]" ; the host's own position at this depth, ± k
name     = 1*( nchar / "\" CHAR ) ; selects a string key; "\" escapes a metachar
         / quoted                 ; a key containing a SPACE must be quoted ('…' / "…")
nchar    = <any char except unescaped  : [ ] * & # ~ ? ! ( ) < > = |  or whitespace>
ws       = *( SP )                ; canonical styling: ": " after each separator;
                                  ;   the space is optional on input, absent in flow
```

`[n]` selects the **integer key** `n` (a position); `: x` selects the **string
key** `x`. With one ordered container (see *Lists and dicts are one ordered
mapping*), this is the only distinction needed — the old worry of an integer key
`1:` versus a string key `"1":` is simply `[1]` versus `: 1`.

The empty brackets `[]` are legal only as the **last** token of an anchor (`&…[]`,
ordinal membership — see §`&`); they never appear in a `*` pointer. The query
wildcard `[?]` belongs to `QUERY.md` only.

### Relative indexes — `[.]`, `[.-1]`, `[.+2]`

A dot in the brackets makes the index **relative to the pointer's own position**: `.` is
"my position at this depth", and an offset is arithmetic on it — `[.-1]` one before me,
`[.+2]` two after me, bare `[.]` exactly my position. (Bracket bodies stay disjoint by
form: digits = absolute, `.` = relative, `?` = query wildcard. A plain `[-1]` is
deliberately *not* taken — it stays free for a possible future from-the-end index.)

Resolution is the **frame rule (depth alignment)**: the frame is the **host entry's own
path** — the entry holding the pointer. After the base and any `..` ascents, each step of
the pointer consumes one depth; a `[.±k]` at depth *d* selects position *(the host's
position at depth d) ± k*. Keyed entries hold positions too (see *Lists and dicts are one
ordered mapping*), so the frame always exists.

The motivating idiom is the **table** (`MARKLOWER.md`) — a cell at row *r*, column *c* naming
its adjacent previous cells (the base of a bare pointer is the current mapping — the row):

```yamlover
- *[.-1]          # the cell to my LEFT: row r, column c-1        → a colspan
- *..[.-1][.]     # the cell ABOVE: .. to the table, previous row, my column → a rowspan
```

A relative index yields **at most one successor**, so it is a *link*, authorable after `*`
(SEPARATOR.md §5 classifies it unambiguous). Out of range (`[.-1]` in the first position)
is the ordinary dangling-pointer diagnostic. In `&` **anchors it is rejected**: an anchor
claiming a position is already outlawed (`&path[3]`, §`&`), and a relative claim is still
a claim.

### Literal characters (escaping)

A key may itself contain a metacharacter — `: [ ] * & # ~ \`, the query characters
`? ! ( ) < > = |` (reserved for `QUERY.md`; pointers and queries share one lexical
space), or an all-dots segment `..` / `...` (parent / query descent). Escape it with
a **backslash**, which suppresses the pointer meaning of the next character; a key
containing a **space** must instead be quoted (`'…'` / `"…"` — the host surface's
string quoting). Backslash escaping carries the literal-vs-interpreted distinction
that quotes cannot: in JSON5 and YAML `'` and `"` are interchangeable string
delimiters — `*".."` and `*'..'` are the same string, both meaning *parent*.

What `/` gained by leaving the metachar set: MIME-type keys (`text/html`), date
keys (`01/02/2026`) and URL-ish keys now ride **bare** in paths. (During the
migration window `\/` still parses.)

```yamlover
mime:  *..: text/html: x     # "/" is no metacharacter — the key "text/html" rides bare
colon: *schedule: 09\:30     # a literal ":" inside the key "09:30"
space: *: tags: 'дорожный знак'  # a key with a space — quoted
dots:  *\.\.                 # the literal key ".." (not "parent")
star:  *\*boss               # the literal key "*boss"
```

(For JSON-Schema `$ref` interop a resolver may additionally accept JSON-Pointer
escaping: `~1`=`/`, `~0`=`~`.)

### `&` — path anchors (the push side of `*`)

> **Implemented** (spec'd 2026-06-12, `ANCHOR_REFACTOR.md`; landed with PLAN.md
> Phase A). Both parsers emit path anchors (`pointer.ts makeAnchor` →
> `NodeMeta.anchors`) and the resolver realizes them as ref edges
> (`resolve.ts realizeAnchors`). The previous name-only anchor — and its
> anchor-over-sibling-key precedence rule — is gone: `*name` is pure path lookup.

`*path` **pulls** — "my value lives there". `&path` **pushes** — "I *also* live
there". An anchor's name is a full pointer path (same scope ladder — current /
`..` / `:` document / `::` project / `:::` world — same metachars, same backslash
escaping). Declaring `&P: k` on a node means: the container at `P` gains the entry
`k`, a **ref edge to this node**. The authored position stays the containment
spine and the node's identity path; anchor-created entries are ordinary non-owning
ref edges, exactly what a forward `k: *me` authored at `P` would produce —
`normalize` folds the two authorings of one edge together (see *Collisions*
below).

```yamlover
humans:
  - age: 30
    pet: &: supercat    # this pet node is ALSO the document-root key "supercat"
      species: cat
      color: pink
  - age: 10
    pet: *: supercat    # plain path — no anchor namespace involved
```

**Anchors are real keys, not a separate namespace.** `*name` is pure path lookup;
the old precedence rule (a declared anchor shadows a sibling key) is gone, and with
it the `*whiskers` local-vs-global ambiguity. This deliberately changes the meaning
of plain-YAML `&a` … `*a` pairs — see `YAMLOVER.md` §3.

**Anchors are not entries.** They never count toward a node's kind: a scalar with
anchors is still a scalar, a blob is still a blob — the same rule that keeps a
reverse-tagged PDF `binary`. No `!!var` is needed to anchor a scalar. An anchor
attaches to a NODE; a pointer entry (`k: *p`) cannot carry one.

**Multiplicity & placement.** A node may declare any number of anchors: on the
value's line (the YAML anchor position — quoted when colon-styled, e.g.
`path: &': another: path' 12`) or on their own lines inside the node's block; the
CANONICAL style puts them on their own lines after the value (own-line tokens run
to end of line, no quoting needed). A whole-document scalar can therefore be
tagged in two bare lines:

```yamlover
30
&:: tags: field: mathematics: numbers: whole[]
```

**Ordinal anchors — `&path[]`.** A trailing `[]` makes the membership **keyless**:
the container at `path` gains this node as a positional member. The rules carry
over from `~-` verbatim: **no position may be claimed** (`&path[3]` is rejected —
order is the container's own data; an anchor declares *that* it holds me, never
*where*); membership is **additive** (each `[]` appends one element; lists may
repeat) **except into a `!!set`**, where duplicates — forward, anchored, or both —
collapse by target. Anchor-created members project after the container's own
entries, lexicographically by member path.

**Collisions.** An anchor-created entry may meet an authored one at the same path.
That is *valid* iff they denote the same thing — the same target node, or
structurally equal values (this is the both-ways authoring the genealogy uses,
folded by `normalize` like any forward+reverse pair):

```yamlover
some:
  path: 12
    &: another: path    # canonical own-line anchor

another:
  path: 12              # same value — the two declarations agree; one node
```

Unequal declarations are a **reported conflict** — surfaced like dangling
pointers, never silently dropped. Anchors within one document are checked at
parse/resolve time; cross-document anchors (project `::` / world `:::` scopes,
document-root scopes across files) are realized and checked by the engine at
index time.

**Relocation is just an edge** — there is no special `&` form for it; point a new
place at the existing node with `*`:

```yamlover
acting_boss: *: pets[0]
```

### `~` — reverse edges (DEPRECATED → path anchors)

> **Deprecated 2026-06-12 (`ANCHOR_REFACTOR.md`)** in favor of path anchors:
>
> ```
> ~key: *P     ≡   &P: key       (keyed reverse edge)
> ~- *P        ≡   &P[]          (keyless reverse membership)
> ```
>
> Both forms produce identical normalized edges. The acceptance example — the
> 67-pdf-tags blob, whose three `~` lines become three anchors with the same
> three edges:
>
> ```yamlover
> "Chemical-Free.pdf":                                    "Chemical-Free.pdf":
>   ~chemical-free: *: tags: field: chemistry               &: tags: field: chemistry: chemical-free
>   ~chemical-free: *: tags: genre: brevity: empty-body     &: tags: genre: brevity: empty-body: chemical-free
>   ~chemical-free: *: tags: genre: humor: satire           &: tags: genre: humor: satire: chemical-free
> ```
>
> Parsers keep accepting `~` through the migration window (PLAN.md Phase A);
> serializers will emit anchors only. The `~` reverse **axis** in `QUERY.md` is
> unaffected — after the window, `~` means "reverse" only in the query language.
> The text below remains authoritative for the shared *semantics* (the graph
> edges are the same either way).

The key name always denotes the **forward** relation; a `~` prefix **reverses** it.
So `~X` on a node is "the source of the forward `X`-edge that lands here" — and it
works whether the forward `X` is a containment edge or a `*` reference:

```yamlover
eve:
  cain: *: adam: cain    # forward:  eve --cain--> cain
adam:
  cain:
    ~cain: *: eve        # reverse of eve's "cain" edge → eve
```

A `~` edge is **up / non-owning**: it is not part of the containment spine (so the
*tree* stays acyclic while the *graph* gains the back-link), is **never expanded
inline**, may point to an ancestor, and materializes on a filesystem as a **symlink**.

**Containment and `*` are the same relation kind, keyed by the child's name.** A
parent's child-edge is labelled by the child (`eve --cain--> cain`) whether it is drawn
by *containment* (the spine — the structural parent) or by a `*` pointer (a second parent
off the spine). So "two parents" is just **two same-named child-edges into one node** —
the directed graph the model implements (see `examples/58-genealogy-dag`: the spine is the
paternal line, a `*` edge is the maternal one, both `descends` the child; genealogy happens
to be acyclic, but `*`/`~` edges may form cycles — see §"general graph" above). `~name: *parent`
is then exactly the reverse view of `parent.name: *child` — "parent descends me, as
`name`".

The model is a **graph kept exactly as written.** Placement is yours (a node lives
where it is written inline and is reused elsewhere by `*` alias), and for any relation
you may author the forward edge, its `~` reverse, or **both** — valid as long as the
two do not contradict. Since `~X` is by definition the inverse of `X`, one side is
always derivable; the engine keeps what you wrote and offers a `normalize` command to
reduce a tree to a canonical **forwards-only** form (see `ENGINE.md`).

#### `~-` — reverse *positional* membership (keyless; DEPRECATED → `&path[]`)

A forward entry need not be keyed — `- *me` is a keyless, positional member. Its
reverse follows the same sigil rule: **`~` tight against what the forward entry starts
with** — a key (`~name:`) or the `-` marker (`~-`):

```yamlover
my_node:
  ~- *: some: other: location   # ⇒ the container at : some: other: location has  - *…my_node
```

(In json5p, which has no `-` marker, the sigil prefixes the pointer directly:
`~*':some:other:location'`.) A `~-` entry's value must be a pointer — a back-edge needs
a target.

Keyless reversal differs from keyed reversal in two deliberate ways:

- **No reverse index — `~[n]:` is rejected.** Order is the *container's* data (text
  order in its source; the `body.yamlover` pointer-array for a directory). A remote
  node claiming "I am element `[3]`" would be a second writer for single-writer data:
  any insertion in the container silently invalidates the claim, and two members can
  claim the same slot. If an exact position matters, author it forward — the container
  lists `- *member` where it wants it. A `~-` membership is **unpositioned**: it
  declares *that* the container holds me, never *where*.
- **Additive, not deduplicated.** A keyed pair (`X: *b` at `a` and `~X: *a` at `b`)
  is one relation authored twice — the label gives it identity, and the engine
  reconciles the pair. A keyless membership has no label and no index, hence **no
  identity to match on**: every `~-` declaration ADDS one element to the container,
  even when a forward `- *member` (or another `~-`) to the same node already exists —
  lists may contain repetitions, and collapsing them would silently destroy data. The
  cost: redundant both-ways authoring of *one* membership is not available keyless —
  unless the container is a **`!!set`**.

Reverse-authored members are projected **after** all of the container's own in-place
entries, ordered **lexicographically by the member's path** (deterministic and
reconstructible from the graph alone). They never affect the container's *kind* —
a container's type comes from its owned entries only.

**`!!set`** (a value-position tag, like `!!mix`/`!!var`; the inline spelling of the
schema keyword `uniqueItems: true`, which is the route for json5p and overlays) opts a
container into **set semantics**: membership is by identity, so duplicate memberships —
forward+forward, forward+reverse, reverse+reverse — collapse to one. (yamlover
reinterprets YAML's `!!set` tag; see the divergence list in
`tools/parser/YAML-CONFORMANCE.md`.)

`~` is a single, dedicated sigil. Like `* & # /`, a `~` that is part of a literal key
must be backslash-escaped (`\~`).
