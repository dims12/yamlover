## Isomorphisms briefly

### YAML vs JSON

YAML is a superset of JSON, denoting principally the same data structure.

### directory vs YAML or JSON

A directory is a dictionary of BLOBs.

### document vs graph

A `*` pointer turns a copied subtree into a **shared edge** — the same node
reached from several places. Trees are the degenerate, pointer-free case.

## Concrete representations — a supersession lattice

A node of the graph, and the structure around it, can be rendered in any of the
following concretes. They are **not** isomorphic — the JSON family forms a
supersession lattice (serializing a graph *down* it is lossy); yamlover is a
*separate* YAML-like language rather than a superset of YAML:

```
json ⊂ json5 ⊂ json5p          yaml ~ yamlover   (close kin, not ⊂)
```

1. **json** — strict JSON; tree-only (a shared node becomes a copy).
2. **json5** — JSON plus comments, unquoted keys, trailing commas, …; still tree-only.
3. **json5p** — JSON5 **plus pointers**: `*` deref, `&` anchors, `~` back-edges,
   scopes. A full-graph concrete.
4. **yaml** — plain YAML; native `&`/`*` anchors are its sharing ceiling.
5. **yamlover** — a distinct, YAML-like language (not a superset of YAML) carrying
   the pointer layer: extended `*` paths, `&`, `~`, bare-integer position /
   string-key addressing, links. A full-graph concrete; it can switch to json5p,
   never to pure YAML.
6. **dir** — a regular filesystem directory: filenames are keys, files are blobs
   or nested documents.
7. **dir + `.yo/` overlays** — a directory whose hidden `.yo/` subdirectory
   overlays it with instance data and/or metadata; a full-graph concrete, and the
   one that makes a directory "speak YAML".

`examples/` walks the lattice over one dataset: `01-tour.json` →
`02-tour.json5` → `03-tour.json5p` and `05-tour.yaml` → `06-tour.yo`.

## The `.yo/` overlays

A directory's hidden `.yo/` holds up to two complementary overlays, plus engine
state:

- **`body.yo`** — the **instance** overlay: data values laid over the
  directory (scalars, mappings, pointers, ordering). A pointer-array body
  (`- *file1 …`) assigns element order to the **subset it names** — disk has
  none; a child the body never names is a **keyed-only member** (present under
  its filename, granted no position). The projection shows a named member's
  filename as a dimmed derived `&` anchor: `- &file1 value`.
- **`meta.yo`** — the **metadata schema**: a JSON-Schema-equivalent written in
  yamlover (`properties`, `type`, `format`, `prefixItems`, …) whose primary job
  is typing / decoding / presentation, with validation optional.
- in the **project root** only, **`settings.yo`** — project configuration
  (defaults such as where new annotations are created).

Either overlay is optional: a plain directory has neither and its files simply
*are* the data; `examples/50-object-in-overlay` has only a body;
`examples/55-scalar-as-binary` has only a meta (the data is the on-disk file,
the meta says how to read its bytes).

## The core idea

There is one data model — an ordered graph whose nodes are mappings, scalars,
and blobs, connected by **containment** and **reference** edges — with the
concretes above as equivalent-up-to-the-lattice renderings. The two big families
are the **filesystem** view and the **document** view:

- **A node (mapping)** → a directory / a yamlover or json5p file.
- **A child with a structured value** → a subdirectory or file / a nested key.
- **A child with a scalar value** → a small file, or an entry in `body.yo` / a
  scalar key.
- **A shared or cross-referencing child** → a `*` pointer (and optionally its
  `~` reverse), in any full-graph concrete.

A directory can be *collapsed* into a single file, and a file *expanded* into a
directory, without changing what the data means. `examples/51-object-in-dir`,
`50-object-in-overlay`, and the tour files draw this triangle over one datum.

## Equivalence rules

1. **A directory is a mapping.** Its children are the keys; files supply string
   keys (filenames), the `body.yo` pointer-array supplies integer-key positions
   when order matters — to the members it names; the rest stay keyed-only, after
   the ordered block.
2. **A file is equivalent to a subdirectory** — both represent the same node. A
   structured child may be stored either as `child.yo` (collapsed) or as
   `child/` (expanded). Tools may convert freely between the two.
3. **The `.yo/` directory is the overlay marker.** Its presence promotes a plain
   *dir* into a node with instance/metadata overlays.
4. **One ordered container.** There is no separate list/dict: a mapping is
   ordered and its positions are integer keys, addressed by the bare integer
   segment (`: 1`); `: x` addresses a string key, `: '1'` the numeric string.
   Order is data — text order in a file, the pointer-array for a directory (a
   positional prefix over the named subset; unnamed children have no position to
   lose).
5. **Pointers are edges, not copies.** `*` dereferences a path
   (`*..: ..: pets: 1`, `*: people: alice`), `&` declares an anchor, `~key:`
   authors a back-edge. One reference mechanism across every concrete.

## Partial flattening

Collapse/expand (above) trades *storage* shapes without changing the data.
**Partial flattening** is the *presentation* analogue: a view may render a deeper
subtree shallowly, pulling some descendants up to become constituent parts of
*this* level instead of separate places you navigate away to. The data and its
paths are unchanged — only how a renderer lays them out.

The first instance is the **chapter** renderer: a fully omni node whose scalar
self-value is the **title**, with an optional keyed `description` and a
**positional body** of chunks and subchapters. A chapter's chunks are flattened
into one readable page (each chunk rendered by the renderer for its own type —
prose chunks by marklower, which inlines images, video, and audio where the
author wrote an `*[…](…)` embed), rather than being browsed one node at a time.
Its subchapters — body elements that are themselves chapters — are *not*
flattened; they stay links you navigate to.

Flattening must not cost a node its address. The rule:

> A flattened child still exposes its location, as a **fragment anchor** whose
> syntax is the **path continuation** that reaches it — and the full path keeps
> working as ordinary navigation.

So a chapter at `:book` whose first body chunk lives at the still-navigable path
`:book:1` exposes that chunk, on the flattened page, as the anchor `#/1`: opening
`:book#/1` scrolls straight to it. The fragment is the **slash continuation** of
the path suffix, so the two notations agree — `:book:1` navigates *to* the
chunk's own node; `:book#/1` locates the *same* chunk where it was flattened in.
Deeper flattening simply yields longer continuations (e.g. `#/3/2` for a chunk
inside a subchapter).

A rendered prose document has the same need at a finer grain. A `.md`/`.adoc`
file is one HTML blob, so its **headings** would otherwise have no address. The
markdown and asciidoc renderers therefore give every heading an `id` and a small
`§` link to it, so a section is reachable as `<page>#<slug>` — the prose-document
counterpart of the chapter's chunk anchors. Asciidoctor's own section ids are
kept, so the anchors line up with the document's internal cross-references.

## Metadata, formats, rendering

`meta.yo` (or an inline `!!<…>` tag in a yamlover file) gives a node its
`(type, format)`; the web viewer's renderer registry keys on that tuple. Format
resolution order: the meta `format:` if present; else a recognized file extension
(`.png`→`image/png`, `.md`→`text/markdown`, `.yo`→`yamlover`, …); else sniff. A
chapter's prose chunks carry `text/marklower` by schema propagation; a string
with no format at all is data, and shows in the data view. `type: binary` plus a
codec format (`int32/le`) decodes raw bytes (`examples/55-scalar-as-binary`);
`prefixItems` orders and types an array whose elements live in arbitrary files
(`examples/56-array-of-files`); a `format` like `text/x-latex` or a per-chunk
`!!<…>` tag picks a renderer (`examples/65`/`66`/`68`).

References inside a schema use the same `*` pointers as instances (reusable
fragments under `$defs`, e.g. `*yamlover/$defs/chapter`) — **not** JSON Schema's
`$ref`/JSON-Pointer dialect, so there is one reference mechanism everywhere.
