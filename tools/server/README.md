# server

Browse a yamlover tree in the web browser.

```console
$ npx yamlover [ROOT] [--port N] [--headless] [--host ADDR] [--no-gitignore] [--prod]
```

`ROOT` is any yamlover entity — a project directory (one with a `.yamlover/`),
a plain directory, or a single file. It defaults to the current directory. The
command starts a local web server — **bound to `127.0.0.1` (local only) by
default**, the safe default for a personal viewer and for the desktop wrapper
(`tools/desktop`) — and serves a React single-page app that browses the entity
starting from `ROOT`. Pass `--headless` to bind `0.0.0.0` (all interfaces, e.g.
for remote access with no GUI), or `--host ADDR` for an explicit override.
`--prod` forces the prebuilt static client + bundled server (the default when
the dev sources aren't present, e.g. an installed package); without it, a
checkout runs the client from source via Vite with HMR.

The page is split into two independently scrolling panes:

- **Left — a table of contents.** A collapsible tree of **every** node — object
  keys and array elements alike, scalars included (so a leaf like
  `05-scalar-as-file` is listed and clickable). A node is *expandable* when it is
  a container with children and has no *active* renderer (see *Renderers*); the
  first three levels load expanded, and deeper branches load lazily via the
  chevron. Each entry is labeled by its `title` when present, otherwise by its
  key (objects) or `[index]` (arrays).

  Each row carries a **type/format icon** (chosen by the node's `format`, falling
  back to its type — `{}`/`[]` for object/array, `"`/`#`/`◧` for
  string/number/boolean, 📅/✉️/🔗/🖼️… for formats). The tree is agnostic to a
  node's *concrete* (how it is stored) — that shows in the node view's tags.
- **Right — the selected node.** A node with a registered renderer shows that
  renderer's view; every node also offers a set of **data-representation tabs**,
  always including:
  - **yamlover** *(default)* — the node's value in yamlover (YAML-family) syntax.
  - **yamlover/schema** — the node's instance schema.

  plus **json5p** for a JSON-family file. All representations behave
  **identically**: syntax-highlighted, **one level deep**, with every nested node
  shown as a **hyperlink** you click to descend (never inlined) —
  `{ object with N properties }`, `[ array with M items ]`, or
  `< binary of N bytes >`. The selected representation is part of the URL
  (`?format=`), so it is preserved as you navigate and is shareable.

  A binary leaf's bytes are read only when you select it and view its value.

The page updates **live**: an FS watcher re-indexes on external edits and pushes
what changed over an SSE stream (`/api/events`), so every surface (tree, node
view, tag pages) refreshes without a reload.

Surfaced *stray* files (those not described by the tree) honor `.gitignore` by
default — `node_modules/`, build output, etc. are hidden. Pass `--no-gitignore`
to show everything.

The browser URL is the node's path in **JSON space** — `/examples[0]/markup` —
plus `?format=` for the representation. Each key is percent-encoded, so a key
that itself contains a `/` (e.g. `@vitejs/plugin-react`) stays a single segment.
It updates as you navigate and is shareable / back-button friendly — opening a
deep link expands the TOC along the path and selects (and scrolls to) the target.

**In-page scroll (the `#` rule).** A node deeper than the served page is reached by
splitting its path at the page boundary and replacing that `/` with `#`: for a full
path `a/b/c/d` whose served page is `a/b`, the *scrollable* URL is `a/b#c/d` — the
page loads `a/b` and scrolls to the `c/d` node within it. A **fragment** (a tagged
region — see `ANNOTATIONS.md`) is one instance: a region of `…/IMG.jpg` lives at
`…/IMG.jpg/yamlover-fragments/<slug>`, so its scrollable URL is
`…/IMG.jpg#yamlover-fragments/<slug>` — opening it (or clicking the region in the
fragments panel) scrolls/pans to **and briefly flashes** the region.

## How it works

The server is backed by the yamlover **engine** (`tools/engine`): `walkDir`
turns the directory concrete into the parser's IR, and a `Store` (a SQLite
property-graph index) holds nodes and pointer edges. The HTTP layer
(`src/server/engine-api.ts`) reads from the `Store` and emits the response
shapes the React client consumes (the `$yamloverLink` / `$yamloverBinary` /
`$yamloverMixed` markers, the schema view).

The on-disk index lives at `<root>/.yamlover/index.db`. It is a derived cache
with a persistent **file manifest** (path + hash + size + mtime): startup
re-indexes against it (an offline reconcile — unchanged blobs are never re-read,
so it is cheap), and the FS watcher re-indexes on edits and broadcasts the diff
over `/api/events`.

**Long-running work runs as background tasks** (`src/server/tasks.ts`): the HTTP
server listens immediately and serves the previous index (or an empty one on a
cold start) while the initial walk and the background hasher (which fills in
content hashes for large blobs the walk no longer reads) run. Store-mutating
jobs (index, mv, paste, annotate) serialize through one writer queue; reads
never wait. Progress lands both on the console and in the web UI (SSE `task`
frames + `GET /api/tasks`).

Leaf bytes are read **lazily**: materialization builds structure but does not
read a leaf's content until that node is serialized.

### Build

There are two run modes:

- **Dev** (a checkout): the launcher runs [Vite](https://vitejs.dev) in
  middleware mode, serving the client from source with HMR and loading the
  server handler through Vite's `ssrLoadModule`.
- **Prod** (`--prod`, or an installed package): the client is a prebuilt static
  SPA under `dist/client` and the server handler is a single bundle at
  `dist/server.js`. `scripts/build.mjs` produces both — `vite build` for the
  client and `esbuild` for the server (bundling the engine, parser, and the
  `ignore` / `js-yaml` / `xxhash-wasm` deps, plus the dynamically-imported
  thumbnail codecs). It runs on `prepack`, so the published npm package ships
  `dist/` and has **no runtime dependencies**.

### API

All endpoints take a JSON-space `path` (default `/`); the value/schema endpoints
take an optional `depth` (container-nesting limit).

| endpoint | returns |
|----------|---------|
| `GET /api/info` | the breadcrumb head (the root label) |
| `GET /api/tree?path&depth` | the TOC subtree at `path`, `depth` levels deep (default 3) — fetched again per branch for lazy expansion |
| `GET /api/json?path&depth&binary` | the node's value, one level deep (`depth` default 1); nested containers become link markers (`&binary=1` for a binary leaf's base64) |
| `GET /api/schema?path&depth` | the node's instance schema, with the same link markers |
| `GET /api/blob?path` | a file-backed node's **raw bytes**, with its (inferred) format as the `Content-Type` |
| `GET /api/thumb?path&w&h` | a lazily-generated thumbnail of a file-backed blob |
| `GET /api/tagged?path` | the materials filed under a tag (annotations → targets) |
| `GET /api/annotations?path` | the annotations on a node |
| `GET /api/query?q&path` | the query evaluator (colon match templates) |
| `GET /api/dangling` | pointers that did not resolve at index time |
| `GET /api/events` | SSE: `{type:"diff",…}` reindex diffs + `{type:"task",…}` progress |
| `GET /api/tasks` | long-running tasks in flight (a snapshot for a fresh page) |
| `POST /api/reindex` | manual reconcile (the watcher's fallback) |
| `POST /api/edit` | the yamlover **editor** — surgical source edits (see below) |
| `POST /api/paste` | clipboard paste / upload (text or files) |
| `POST /api/mv` | mediated move (surgical inbound-ref rewrite + auto-relink) |
| `POST /api/tag` | create-on-miss a tag in the taxonomy |
| `POST / DELETE /api/annotate` | add / remove an annotation on a target |
| `POST /api/fragment` | upsert a fragment (region of a target) |
| `POST /api/board` | board mutations |
| `POST /api/agent-docs` | install the LLM-agent guide (`AGENTS.md` + `CLAUDE.md`) into the root — a marker-fenced block appended to (or updated in place within) an existing file, never clobbering the human's own rules; idempotent |

#### `POST /api/edit` — the editor

One edit `{ path, op, yamlover?, meta?, concrete?, name? }`, or a batch `{ edits: [ … ] }` applied in
order and grouped by backing file. It **splices source lines** rather than reserializing, so
comments, quoting, and block scalars elsewhere in the document survive an edit untouched.

`path` is a plain yamlover path naming the node being edited; each segment is a key (`:doc:title`)
or an **absolute entry index** (`:doc[3]` — keyed entries consume indices too). A node has four
**facets**: its scalar value, its keyed entries, its ordinal entries, and its `!!<…>` meta tag.

| op | facets | `meta` |
|----|--------|--------|
| `emplace` | replaces only the facets `yamlover` carries; the rest of the node stands | omitted → **preserved** |
| `replace` | drops all four, assigns `yamlover` | omitted → **dropped** |
| `insert` | the new entry takes the position `path` names; an index past the end **appends** | sets the tag |
| `remove` | deletes the node at `path` | — |

That is why editing a chunk's prose is an `emplace`: an annotated chunk is an omni node whose tag
applications are keyed entries laid over its scalar, and only the scalar facet is being replaced.

`yamlover` is valid inline yamlover **source**, not prose — the caller escapes its own text (the web
client through `escapeYamloverScalar`), and the server parses the fragment to validate it before
anything is written. `meta` is a schema pointer (`*::yamlover:$defs:chapter`) written as the tag;
`null` removes it. `concrete` (`yamlover` | `file/yamlover` | `dir/yamlover`) is accepted only where
content is **born**, and rejected on an existing node — converting one is a move, not an edit.

Creating an object is therefore just an `insert` carrying a `meta` and a body: a document's body
gains a child (inline, or a linked file/dir plus a `*` pointer), while a plain directory — which
backs no document, so it has no source to splice — gains a member. The response carries the new
node's `path`.

A **link marker** — `{ "$yamloverLink": { kind, path, count|size } }` — stands in
for a node shown only as a link (a nested container past the one-level view, or
any binary leaf); the client renders it as a `{ object with N properties }`,
`[ array with M items ]`, or `< binary of N bytes >` hyperlink. The same marker
appears in both the value and the schema, so every representation renders
identically. A selected binary leaf's bytes arrive as
`{ "$yamloverBinary": {format,size,base64} }`.

### Renderers

A renderer declares an **`accepts` predicate** over a node's **type facets**
(value-type, `format`, and the keyed/ordinal capability flags) — most are
`byFormat("…")`, which matches on the node's format and tolerates the other
facets (so tagging a markdown node doesn't break its markdown rendering). The
most specific matching renderer wins; a node with no match falls through to the
default data-representation tabs and expands normally in the TOC.

The registry lives in `src/client/renderers/`. A renderer participates several
ways:

- **`render`** — the full RHS page (its tab is the node's default representation).
- **`renderChunk`** — its *inline* form, when embedded in another renderer's page
  (e.g. the `chapter` renderer draws each chunk by delegating to that chunk's
  own renderer).
- **`tocView`** — how the node appears in the TOC: which children are navigable,
  whether it expands and is loaded. A renderer can unwrap or filter (e.g.
  `chapter` surfaces its subchapters and keeps its chunks off the tree).
- **`depth`** — the value depth `NodeView` fetches for it (default 1).

Registered today (a representative slice — the registry is the source of truth):

| renderer | matches (format) | draws with |
|----------|------------------|------------|
| `chapter` | `x-yamlover-chapter` | a positional body: numbered chunks + subchapter links |
| `tag` / `board` | `x-yamlover-tag` / `x-yamlover-board` | tag-hierarchy diagram / board (handled outside the specificity loop) |
| `task` | `x-yamlover-task` | task view |
| `marklower` | `text/marklower` (a chapter's prose chunks, by schema propagation) | its own inline grammar (`MARKLOWER.md`): emphasis, `` `code` ``, `$$math$$` via KaTeX, links, and `*[…](…)` media embeds |
| `markdown` | `text/markdown` | [marked](https://marked.js.org) |
| `asciidoc` | `text/asciidoc` | [@asciidoctor/core](https://asciidoctor.org) |
| `csv` | `text/csv`, `text/tab-separated-values` | a table |
| `plaintext` | `text/plain` | preformatted text |
| `latex` | `text/x-latex` | [KaTeX](https://katex.org) |
| `plantuml` | `text/x-plantuml` | rendered diagram |
| `map` | KML / KMZ | [Leaflet](https://leafletjs.com) |
| `image` | `image/png`, `jpeg`, `gif`, `webp`, `avif`, `svg+xml`, … | native `<img>` |
| `html` | `text/html` | sandboxed `<iframe>` |
| `pdf` | `application/pdf` | [pdf.js](https://mozilla.github.io/pdf.js/) via react-pdf |
| `djvu` | `image/vnd.djvu` | [DjVu.js](https://djvu.js.org) (vendored) |
| `epub` / `fb2` | `application/epub+zip` / FictionBook | paged e-book view |
| `docx` / `doc` / `rtf` | Word / RTF | [mammoth](https://github.com/mwilliamson/mammoth.js) etc. |
| `spreadsheet` | xlsx / xls | [SheetJS](https://sheetjs.com) |
| `psd` / `tiff` / `heic` | Photoshop / TIFF / HEIC | decoded to a canvas/image |

Adding a shape is still a single registry entry.

Two implementation notes:

- **DjVu has no native browser support**, so it is decoded client-side by
  **DjVu.js**, vendored as a prebuilt bundle at `src/client/vendor/djvu.js`.
  The library is **GPL-v2** (see `src/client/vendor/README.md` for provenance);
  the rest of this package is not.
- **pdf.js and DjVu.js (and several heavier codecs) reach for browser globals at
  import time**, which would break the (Node/jsdom) test run, so their renderers
  are **lazy-loaded** — importing the registry never pulls them in until such a
  node is actually shown.

### File rendering and format inference

The file renderers turn the browser into a viewer for the common file types a
tree carries. They hang off one rule, applied to any file-backed node that
carries **no explicit `format`**: the server **infers a format from the file
extension**. So a stray `.pdf`, `.png`, or `.md` renders without a `format:`
line. An explicit `format` always wins.

Inference splits two ways by how the renderer consumes the file:

- **Served as bytes** — images, `application/pdf`, `text/html`, `image/vnd.djvu`,
  etc. Their renderer points an `<img>`/`<iframe>`/loader at **`/api/blob`** (or
  fetches the `ArrayBuffer`), so the bytes stream straight from disk with no
  base64 round-trip.
- **Read as text** — `.md`/`.adoc` keep a **string** value (the file's text),
  which the renderer parses to HTML.

## Requirements

- Node.js **22.13+** (the engine's store uses the built-in `node:sqlite`, unflagged only from 22.13).

There are **no runtime dependencies**: the client deps are bundled into
`dist/client` by `vite build` and the server deps into `dist/server.js` by
esbuild at `prepack`. The `devDependencies` (React, Vite, the engine/parser, and
the renderer libraries) are build- and test-time only. DjVu.js is **vendored**
(`src/client/vendor/djvu.js`), not an npm dependency.

## Tests

This package is covered by [Vitest](https://vitest.dev) (it runs the TypeScript
directly, no build):

```console
$ npm test          # run once
$ npm run test:watch
```

This server suite is **separate** from the repository root's `npm test`, which
runs only the parser and engine suites. CI gates on the server suite, so run
both before pushing. (Run everything from the project root — see the root
`package.json`.)

## Layout

```
bin/yamlover.js        CLI entry — arg parsing + dev (Vite) / prod (dist) wiring
scripts/build.mjs      prod build: vite build → dist/client, esbuild → dist/server.js
src/server/            the engine-backed JSON API
  engine-api.ts          createHandlers: all /api/* routes, backed by the engine Store
  embed.ts               annotation / fragment / thumbnail embedding (overlay writes)
  node-kind.ts           node-kind classification (object|array|scalar|binary|omni|mix)
  tasks.ts               background task registry + SSE task frames
  gitignore.ts           .gitignore predicate for surfaced stray files
  extract/               per-type extractors (thumbnails, fragments)
  agent-docs/            the AGENTS.md / CLAUDE.md guide installed by POST /api/agent-docs
src/client/            the React SPA (tree, node view, render, icons, paths, live SSE)
  renderers/             facet-predicate renderer registry + per-format renderers
  vendor/djvu.js         prebuilt DjVu.js bundle (GPL-v2; see vendor/README.md)
test/                  Vitest suite (server logic + client components)
index.html             SPA shell
```
