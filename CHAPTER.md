# CHAPTER — the `chapter` / `chunk` document model

A **chapter** is yamlover's document node: a readable page with an optional heading and a body of
content. It is the schema the web viewer renders as an article (README §chapter renderer). This
spec defines its shape; companion specs: `META.md` (the schema vocabulary), `TYPES.md` (the type
lattice), `YAMLOVER.md` (the surface), `TICKETS.md` (`task`, which extends chapter).

## The model — an omni node with a positional body

> A chapter is **just an omni (`variant`) node** (TYPES.md): optional keyed **`title`** and
> **`description`**, and everything else is an **unkeyed (positional) body element**. Each body
> element is *either* a **nested chapter** (the recursion) *or* a **chunk** (a renderable content
> block). There is one interleaved body stream, read top to bottom — no `chunks` array and no
> `children` array.

This is the whole design. Prose, media, diagrams, and subchapters are **siblings in one ordered
sequence**, the way a real document reads. A chapter with only prose is a flat article; a chapter
with subchapters is a tree.

```yamlover
# a whole article in one tagged .yamlover file
!!<*yamlover/$defs/chapter>
title: Getting Started
description: the shortest tour            # optional
- yamlover is a YAML layer over the filesystem.   # a chunk (markdown by default)
- !!<format: text/x-latex> |              # a chunk that overrides its (type, format)
  e^{i\pi} + 1 = 0
- *: diagram.png                          # a chunk that is a pointer to a file
- title: A subchapter                     # a nested chapter (a body element with a title)
  - its own body chunk, and so on…        # recursion
```

- **`title` / `description`** are keyed and optional (`text/marklower`). They are the heading.
- **A chunk** (`$defs/chunk`) is one renderable value; its `(type, format)` selects the renderer,
  defaulting to markdown prose. Override per chunk with an inline tag (`!!<format: …>`) or a file
  pointer (`*: pic.png`, whose format comes from the extension). A chunk may be a `string` or a
  `binary` (an image/pdf/… pointer).
- **A subchapter** is a body element that is itself a chapter — recognized **structurally**: a
  *container* (it has keyed and/or positional entries) renders as a subchapter; a *leaf* (a scalar
  or a file pointer) renders as a chunk.

## The schema

`$defs/chapter` is a normal yamlover/meta schema (META.md):

```yamlover
type: variant                     # omni: keyed fields AND a positional body at once
properties:
  title:       { type: string, format: text/marklower }
  description: { type: string, format: text/marklower }
items:                            # the body — a positional sequence
  anyOf:
    - *:: yamlover: $defs: chapter   # a subchapter (a container) — the recursion
    - *:: yamlover: $defs: chunk     # a content block (a leaf)
```

The body element type is a **union** (`items: {anyOf: […]}`) — the first construct of its kind in
the taxonomy. The engine's schema propagation (walk.ts) routes each body element to the matching
branch by shape (container → chapter, leaf → chunk) and stamps its `(type, format)`, so a chapter
tagged only at its root makes every nested subchapter `x-yamlover-chapter` and every prose chunk
`text/marklower` — no per-node tag needed.

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
  (`examples/66-doc-tree`, `68-math-chapter`, `65-all-formats-chunks`).

## Addressing body elements

A chapter node at path `P` addresses its **body elements by their store index** on the node itself:
`P[i]` (the omni model indexes keyless entries by their absolute position — `title`/`description`,
being keyed, consume indices too, so a titled chapter's first body element is `P[1]`). A
document-relative marklower link therefore points at `/[i]` (see `69-marklower-links.yamlover`),
and a subchapter's chunk at `/[i][j]`.

The web editor's surgical edits (`/api/edit`, README §editor) address a body element by its
**rank** among the positional items (`<chapter>[rank]`), which lines up 1:1 with the source `- `
items; a subchapter *descent* uses the absolute store index. See `tools/server` `engine-api.ts`.

## `task` extends `chapter`

`$defs/task` (TICKETS.md) is declared as an **extension** of chapter — `allOf: [*chapter]` — so it
inherits `title`/`description` and the omni body, adds keyed planning fields (`priority`, `due`,
`assignee`, `estimate`, `depends`), and **narrows** the body recursion to subtasks with its own
`items: {anyOf: [*task, *chunk]}`. Because `task ⊆ chapter`, the intersection collapses to
`task | chunk` — a subtask, not a subchapter.

## Status

The positional-body model **replaces** the earlier `title`/`description`/`chunks`/`children`
encoding (a chapter used to keep chunks and subchapters in two separate keyed arrays). Migrated
across schemas, engine, the web renderer/editor, examples, and tests.
