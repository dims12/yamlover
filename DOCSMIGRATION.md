# DOCSMIGRATION — the MD specs become the `docs/` yamlover book

The root-level `*.md` specs migrate into a **yamlover document tree under `docs/`** — a
directory chapter (`CHAPTER.md` model, the `examples/66-pet-keeper-handbook` shape): `docs/` is
the book, each toplevel chapter its own subdirectory with a `.yo/body.yo`, prose in marklower
chunks, structure in the positional body. The book is read, edited, and dogfooded through the
yamlover server itself — the documentation becomes the largest real instance of the thing it
describes. Marklower features are expected to **improve along the way** (§Conventions lists the
constructs the MD sources use that marklower does not carry yet).

## Target structure

Decided 2026-08-01: **`docs/language/` is the self-contained spec** — it absorbs the pointer,
type, concrete, and query material (the planned `pointers/`, `types/`, `concretes/`, `query/`
toplevel chapters were dropped). Storage follows the **default model, recursively**: every
chapter's own content lives in its directory's `.yo/body.yo`, and ALL subchapters are
subdirectories, the same way at every depth.

```
docs/
  .yo/body.yo        — the book root: title, intro prose, the ordered chapter pointers
  .yo/settings.yo    — project settings (already present; docs/ is a served root)
  language/          — The yamlover language: the full spec, five parts:
    principles/        one subdirectory per principle (order-is-data, one-node, …)
    vs-yaml/           the kept surface + every deliberate break, one each
    model/             terminology, facets, values, order, graph, metadata, matching
    concretes/         storage axis + the full representation catalog, one form each
    pointers/          paths, scopes, deref, anchors, escaping + queries/ nested
  documents/         — Documents (chapters, marklower, tables, lists)
```

Order is each body's pointer-array data; directory names carry no order prefixes (the
chapters are hand-authored, not editor-materialized, so the `01-…` cosmetic numbering of
CONCRETES.md §Member-encoding does not apply).

## Source → chapter mapping

| source | target chapter | notes |
| --- | --- | --- |
| `YAMLOVER.md` | `language/` root + `principles/` + `vs-yaml/` | kept YAML, additions, deliberate breaks |
| `ANCHOR_REFACTOR.md` | `language/pointers/` | historical design round — fold the *decisions* in, drop the sketch |
| `SEPARATOR.md` | `language/pointers/` | the colon grammar; its M/O rulings become normative rules |
| `URIs.md` | `language/pointers/` + `language/model/graph/` | scopes, `&` anchors, escaping, relative indexes; the graph model |
| `TYPES.md` | `language/model/` | the facet lattice |
| `META.md` | `language/model/metadata/` + `language/concretes/` | the metadata schema; the `.yo/` contract |
| `CONCRETES.md` | `language/concretes/` | storage taxonomy, representation, inheritance rules, layout invariants |
| `QUERY.md` | `language/pointers/queries/` | the query language |
| `CHAPTER.md` | `documents/` | the chapter/chunk document model |
| `MARKLOWER.md` | `documents/` | the inline markup, tables, lists |

### Candidates (not yet in scope — decide per file)

`JSON5P.md` (→ `language/`), `IR.md`, `ENGINE.md`, `IMPORTS.md`, `ANNOTATIONS.md`,
`EDITOR.md`, `UI.md`, `TICKETS.md`, `QUERY-FUTURE.md`, `PRIOR-ART.md`, `VERSION-CONTROL.md`.
Planning/process docs stay MD and stay put: `PLAN.md`, `TODO.md`, `FUTURE.md`, `README.md`,
`YOMIGRATION.md`, this file.

## Conventions for migrating a file

- **`##` headings → subchapters** (body elements — inline at first, a subdirectory when a
  section grows media of its own). The MD file's `#` title becomes the chapter's self-value.
- **Prose paragraphs → marklower chunks.** Inline constructs map 1:1 (bold, italic, `code`,
  links); a single MD paragraph is one chunk; hard-wrapped lines rejoin (soft breaks).
- **Fenced code blocks → format-tagged chunks**: `` !!<format: …> | `` blocks
  (`text/x-yamlover`, `text/x-json5p`, `text/plain` for ABNF/ASCII layouts…) — the
  PlantUML precedent in `examples/66`. *Marklower improvement likely wanted: a code-block
  renderer with syntax highlighting for the yamlover family.*
- **MD tables → `$defs/table` nodes** (explicitly tagged body elements).
- **MD bullet/numbered lists → `$defs/bullets` / `$defs/numbered`** when they are content;
  restructure into body elements when they were structure in disguise.
- **Cross-doc links** (`URIs.md §&`) → marklower links into the book's own instance space
  (`:pointers`, `::documents:…`) instead of `.md` file references.
- **Blockquotes (`>`)** — no marklower construct yet; likeliest an *aside/note* chunk format.
  Track as a marklower improvement; until then, plain prose.
- **Status/history sections** ("Resolved 2026-06-12", dual-window notes): compress to the
  standing rule; the git history of the MD file keeps the archaeology.
- A migrated MD file is **replaced by a one-line stub** pointing into `docs/` (kept one cycle
  so stale references land somewhere), then deleted.

## Progress

- [x] `docs/` book root: intro prose + ordered chapter pointers (`docs/.yo/body.yo`)
- [x] `YAMLOVER.md` → `language/` (2026-08-01 — modernized to the colon grammar: the MD's stale
      slash-path examples and closed-window statuses were rewritten, not carried)
- [x] `language/` restructured as the self-contained spec (2026-08-01): the four absorbed
      toplevel chapters dropped, the five-part tree scaffolded, the name note
      (README.md — "YAML Overlay, not Yam lover") restored to the chapter root
- [x] `language/principles/` + `language/vs-yaml/` (2026-08-01 — nine principles, the kept
      table + five breaks + conformance)
- [x] `language/model/` ← `TYPES.md` + `META.md` vocabulary + `URIs.md` graph model
      (2026-08-01 — the variant-⊤/matcher-region tension stated explicitly; the stale
      "YAML ⊂ yamlover" and "`&` is an ordinary YAML anchor" wordings not carried)
- [x] `language/concretes/` ← `CONCRETES.md` + `META.md` `.yo/` contract (2026-08-01 —
      schema-pinned values not carried: META.md dropped schema-as-storage)
- [x] `language/pointers/` (incl. `queries/`) ← `URIs.md` + `SEPARATOR.md` rulings +
      `QUERY.md` + `ANCHOR_REFACTOR.md` decisions (2026-08-01 — the M/O rulings folded in
      as normative rules; the retired `~` query axis described only as deprecation)
- [ ] `CHAPTER.md` → `documents/`
- [ ] `MARKLOWER.md` → `documents/`
- [ ] Rule on the candidate files (§above)
- [ ] Marklower improvements met along the way (asides, syntax highlighting, …) — spec'd in
      `MARKLOWER.md` as they land
  - [x] Code chunks render (2026-08-01): the `code` registry entry accepts `text/x-yamlover`,
        `text/x-json5p`, `text/x-yaml` — verbatim `<pre>` for now, highlighting later;
        `PlaintextChunk` reads an inline chunk's own text instead of fetching bytes
  - Authoring gotcha worth knowing: marklower emphasis never spans a code token, so the MD
    habit `` **`code`** `` renders literally — write the code span unbolded
  - Authoring gotcha (2026-08-01): a `$defs/table` FLOW row's plain cell must not contain
    spaces (yamlover flow quotes spacey scalars) — quote it. One unquoted cell fails the
    whole tree's reconcile with a parse error while the served index silently keeps the
    last good state; check the server log's `[reconciling]` lines when a body edit seems
    to have no effect
- [ ] Stub / retire the migrated MD files
