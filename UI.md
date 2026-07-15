# Operating the yamlover UI

The `yamlover` server (`npx yamlover <root>`, or `npm start -- <root>` from this repo)
serves a web app that browses a tree/DAG as a graph of nodes. This guide covers how to
drive that UI: the layout, navigation, the data/schema views, the unified pan/zoom/select
interaction model for materials, and annotations.

> Materials are the leaf documents a node carries — prose (Markdown, AsciiDoc, marklower,
> chapters), images, KML/KMZ maps, PDFs, DjVu scans, spreadsheets, and so on. Each is shown
> by a renderer; the interaction rules below are the same across them by design. (Marklower
> prose carries its own inline media: an `*[…](…)` embed inlines an image, a video, or an
> audio track without leaving the paragraph — `MARKLOWER.md`.)

## Layout

```
┌──────────────┬──────────────────────────────────────────────┐
│  TOC tree    │  breadcrumb                                   │
│  (left)      │  [type] [tags]  |  yamlover · json5p · schema │  ← node header
│              │ ──────────────────────────────────────────── │
│  click a     │  upstream relations ( .. and incoming refs)  │
│  node to     │  ───────────────────────────  ← the <hr>     │
│  open it     │  the node's value / rendered material         │
└──────────────┴──────────────────────────────────────────────┘
```

- **TOC tree (left).** The whole tree, lazily expanded. Click a row to open that node on
  the right; click the ▸/▾ to expand or collapse without navigating. Each row shows the
  node's type icon and its title (or its key / `[index]`).
- **Breadcrumb (top).** The path from the served root to the current node; click any
  segment to jump up.
- **Node header.** A `[type]` chip (`object`, `array`, `variant`, `mixed`, a scalar type, a
  binary media type…), any **tag** chips the node is filed under (click to open the tag),
  and the **representation tabs**.
- **Task strip (top bar).** While the server runs long work — indexing a big tree,
  background-hashing files — a chip per task shows its label, counts, and a progress
  bar, fed by the live event stream (`/api/tasks` + SSE task events). It disappears
  when the work is done.

The two panes scroll independently.

**Everything refreshes live.** Every change — an edit you make in the UI, a file
saved in your editor, a shell `mv` — flows through one channel: the server announces
an index diff over SSE and every affected surface (TOC branches, the open node, tag
pages) re-fetches itself. There is no manual reload step.

## Views (representation tabs)

Every node can be shown in several representations; pick one with the tabs:

- **`yamlover`** — the YAML-family syntax (the default).
- **`json5p`** — the JSON-family syntax.
- **`yamlover/schema`** — the node's instance schema.
- **A renderer tab** (e.g. `chapter`, `image`, `map`, `pdf`) — present only when the node is
  a material; it is that node's default, showing the rendered document.
- **`explorer`** — a file-manager-style **icon grid**, the default for a concrete
  directory (each child as an icon + label; click to open) and for a **tag's own
  page**, where the grid shows the materials filed under that tag (via
  `/api/tagged` — annotation targets deduplicated, whole-node tags included).

Each data/schema view is **one level deep**: a nested object or array appears as a
`{ N properties }` / `[ M elements ]` link — click it to descend. Pointers (`*`/`~` edges)
likewise render as links you click to follow.

### Relations panel

In a data view, the area **above the `<hr>`** lists the node's **upstream** relations —
its containment parent as `..`, plus any incoming references (who points at it). The
material/value and the node's **downstream** relations sit **below** the `<hr>`. (This split
by natural edge direction is uniform across every node — see `URIs.md`.)

## The unified interaction model

Materials that can pan/zoom (images, maps) or that are long documents (PDF, DjVu, prose)
all obey the **same gestures**, so muscle memory carries across them. **Selecting is the
default**; panning and zooming move to a held modifier (**Ctrl** or **Alt** — either works,
plus **⌘** on a Mac).

| Gesture | Prose (text) | Image / Map | PDF / DjVu |
|---|---|---|---|
| **drag** | select text → annotate | drag a rectangle → annotate the region | (PDF) select text → annotate |
| **Ctrl/Alt + drag** | — | **pan** the canvas | — |
| **wheel** | scroll | **pan vertically** | scroll |
| **Ctrl/Alt + wheel** | — | **zoom** (around the cursor) | **zoom** (page width) |

Notes:

- A **plain drag is always a selection** — on an image or map the cursor is a crosshair to
  signal it. To move the canvas instead, **hold Ctrl/Alt and drag**.
- A **plain wheel** behaves like scrolling everywhere: it scrolls prose and paged documents,
  and pans an image/map vertically (so a tall image scrolls past like text).
- **Ctrl/Alt + wheel zooms** an image, map, PDF, or DjVu. Images and maps zoom around the
  pointer; PDF and DjVu scale the page width (then the pane scrolls).
- Inline materials embedded in a **chapter** (an image or map chunk) keep plain-drag **pan**
  and let a plain wheel scroll the chapter, so the surrounding page still scrolls normally;
  Ctrl/Alt + wheel still zooms the chunk. A marklower **embed** inside a prose chunk is a
  figure (alone on its line) or a chip that opens in place (mid-sentence); a video embed shows
  a poster and loads the player only once you click it.

## Annotations

An annotation is **a tag applied to a piece of a material** — one tag application, saved **into
the target itself**: a selected region becomes a `yamlover-fragments` entry on the node, and each
applied tag an element of its `yamlover-annotations` array (`ANNOTATIONS.md`) — so it travels
with the document, persists across reloads, shows up wherever the material is read, and is
listed on the tag's own page among the tag's members. Its display color is **the applied
tag's**: a built-in **pure color tag** (`yamlover/tags/colors/…`) carries an explicit color, and
any **named tag** gets its stable name-derived hue (the same hue its badges use everywhere). The
flow is the **same for prose, images, maps, and PDFs**: you **select**, then pick a tag.

1. **Select** the thing to mark:
   - **Prose / PDF** — drag to select text.
   - **Image / Map** — drag a rectangle over the region.
2. A small **tag picker** pops up by the selection. **Nothing is pre-selected** — a new mark
   starts blank, and the selected text / dragged rectangle stays shown in a **neutral** color
   while the picker is open, so it's clear what you're marking without implying a tag. The controls:
   - **Color-tag swatches** — the six built-in pure color tags; click one to apply it.
   - **Named-tag chips** — the tags already on this target (shown **outlined**), the tags on the
     same node's other parts, your **recently-used** tags, and the project taxonomy; click one to
     apply it.
   - **A tag path input** — type any tag's node path (e.g.
     `/examples/67-pdf-tags/tags/genre/humor/deadpan`) and press **Enter** to apply that tag.
     A **bare name** (no `/`) works too: if no such tag exists yet it is **created on the
     spot** — appended to the project's tag taxonomy (the `tags: *:: tags` setting in
     `.yamlover/settings.yamlover`, `<root>/tags` by default) as `<name>: !!<*$defs/tag>` —
     and then applied.
   - **⧉ Copy** (prose only) — copies the selected text to the clipboard and creates **no**
     annotation.
   - **✕ Close** (or click anywhere outside) — closes the picker, committing nothing extra.
3. **Picking a tag IS the apply.** Each pick applies its tag at once and the menu stays open, so
   you can add several; an **applied** tag shows outlined, and clicking it again **removes** it.
   Closing without picking leaves the region untagged — a new selection never tags itself.

A new mark appears **immediately** — it doesn't wait for the save round-trip. Saved marks
render in their tag's color — a highlight under prose, a colored rectangle over an image, map,
PDF, or DjVu region — and a count shows above the material. The same region can carry several
tags — each application is its own annotation.

**To re-tag or delete an annotation, click it.** The same picker reopens in *edit* mode over the
mark's current tags (shown outlined): pick another tag to add, click an outlined one to remove,
or close to leave it.

The built-in tags ship with the yamlover project (at its root: `tags/colors`, beside
`$defs/`); the engine grafts the **self-import key `yamlover`** → {$defs, tags} into every
served root — including the yamlover project itself — so `/yamlover/tags/colors/…` and
`/yamlover/$defs/…` resolve in every project (and there, `//X` ≡ `//yamlover/X`).
Whole-node tagging stays as it was: an anchor membership on the node itself (no annotation
object needed when there's no region and no comment).

New annotations are written **into the target's own source** — the `yamlover-fragments` /
`yamlover-annotations` keys sit beside the node's value (yamlover's omni shape), and for an
on-disk binary file they land in the enclosing directory's `.yamlover/body.yamlover` overlay
under the file's key. An image/PDF region also embeds a **crop**, stored as a sidecar blob
referenced by a `*` pointer. It is all ordinary yamlover in the tree — read, version, or
hand-edit it like anything else (`ANNOTATIONS.md` has the exact shapes).

## Editing a chapter

A chapter (or a task) page is **read-only until you unlock it** — the lock button in the node bar,
or **F2**; **Esc** locks it again. The mode sticks across navigation, so clicking through to a
subchapter keeps you editing.

Unlocked, the page edits **in place**: the rendered prose *is* the editable surface (a
`contentEditable`), not a source textarea beside it. Title and description edit as themselves;
each prose chunk edits as the paragraph you were just reading. **Enter** splits a chunk in two,
**Backspace** at the very start joins it into the previous one, **Delete** at the end pulls the next
one in, and the arrow keys walk out of a chunk into its neighbour — so the chapter's positional body
is edited the way a document is written, not the way a tree is edited. Edits ride the surgical
`/api/edit` write path in the background (debounced and coalesced), addressing each body element by
its **absolute entry index** (`:doc[3]` — keyed entries consume indices too, `CHAPTER.md`); a `🗑`
removes a chunk.

Prose is **marklower** (`MARKLOWER.md`): emphasis is edited live as markup, while its atomic
tokens — `$$math$$`, `` `code` ``, links, and `*[…](…)` embeds — render as single non-editable
objects that carry their own source, so a round trip through the editor never rewrites them. A
LaTeX chunk edits its raw source in a textarea instead; a chunk whose format has no editor stays
read-only in place.

## Paste & drag-and-drop upload

A file can be added to the tree straight from the clipboard (**Ctrl+V** on a node page) or
by **dropping** it onto the page — both follow the same rules, by what the current node is:

- **A directory** — the file lands in that directory (the page refreshes in place).
- **A member of a directory** (any non-chapter node) — the file lands in the nearest
  enclosing directory, and the new file opens in its renderer.
- **A chapter** — the file lands in the chapter's owning directory **and** a `*…` pointer
  to it is appended as the chapter's last chunk, so it appears inline at the bottom of the
  page.

Filenames are sanitized and de-duplicated (`name-1.ext`, …); pasted images get a generated
name. Everything is an ordinary file on disk afterwards — move or rename it like anything
else.

**Pasting text** follows the same shape: on a **chapter** the text becomes an inline
block-scalar chunk appended to the page; anywhere else it becomes a **new chapter
file** (`.yamlover`), titled from its first line. **Pasting links or rich HTML** goes
further: a pasted URL list becomes pointer chunks, an arXiv link fetches the PDF, a
tweet link captures the full tweet, and a rich-HTML selection is decomposed into
chunks (text, images, embedded video, subchapters) so the pasted page stays structured
rather than landing as one opaque blob. A copied **YouTube or Vimeo player** survives the
trip as a marklower embed; a frame from any other origin is dropped rather than pasted
(`MARKLOWER.md` — the embeddable hosts are an allowlist, and that is a security boundary).

**Pasting an image *into* an open prose chunk** is the one case that does not append
anything: the picture is uploaded beside the chapter and referenced from the sentence you
were writing, as a marklower embed. The bytes become an ordinary file in the tree — never a
hotlink to someone else's server, and never a second copy of the picture at the foot of the
page.

## Tips

- The URL path **is** the node path — link straight to `…/59-all-formats-object/markdown`,
  or share a deep link. The `?format=` query selects the active tab.
- A node's **title** (a `title` child) drives both its tree label and the browser tab.
- The SQLite index under `<root>/.yamlover/` is a derived cache; delete it to force a clean
  rebuild. External edits are picked up **live** by the FS watcher (and reconciled on
  startup for edits made while the server was down); `POST /api/reindex` is the manual
  fallback.
