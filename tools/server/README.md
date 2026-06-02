# server

Browse a yamlover tree in the web browser.

```console
$ npx yamlover [ROOT] [--port N] [--host ADDR] [--no-gitignore]
```

`ROOT` is any yamlover entity — a directory with a `.yamlover/schema.yaml`, a
plain directory, or a single file (the same shapes [`walker`](../walker/)
understands). It defaults to the current directory. The command starts a local
web server (on `0.0.0.0` by default, so it is reachable from the network — use
`--host 127.0.0.1` to keep it private) and serves a React single-page app that
lets you browse the entity starting from `ROOT`.

The page is split into two independently scrolling panes:

- **Left — a table of contents.** A collapsible tree of **every** node — object
  keys and array elements alike, scalars included (so a leaf like
  `05-scalar-as-file` is listed and clickable). A node is *expandable* when it is
  a container with children and has no *active* renderer (see *Renderers*); the
  first three levels load expanded, and deeper branches load lazily via the
  chevron. Each entry is labeled by its schema `title` (or an instance `title`
  child) when present, otherwise by its key (objects) or `[index]` (arrays).

  Each row carries a **type/format icon** (chosen by the schema `format`, falling
  back to `type` — `{}`/`[]` for object/array, `"`/`#`/`◧` for
  string/number/boolean, 📅/✉️/🔗/🖼️… for formats). The tree is agnostic to a
  node's *concrete* (how it is stored) — that shows in the node view's tags.
- **Right — the selected node**, in one of four representations (tabs):
  - **yaml-schema** *(default)* — our schema (the yamlover schema concrete) as YAML.
  - **yaml** — the node's value as YAML.
  - **json** — the node's value as JSON.
  - **json-schema** — the standard instance JSON Schema (every leaf `const`).

  All four behave **identically**: syntax-highlighted, **one level deep**, with
  every nested node shown as a **hyperlink** you click to descend (never inlined)
  — `{ object with N properties }`, `[ array with M items ]`, or
  `< binary of N bytes >`. A registered renderer, if any, replaces the value
  views. The selected representation is part of the URL (`?format=`), so it is
  preserved as you navigate and is shareable.

  A binary leaf's bytes are read only when you select it and view its value: the
  yaml view shows a YAML `!!binary` block, json shows the `{format,size,base64}`
  metadata.

Surfaced *stray* files (those the schema does not describe) honor `.gitignore` by
default — `node_modules/`, build output, etc. are hidden. Pass `--no-gitignore`
to show everything. Schema-described children are always shown.

The browser URL is the node's path in **JSON space** — `/examples[0]/markup` —
never schema space, so there are no `properties` segments, plus `?format=` for
the representation. Each key is percent-encoded, so a key that itself contains a
`/` (e.g. `@vitejs/plugin-react`) stays a single segment. It updates as you
navigate and is shareable / back-button friendly — opening a deep link expands
the TOC along the path and selects (and scrolls to) the target node.

## How it works

This is a TypeScript reimplementation of the read side of [`walker`](../walker/)
(concretes, `$ref`/`$defs`, inline `const`, collapsed files, expanded
subdirectories), plus a small server and SPA. There is **no build step**: the
launcher runs [Vite](https://vitejs.dev) in middleware mode, serving the client
from source with HMR and loading the server-side materializer through Vite's
`ssrLoadModule`.

Leaf bytes are **read lazily**: materialization builds the tree's structure but
does not read a leaf's content until that node is actually serialized. So listing
or eliding a node never reads its file — `value: 30` is read only when its node is
shown, and a binary blob only when its base64 is requested. The materialized tree
is cached per server for a short window, so a burst of clicks does not re-read the
filesystem; edits show up after the window on reload.

### API

All endpoints take a JSON-space `path` (default `/`); `json` and `schema` take an
optional `depth` (container-nesting limit).

| endpoint | returns |
|----------|---------|
| `GET /api/info` | `{ root }` — the root label (the served entity's yamlover title, else its directory name): the breadcrumb head and TOC root |
| `GET /api/tree?path&depth` | the table of contents rooted at `path`, `depth` levels deep (default 3) — fetched again per branch for lazy expansion |
| `GET /api/json?path&depth` | the node's value, one level deep (`depth` default 1); nested containers become link markers (add `&binary=1` for a binary leaf's base64) |
| `GET /api/schema?path&depth` | the node's instance JSON Schema, one level deep, with the same link markers |
| `GET /api/blob?path` | a file-backed node's **raw bytes**, with its (inferred) format as the `Content-Type` — what the image / html / pdf / djvu / markup renderers read, instead of base64 over `json` |

A **link marker** — `{ "$yamloverLink": { kind, path, count|size } }` — stands in
for a node shown only as a link (a nested container past the one-level view, or
any binary leaf); the client renders it as a `{ object with N properties }`,
`[ array with M items ]`, or `< binary of N bytes >` hyperlink. The same marker
appears in both the value and the schema, so every representation (YAML/JSON ×
data/schema) renders identically — just a syntax choice over one structure. A
selected binary leaf's bytes arrive as `{ "$yamloverBinary": {format,size,base64} }`.

### Renderers

A renderer is keyed by a **(type, format)** tuple — the JSON-Schema `type` plus
its `format` — the same key the TOC icons and the link markers carry. A node with
no matching renderer falls through to the default tabbed view (YAML/JSON ×
data/schema) and expands normally in the TOC.

The registry lives in `src/client/renderers/`. A renderer participates three ways,
all on the one tuple:

- **`render`** — the full RHS page (its tab is the node's default representation).
- **`renderChunk`** — its *inline* form, when embedded in another renderer's page.
  A renderer composes children by routing each to the renderer for the child's own
  tuple: the `chapter` renderer draws each of its `chunks` by delegating to that
  chunk's renderer (a `string`/`text/markdown` chunk → the `text` renderer; an
  `image/png` chunk would route to an image renderer, no change to `chapter`).
- **`tocView`** — how the node appears in the TOC: which children are navigable,
  whether it expands, and whether they are loaded (default: its own children,
  lazily loaded). A renderer can unwrap or filter — `chapter` surfaces its
  subchapters directly (from its `children` array) and keeps its `chunks` off the
  tree, so the TOC reads as a table of contents.

A renderer may also declare **`depth`** — the value depth `NodeView` fetches for
it (default 1; `chapter` needs 2 to reach its chunk/subchapter elements).

Registered today:

| renderer | (type, format) | draws with |
|----------|----------------|------------|
| `chapter` | `object` / `x-yamlover-chapter` | numbered chunks + subchapter links |
| `tag` | `object` / `x-yamlover-tag` | a hierarchy diagram: supertag (containment parent) and subtags (children) wired to the current tag |
| `text` | `string` / `text/markdown` | [marked](https://marked.js.org) |
| `asciidoc` | `string` / `text/asciidoc` | [@asciidoctor/core](https://asciidoctor.org) |
| `image` | `binary` / `image/*` | native `<img>` |
| `html` | `binary` / `text/html` | sandboxed `<iframe>` |
| `pdf` | `binary` / `application/pdf` | [pdf.js](https://mozilla.github.io/pdf.js/) via [react-pdf](https://github.com/wojtekmaj/react-pdf) |
| `djvu` | `binary` / `image/vnd.djvu` | [DjVu.js](https://djvu.js.org) (vendored) |

Adding a shape is still a single registry entry.

### File rendering and format inference

The bottom seven renderers above turn the browser into a viewer for the common
file types a tree carries. They hang off one rule, applied to any file-backed
node that carries **no explicit schema `format`**: the server **infers a format
from the file extension** (`formatFromExt` in `src/server/yamlover.ts`). So a
stray `.pdf`, `.png`, or `.md` — or one declared with only `concrete: file`/
`file/binary` — renders without a `format:` line. An explicit schema `format`
always wins.

Inference splits two ways by how the renderer consumes the file:

- **Served as bytes** — images, `application/pdf`, `text/html`, `image/vnd.djvu`
  become `file/binary`. Their renderer points an `<img>`/`<iframe>`/pdf-loader at
  **`/api/blob`** (or, for DjVu, fetches the `ArrayBuffer`), so the bytes stream
  straight from disk with no base64 round-trip.
- **Read as text** — `.md`/`.adoc` keep a **string** value (the file's text),
  which the `text`/`asciidoc` renderer parses to HTML. (This preserves the
  existing "a `.md` file is a string" behavior.)

Two implementation notes:

- **DjVu has no native browser support**, so it is decoded client-side by
  **DjVu.js**, vendored as a prebuilt bundle at `src/client/vendor/djvu.js`.
  The library is **GPL-v2** (see `src/client/vendor/README.md` for provenance and
  how to regenerate); the rest of this package is not.
- **pdf.js and DjVu.js reach for browser globals at import time**, which would
  break the (Node/jsdom) test run. So the `pdf` and `djvu` renderers are
  **lazy-loaded** (`React.lazy`) — importing the registry, as the TOC and the
  tests do, never pulls them in until a PDF/DjVu node is actually shown.

`examples/16-pdf-tags` exercises this: a library of real papers stored as PDFs
and one saved HTML page, each rendered in place.

## Requirements

- Node.js 18+

Dependencies (React, Vite, js-yaml, ignore, plus the renderer libraries
`react-pdf`, `marked`, `@asciidoctor/core`) install with `npm install` in this
directory; `npx yamlover` then runs `bin/yamlover.js`. DjVu.js is **vendored**
(`src/client/vendor/djvu.js`), not an npm dependency.

## Tests

Both sides are covered by [Vitest](https://vitest.dev) (it runs the TypeScript
directly, no build):

```console
$ npm test          # run once
$ npm run test:watch
```

- **Server** (`test/*.test.ts`, Node) — against the `examples/` fixtures: path
  encoding round-trips (incl. keys with `/`), materialization and `$ref`/`$defs`
  equivalence, one-level link markers (object/array/binary) in value and schema,
  lazy binaries and the `!!binary` payload, the non-YAML → raw-text fallback,
  `buildTree` (all nodes, depth, titles), `.gitignore` filtering, and the API
  endpoints (`/api/info`, `/api/tree`, `/api/json`, `/api/schema`).
- **Client** (`test/client/*`, jsdom + React Testing Library) — path/URL helpers
  and breadcrumbs, type/format icons, the renderer registry, the unified
  `Render` (scalars, `{ object with N properties }` / `[ array with M items ]` /
  `< binary of N bytes >` links, `!!binary`, YAML vs JSON), the `Tree`
  (selection, lazy expand, leaves), `NodeView` (markers, tab switches, binary,
  schema), and `App` (breadcrumb head + TOC).

## Layout

```
bin/yamlover.js     CLI entry — arg parsing + Vite middleware-mode server
src/server/         TypeScript port of the walker read side + JSON API
  yamlover.ts         materialize a logical tree (lazy leaves); toPlain/toSchema/buildTree; formatFromExt
  gitignore.ts        .gitignore predicate for surfaced stray files
  api.ts              /api/info, /api/tree, /api/json, /api/schema, /api/blob
src/client/         the React SPA (tree, node view, render, icons, paths)
  renderers/          (type, format) registry + chapter/text/asciidoc/media/pdf/djvu
  vendor/djvu.js      prebuilt DjVu.js bundle (GPL-v2; see vendor/README.md)
test/               Vitest suite for the server logic
index.html          SPA shell
```
