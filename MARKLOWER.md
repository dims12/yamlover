# MARKLOWER — the inline markup of a chunk

**Marklower** is yamlover's prose format: a markup language deliberately a notch *below* Markdown
(hence the name). It is the format a **chapter's chunks** carry — `$defs/chunk` declares
`format: text/marklower` and schema propagation stamps every prose chunk with it, so an article
needs no per-chunk tag (`CHAPTER.md`). It is asked for by name: a format-less string *elsewhere* in
the tree is data, not prose. This spec defines the language; companion specs: `CHAPTER.md`
(the document model it serves), `TABLE.md` (the table model it delegates to), `SEPARATOR.md`
(the `:` path grammar its links speak), `TYPES.md` (the type lattice), `META.md` (the schema
vocabulary).

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
`!!<*yamlover: $defs: table>` (`TABLE.md`), whose cells are themselves marklower.

```yamlover
!!<*yamlover: $defs: chapter>
title: Embedding things                  # title/description are marklower too
- |
  Prose with **bold**, *italic*, `code`, inline math $$e^{i\pi}+1=0$$, and a
  [link to the next section](:[2]) — all inline, all in one chunk.
- |
  An embed alone on its line becomes a figure:

  *[Kubrick on Napoleon](https://youtu.be/dQw4w9WgXcQ)

  The same token *[mid-sentence](https://youtu.be/dQw4w9WgXcQ) is a chip instead.
- title: The next section               # STRUCTURE — a body element, never `##` in the prose
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

## Tables

Marklower has **no table syntax** — no pipe rows, no separator lines. A table is structure, and
structure is yamlover's job: it is a **body element** tagged

```yamlover
- !!<*yamlover: $defs: table>
  header: [Name, Species]
  - [Whiskers, cat]
  - [Rex, dog]
```

— an omni node whose keyless entries are the rows, whose `header`-keyed row is the header, and
whose **cells are marklower chunks**, so the inline grammar simply recurses into every cell (bold,
links, math, embeds — all of it, per cell). Merged cells are `*` pointers to the adjacent previous
cell (`*[.-1]` left, `*..[.-1][.]` up) — the same dereference `*` means everywhere else. The full
model — header, caption, column inference, spans, nested tables — is `TABLE.md`.

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
parse them would be teaching it block structure, which is the one thing it refuses to have. The
likelier resolution is that paste stops emitting them.

## Status

Implemented in `tools/server/src/client/renderers/marklower.tsx` (the grammar, as one `TOKEN`
alternation), `embed.ts` (the embed resolver and its allowlist), `links.tsx` (`resolveLink`), and
`marklower-serialize.ts` (HTML → marklower). The embed token is new; the rest predates it.
