# yamlover — YAML + pointers (+ concretes)

**yamlover** is the indentation / filesystem surface over the shared pointer model — the
twin of `JSON5P.md`'s brace surface. It is **not** a superset of YAML — it is a distinct,
closely-related language:

    YAML  ≈  yamlover   (close, but different in links & anchors)

It shares YAML's surface syntax and **adds** the pointer layer (the extended `*`, `~`
back-edges, keys-as-pointers; `&` reinterpreted) plus **concretes** — the same logical
document can live in one file *or* as a directory tree. But its links and anchors **diverge**
from YAML (§3), so it needs its own parser. Reading is **concrete-aware**: a `.yaml`/`.yml`
file is parsed with YAML's link semantics, a `.yamlover` file with yamlover's — each read
faithfully into the one concrete-agnostic IR. (Unlike json5p, which *is* a clean strict
superset of JSON5.)

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
| `&` anchors and `*` aliases | `&a {…}` … `*a` — syntax kept, **meaning extended** (§2, §3) |

A YAML `- item` sequence entry is the same thing as a keyless `:` entry in the one-ordered
container (§4) — both are an entry with no string key.

## 2. What yamlover adds

The pointer layer, identical in meaning to json5p (grammar in `URIs.md`):

- **Extended `*` — dereference.** Beyond YAML's bare alias word, `*` takes a **pointer
  expression**: a path with scopes, resolved purely structurally (a bare `*a` is the
  sibling key `a`). Unquoted on this surface.
  ```yamlover
  feline: *pets[1]        # current mapping (a sibling) — a shared edge, not a copy
  manager: */pets[1]      # / = current document root
  remote:  *//pet.store.com/pets   # // = a link (any other start); scheme optional, never fetched
  ```
- **Keys are pointers; `[n]` vs `/x`.** Positions are integer keys (`*pets[1]`), names are
  string keys (`*pets[1]/name`). Arrays and mappings are the **one ordered container** (§4).
- **`&` — path anchors (the push side of `*`).** *Spec'd 2026-06-12
  (`ANCHOR_REFACTOR.md`); parsers still implement the old name-only anchor until
  PLAN.md Phase A lands.* An anchor's name is a full pointer path: `&P/k` on a node
  means the container at `P` gains the key `k` → a ref edge to **this node** ("I also
  live there"). A trailing `[]` makes it a keyless, appended membership (`&P[]`). A
  node may carry **multiple** anchors — on the value's line, or on their own lines
  inside the node's block (before or after the value line; order irrelevant). Anchors
  are **not entries**: they never change a node's kind (a scalar with anchors stays a
  scalar). There is **no anchor namespace** — anchors create real keys, and `*name` is
  pure path lookup. Full semantics (ordinal rules, collisions): `URIs.md` §`&`.
  ```yamlover
  pet: &/supercat       # this node is ALSO the document-root key "supercat"
    species: cat
  friend: */supercat    # plain path reaches it
  ```
- **`~` — back-edges (key sigil). DEPRECATED → path anchors** (`~key: *P` ≡ `&P/key`).
  Still parsed through the migration window. A key prefixed with `~` is the reverse of
  the forward relation it names; the `~` is a **sigil outside the key**:
  ```yamlover
  adam:
    cain:
      ~cain: */eve        # ≡ &/eve/cain — reverse of eve's "cain" edge → eve
  ```
- **`~-` — reverse *positional* membership (keyless back-edge). DEPRECATED →
  `&path[]`.** The sigil sits tight against what the forward entry starts with — a key
  (`~cain:`) or the `-` marker (`~-`; a spaced `~ -` is an error, as is `~ cain:`).
  The value **must be a pointer** — it names the container that holds me:
  ```yamlover
  my_node:
    ~- */some/other/location   # ≡ &/some/other/location[] — that container holds me
  ```
  A `~-` membership is **unpositioned** (no `~[n]:` — order is the container's data) and
  **additive**: with no label and no index there is no identity to dedup on, so every `~-`
  adds one element, even alongside a forward `- *me` (lists repeat) — unless the container
  is a `!!set` (§4). Semantics in `URIs.md` §`~-` — and identically for `&path[]`.

## 3. Where yamlover deliberately breaks YAML

yamlover is **not a superset of YAML.** It is a distinct, closely-related language: it
shares YAML's surface syntax but differs in **links and anchors** (and the `~` / `!!set` /
omni points below). Reading is therefore **concrete-aware** — a `.yaml`/`.yml` file is
parsed with YAML's link semantics, a `.yamlover` file with yamlover's — so a YAML document
is read *faithfully* (no "porting" step). The table is how the SAME token differs between
the two surfaces:

| Construct                             | YAML means                                  | yamlover means                                                                                                   |
|---------------------------------------|---------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| `&anchor`                             | a reusable intra-document name for the node | **path anchor** — "this node also lives at that path"; the path's parent gains a real key (§2, `URIs.md` §`&`)   |
| `*alias`                              | alias to anchor `alias` (name only)         | **pointer** — a pure path/scope expression (`*a` = the sibling key `a`; no anchor namespace, no precedence rule) |
| `~key:` (key position)                | the plain-scalar key `"~key"`               | **back-edge** sigil on key `key` (deprecated → `&P/key`, §2)                                                     |
| `~-` (entry position)                 | the plain scalar `~-` (rare)                | **keyless back-edge** (deprecated → `&P[]`, §2)                                                                  |
| `~` (value position)                  | null                                        | **unchanged — still null**                                                                                       |
| `!!set`                               | a mapping of null-valued keys               | a **set-semantics container** — memberships dedup by identity (§4)                                               |
| scalar + fields / mixed keyed+keyless | invalid / two node kinds                    | **one node** — omni by default (§4)                                                                              |

The anchor row is the consequential one, and the reason reading is concrete-aware. A
YAML `&a` … `*a` pair is **document-wide**: the parser reading a `.yaml` file maps it to
yamlover's document scope — `&: a` … `*: a` (one shared key at the document root) — so the
alias resolves exactly as YAML intends. A `.yamlover` file's bare `&a`/`*a` instead mean
the **current/parent** scope (`*a` = a sibling key, `*[1]` = the parent's ordinal member;
no `:` ⇒ relative to the parent); document scope is written with the leading `:`. Either
way the IR is concrete-agnostic and renders back in yamlover syntax. The `yaml-test-suite`
anchor/alias cases are a *diverges-by-design* group, not failures
(`tools/parser/YAML-CONFORMANCE.md`).

## 4. One ordered container

No separate list/dict type. A mapping is **ordered**; positions are integer keys. A keyless
entry (a `- item` sequence element, or the `:` spelling) takes only its position; a keyed
entry's position is a `*`-alias to it. Access: **`[n]`** = integer key (position), **`/x`**
= string key. Order is data — text order in a file; for a directory, the `body.yamlover`
overlay imposes it (§5). Full treatment in `URIs.md` (*Lists and dicts are one ordered
mapping*).

Concretely, keyless (`- value`) and keyed (`key: value`) entries can be **mixed in one node** —
*partially ordered, partially keyed* — which plain YAML forbids. **Mixtures are the default**
(spec'd 2026-06-12, `ANCHOR_REFACTOR.md`; the parsers still require the opt-in tags until
PLAN.md Phase A lands): an untagged node may mix keyed and keyless entries, and may carry a
scalar value alongside fields. The former opt-in tags remain parseable as **optional, no-op
markers** — existing files round-trip, and they stay useful as documentation:

- **`!!mix`** — marks a container that mixes keyless and keyed entries (a dict ∪ list).
- **`!!var`** (formerly **`!!omni`**, still accepted as a deprecated alias) — marks a node that
  carries a scalar value **and** fields at once (scalar ⊕ `mix`); the schema spelling of the shape
  is `type: variant` (META.md). (The tag was renamed to free the word "omni": the *type* `omni` is
  the top `true` — TYPES.md — while this tag marks the specific `variant` shape.) The node's
  **scalar value line** may sit at any position among the entries — first, last, or between; at
  most **one** scalar line per block, and line order does not change the data:
  ```yamlover
  30            # the node's own value …
  - one         # … may precede or follow its fields; same node either way
  two: three
  ```
  This holds at the **document root** too — a bare root scalar may be followed by entries
  and anchors (no tag needed), which is what makes the two-line tagged-scalar file legal
  (`URIs.md` §`&`).
- **`!!set`** — a container with **set semantics**: an element appears at most once, so
  duplicate memberships — forward+forward, forward+reverse (`~-` or `&…[]`), reverse+reverse —
  collapse to one (dedup by target). The inline spelling of the schema keyword
  `uniqueItems: true` (`META.md`), which is the route for json5p and directory overlays (no
  tags there). Reinterprets YAML's `!!set` (whose meaning is a null-valued mapping) — see §3.
  Unlike `!!mix`/`!!var`, `!!set` is **not** a no-op: it carries real (dedup) semantics.

The tag sits in **value position** — right after the `key:` (or `- `) whose value it types,
exactly where a YAML tag goes. `!!mix` precedes a (mixed) block; `!!var` precedes the
node's own scalar value, with the fields in the block below:

```yamlover
playlist: !!mix
  - Intro                 # [0]            keyless / positional
  - Verse                 # [1]            keyless
  title: Greatest Hits    # [2], key=title keyed — AND still positioned
  - Chorus                # [3]            keyless
# *playlist[2] (by position) and *playlist/title (by key) resolve to the SAME node.

rating: !!var 5          # the node's own scalar value …
  - solid                 # [0] … and positional + keyed fields together
  scale: 10
```

An `!!var` value may also be a **block scalar** (`|` / `>`), just as a YAML tag can precede
one. Since a block scalar is bounded by *its own content indent* (YAML's rule — `|2` can pin
it), the fields simply sit at a **shallower** indent than the block content (but still deeper
than the key):

```yamlover
review: !!var |
      multi-line text is
      the node's value
  stars: 5                # a field — shallower than the block content, deeper than the key
```

A lone tag with no preceding key (`!!var 5` / `!!mix` on the first line) marks the
**document root** (see `examples/07-omni.yamlover`); with omni as the default the root tag,
like the tags everywhere else, is optional. (Under the *current* parsers — until PLAN.md
Phase A — an untagged mixture is still a parse error; see `examples/06-tour.yamlover`.) The
block must be indented under its key; a same-indent `- …` sequence stays sequence-only,
since a same-indent `key:` there is a sibling.

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

| Form                            | Base                                                          |
|---------------------------------|---------------------------------------------------------------|
| `*name`, `*../…`                | current mapping / its parents                                 |
| `*/…`                           | current **document** root                                     |
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

Because yamlover is a close-but-distinct language (not a YAML superset), the YAML
conformance corpus (`yaml/yaml-test-suite`) is run as **"accept all positive cases except a
documented divergence allowlist"** (§3) — the anchor/alias cases are diverges-by-design, not
failures. The walk parses `.yaml`/`.yml` files with YAML link semantics (concrete-aware).
