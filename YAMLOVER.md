# yamlover — YAML + pointers (+ concretes)

**yamlover** is the indentation / filesystem surface over the shared pointer model — the
twin of `JSON5P.md`'s brace surface. It is a superset of YAML *in features*:

    YAML  ⊂  yamlover

Anything expressible in YAML has a yamlover meaning; yamlover **adds** the pointer layer
(the extended `*`, `~` back-edges, keys-as-pointers; `&` stays) and **adds concretes** —
the same logical document can live in one file *or* as a directory tree. Unlike json5p
(which is a clean strict superset of JSON5), yamlover **deliberately breaks YAML** in a few
spots, so it is *not* byte-for-byte conformant and needs its own parser (see §3, §9).

File extension **`.yamlover`**; a directory is the other concrete (§5).

## 1. Everything from YAML (kept)

yamlover keeps the YAML surface you know:

| Feature | Example |
|---|---|
| Block mappings & sequences | `key: value` / `- item` |
| Flow style | `{a: 1, b: 2}`, `[1, 2, 3]` |
| Comments | `# note` |
| Scalars (plain/quoted/folded/literal) | `a`, `'a'`, `"a"`, `>`, `\|` |
| `null` spellings, incl. `~` **in value position** | `key: ~`  → null |
| `&` anchors and `*` aliases | `&a {…}` … `*a` |

A YAML `- item` sequence entry is the same thing as a keyless `:` entry in the one-ordered
container (§4) — both are an entry with no string key.

## 2. What yamlover adds

The pointer layer, identical in meaning to json5p (grammar in `URIs.md`):

- **Extended `*` — dereference.** Beyond a plain anchor name, `*` takes a **pointer
  expression**: a path with scopes. Unquoted on this surface.
  ```yamlover
  feline: *pets[1]        # current mapping (a sibling) — a shared edge, not a copy
  manager: */pets[1]      # / = current document root
  remote:  *//pet.store.com/pets   # // = a link (any other start); scheme optional, never fetched
  ```
- **Keys are pointers; `[n]` vs `/x`.** Positions are integer keys (`*pets[1]`), names are
  string keys (`*pets[1]/name`). Arrays and mappings are the **one ordered container** (§4).
- **`~` — back-edges (key sigil).** A key prefixed with `~` is the reverse of the forward
  relation it names. The `~` is a **sigil outside the key**:
  ```yamlover
  adam:
    cain:
      ~cain: */eve        # reverse of eve's "cain" edge → eve   (~ = sigil, key = "cain")
  ```
- **`~-` — reverse *positional* membership (keyless back-edge).** The sigil sits tight
  against what the forward entry starts with — a key (`~cain:`) or the `-` marker (`~-`;
  a spaced `~ -` is an error, as is `~ cain:`). The value **must be a pointer** — it names
  the container that holds me:
  ```yamlover
  my_node:
    ~- */some/other/location   # ⇒ that container has an element  - *…/my_node
  ```
  A `~-` membership is **unpositioned** (no `~[n]:` — order is the container's data) and
  **additive**: with no label and no index there is no identity to dedup on, so every `~-`
  adds one element, even alongside a forward `- *me` (lists repeat) — unless the container
  is a `!!set` (§4). Semantics in `URIs.md` §`~-`.
- **`&` anchors — unchanged.** Exactly YAML anchors: a single intra-document name, no
  paths; `*name` reuses the node (precedence: a declared anchor wins over a sibling key).

## 3. Where yamlover deliberately breaks YAML

These are the *only* incompatibilities — everything else is YAML:

| Construct | YAML means | yamlover means |
|---|---|---|
| `*alias` | alias to anchor `alias` (name only) | **pointer** — a path/scope expression (`*a` still hits anchor `a` by precedence, but `*a/b`, `*/x`, `*pets[1]` are new) |
| `~key:` (key position) | the plain-scalar key `"~key"` | **back-edge** sigil on key `key` |
| `~-` (entry position) | the plain scalar `~-` (rare) | **keyless back-edge** — reverse positional membership (§2) |
| `~` (value position) | null | **unchanged — still null** |
| `!!set` | a mapping of null-valued keys | a **set-semantics container** — memberships dedup by identity (§4) |

So a YAML file whose anchor names contain pointer metacharacters (`&a/b` … `*a/b`), or
whose **plain keys begin with `~`**, will read differently. Everything else round-trips.
This is the documented divergence set our conformance harness allowlists (see
`URIs.md` and the conformance notes).

## 4. One ordered container

No separate list/dict type. A mapping is **ordered**; positions are integer keys. A keyless
entry (a `- item` sequence element, or the `:` spelling) takes only its position; a keyed
entry's position is a `*`-alias to it. Access: **`[n]`** = integer key (position), **`/x`**
= string key. Order is data — text order in a file; for a directory, the `body.yamlover`
overlay imposes it (§5). Full treatment in `URIs.md` (*Lists and dicts are one ordered
mapping*).

Concretely, keyless (`- value`) and keyed (`key: value`) entries can be **mixed in one node** —
*partially ordered, partially keyed* — which plain YAML forbids. Mixing keyed and keyless in a
container is **opt-in via a type tag**, so plain yamlover stays a clean YAML superset:

- **`!!mix`** — a container that mixes keyless and keyed entries (a dict ∪ list).
- **`!!omni`** — a node that carries a scalar value **and** fields at once (scalar ⊕ `mix`).
  Unlike `!!mix`, the tag is **optional**: a deeper-indented block under a scalar value is
  invalid YAML outright, so reading it as the node's fields is unambiguous — the shape itself
  is the intention (`key: value` + a deeper block just works; write `!!omni` for explicitness,
  or declare the shape once in a schema as `type: variant`, META.md). The one place the tag is
  still required is the **document root**, where a bare scalar cannot precede the keys.
- **`!!set`** — a container with **set semantics**: an element appears at most once, so
  duplicate memberships — forward+forward, forward+`~-` reverse, reverse+reverse — collapse
  to one (dedup by target). The inline spelling of the schema keyword `uniqueItems: true`
  (`META.md`), which is the route for json5p and directory overlays (no tags there).
  Reinterprets YAML's `!!set` (whose meaning is a null-valued mapping) — see §3.

The tag sits in **value position** — right after the `key:` (or `- `) whose value it types,
exactly where a YAML tag goes. `!!mix` precedes a (mixed) block; `!!omni` precedes the
node's own scalar value, with the fields in the block below:

```yamlover
playlist: !!mix
  - Intro                 # [0]            keyless / positional
  - Verse                 # [1]            keyless
  title: Greatest Hits    # [2], key=title keyed — AND still positioned
  - Chorus                # [3]            keyless
# *playlist[2] (by position) and *playlist/title (by key) resolve to the SAME node.

rating: !!omni 5          # the node's own scalar value …
  - solid                 # [0] … and positional + keyed fields together
  scale: 10
```

An `!!omni` value may also be a **block scalar** (`|` / `>`), just as a YAML tag can precede
one. Since a block scalar is bounded by *its own content indent* (YAML's rule — `|2` can pin
it), the fields simply sit at a **shallower** indent than the block content (but still deeper
than the key):

```yamlover
review: !!omni |
      multi-line text is
      the node's value
  stars: 5                # a field — shallower than the block content, deeper than the key
```

A lone tag with no preceding key (`!!omni 5` / `!!mix` on the first line) types the
**document root** (see `examples/07-omni.yamlover`). Without the tag, a mixed container or a
scalar-with-fields is a **parse error**. (See `examples/06-tour.yamlover`.) The block must be
indented under its key; a same-indent `- …` sequence stays sequence-only, since a same-indent
`key:` there is a sibling.

## 5. Concretes: one file, or a directory

yamlover instances materialize two ways (same logical graph):

- **File concrete** — a single `.yamlover` file holds the whole instance (see
  `examples/06-tour.yamlover`).
- **Directory concrete** — a directory *is* the mapping: each file/subdir is an entry
  (filename → string key, bytes → a `Blob`/sub-document). Its `.yamlover/` holds up to two
  overlays:
  - **`.yamlover/body.yamlover`** — the *instance* overlay: adds scalars/pointers over the
    directory and — as a pointer-array (`- *file1 …`) — imposes child **order** (a bare
    directory takes filesystem order).
  - **`.yamlover/meta.yamlover`** — the *metadata* schema (types, `format`/decoding,
    `concrete`, presentation): a **JSON-Schema-equivalent written in yamlover**, used e.g.
    to say an on-disk blob is `type: binary, format: int32/le`. Metadata-first, validation
    optional — see **`META.md`**.

  The precise overlay-merge precedence (directory ∪ `body.yamlover`, plus `meta`) is the
  Phase 1c spec (`PLAN.md`); `<<:` (extended to `<<: *pointer`) is the explicit merge tool.

A file and a subdirectory are equivalent ways to represent the same node.

### Attaching a schema inline — the `!!<…>` tag

A node can carry a **schema/metadata** reference inline via a tag, so a plain `.yamlover`
file needs no `.yamlover/` overlay:

```yamlover
!!<*yamlover/$defs/chapter>      # tag on the document root
title: My Article
chunks:
- The first paragraph.
- The second.
children:
- title: A subsection
  chunks: [ … ]
```

- `!!<…>` borrows YAML's tag syntax, and **its contents are themselves yamlover**. Since a
  schema (yamlover/meta) is also yamlover, the tag holds *either*:
  - **a pointer** to a hosted schema — `!!<*yamlover/$defs/chapter>` references the `chapter`
    schema under the project's `$defs`; an absolute URI (`https://…/$defs/chapter`) is an
    equivalent link. (A bare `*…` is the deref.)
  - **an inline schema literal** — `!!<format: text/x-plantuml>` *is* a one-line yamlover/meta
    document (`{format: text/x-plantuml}`); flow form `!!<{type: string, format: text/x-latex}>`
    works too. No named `$defs` entry needed for one-off formats.
- The tag attaches the schema to the value that follows it (after `key:` or `- `), or — on
  its own line at the top of a file — to the **document root**.
- The schema is **metadata-first, not validation** (`META.md`): it gives the node its
  shape/type/format. In the IR it is `NodeMeta.schema`, a `Value` (a `Pointer` *or* an inline
  schema `Node`), stored unresolved.

This is the file-concrete counterpart to a directory's `.yamlover/meta.yamlover`. (json5p
has no tags; inline schema attachment is yamlover-only.)

## 6. Escaping

Backslash-based, **not** quote-based (in YAML `'` and `"` are interchangeable, so they
cannot carry a literal-vs-interpreted distinction). A literal metachar (`/ [ ] * & # ~ \`,
the query characters `? ! ( ) < > = |` — see `QUERY.md` — or an all-dots segment
`..` / `...`) in a key is escaped with `\`:

```yamlover
weird: *../cat\/dog/x    # second step is the literal key "cat/dog"
dots:  *\.\.             # the literal key ".." (not the parent scope)
star:  *\*boss           # the literal key "*boss"
```

## 7. Scopes (summary)

Identical to json5p (full rules in `URIs.md`), only unquoted here:

| Form | Base |
|---|---|
| `*name`, `*../…` | current mapping / its parents |
| `*/…` | current **document** root |
| `*//auth/…`, `*scheme://auth/…` | a **link** — any other start (project, sibling doc, external) |

## 8. Relationship to the rest of the system

- **IR** (`IR.md`): a mapping/sequence → `Mapping` (ordered entries); a `*` value → an
  `Entry` with `edge:"ref"` and an unresolved `Pointer`; a `~`-key → `edge:"back"`; a `&`
  anchor is recorded for the resolver. Bytes in the directory concrete → `Blob` by hash.
- **Engine** (`ENGINE.md`): a parsed yamlover document/dir populates `node`/`edge`.
- **json5p** (`JSON5P.md`): the brace twin — same `*`/`~`/`&`, `[n]`/`/x`, scopes; differs
  only in surface (`*` is quoted there: `*'…'`) and in that json5p is a *clean* superset of
  JSON5, while yamlover breaks YAML per §3.

## 9. Worked examples & conformance

- **`examples/05-tour.yaml`** — plain YAML (the base): native `&`/`*` anchor sharing, no
  paths/`~`.
- **`examples/06-tour.yamlover`** — the same data with the full pointer layer.

Because yamlover is a *feature* superset (not byte-for-byte), the YAML conformance corpus
(`yaml/yaml-test-suite`) is run as **"accept all positive cases except a documented
divergence allowlist"** (§3), not 100% — see the conformance harness.
