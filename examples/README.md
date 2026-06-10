# Examples

Samples of yamlover entities. The model is **instance-only**: an example stores *data*
(plus pointers), in one of the **concretes** — a `.json`/`.json5`/`.json5p` file, a
`.yaml`/`.yamlover` file, or a **directory** (optionally with a `.yamlover/` overlay).
Metadata (types, formats) lives in a separate schema layer (see `../META.md`), never as
storage. Specs: `../URIs.md`, `../IR.md`, `../JSON5P.md`, `../YAMLOVER.md`, `../META.md`.

## Tours — the supersession lattice over one dataset

The same pets/humans data through each surface, smallest to richest:

| # | file | shows |
|---|------|-------|
| 01 | `01-tour.json`    | strict **JSON** — the austere base; no sharing |
| 02 | `02-tour.json5`   | **JSON5** — comments, unquoted keys, trailing commas, hex/`Infinity`/`NaN` (still no pointers, so a shared node is a *copy*) |
| 03 | `03-tour.json5p`  | **json5p** — JSON5 **+ pointers**: `*` deref (copy → shared edge), `~` back-edges, `&` anchors, scopes, escaping |
| 05 | `05-tour.yaml`    | plain **YAML** — native `&`/`*` anchor sharing (its ceiling) |
| 06 | `06-tour.yamlover`| **yamlover** — YAML **+ pointers**: extended `*`, `~`, `&`, `[n]`/`/x`, links |

`JSON ⊂ JSON5 ⊂ json5p` and `YAML ⊂ yamlover`. (`04` is intentionally unused.)

## Instance examples (directory + `.yamlover/` overlays)

Modern, instance-only. `body.yamlover` holds data; `meta.yamlover` holds type/format
metadata; a plain directory's files *are* the data.

| # | example | concrete / what it shows |
|---|---------|--------------------------|
| 50 | `50-object-in-overlay`   | a directory whose `body.yamlover` holds an object instance |
| 51 | `51-object-in-dir`       | object as one file per child (`name`/`age`/`isAdmin`); empty `.yamlover/` marker |
| 52 | `52-scalar-as-file`      | a bare scalar stored as a plain file |
| 53 | `53-plain-dir`           | a plain directory (no `.yamlover/`) — files are the data |
| 54 | `54-scalar-file-overlay` | a scalar carried in `body.yamlover` (scalar twin of 50) |
| 55 | `55-scalar-as-binary`    | a binary file typed by `meta.yamlover` (`type: binary`, `format: int32/le`) |
| 56 | `56-array-of-files`      | a sequence whose elements live in files; order + per-element format |
| 57 | `57-image-with-markup`   | a PNG (file, typed via `meta`) + structured `markup` data in `body` |
| 58 | `58-genealogy-dag`       | the canonical **DAG**: containment = paternal line, `*` = maternal cross-edge, `~` reverses (single `body.yamlover`) |
| 59 | `59-all-formats-object`  | catalogue of every renderable `(type, format)` — textual content in `body`, binary samples typed in `meta` |

## Chapters (the `chapter` schema)

Documents — `title` + `chunks` + recursive `children` — tagged with the `chapter` schema
(`$defs/chapter`). A schema attaches *inline* in a `.yamlover` file via the `!!<…>` tag (no
overlay needed), or via a directory's `.yamlover/meta.yamlover`. See `../YAMLOVER.md`, `../META.md`.

| # | example | concrete / shows |
|---|---------|------------------|
| 60 | `60-simple-chapter.yamlover` | a single tagged **file** — the minimal chapter (`title`/`chunks`/`children`) |
| 65 | `65-all-formats-chunks`      | a **directory** chapter — chunks are textual (block scalars) + `*sample.*` pointers to binary files; per-chunk formats + file types in `meta.yamlover` |
| 68 | `68-math-chapter`            | a **directory** chapter — marklower prose (inline `$$…$$`) + standalone LaTeX chunks (`format: text/x-latex` in `meta`) |
| 69 | `69-marklower-links.yamlover`| a tagged **file** — nested chapters demonstrating `/`, `//`, and external marklower links (all default format, no meta) |
| 66 | `66-doc-tree`                | a recursive **directory** chapter — prose + `*png` image chunks + PlantUML chunks tagged per-chunk `!!<*yamlover/$defs/plantuml>` (no meta needed: png by extension, plantuml by tag) |

## Plain directories (format by extension)

No `.yamlover/` — each file's `(type, format)` comes from its recognized extension:

`70-office-docs` (docx/xls/xlsx/rtf) · `71-kml-map` (kml/kmz) · `72-images` (JPG/HEIC photos)

## Tags

| # | example | concrete / shows |
|---|---------|------------------|
| 67 | `67-pdf-tags` | real PDFs (messy names) + a `body.yamlover` overlay: a `!!<*yamlover/$defs/tag>` taxonomy whose slugs link papers by `*` pointer, with the paper mirroring `~slug:` back — membership authored both ways, reconciled by the engine |

No examples remain in the old schema-as-storage model (`.yamlover/schema.yaml`).
