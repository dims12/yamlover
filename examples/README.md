# Examples

A guided corpus of yamlover entities — one worked instance per idea, ordered from the
austere base formats up to rich documents, graphs, and boards. Read them alongside the
specs; every example is a real fixture the parser and server test against, so what you see
here is exactly what the tools accept.

The model is **instance-only**: an example stores *data* (plus pointers), in one of the
**concretes** — a `.json`/`.json5`/`.json5p` file, a `.yaml`/`.yamlover` file, or a
**directory** (optionally carrying a `.yamlover/` overlay). Metadata — types and formats —
lives in a separate schema layer ([META.md](../META.md)), never as storage. When an example
needs to name a type or format it does so *inline* (a `!!<…>` tag) or in an overlay's
`meta.yamlover`, alongside the data but never replacing it.

**Specs:** [URIs.md](../URIs.md) · [IR.md](../IR.md) · [JSON5P.md](../JSON5P.md) ·
[YAMLOVER.md](../YAMLOVER.md) · [META.md](../META.md) · [TICKETS.md](../TICKETS.md)

## Tours — the supersession lattice over one dataset

The **same** pets/humans dataset rendered through each surface, smallest to richest. Reading
them in order shows exactly what each format adds over the one below it:

| # | file | what it adds |
|---|------|--------------|
| 01 | [`01-tour.json`](01-tour.json)     | strict **JSON** — the austere base of the lattice; no comments, no sharing |
| 02 | [`02-tour.json5`](02-tour.json5)   | **JSON5** — comments, unquoted keys, trailing commas, hex / `Infinity` / `NaN` (still no pointers, so a shared node is a *copy*) |
| 03 | [`03-tour.json5p`](03-tour.json5p) | **json5p** — JSON5 **+ pointers**: `*` deref (a copy becomes a shared edge), `~` back-edges, `&` anchors, scopes, escaping |
| 05 | [`05-tour.yaml`](05-tour.yaml)     | plain **YAML** — native `&` / `*` anchor sharing (YAML's ceiling) |
| 06 | [`06-tour.yamlover`](06-tour.yamlover) | **yamlover** — YAML **+ pointers**: the extended `*`, `~`, `&`, `[n]` / `/x`, and links |

The containment is strict: `JSON ⊂ JSON5 ⊂ json5p` and `YAML ⊂ yamlover`. (`04` is
intentionally skipped so the JSON and YAML branches keep matching last digits.)

## The omni node

| # | file | shows |
|---|------|-------|
| 07 | [`07-omni.yamlover`](07-omni.yamlover) | the **unified node** — `!!var` / `!!mix`: a single node carrying a scalar *self-value*, **positional** fields, and **keyed** fields all at once, instead of forcing scalar-vs-array-vs-object |

## Instance examples (directory + `.yamlover/` overlays)

The modern, instance-only shapes. In a directory an optional overlay splits the two layers:
`body.yamlover` holds the **data**, `meta.yamlover` holds **type/format** metadata; a plain
directory with no overlay simply *is* its files. Together they cover every concrete an object
or scalar can take.

| # | example | concrete / what it shows |
|---|---------|--------------------------|
| 50 | [`50-object-in-overlay`](50-object-in-overlay)     | a directory whose `body.yamlover` holds the whole object instance |
| 51 | [`51-object-in-dir`](51-object-in-dir)             | the same object as one file per child (`name` / `age` / `isAdmin`), with an empty `.yamlover/` marker |
| 52 | [`52-scalar-as-file`](52-scalar-as-file)           | a bare scalar stored as a single plain file |
| 53 | [`53-plain-dir`](53-plain-dir)                     | a plain directory with **no** `.yamlover/` — the files themselves are the data |
| 54 | [`54-scalar-file-overlay`](54-scalar-file-overlay) | a scalar carried in `body.yamlover` (the scalar twin of 50) |
| 55 | [`55-scalar-as-binary`](55-scalar-as-binary)       | a binary file decoded by `meta.yamlover` (`type: binary`, `format: int32/le`) |
| 56 | [`56-array-of-files`](56-array-of-files)           | a sequence whose elements live in files — order and per-element format come from meta |
| 58 | [`58-genealogy-dag`](58-genealogy-dag)             | the canonical **directed graph**: containment is the paternal line, `*` a maternal cross-edge, `~` its reverse (one `body.yamlover`; acyclic here, but `*` / `~` cycles are allowed) |
| 59 | [`59-all-formats-object`](59-all-formats-object)   | a catalogue of every renderable `(type, format)` — textual content inline in `body`, binary samples typed in `meta` |

## Chapters (the `chapter` schema)

Documents — `title` + `chunks` + recursive `children` — tagged with the `chapter` schema
(`$defs/chapter`). A schema attaches *inline* in a `.yamlover` file via the `!!<…>` tag (no
overlay needed), or through a directory's `.yamlover/meta.yamlover`. See
[YAMLOVER.md](../YAMLOVER.md) and [META.md](../META.md).

| # | example | concrete / shows |
|---|---------|------------------|
| 60 | [`60-simple-chapter.yamlover`](60-simple-chapter.yamlover)   | a single tagged **file** — the minimal chapter (`title` / `chunks` / `children`) |
| 65 | [`65-all-formats-chunks`](65-all-formats-chunks)             | a **directory** chapter — textual chunks (block scalars) interleaved with `*sample.*` pointers to binary files; per-chunk formats and file types in `meta.yamlover` |
| 66 | [`66-doc-tree`](66-doc-tree)                                 | a recursive **directory** chapter — prose + `*png` image chunks + PlantUML chunks tagged per-chunk `!!<*yamlover/$defs/plantuml>` (no meta: png by extension, plantuml by tag) |
| 68 | [`68-math-chapter`](68-math-chapter)                         | a **directory** chapter — marklower prose (inline `$$…$$`) plus standalone LaTeX chunks (`format: text/x-latex` in `meta`) |
| 69 | [`69-marklower-links.yamlover`](69-marklower-links.yamlover) | a tagged **file** — nested chapters demonstrating `/`, `//`, and external marklower links (all default format, no meta) |

## Plain directories (format by extension)

No `.yamlover/` overlay at all — each file's `(type, format)` is inferred from its recognized
extension, so a directory of ordinary documents just works:

| # | example | shows |
|---|---------|-------|
| 70 | [`70-office-docs`](70-office-docs) | office documents (docx / xls / xlsx / rtf) |
| 71 | [`71-kml-map`](71-kml-map)         | KML / KMZ maps drawn over an OpenStreetMap overlay |
| 72 | [`72-images`](72-images)           | JPG / HEIC photographs in the pan/zoom image viewer, with per-image fragment + thumbnail overlays (EXIF/GPS fixtures from the [Greenstone tutorial samples](https://files.greenstone.org/tutorial/gs3-current/en/images_gps.htm), vendored unmodified) |

## Tags, boards & workflows

Tag taxonomies classify materials by `*`-pointer membership; a board reuses the same
machinery to arrange task cards into workflow columns.

| # | example | concrete / shows |
|---|---------|------------------|
| 67 | [`67-pdf-tags`](67-pdf-tags)   | real PDFs (messy filenames) + a `body.yamlover` overlay: a `!!<*yamlover/$defs/tag>` taxonomy whose slugs link papers by `*` pointer, with each paper mirroring `~slug:` back — membership authored both ways, reconciled by the engine |
| 73 | [`73-dev-board`](73-dev-board) | an agile **board** — a directory of `!!<*yamlover:$defs:task>` cards grouped into kanban columns by the project-global `dev` workflow's states; dragging a card between columns re-tags it (see [TICKETS.md](../TICKETS.md)) |

---

No examples remain in the retired schema-as-storage model (`.yamlover/schema.yaml`); every
type or format above is either inferred from an extension, declared in a `meta.yamlover`, or
attached inline with a `!!<…>` tag.
