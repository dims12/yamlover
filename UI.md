# Operating the yamlover UI

The `yamlover` server (`npx yamlover <root>`, or `npm start -- <root>` from this repo)
serves a web app that browses a tree/DAG as a graph of nodes. This guide covers how to
drive that UI: the layout, navigation, the data/schema views, the unified pan/zoom/select
interaction model for materials, and annotations.

> Materials are the leaf documents a node carries — prose (Markdown, AsciiDoc, marklower,
> chapters), images, KML/KMZ maps, PDFs, DjVu scans, spreadsheets, and so on. Each is shown
> by a renderer; the interaction rules below are the same across them by design.

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

The two panes scroll independently.

## Views (representation tabs)

Every node can be shown in several representations; pick one with the tabs:

- **`yamlover`** — the YAML-family syntax (the default).
- **`json5p`** — the JSON-family syntax.
- **`yamlover/schema`** — the node's instance schema.
- **A renderer tab** (e.g. `chapter`, `image`, `map`, `pdf`) — present only when the node is
  a material; it is that node's default, showing the rendered document.

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
  Ctrl/Alt + wheel still zooms the chunk.

## Annotations

An annotation marks a piece of a material and is saved as a first-class node in the graph
(a `$defs/annotation` object), reverse-linked to the material — so it persists across reloads
and shows up wherever the material is read. The flow is the **same for prose, images, maps,
and PDFs**: you **select**, then pick a color.

1. **Select** the thing to mark:
   - **Prose / PDF** — drag to select text.
   - **Image / Map** — drag a rectangle over the region.
2. A small **palette** pops up by the selection. The selected text / dragged rectangle stays
   shown while it's open, so it's clear what you're marking. The buttons:
   - **Color swatches** — click one to create the annotation in that color. The **last color
     you used is pre-selected** and remembered, so repeated marks stay one color.
   - **✓ Confirm** — create in the pre-selected color (the explicit alternative to clicking away).
   - **⧉ Copy** (prose only) — copies the selected text to the clipboard and creates **no**
     annotation.
   - **🗑 Discard** — drops the pending mark, creating nothing.
3. **The default is to keep the mark:** clicking anywhere outside the menu also commits in the
   pre-selected color. Only **Copy** or **Discard** skip creation.

A new mark appears **immediately** — it doesn't wait for the save round-trip. Saved marks
render in their color — a highlight under prose, a colored rectangle over an image, map, PDF,
or DjVu region — and a count shows above the material.

**To recolor or delete an annotation, click it.** The same palette reopens in *edit* mode, with
the annotation's current color pre-selected: click a swatch to **recolor**, or **🗑** to **delete**
it; clicking away just closes. (Any *standalone* annotation file can be edited this way, wherever
it lives; an annotation authored inline in a shared document is shown but frozen.)

New annotations are written as ordinary `.yamlover` files (one per annotation) under the
project's **default annotation location** — `<root>/annotations/` unless
`.yamlover/settings.yamlover` configures `annotations: {location: …}`. The location is only a
creation default: annotations are graph nodes, pointing at their material with a project-scoped
pointer, so you can read, **move to any directory**, version, or hand-edit them like anything
else in the tree and they keep working.

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

## Tips

- The URL path **is** the node path — link straight to `…/59-all-formats-object/markdown`,
  or share a deep link. The `?format=` query selects the active tab.
- A node's **title** (a `title` child) drives both its tree label and the browser tab.
- The SQLite index under `<root>/.yamlover/` is a derived cache; delete it to force a clean
  rebuild. External edits are picked up on server restart.
