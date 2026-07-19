# MARKLOWER — the inline markup of a chunk

**Marklower** is yamlover's prose format: a markup language deliberately a notch *below* Markdown
(hence the name). It is the format a **chapter's chunks** carry — `$defs/chunk` declares
`format: text/marklower` and schema propagation stamps every prose chunk with it, so an article
needs no per-chunk tag (`CHAPTER.md`). It is asked for by name: a format-less string *elsewhere* in
the tree is data, not prose. This spec defines the language AND the structures it delegates to —
tables (§Tables) and typographical lists (§Lists); companion specs: `CHAPTER.md` (the document
model it serves), `SEPARATOR.md` (the `:` path grammar its links speak), `TYPES.md` (the type
lattice), `META.md` (the schema vocabulary).

## The model — inline only, structure delegated

> Marklower is **inline-only**. It styles a run of prose, points at things, and inlines things. It
> has **no block structure whatsoever** — no headings, no lists, no nesting, no document tree —
> because that is `chapter`'s job. A chapter's **positional body** *is* the structure; marklower is
> what one chunk in that body *says*.

This is the whole design. Markdown carries a document model of its own — `##` opens a section, `-`
opens a list, `|---|` opens a table — and inside a yamlover chunk that model would compete with the
chapter's positional body for the same job, and lose: a `##` buried in a chunk's text cannot become
a subchapter that the TOC lists, that a `*` pointer addresses, or that `/api/edit` moves. A
subchapter is a body element. So marklower gives up block syntax on purpose, and keeps exactly what
a *sentence* needs. **Tables are the flagship case** of the delegation: where Markdown draws a grid
out of pipe characters, marklower has nothing — a table is a *yamlover node* tagged
`!!<*yamlover: $defs: table>` (§Tables below), whose cells are themselves marklower. Bullet and
numbered lists delegate the same way (§Lists).

```yamlover
!!<*yamlover: $defs: chapter>
Embedding things                         # the SELF-VALUE title (CHAPTER.md) — marklower too
- |
  Prose with **bold**, *italic*, `code`, inline math $$e^{i\pi}+1=0$$, and a
  [link to the next section](:[2]) — all inline, all in one chunk.
- |
  An embed alone on its line becomes a figure:

  *[Kubrick on Napoleon](https://youtu.be/dQw4w9WgXcQ)

  The same token *[mid-sentence](https://youtu.be/dQw4w9WgXcQ) is a chip instead.
- The next section                      # STRUCTURE — a body element, never `##` in the prose
  - deeper prose…
```

## The grammar

Five constructs, and no others. Everything else passes through verbatim.

| Syntax | Meaning |
| --- | --- |
| `**bold**`, `__bold__` | strong |
| `*italic*`, `_italic_` | emphasis |
| `~~strike~~` | struck through |
| `` `code` `` | code span — **atomic** |
| `$$…$$` | math, typeset with KaTeX — **atomic**, may span lines |
| `[label](target)` | a link — *points at* the target |
| `*[label](target)` | an **embed** — *inlines* the target |

**Atomic** means the contents are never re-interpreted as markup: a `*` inside `` `code` `` or
`$$…$$` is a literal asterisk, not emphasis. Bold is matched before italic, so `**x**` is one strong
run rather than two emphases. Emphasis does not span a token — `*a `b` c*` leaves its markers as
literal text.

Marklower is **not a Markdown subset**, and does not try to be. `![](…)` is not image syntax here
(see *Embeds*), and `*[a](b)` means something Markdown has no word for.

### Line breaks

A **single newline is a soft break**: the hard-wrapped lines of a block scalar are a *source*
courtesy, so they rejoin into one flowing run and the rendered prose wraps at the reader's chosen
width instead of the authored column — Markdown's rule, kept for the same reason. The join crosses
an inline token (`text\n$$x$$` is one sentence), and emphasis may span it. A **blank line stays**:
it renders as the vertical gap the author drew. A block embed's own line vanishes with the figure
(see *Embeds*), never leaving a stray gap above or below it.

## Link targets

A target is addressed in the app's **JSON instance space** — the same space the tree, the
breadcrumbs, and the URL navigate — with the colon grammar of `SEPARATOR.md`:

| Target | Anchored at |
| --- | --- |
| `:a:b`, `:[2]` | the **document** the link appears in (the nearest yamlover entity) |
| `::a:b` | the **project root** (the directory yamlover was served) |
| `scheme://…`, `mailto:…` | an ordinary **external** link, opened in a new tab |

Anything else does not resolve, and the label renders as plain text. The legacy slash spellings
(`/a/b` document-relative, `//a/b` project-rooted) still parse; `examples/69-marklower-links.yamlover`
is a tour of all three flavours. One function, `resolveLink`, decides what a target means, for every
renderer that emits links.

## Embeds

`[…]` points at a target; `*[…]` **inlines** it. The `*` carries exactly the sense it carries in
yamlover proper: a dereference. One token therefore covers pictures, video, audio, and any media a
target can name — there is no separate image syntax, and none is wanted.

What a target inlines to is decided by its host first and its extension second:

| Target | Inlines as |
| --- | --- |
| `youtube.com/watch?v=…`, `youtu.be/…` | a `youtube-nocookie.com` player |
| `vimeo.com/…` | a `player.vimeo.com` player (`dnt=1`) |
| `…mp4`, `.webm`, `.ogv`, `.mov` | a native `<video>` |
| `…mp3`, `.ogg`, `.wav`, `.flac` | a native `<audio>` |
| `…png`, `.jpg`, `.webp`, `.avif`, … | an `<img>` |
| an in-app node path with such an extension | the same, streamed from `/api/blob` |
| **anything else** | **nothing** — it degrades to the plain link it already was |

That last row is a **security boundary, not a fallback**. The set of hosts that may be framed is an
allowlist; an arbitrary origin, a `data:` URL, and a `javascript:` URL are all refused, so prose can
never mount a frame of its own choosing. A provider embed also renders as a **facade** — poster plus
play button — and loads the third party's frame only once the reader clicks it.

Timestamps need no syntax: they ride on the target's own query string
(`*[the good bit](https://youtu.be/abc?t=1m30s)`).

**Position decides the shape, not kind.** A token alone on its line becomes a block `<figure>`,
captioned by its label. The same token inside a sentence becomes an inline chip that opens in place.
A YouTube video is a figure or a chip depending only on where the author put it.

### The one ambiguity

Reusing `*` costs exactly one collision, with emphasis:

- `*[a](b)` — an embed.
- `*[a](b)*` — an *italic link*; the `*`s pair around it.
- `**[a](b)**` — a bold link, for the same reason.

The trailing `*` decides. This is the price of spelling deref the way yamlover spells it, and it is
worth paying.

## Structure — how a chapter, a table, and a list divide the work

The structures marklower delegates to are all ordinary yamlover nodes, told apart by their
schema tag and their shape:

- **A chapter** (`$defs/chapter`) is a list whose elements are the **paragraphs** (chunks);
  its scalar self-value is the **title**, and a keyed `description` is supported. A **nested
  container is a subchapter** (titled when it carries its own self-value): an untagged container
  element keeps routing to the chapter recursion, so structure comes free. A table or a
  typographical list enters a body **only by its explicit tag** (`CHAPTER.md`).
- **A table** (`$defs/table`) consumes exactly **two nesting levels**: the first level is the
  **rows**, the second the **cells**. A third-or-deeper untagged container **switches back to
  a chapter** — a cell holding prose and structure under the same rules as the top chapter.
  Nesting a table needs the explicit table tag again.
- **A list** (`$defs/bullets`, `$defs/numbered`) applies at **any depth**: an untagged nested
  container is a sublist of the *same kind*, until an explicit tag switches to something else.

## Tables

Marklower has **no table syntax** — no pipe rows, no separator lines. A table is structure, and
structure is yamlover's job: it is a **body element** tagged `!!<*yamlover: $defs: table>`.

### The model — rows of cells, one omni node

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

A row is written flow (`- [a, b, c]`) or block — a `- ` whose cells follow as `- ` items,
compacting onto one line (`- - cell`) or not (a lone `-` with the cells deeper); the three
spellings are the same row. In a flow row a cell containing a space, or opening with a
marklower `*`/`&` (a yamlover sigil), is quoted.

- **The column count is inferred from the first row** — the `header` when present, else the
  first keyless row. A shorter row pads with empty trailing cells; a longer row is a
  **reported inconsistency**, surfaced like a dangling pointer, never silently truncated.
- **`header`** renders as the header (`<th>` cells) wherever it is authored; by convention
  it is written first. Other keyed rows have no table meaning — the key just makes the row
  addressable by name.
- **`title`** is the caption, `text/marklower` like a chapter's title (which, unlike this one,
  is the chapter node's *self-value*). Being keyed, `title` and `header` **consume positions**
  in the omni stream (CHAPTER.md §Addressing) — a captioned table's header is `[1]` and its
  first body row `[2]`.

### Cells

The table schema spends its **two levels** on rows and cells; a cell is
`anyOf: [chunk, chapter, table, bullets, numbered]`:

- **A chunk** (`$defs/chunk`) — the default. Schema propagation stamps every leaf cell
  `text/marklower`, exactly as a chapter's body prose is stamped, so cells carry bold,
  links, math, and embeds with no per-cell tag. An empty string is an empty cell.
- **A chapter** (`$defs/chapter`) — the *untagged container* cell. Past the table's two
  levels, shape routing switches **back to the chapter rules**: the cell's items are chunks
  of a chapter, its untagged containers subchapters, its tagged elements tables and lists —
  the same rules as the top chapter. The explicit `!!<*yamlover: $defs: chapter>` tag stays
  legal, just no longer required:

  ```yamlover
  - - Rocky                            # a block row, compact
    - raccoon
    -                                  # an untagged container cell — a CHAPTER
      - night shift **only**
      - !!<*yamlover: $defs: table>    # its inner table enters by its tag, as in any chapter
        - [bins, tipped]
  ```
- **A nested table** — only by the explicit `!!<*yamlover: $defs: table>` tag; the tag
  restarts the two-level budget, and the recursion bottoms out in marklower.
- **A list** — only by its explicit tag (§Lists).
- **A pointer** — a cell may be a `*` edge to any node; a pointer is an edge, not a schema
  branch, and the shared target conforms as whatever it is. Two pointer targets are special
  — the adjacent previous cells — and they mean **merging**:

### Merged cells — relative pointers

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

### Header widths

A header cell follows the same rules as a regular cell, with one extra: it may be an **omni
scalar** — the heading text plus a keyed sidecar — carrying **`width`**, a **proportional
column weight** (the AsciiDoc `cols="1,2,6"` precedent; Markdown has no widths at all):

```yamlover
!!<*yamlover: $defs: table>
header:
  - Name                               # an omni header cell: text + a `width` sidecar
    width: 3
  - Species
  - Duty
- [Whiskers, cat, 'supervising humans']
```

A bare number is a relative weight; the renderer emits each column as
`weight / sum-of-weights` percent (`<colgroup>`). A width-less column defaults to weight 1,
so a partial spec still lays out the whole grid; a non-numeric width, and a pointer or
merged header cell, contribute nothing (weight 1). `width` is deliberately **schema-untyped**
— an omni cell must stay a *leaf* for shape routing, so the sidecar is convention, not
vocabulary.

### The schema

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
        - *:: yamlover: $defs: chapter
        - *:: yamlover: $defs: table
        - *:: yamlover: $defs: bullets
        - *:: yamlover: $defs: numbered
items:                             # a row
  type: array
  items:                           # a cell
    anyOf:
      - *:: yamlover: $defs: chunk    # marklower prose (the default leaf)
      - *:: yamlover: $defs: chapter  # an UNTAGGED container cell IS a chapter (the first
      - *:: yamlover: $defs: table    #   container branch wins shape routing); a nested
      - *:: yamlover: $defs: bullets  #   table — and a list — enters a cell only by its
      - *:: yamlover: $defs: numbered #   explicit tag
```

A table enters a chapter body as an **explicitly tagged** element — the tag decides;
untagged containers keep routing to subchapters (CHAPTER.md §The schema).

### Addressing cells

A table node at path `P` addresses a cell as `P[r][c]` — row by its omni position, cell by
its position in the row — so a document-relative marklower link points at `:[i][r][c]`
(the table at body index `i`). The `header` row is also addressable by name (`P: header`),
and `title`/`header` consume indices per the omni model, as noted above. Nested tables just
go deeper: `:[i][r][c][r'][c']`.

## Lists

Typographical lists — unnumbered (bullet) and numbered — are delegated exactly like tables:
marklower has no `- ` or `1. ` syntax; a list is a **body element** tagged
`!!<*yamlover: $defs: bullets>` or `!!<*yamlover: $defs: numbered>`, and syntactically it is
**just a yamlover list** whose items are marklower chunks:

```yamlover
- !!<*yamlover: $defs: bullets>
  - the first point, with **bold** and [links](:[2]) — items are marklower
  - - a nested sub-point               # an untagged container = a sublist of the SAME kind
    - - and deeper still               # …at ANY depth (compact `- - ` or block form alike)
- !!<*yamlover: $defs: numbered>
  - step one
  - step two
```

The one rule that distinguishes lists from tables: where the table schema spends exactly two
levels and hands a deeper container back to `chapter`, a list schema applies **at any
depth** — an untagged container item *is* a nested sublist of the same kind — until an
**explicit tag** switches (a numbered list inside a bullets list, a table inside an item,
each by its own tag). Both schemas are two-line mirrors of each other
(`items: anyOf: [<self>, chunk]`, `type: variant` deriving `x-yamlover-bullets` /
`x-yamlover-numbered`), registered like every `$defs` schema and rendered as `<ul>` / `<ol>`.

A chapter body remains the home of *structural* lists — a body's own `- ` elements are
paragraphs and subchapters, not typography. Tag a list when the bullets are *content*
(a shopping list inside a paragraph flow), not when they are the document's structure.

## Atoms and the WYSIWYG round-trip

The web editor edits a prose chunk **in place**: the rendered prose itself is `contentEditable`.
Emphasis is edited live as markup, while every **atomic** token — math, code, links, embeds — renders
`contenteditable="false"` carrying its verbatim marklower source in `data-src`. The reverse
serializer returns that source untouched rather than re-deriving it from the rendered KaTeX, code, or
player.

That is why the language is worth keeping small: every construct must survive a round trip through a
DOM the browser is allowed to rewrite. `domToMarklower` is the single reverse serializer, shared by
the editor and by clipboard paste, so the two always agree on the markup they emit.

An image pasted **into** an open chunk is uploaded beside the chapter (an `inline` file paste, which
appends no chunk) and referenced by an embed token — the bytes become the project's, not a hotlink.

## Known divergence

The HTML-clipboard paste path (`paste-html.ts`) emits three block constructs the renderer does
**not** parse, and which therefore render as literal text: `- ` bullets, ` ``` ` fenced code, and
`> ` block quotes. They are recorded here as a divergence, not a promise: teaching marklower to
parse them would be teaching it block structure, which is the one thing it refuses to have.
Bullets now have a structural home — `$defs/bullets` (§Lists) — so the likelier resolution is
that paste emits a tagged list; fenced code and quotes still await theirs.

## Status

The inline grammar is implemented in `tools/server/src/client/renderers/marklower.tsx` (as one
`TOKEN` alternation), `embed.ts` (the embed resolver and its allowlist), `links.tsx`
(`resolveLink`), and `marklower-serialize.ts` (HTML → marklower).

The delegated structures — spec'd 2026-07-16, cell routing flipped and lists added 2026-07-17:

- **Schemas** — hosted `$defs/table`, `$defs/bullets`, `$defs/numbered` (registered in
  `$defs/.yamlover/meta.yamlover`); `examples/61-table.yamlover` is the worked table fixture,
  `examples/60-simple-chapter.yamlover` carries the list demos.
- **Relative-index resolution** — `tools/engine/ts/src/resolve.ts`: a `[.±k]` step resolves
  by the frame rule (the host positions vector rides the resolution chain), and a chain of
  merge pointers resolves transitively to the origin cell. Out of range / no host frame at
  the depth → the ordinary dangling diagnostic.
- **The renderers** — `tools/server/src/client/renderers/table.tsx` (registry entry
  `byFormat("x-yamlover-table")`): rows/header/caption, `colSpan`/`rowSpan` computed from the
  resolved pointers' target paths + the rectangle rule above, header `width` sidecars as a
  `<colgroup>`, tagged nested tables inline, untagged container cells as chapter cells,
  marklower cells; and `list.tsx` (`byFormat("x-yamlover-bullets"/"x-yamlover-numbered")`):
  `<ul>`/`<ol>`, same-kind nesting at any depth, tagged tables inline.
- **Cell editing** — under the chapter lock, a prose cell edits in place and emplaces at its
  `<table>[r][c]` path; the server splices flow-row cells token-wise (a multi-line cell needs
  the block row form and is rejected in flow). Structure editing (add/remove rows and
  columns, making merges) is **pending**.
- **onenote2yamlover** emits tables in this format (was: CSV) — nested tables carry the
  explicit table tag, marklower cell formatting preserved; OneNote has no header rows or
  merges, so none are emitted. A OneNote cell mixing prose and tables becomes a **chapter
  cell** (nothing is dropped).
