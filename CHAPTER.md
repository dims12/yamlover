# CHAPTER — the `chapter` / `chunk` document model

A **chapter** is yamlover's document node: a readable page with an optional heading and a body of
content. It is the schema the web viewer renders as an article (README §chapter renderer). This
spec defines its shape; companion specs: `META.md` (the schema vocabulary), `TYPES.md` (the type
lattice), `YAMLOVER.md` (the surface), `MARKLOWER.md` (the inline markup a prose chunk is written
in), `TICKETS.md` (`task`, which extends chapter).

## The model — a fully omni node with a positional body

> A chapter is **just an omni (`variant`) node** (TYPES.md) — a **fully** omni one: the node's own
> scalar **self-value is the title** (there is no `title:` key), **`description`** is an optional
> keyed field, and everything else is an **unkeyed (positional) body element**. Each body element
> is *either* a **nested chapter** (the recursion) *or* a **chunk** (a renderable content block).
> There is one interleaved body stream, read top to bottom — no `chunks` array and no `children`
> array.

This is the whole design. Prose, media, diagrams, and subchapters are **siblings in one ordered
sequence**, the way a real document reads. A chapter with only prose is a flat article; a chapter
with subchapters is a tree.

Because the title is the self-value, a **bare string body element is indistinguishable from a
title-only subchapter — and that is the design**: a title-only subchapter IS a chunk. With no body
there is nothing to descend into, so it renders as prose in place; the moment it gains body
entries it becomes a container and routes as a subchapter.

**Position is the author's.** The renderer shows every element — `title`, `description`, chunks,
and subchapter links — **in source order**, wherever the author placed it: the heading is not
hoisted to the top, subchapters are not forced to the end, and base-level prose may follow a
subchapter. The **TOC** likewise lists subchapters in **body order** — even when each subchapter is
its own subdirectory (a directory chapter, `examples/66-pet-keeper-handbook`), whose alphabetical
directory scan is overridden by the positional `*` body pointers that place them. A subdirectory
present on disk but never referenced by a body pointer sorts **after** the ordered ones, in
directory-scan order.

```yamlover
# a whole article in one tagged .yamlover file
!!<*yamlover/$defs/chapter>
Getting Started                           # the node's SELF-VALUE — the title (no `title:` key)
description: the shortest tour            # optional, keyed
- yamlover is a YAML layer over the filesystem.   # a chunk (marklower prose by default)
- !!<format: text/x-latex> |              # a chunk that overrides its (type, format)
  e^{i\pi} + 1 = 0
- *: diagram.png                          # a chunk that is a pointer to a file
- A subchapter                            # a nested chapter: ITS self-value + its own body
  - its own body chunk, and so on…        # recursion
- A title-only subchapter is a chunk      # a bare string — the same thing, by design
- - an untitled subchapter                # a container with no self-value — still a chapter
  - its second chunk
```

- **The title** is the node's own scalar **self-value** (`text/marklower`) — declared in the
  schema as the `value:` facet. **`description`** is keyed and optional (`text/marklower`).
  Together they are the heading.
- **A chunk** (`$defs/chunk`) is one renderable value; its `(type, format)` selects the renderer,
  defaulting to `text/marklower` prose (`MARKLOWER.md`). Override per chunk with an inline tag (`!!<format: …>`) or a file
  pointer (`*: pic.png`, whose format comes from the extension). A chunk may be a `string` or a
  `binary` (an image/pdf/… pointer).
- **A subchapter** is a body element that is itself a chapter — recognized **structurally**: a
  *container* (it has body entries — a titled one is an omni scalar whose self-value is its title,
  an untitled one a plain container) renders as a subchapter; a *leaf* (a scalar or a file pointer)
  renders as a chunk, which is exactly what a title-only subchapter is. (An annotated chunk's
  overlay keys — `yamlover-annotations`/`yamlover-fragments`, ANNOTATIONS.md — are not body, so a
  scalar carrying only those stays a chunk.)
- **A table** (`MARKLOWER.md`) is a body element explicitly tagged `!!<*yamlover: $defs: table>` — a
  container, so the tag (not shape) is what keeps it from being a subchapter.

## The schema

`$defs/chapter` is a normal yamlover/meta schema (META.md):

```yamlover
type: variant                     # fully omni: a scalar self-value, keyed fields, AND a positional body
value:       { type: string, format: text/marklower }   # the self-value — the TITLE
properties:
  description: { type: string, format: text/marklower }
items:                            # the body — a positional sequence
  anyOf:
    - *:: yamlover: $defs: chapter   # a subchapter (a container) — the recursion
    - *:: yamlover: $defs: table     # a table (MARKLOWER.md) — enters only by its explicit tag
    - *:: yamlover: $defs: chunk     # a content block (a leaf)
```

The body element type is a **union** (`items: {anyOf: […]}`) — the first construct of its kind in
the taxonomy. The engine's schema propagation (walk.ts) routes each body element to the matching
branch by shape (container → chapter, leaf → chunk) and stamps its `(type, format)`, so a chapter
tagged only at its root makes every nested subchapter `x-yamlover-chapter` and every prose chunk
`text/marklower` — no per-node tag needed. A **table** (`$defs/table`, MARKLOWER.md) does not take part
in the shape routing — both a subchapter and a table are containers — so it enters the body only by
its **explicit tag** (`!!<*yamlover: $defs: table>`), which wins over the structural default; an
untagged container stays a subchapter.

`$defs/chunk`:

```yamlover
type: [string, binary]            # prose, or an image/pdf/… pointer
format: text/marklower            # the default; overridden per chunk
```

## Attaching a chapter

Two ways, both in `META.md`:

- **Inline tag** (a `.yamlover` file or an inline value): `!!<*yamlover/$defs/chapter>` on the node.
  A whole article fits in one file (`examples/60-simple-chapter.yamlover`).
- **Directory overlay**: a directory's `.yamlover/body.yamlover` is tagged at its root, so the
  *directory itself* is the chapter and its files can be referenced as pointer chunks
  (`examples/68-math-chapter`, `65-all-formats-chunks`). Subchapters can themselves be
  **subdirectories** — each its own directory chapter, referenced by a `*`-pointer body element —
  giving a recursive tree where every chapter is a directory (`examples/66-pet-keeper-handbook`:
  `dogs/`, `cats/`, `fish/`, and nested `dogs/puppies/`).

## Addressing body elements

A chapter node at path `P` addresses its **body elements by their store index** on the node itself:
`P[i]` (the omni model indexes entries by their absolute position — a keyed entry like
`description` consumes an index too, so a described chapter's first body element is `P[1]`). The
**title consumes NO index**: it is the node's self-value, not an entry. A document-relative
marklower link therefore points at `:[i]` (`MARKLOWER.md`; the legacy slash spelling `/[i]` still
parses — see `69-marklower-links.yamlover`), and a subchapter's chunk at `:[i][j]`.

The web editor's surgical edits (`/api/edit`, README §editor) use **the same absolute index** — an
edit path is a plain yamlover path, nothing else. (It once addressed a body element by its *rank*
among the positional items, a second index space in which keyed entries counted for nothing; the
two disagreed about which `[i]` a subchapter was.) A **title edit is an `emplace` on the chapter
node itself** — the payload's scalar facet replaces the self-value, the entries stand; an empty
payload drops the title line. See `tools/server` `engine-api.ts`.

## `task` extends `chapter`

`$defs/task` (TICKETS.md) is declared as an **extension** of chapter — `allOf: [*chapter]` — so it
inherits the fully-omni shape (the self-value title, the keyed `description`) and the omni body,
adds keyed planning fields (`priority`, `due`, `assignee`, `estimate`, `depends`), and **narrows**
the body recursion to subtasks with its own `items: {anyOf: [*task, *chunk]}`. Because
`task ⊆ chapter`, the intersection collapses to `task | chunk` — a subtask, not a subchapter.

## Status

The positional-body model **replaces** the earlier `title`/`description`/`chunks`/`children`
encoding (a chapter used to keep chunks and subchapters in two separate keyed arrays), and the
self-value title **replaces** the keyed `title:` (2026-07-18 — the TODO "Change title to omni
scalar in chapter"). Migrated across schemas, engine, the web renderer/editor, the OneNote
importer, examples, and tests; the server still *reads* a legacy keyed `title:` as a fallback, and
the editor migrates one out on the first title edit.
