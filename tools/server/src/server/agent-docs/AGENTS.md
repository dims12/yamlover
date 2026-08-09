# Working with this yamlover project (guide for AI agents)

This project stores structured knowledge as **yamlover** files. You (an AI coding agent) and a
human are editing the **same directory** at the same time: the human browses the tree in the
yamlover web UI (`npx yamlover .`) while you read and edit the files on disk. This document
tells you how to manipulate these files **correctly** so you don't corrupt the data or break the
human's live view.

> This file is self-contained. You do **not** need any other spec to follow it. The full,
> authoritative spec is the yamlover documentation book (the `docs/` tree of the yamlover
> project itself — the language under `docs/language/`, the document model under
> `docs/documents/`); consult it for edge cases.

---

## 1. What yamlover is

yamlover is a **distinct, YAML-like language** — close to YAML and mostly readable as it, but
**not a strict superset**: `*` and `&` carry different meaning (see below), so a stock YAML
document that uses aliases/anchors does **not** round-trip identically. On top of a YAML-style
surface it adds a small **pointer layer** so that data forms a graph, not just a tree:

- **`*` pointers** — a value that *refers to* another node (a shared edge, not a copy).
- **`&` path anchors** — declare that "this node also lives over there" (the push side of `*`).
- **`!!` tags** — type/schema markers, including inline schema references `!!<…>`.

There is a sibling brace surface called **json5p** (`.json5p` files) — the same pointer layer
expressed in JSON5 syntax. Most projects use `.yo`; treat `.json5p` as the JSON-flavored
twin (pointers are written as quoted strings, e.g. `*": pets: 1"`).

**Important:** because `*` and `&` mean something different than in stock YAML (a `*` is a path
pointer, **not** a YAML alias), these files require the yamlover parser. Do not "fix" them with
a generic YAML formatter — you will destroy the pointers and anchors.

---

## 2. The one-ordered-container model

Plain YAML forces a node to be **either** a sequence (all `- item`) **or** a mapping (all
`key: value`). yamlover unifies them: there is **one ordered container**. Every entry has an
integer **position** (0, 1, …) and **may also** carry a string key. Keyless (positional)
and keyed entries coexist in one node — this is the default ("omni"):

```yamlover
playlist:
  - Intro                  # position 0            keyless / positional
  - Verse                  # position 1            keyless
  title: Greatest Hits     # position 2, key=title keyed — AND still positioned
  - Chorus                 # position 3            keyless
  encore: *: pets: 0       # position 4, key=encore a keyed pointer, still in order
```

A node can even carry a **scalar value AND fields at once**:

```yamlover
rating: 5                  # the node's own scalar value …
  - solid                  # position 0  positional field
  scale: 10                # position 2  keyed field
```

(You may see an optional `!!mix` tag marking these shapes. It is a **no-op readability marker**
— mixing and scalar-plus-fields are the default. Don't add or remove it to change meaning; it
doesn't carry any. `!!yo` — whose deprecated aliases `!!var` / `!!omni` still parse — is a
DIFFERENT thing and is **semantic**: see §6.)

---

## 3. Paths use COLONS, not slashes

A path is `key: value` chained. The separator is the **colon**: `a: b: c` means "key a → key b →
key c". Canonical style writes `: ` (colon + space) after each step; a colon without the space
also parses.

`/` is an **ordinary character** now — MIME-type keys (`text/html`), date keys (`01/02/2026`)
and URL-ish keys ride bare in a path. (The old `/`-separator form is DEAD — it no longer
parses as a path: `*/pets` is a dangling reference to the literal key "/pets". Author `:` only.)

### The scope ladder — more colons, wider scope

```
current: object: path                         # bare       — current scope (siblings)
: document: rooted: path                      # :          — this document's root
:: project: rooted: path                      # ::         — this project's root
::: yamlover.inthemoon.net: $defs: tag        # :::        — the world (an external project)
```

- `*pets: 1` — bare: a **sibling** named `pets`, position 1.
- `*: pets: 0` — `:` document root.
- `*:: tags: genre` — `::` this project's root.
- `*::: host.example: $defs: tag` — `:::` a world/external reference.

### The bare-token rule — what a portion means

Every portion is typed **by its own form**:

- **pure digits** = the integer key, i.e. a **position**: `*: pets: 1: name` = root → position 1
  → key `name`.
- **a bare `~`** = the **null key** (`~: value`; `: v` is the same entry). The *string* key
  `"null"` is written `null:`.
- **anything else bare, and any quoted portion** = a **string key**: `: '1'` is the numeric
  string key, `: '~'` the literal tilde.

A key whose bare form would read as something else MUST be quoted: empty, pure digits, `~`,
`-`+digits, or a key containing a space. In a document, a plain `1:` is a **parse error** —
author `'1':` for the numeric string key.

> **The retired bracket index.** The old `[n]` position form (`*pets[1]`) still *reads* — it is
> a permanent alias — but it is **written never**. Author the bare-integer segment. The one
> surviving bracket operator is `[.±k]` (a position relative to the pointer's own host). The
> former `[]` (append) and `[?]` (any position) brackets were REMOVED — both are now the `-`
> segment: a trailing `: -` on a bookmark appends (§5), and `-` in a query matches any
> position. A literal `-` key must be quoted (`'-'`).

---

## 4. Pointers `*` (the pull side)

A `*` value dereferences a path to another node and creates a **shared edge** (not a copy):

```yamlover
humans:
  - name: Alice
    manager: *: pets: 1      # Alice.manager IS the node at root → pets → position 1
feline: *pets: 1             # bare → a sibling
topDog: *: pets: 0           # : → document root
```

Pointers are **lazy** and **cycle-safe** — pointing two nodes at each other is fine. Editing the
target changes everything that points at it.

---

## 5. Path anchors `&` (the push side)

`&: path` on a node declares "this node **also lives** at that path" — it grafts a **real key**
(there is no separate anchor namespace), so any plain pointer can then reach it:

```yamlover
boss: &: chief             # this node is ALSO reachable as the document-root key `chief`
  name: Rex
team:
  lead: *: chief           # same node as `boss` — a shared edge, not a copy
```

Reverse relations are spelled as anchors. `&: parent: child` means "parent holds me as child":

```yamlover
adam:
  cain:
    &: eve: cain           # "eve holds me as cain" — the reverse of eve's cain-edge
```

`&: container: -` (a trailing `-` segment) means **positional membership**: "that container also
holds me", appended after the container's own entries:

```yamlover
fan:
  name: Bob
  &: favorites: -          # Bob appends himself to `favorites`
```

Anchor paths must be **unambiguous** (no wildcards, no trailing position claim — neither a bare
integer nor a relative `[.±k]`) — they create real keys, so they must resolve to exactly one
place. The trailing `-` is an append, not a claim; a `-` anywhere else in an anchor path is
reserved (a parse error today). The old `&: container[]` bracket spelling was removed and no
longer parses.

> You may encounter the older `~key: *path` back-edge syntax in legacy files. It still parses but
> is deprecated; author new reverse edges as `&` anchors.

---

## 6. Tags `!!` and `$defs` schemas

- `!!type` — a YAML-style tag. `!!mix` is the one no-op marker (see §2). The rest are
  **semantic** and must not be added or dropped casually:
  - `!!set` marks a container whose membership is by identity (duplicates collapse);
  - `!!yo` (deprecated aliases `!!var` / `!!omni`) marks a node as **plain yamlover, exempt
    from the enclosing document's schema** — a *data island*. Inside a structured document (a
    chapter, say) a `!!yo` node is never interpreted by that schema: it is data, drawn by the
    generic renderer.
- **Inline schema reference** `!!<…>` binds a node to a reusable schema definition:
  ```yamlover
  mychapter: !!<*:: yamlover: $defs: chapter>
  ```
  Reusable schemas live at the project root under **`$defs`** (e.g. `$defs: chapter`,
  `$defs: tag`, `$defs: annotation`, `$defs: fragment`). They are referenced project-scoped
  (`*:: $defs: name`) or via the self-import (`*:: yamlover: $defs: name` — synonyms inside this
  project). Schemas are **metadata** (typing/format/presentation), not data storage.

---

## 7. Concretes: how a node is stored on disk

A node can be materialized two ways:

1. **Single-file concrete** — a whole document in one `.yo` (or `.json5p`) file.
2. **Directory concrete** — a directory **is** the node; its files/subdirs are its entries, and
   two optional overlay files inside a hidden `.yo/` subdir add data and schema:
   - `.yo/body.yo` — **instance** overlay: scalar values, ordering, pointers,
     extra keyed/keyless entries layered onto the directory's contents.
   - `.yo/meta.yo` — **schema** overlay: typing, format, validation.

So to add a pointer or a value "to a folder", you edit (or create) that folder's
`.yo/body.yo`. Plain files inside the directory are its members; a `.yo/`
subdir does not appear as a member — it's the overlay.

A pure pointer-array body (`- *file1` …) is the ORDER overlay: it grants positions to the
members it names (the projection shows each consumed key as a dimmed derived `&` anchor,
`- &file1 value`); a member the body never names stays keyed-only, after the ordered block.
Editing derives storage for NEW children by the INHERITANCE RULES (`concrete-rules.ts` — one
pure module, an explicit `concrete:` always wins): a directory-concrete parent keeps children
directory-concrete; a keyed container child becomes a nested real directory; an untagged
keyless (ordinal) container child becomes an order-numbered subdirectory (`item01`,
`item02`, …) referenced by a `- *: itemNN` pointer-array element; scalars and tagged containers
(tables, typographical lists) go inline into `body.yo`. Title-born subchapter members are
numbered too (`01-Введение`). The numbers are COSMETIC listing order — the body pointer-array is
the order's data, and an existing member is NEVER renamed: an insert between neighbors slots a
sub-number (`item01-1`, `01-1-Новая`). Content inside a file document speaks that file's
language (a `.json5p` interior never switches to yaml).

**Collapse / expand / promotion — the same node, two shapes.** The two concretes are
freely interconvertible without changing what the data means: a child stored as
`child.yo` (collapsed) and the same child stored as `child/` with a
`.yo/body.yo` (expanded) are equivalent. Converting a single-file node **into**
a directory is called **directory promotion** (the UI's action; the engine keeps inbound
pointers valid across it, like `mv`). If you do it by hand, it is a two-step move: create the
`child/` directory, move the file's contents into `child/.yo/body.yo` (plus any
members as files), and delete the old `child.yo` — then let the engine reindex. Because
it is a move, treat it with the same care as any rename: pointers that addressed the old file
path must still resolve (prefer the mediated `mv`/promotion in the UI, which rewrites them —
see §10).

---

## 8. Annotations & fragments (tags applied to content)

The human marks up documents in the UI. These live **on the target node**, not in side files:

- **`yamlover-fragments`** — a mapping of slug → selector (a text span, image/PDF rectangle, or
  map box) identifying a region within the node.
- **`yamlover-annotations`** — a sequence; each element applies a tag to the node (or a
  fragment). An element is either a bare **tag pointer** or an object with a `tag:` field plus
  parameters:
  ```yamlover
  yamlover-annotations:
    - *:: tags: genre: brevity            # parameterless
    - {description: 'A math block', tag: *:: tags: topic: math}   # parametrized
  ```

  (A flow scalar carrying a SPACE must be quoted — an unquoted `A math block` inside `{…}` is a
  parse error.)

Prefer letting the human create these through the UI. If you must touch them by hand, keep the
exact key names (`yamlover-fragments`, `yamlover-annotations`) and the tag-pointer form, and do
not renumber or reorder fragment slugs.

---

## 9. Escaping (critical when editing keys)

A literal metacharacter inside a key is **backslash-escaped** (this is per-character, not
quote-based):

```yamlover
weird:
  cat\:dog: 1              # the literal key "cat:dog" (\: suppresses the separator)
  cat/dog: 2              # `/` is ordinary now — no escape needed
ref:  *weird: cat\:dog    # the second portion is the literal key "cat:dog"
dots: *\.\.               # the literal key ".." (NOT the parent scope)
```

- Metachars that need escaping in a key include: `:` `[` `]` `*` `&` `~` `#` `\` `?` `!`
  `(` `)` `<` `>` `=` `|`.
- The literal keys `..` and `...` are written `\.\.` and `\.\.\.` (bare `..` means "parent").
- **A key containing a space MUST be quoted**: `: tags: 'дорожный знак'`. Use the host surface's
  string quoting (`'…'` / `"…"`).

---

## 10. Co-editing workflow & safety rules

The yamlover server **watches the filesystem**. Every time you save a file, it reindexes and
pushes the change to the human's browser over a live event stream — so your edits appear in their
UI within a moment, and theirs appear to you on disk. Work with that, not against it:

- **Make small, valid saves.** A half-written file will reindex as broken. Prefer complete edits.
- **NEVER touch `.yo/index.db`** (nor its `-wal` / `-shm` companions). It is the server's
  generated SQLite index — it regenerates itself from the source files. Editing or deleting it
  does nothing useful and can confuse a running server. It is the *only* thing in `.yo/`
  you must not edit; `body.yo` / `meta.yo` overlays (§7) are normal editable data.
- **Renames and moves break inbound pointers.** Other files may point at a node by its path
  (`*: some: node`). If you move or rename it with a plain `mv`, those pointers dangle. The
  running server exposes a **mediated move** (`POST /api/mv`) that surgically rewrites inbound
  references at their source. Prefer it for moves/renames; if you must move by hand, search the
  project for pointers to the old path (`*` followed by the path) and update them too.
- **Don't reformat with a generic YAML/JSON tool.** It will mangle `*`, `&`, `!!<…>`, the
  colon paths, and the mixed keyed/keyless ordering. Edit the text directly and preserve style.
- **Settings live in `.yo/settings.yo`** at the project root (e.g. where new tags and
  annotations are written). Treat it as configuration; change it only when asked.
- **When unsure of a path, query it.** The server answers `GET /api/query?...` using the path
  grammar above, and serves the tree at `GET /api/tree` / a node's yamlover at
  `GET /api/content/a/b` (slash-spelled path; digits are positions, `~` the null key).
  Use these to confirm a path resolves before you author a pointer to it.

---

## 11. Quick reference

```yamlover
# pointers (pull) — colon paths, the scope ladder
sibling:   *pets: 1                 # current scope, by position (bare digits = the position)
rooted:    *: humans: 0: name       # document root → position 0 → key name
strkey:    *: counts: '1'           # QUOTED digits = the numeric STRING key
nullkey:   *: doc: ~                # the null key
projscope: *:: tags: genre          # this project's root
world:     *::: host.example: $defs: tag

# anchors (push) — "I also live there"; real keys; unambiguous only
here:  &: chief                     # also at document-root key `chief`
rev:   &: parent: child             # parent holds me as `child`
mem:   &: favorites: -             # appended member of `favorites`

# tags / schema
node:  !!<*:: $defs: chapter>       # bind a reusable schema

# escaping
lit:   *weird: cat\:dog             # literal colon in a key
space: : tags: 'two words'          # spacey key must be quoted
```
