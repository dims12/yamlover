# ANNOTATIONS — fragments & tagging

How a user marks up a document: **fragments** (regions) and **annotations** (tags applied
to a whole node or a fragment). Both live **on the target node** — they travel with the
document, not in a side file. Companion specs: `YAMLOVER.md` (§4 omni), `META.md` (`$defs`,
`variant`), `SEPARATOR.md` / `URIs.md` (the `::` project scope, `*`/`&`), `QUERY.md`.

> Supersedes the old model (a separate `/annotations/*.yamlover` node per tag application,
> reverse-linked by a `target` pointer). The selector role moves into **fragments**; the
> tag-application becomes a `yamlover-annotations` array element. `$defs/annotation` is
> redefined and `$defs/fragment` is new.

## 1. Fragments — `yamlover-fragments`

A **fragment** is a user-selected region inside a supported node: a text span, an image/PDF/
djvu rectangle, a map box. Selecting a region **creates a fragment in the node it was made
in**, stored under the node's **`yamlover-fragments`** key — a **mapping** whose keys are
**slugs** (`${base36(now)}-${rand}`, the scheme that used to name annotation files).

A fragment holds **only what locates/highlights the region** — no description, no color. Its
value is the *selector* (the same shapes the renderers already produce) plus `created`:

| target | fragment value |
|---|---|
| text (prose / markdown chunk) | `{type: text, exact, prefix, suffix}` — a W3C TextQuoteSelector; prefix/suffix context disambiguates repeats (no character offsets) |
| image | `{type: rect, x, y, w, h}` |
| PDF | `{type: pdf, page, x, y, w, h}` |
| djvu | `{type: djvu, page, x, y, w, h}` |
| map | `{type: map, n, s, e, w}` (geographic edges) |

### 1.1 Image-like fragments embed a crop

For **image / PDF / djvu** selections the fragment also carries an **`image`** field — a
**binary** crop (`format: image/png`) of the selected region, produced client-side from the
already-rendered canvas. Because inline binary is unsolved on the text surface, the bytes
live as a **sidecar blob file** referenced by a `*` pointer:

```yamlover
image: *::papers:fragments:mqdo07z1-owgrcv.png
```

Text and map fragments carry no crop.

### 1.2 A fragment's scrollable URL

A fragment is addressable in the browser by the in-page `#` rule (see `tools/server/README.md`):
its node path `<material>/yamlover-fragments/<slug>` becomes the scrollable URL
`<material-url>#yamlover-fragments/<slug>` — the `#` standing in for the `/` after the served
material. Opening that URL (or clicking the fragment in the viewer's fragments panel) scrolls
text/PDF/djvu regions into view and pans image/map regions to fit, then briefly flashes the region.

### 1.3 Future

Fragments will become **hierarchical** and surface as **children under the document node** —
e.g. marking up the table of contents of a textless (image-only) PDF, so the viewer can show
those fragments as a navigable tree. Out of scope here; the shape above is forward-compatible.

## 2. Annotations — `yamlover-annotations`

An **annotation** is the application of a **tag** to a target — the **whole node** or a
**fragment** within it. Annotations live under the target's **`yamlover-annotations`** key,
a **sequence**. Each element is one of:

- **Parameterless** — a bare **tag pointer**. We only know the target *has* this tag:
  ```yamlover
  - *::tags:genre:brevity:shortest-paper
  ```
- **Parametrized** — an **object** carrying a **`tag:`** field plus one or more parameters:
  ```yamlover
  - {description: A standalone LaTeX block, tag: *::tags:topic:math}
  - importance: 10
    tag: *::tags:review:flagged
  ```

The applied tag's **color** (its explicit `color`, else a name-derived hue) drives display —
never the selector. A **fragment node carries its own `yamlover-annotations`** (tagging that
region); the **document root** carries a top-level one (tagging the whole node). Two tags on
one target = two elements.

Tag pointers are written in **project scope** (`*::…`), matching the tag taxonomy at the
project root (`::tags:…`) and the built-in palette (`::yamlover:tags:colors:…`).

## 3. Where the keys physically live (omni)

A target usually already *has a value* (a markdown string, a PDF's bytes). yamlover's **omni**
shape (`type: variant`, `YAMLOVER.md` §4) lets a node carry that self-value **and** fields at
once, so `yamlover-fragments` / `yamlover-annotations` sit beside it.

**Whole yamlover document** — plain root keys (the root may carry a scalar value too):

```yamlover
!!<*::yamlover:$defs:chapter>
title: A Pinch of Math
yamlover-annotations:
- *::tags:genre:brevity:shortest-paper
```

**Chapter chunk (markdown block scalar)** — the chunk becomes an **omni block-scalar**; the
fields sit at a **shallower** indent than the block content (and deeper than the key):

```yamlover
chunks:
- !!var |
    Mathematics likes to hide, but a standalone LaTeX block
    gives it away.
  yamlover-fragments:
    mqdo07z1-owgrcv: {type: text, exact: LaTeX, prefix: ", a standalone ", suffix: " block"}
  yamlover-annotations:
  - *::tags:topic:math
```

**On-disk binary file (a `.pdf`)** — omni over a blob: the parallel keys go in the enclosing
directory's `.yamlover/body.yamlover` overlay under the `"<filename>":` key (the engine's
overlay merge keeps the blob's bytes while attaching fields):

```yamlover
# papers/.yamlover/body.yamlover
"S0002-9904-1966-11654-3.pdf":
  yamlover-annotations:
  - *::tags:genre:brevity:shortest-paper          # whole document, parameterless
  - {description: Two-line proof, tag: *::tags:review:flagged}
  yamlover-fragments:
    myslag:
      type: pdf
      page: 1
      x: 133
      y: 322
      w: 73
      h: 11
      image: *::papers:fragments:myslag.png        # the embedded crop
      created: 2026-06-14T11:20:28.901Z
      yamlover-annotations:                         # tagging just this region
      - *::tags:topic:math
      - {importance: 10, tag: *::tags:review:flagged}
```

## 4. Schemas

- **`$defs/fragment`** (`format: x-yamlover-fragment`) — an object: the selector-union fields
  (`type, exact, prefix, suffix, page, x, y, w, h, n, s, e, w`), `created`, and an optional
  binary `image`.
- **`$defs/annotation`** (`type: variant`, `format: x-yamlover-annotation`) — a tag
  *application*: its self-value is a tag pointer (the parameterless case); as an object it
  carries `tag` plus a `description` and any other parameters.

Both are reached as `*::yamlover:$defs:<name>` (the yamlover project is grafted at every served
root's self-import key `yamlover`). Note the **all-colon** spelling: a project scope `::` must be
followed by colon steps — `*::yamlover/$defs/tag` parses the `/`-path as a link *authority* and
does not resolve, whereas `*yamlover/$defs/tag` (no `::`) is a current-scope slash path that does
(`SEPARATOR.md`). Server-written tags use the colon form.

## 5. Engine derivation

Annotations and fragments are ordinary graph entries, so the engine derives the views:

- **A node's annotations** = its own `yamlover-annotations` elements (plus those of its
  fragments), each resolving to a tag via the element's value pointer or `tag:` field.
- **Materials filed under a tag** (`/api/tagged`) = the reverse of those forward tag pointers —
  every `yamlover-annotations` element pointing at the tag, surfaced as its owning material or
  fragment.
- **Highlighting** reads the sibling fragment's selector (and its `image` crop) for the region.
