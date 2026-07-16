# TABLE — the `table` model (`$defs/table`)

A **table** is yamlover's grid node: rows of cells, with an optional header row and caption.
It is the flagship case of marklower's structure delegation — marklower has **no table
syntax** (`MARKLOWER.md`); a table is an ordinary yamlover node tagged
`!!<*yamlover: $defs: table>`, and only its *cells* are marklower. This spec defines the
model; companion specs: `MARKLOWER.md` (the prose inside a cell), `CHAPTER.md` (the document
body a table sits in), `META.md` (the schema vocabulary), `URIs.md` / `SEPARATOR.md`
(the path grammar, including the **relative indexes** merged cells are built on).

## The model — rows of cells, one omni node

> A table is **just an omni (`variant`) node** (TYPES.md): its keyless entries are the
> **rows**, read top to bottom, and each row is an **array of cells**, read left to right.
> Rows may be keyed — normal for an omni node — and one key is well-known: a row keyed
> **`header`** is the header row. An optional keyed **`title`** is the caption. There is no
> `rows` array and no column objects; the table *is* its rows.

```yamlover
!!<*yamlover: $defs: table>
title: Household staff                     # optional caption (marklower)
header: [Name, Species, Duty]              # the header row — a keyed row
- [Whiskers, cat, 'supervising humans']    # a keyless row: an array of cells
- [Rex, dog, '**security**']               # a cell is marklower prose
```

A row is written flow (`- [a, b, c]`) or as a lone `-` whose cells follow as a block —
yamlover has no compact `- - cell` nesting. In a flow row a cell containing a space, or
opening with a marklower `*`/`&` (a yamlover sigil), is quoted.

- **The column count is inferred from the first row** — the `header` when present, else the
  first keyless row. A shorter row pads with empty trailing cells; a longer row is a
  **reported inconsistency**, surfaced like a dangling pointer, never silently truncated.
- **`header`** renders as the header (`<th>` cells) wherever it is authored; by convention
  it is written first. Other keyed rows have no table meaning — the key just makes the row
  addressable by name.
- **`title`** is the caption, `text/marklower` like a chapter's. Being keyed, `title` and
  `header` still **consume positions** in the omni stream (CHAPTER.md §Addressing) — a
  captioned table's header is `[1]` and its first body row `[2]`.

## Cells

A cell is `anyOf: [chunk, table, chapter]`:

- **A chunk** (`$defs/chunk`) — the default. Schema propagation stamps every leaf cell
  `text/marklower`, exactly as a chapter's body prose is stamped, so cells carry bold,
  links, math, and embeds with no per-cell tag. An empty string is an empty cell.
- **A nested table** — the *untagged* container cell. Shape routing (leaf → chunk,
  container → table) stamps it with **no tag of its own**, and the recursion bottoms out
  in marklower.
- **A chapter** (`$defs/chapter`) — a cell mixing prose and tables (or holding several
  tables): a full document node inside a cell. A chapter and a table are both containers,
  so shape cannot tell them apart; a chapter cell enters **only by its explicit tag**
  `!!<*yamlover: $defs: chapter>` — the exact mirror of the chapter-body rule, where the
  untagged container is the subchapter and the *table* is the tagged branch. Inside the
  cell-chapter's body the ordinary chapter rules apply (its own tables are tagged again):

  ```yamlover
  -                                    # a block row — its third cell is a CHAPTER
    - Rocky
    - raccoon
    - !!<*yamlover: $defs: chapter>
      - night shift **only**
      - !!<*yamlover: $defs: table>
        - [bins, tipped]
  ```
- **A pointer** — a cell may be a `*` edge to any node; a pointer is an edge, not a schema
  branch, and the shared target conforms as whatever it is. Two pointer targets are special
  — the adjacent previous cells — and they mean **merging**:

## Merged cells — relative pointers

A merged (spanned) region is not new vocabulary: it is a cell declaring **"I *am* the
previous cell"** with a `*` pointer, using the **relative indexes** of `URIs.md`
§Relative indexes (`[.]` = my own position at this depth, `[.-1]` = one before it):

| Cell | Meaning |
| --- | --- |
| `*[.-1]` | I am the cell to my **left** (row r, column c−1) → **colspan** |
| `*..[.-1][.]` | I am the cell **above** (`..` to the table, `[.-1]` = previous row, `[.]` = my column) → **rowspan** |

```yamlover
!!<*yamlover: $defs: table>
header: [Animal, Trait, *[.-1]]        # "Trait" spans two columns — its neighbor IS it
- [Mammals, warm-blooded, furry]
- [*..[.-1][.], warm-blooded, barky]   # "Mammals" spans down — this cell IS the one above
```

The rules:

- A merge pointer targets the **adjacent** previous cell — left (`*[.-1]`) or up
  (`*..[.-1][.]`). Chains resolve transitively to the **origin** cell (a pointer to a
  pointer cell is a pointer to its origin).
- The origin plus every cell resolving to it must tile a **filled rectangle**. The renderer
  gives the origin `colspan` = the rectangle's width and `rowspan` = its height, and emits
  nothing for the pointer cells.
- A pointer to any **non-adjacent** cell is *not* a merge — it renders as its own cell
  showing the shared content (plain dereference, the ordinary yamlover meaning). Merging is
  just the rendering of the adjacent-self-reference case; general pointer semantics are
  untouched. A region that is adjacent but **non-rectangular**, or a merge that crosses the
  `header`/body boundary, is a reported inconsistency and renders unmerged.
- Merge pointers do not change a row's **cell count**: a spanned position is still authored,
  as the pointer — every row keeps the full column count.

## The schema

`$defs/table` is a normal yamlover/meta schema (META.md). `type: variant` with no explicit
`format` derives **`x-yamlover-table`** (the chapter/task precedent), which is what the
renderer registry keys on:

```yamlover
type: variant                      # omni: keyed title/header AND positional rows at once
properties:
  title:                           # optional caption
    type: string
    format: text/marklower
  header:                          # the header row — same shape as a body row (the schema
    type: array                    #   loader follows only $defs pointers, so the row
    items:                         #   schema is repeated literally rather than *: items)
      anyOf:
        - *:: yamlover: $defs: chunk
        - *:: yamlover: $defs: table
        - *:: yamlover: $defs: chapter
items:                             # a row
  type: array
  items:                           # a cell
    anyOf:
      - *:: yamlover: $defs: chunk    # marklower prose (the default)
      - *:: yamlover: $defs: table    # a nested table — the UNTAGGED container branch
      - *:: yamlover: $defs: chapter  #   (listed first, so shape routing keeps picking it);
                                      #   a chapter cell enters only by its explicit tag
```

A table enters a chapter body as an **explicitly tagged** element — the tag decides;
untagged containers keep routing to subchapters (CHAPTER.md §The schema).

## Addressing cells

A table node at path `P` addresses a cell as `P[r][c]` — row by its omni position, cell by
its position in the row — so a document-relative marklower link points at `:[i][r][c]`
(the table at body index `i`). The `header` row is also addressable by name (`P: header`),
and `title`/`header` consume indices per the omni model, as noted above. Nested tables just
go deeper: `:[i][r][c][r'][c']`.

## Status

Spec'd and **implemented** 2026-07-16; the schema is hosted (`$defs/table`, registered in
`$defs/.yamlover/meta.yamlover`) and `examples/74-table.yamlover` is the worked fixture.

- **Relative-index resolution** — `tools/engine/ts/src/resolve.ts`: a `[.±k]` step resolves
  by the frame rule (the host positions vector rides the resolution chain), and a chain of
  merge pointers resolves transitively to the origin cell. Out of range / no host frame at
  the depth → the ordinary dangling diagnostic.
- **The renderer** — `tools/server/src/client/renderers/table.tsx` (registry entry
  `byFormat("x-yamlover-table")`): rows/header/caption, `colSpan`/`rowSpan` computed from the
  resolved pointers' target paths + the rectangle rule above, nested tables inline, marklower
  cells. A violating region (non-rectangular, header/body-crossing) renders unmerged. A
  CHAPTER cell is told apart from a nested table by the stamped format the projection now
  carries on its `$yamloverMixed` marker, and renders its body items in order.
- **Cell editing** — under the chapter lock, a prose cell edits in place and emplaces at its
  `<table>[r][c]` path; the server splices flow-row cells token-wise (a multi-line cell needs
  the block row form and is rejected in flow). Structure editing (add/remove rows and
  columns, making merges) is **pending**.
- **onenote2yamlover** emits tables in this format (was: CSV) — nested tables and marklower
  cell formatting preserved; OneNote has no header rows or merges, so none are emitted. A
  OneNote cell mixing prose and tables becomes a **chapter cell** (nothing is dropped).
