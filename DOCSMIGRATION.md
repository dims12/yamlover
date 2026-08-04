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
    concretes/         storage laws (storage, choosing, invariants) + the per-language
                       catalogs (yamlover, yaml, json5p, json5_code, json_code)
    pointers/          paths, scopes, deref, anchors, escaping + queries/ nested
  documents/         — Documents (chapters, marklower, tables, lists)
```

Order is each body's pointer-array data. Toplevel chapter names carry no order prefixes
(hand-authored); the `concretes/` interior was REBUILT through the editor (§Progress) and so
carries the `NN-` cosmetic member numbering of CONCRETES.md §Member-encoding — both shapes
are legal, the numbering is never order's source of truth.

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
- **Fenced code blocks**: a runnable yamlover example becomes a **`!!yo` data island** —
  live, parsed data drawn by the generic renderer (decided 2026-08-01; the island must
  PARSE, so vet it first — the reconcile-poisoning gotcha below). A `` !!<format: …> | ``
  string chunk (`text/x-yamlover`, `text/x-json5p`, `text/plain` for ABNF/ASCII layouts…)
  remains the form for text that must stay QUOTED: examples of tags the projection drops
  (`!!mix`), live anchors that would graft real keys (`&: supercat`), root-tag syntax
  (`!!<…>` at file top), and non-yamlover text. Both forms are syntax-highlighted.
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
- [x] `language/concretes/` REBUILT through dogfooding (2026-08-02→04): grouped by
      concretes, the class lattice in prose AND on the spine — general laws first
      (`00-storage`, `01-choosing`, `02-invariants`; the directory story a cross-reference
      pointer into the yamlover catalog), then the per-language catalogs `03-yamlover` …
      `07-json_code`. The hand-authored 2026-08-01 tree retired to
      `language/.yo/.trash/concretes/`. Editor-materialized, so the interior carries the
      `NN-` member numbering; the chapter directory itself git-renamed from the working
      name `01-Concretes_2` back to `concretes/` and all links repointed (2026-08-04)
- [ ] `CHAPTER.md` → `documents/`
- [ ] `MARKLOWER.md` → `documents/`
- [ ] Rule on the candidate files (§above)
- [ ] Marklower improvements met along the way (asides, syntax highlighting, …) — spec'd in
      `MARKLOWER.md` as they land
  - [x] Code chunks render (2026-08-01): the `code` registry entry accepts `text/x-yamlover`,
        `text/x-json5p`, `text/x-yaml`; `PlaintextChunk` reads an inline chunk's own text
        instead of fetching bytes
  - [x] Code chunks HIGHLIGHT (2026-08-01): the shared heuristic lexer
        (`tools/parser/ts/src/highlight.ts` — the module the JetBrains lexer comment
        anticipated) + the client mapping onto the existing `.k .s .n …` classes
        (`client/highlight.tsx`); wired into the code chunks and the read-only source view's
        format-tagged block-scalar bodies. Editor cells deferred (contentEditable + spans).
  - [x] `!!yo` DATA ISLANDS (2026-08-01): the shape tag formerly `!!var`/`!!omni` renamed
        `!!yo` and made SEMANTIC — plain yamlover, exempt from the enclosing schema; a
        `!!yo`-marked body element renders via the generic data view (read-only) and edits as
        an inline source cell (yed); first live use in `language/principles/one-node`
        (CHAPTER.md §Data island)
  - [x] The YAML-keys round, phase D — the docs respell (2026-08-02): the book, the root
        specs, and `examples/` moved to the new spelling — bare-integer positions
        (`: pets: 1`, store `:pets:1`; the retired `[n]` reads forever as an alias),
        quoted numeric string keys (`'1':` — a plain `1:` is a parse error), operator-only
        value tests (`: rating: =5: scale`; the bare-literal test and the `TEST step`
        combo are dead), and the adopted NULL KEY (`: v` ≡ `~: v`; `null:` stays the
        string key). New book subchapter `language/vs-yaml/null-keys/` (registered in
        vs-yaml's body after `set`); marklower link targets respelled (`:2`, `#/1`
        anchors); the `[.±k]` merge idiom and `[?]`/`&…[]` operators unchanged;
        `05-tour.yaml` stays the plain-YAML baseline. Every edited `.yo` vet-parsed
        before commit (the reconcile-poisoning gotcha honored).
  - [x] JSON code chunks highlight (2026-08-03): `text/x-json` and `text/x-json5` join the
        code-chunk registry and the shared lexer, keeping the page rhythm
  - [x] The chapter page navigates itself (2026-08-03→04): in-page links resolve smartly,
        one scroll primitive; a reference is cited, never inlined (the chapter's
        containment law)
  - Authoring gotcha worth knowing: marklower emphasis never spans a code token, so the MD
    habit `` **`code`** `` renders literally — write the code span unbolded
  - Authoring gotcha (2026-08-01): a `$defs/table` FLOW row's plain cell must not contain
    spaces (yamlover flow quotes spacey scalars) — quote it. One unquoted cell fails the
    whole tree's reconcile with a parse error while the served index silently keeps the
    last good state; check the server log's `[reconciling]` lines when a body edit seems
    to have no effect
- [ ] Stub / retire the migrated MD files
