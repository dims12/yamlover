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
| `CHAPTER.md` | `documents/chapter/` | the chapter/chunk document model |
| `MARKLOWER.md` | `documents/marklower/` | the inline markup, tables, lists |
| `UI.md` | `server/ui/` | operating the UI - layout, views, interaction, upload |
| `EDITOR.md` | `server/editor/` | the projectional editor - the maintainer's map |
| `ANNOTATIONS.md` | `server/annotations/` | fragments & tag applications |
| `YAMLOVER_EDITOR.yo` | `server/yamlover-editor/` + `server/chapter-editor/` | the two machines split; one subchapter per state, transitions as linked tables |
| `QUERY_EDITOR.yo` | `server/query-editor/` | the breadcrumb/pick machine, same shape |

### Candidates (not yet in scope — decide per file)

`JSON5P.md` (→ `language/`), `IR.md`, `ENGINE.md`, `IMPORTS.md`, `TICKETS.md`,
`QUERY-FUTURE.md`, `PRIOR-ART.md`, `VERSION-CONTROL.md`. (Ruled 2026-08-04: `UI.md`,
`EDITOR.md`, `ANNOTATIONS.md` and the two machine `.yo` diagrams migrated into `docs/server/`.)
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
- [x] `CHAPTER.md` → `documents/chapter/` (2026-08-04 — positional-body omni model, schema,
      attaching/materialization, addressing, `task` extension; slash-path tags modernized to
      colon; status history compressed into `task/`)
- [x] `MARKLOWER.md` → `documents/marklower/` (2026-08-04 — inline grammar, link targets,
      embeds, structure division, tables with merges/widths, lists, WYSIWYG atoms, known
      paste divergence; MD tables → `$defs/table`, content lists → `$defs/bullets`)
- [x] `docs/server/` - the "Demo server" chapter (2026-08-04): `UI.md` → `server/ui/`,
      `EDITOR.md` → `server/editor/`, `ANNOTATIONS.md` → `server/annotations/`, and the two
      state-machine diagrams converted from pure yamlover into marklower chapters -
      `server/yamlover-editor/` + `server/chapter-editor/` (split from `YAMLOVER_EDITOR.yo`
      at its CHAPTER-projection divider) and `server/query-editor/` (`QUERY_EDITOR.yo`).
      Every state is a subchapter (39 of them); its transitions are a `$defs/table`
      (Event | Condition/note | Next state) whose next-state cells LINK to the sibling
      state chapters — the machine graph became a browsable hypertext. The shared machine
      conventions (THE LEVEL RULE, host modes, …) are the machine chapters' intro chunks.
      Machine-root descriptions and state pages generated mechanically from the source
      diagrams; sources stubbed (the sync-mirror code comments still name the old files,
      whose stubs redirect). All 68 new bodies vet-parsed
- [ ] Rule on the remaining candidate files (§above)
- [ ] Marklower improvements met along the way (asides, syntax highlighting, …) — spec'd in
      `docs/documents/marklower/` (and this checklist) as they land
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
        (::documents:chapter:model — data island)
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
  - [x] Intra-word `_` no longer italicizes (2026-08-04, found QA-ing the machine chapters):
        `styleText` treated any `_..._` pair as emphasis, so `unquoted_scalar_appending`
        italicized its middle — including inside link labels, mangling every next-state link.
        Markdown's rule adopted: a `_` inside a word is a literal character; only a
        word-boundary `_` (and `__`) opens/closes emphasis. `*` keeps intra-word emphasis.
        Spec'd in `documents/marklower/grammar/`, regression-tested (marklower.test.tsx).
        Same QA pass: state-page descriptions de-backticked (descriptions render plain),
        Event columns widened, stale `QUERY_EDITOR.yo`/`CONCRETES.md` mentions in three
        state descriptions repointed at book links, a live WYSIWYG edit round-tripped on a
        state page (valid write, atomicity held), and a focus-after-flush observation filed
        as MINITODO 028. The dangling `gap_after_token` target closed 2026-08-05: `closeToken`
        lands the caret `at: "after"` — the gap past the closer — which the machine already
        names `scalar_committed` (flow_seq_editing's `close_bracket` row says so), so
        `atom_focused`'s closer row links there instead of naming a state that never existed.
  - [x] The chunk-mangle bug fixed (2026-08-04): touching a long folded prose chunk in the
        yed editor corrupted the file — three fixes. (1) `itemHasFields` misread a PLAIN
        `- >` block (content at the child column) as an omni when a prose line looked like
        `key: ...`, so the emplace replaced one line and orphaned the rest; the block form
        now pins its content indent to the first content line. (2) `/api/edit` now parses
        every spliced file before writing — a surgical bug 400s with the document
        untouched, never persists a corrupt body. (3) `inlineMd` trimmed emphasis inners
        (`<strong> is ... an </strong>` → `**is ... an**`), eating the boundary spaces on
        every round-trip; the whitespace is hoisted outside the markers now. Bonus: a keyed
        insert quotes an all-digit key (`"12": tue` — a bare `12:` is a position).
  - [x] Machine chapters resynced to the PORTION grammar (2026-08-04): the pointer entry
        refactor decomposed a reference into portion cells in the PURE editor
        (grammar/portions.ts + the dispatch table's `portion` cell; completion hints are an
        optional HintProvider seam - complete.ts, `docHints` over the in-memory document in
        the debug editor, `treeHints` over GET /api/query in the server host; the old
        PickKit/holePick mounting retired, TOC-click insertion parked as MINITODO 029).
        `pointer_entry` / `pointer_pick_editing` rewritten with the new transition tables
        (scope climb/descend, portion split/merge/fold, the walk across cells),
        `editor/pick-kit` + `file-index` restructured around the pure/portions + hint-seam
        + server-host layering. Two code comments repointed from the YAMLOVER_EDITOR.yo
        stub to the machine chapter. Fix ridden along: a REFUSED commit no longer strips
        the portion cursor - the cells stay mounted and the typed text stands
        (yed 672, server 1366, both typecheck clean).
  - [x] TOC re-plug documented (2026-08-05): MINITODO 029's parked half landed - the TOC
        filter session + TOC-click insertion re-plugged onto the portion cells host-side
        (renderers/yed-toc-pick.ts useTocRefPick; the pure editor stays TOC-blind). The
        `editor/pick-kit` chapter gained the re-plug bullet (session lifetime = the ref
        edit's, filter fed at the holder, TOC click inserts via pointer-spell, Enter stays
        the one commit), and `pointer_entry` / `pointer_pick_editing` gained the `toc_click`
        transition rows + the session prose. MINITODO 029 closed with the same note
        (yed 672 green, affected server suites 133 green, server typecheck clean).
  - [x] Self-loop transitions de-linked (2026-08-04, user-reported): a state page's
        transition table linked self-loops (`key_cell_editing` -> itself), and clicking a
        link to the page you are already on changes nothing - reads as "links don't work".
        Links were never broken (cross-state links navigate fine); the 26 pages with
        self-loops now render them as plain code with a `(stays)` marker, so only real
        transitions look navigable. All 39 state pages vet-parsed.
- [x] Stub the migrated MD files (2026-08-04 — all ten sources are one-screen stubs
      pointing into `docs/`; kept one cycle so stale references land somewhere)
- [x] The code comments repointed (2026-08-05) — the gate on deleting the stubs. 292 citations
      across 91 source files under `tools/` named a migrated file, most with a `§section` that
      would resolve to nothing once the stub went. All now name their BOOK CHAPTER by path
      (`docs/language/pointers/escaping`, `docs/documents/chapter/schema`, … - the spelling the
      one hand-repointed comment already used); the section anchor is DROPPED, the chapter name
      carries it. The section-level mapping was read off the pre-stub headings in git, not
      guessed - `TYPES.md §9` (Matching) to `model/matching` but `§1` (the facets) to
      `model/facets`; `CONCRETES.md §Member encoding` to `concretes/01-choosing`,
      §Collection style to `concretes/00-storage/00-inlined` (the K&R concrete switch),
      the representation vocabulary to `concretes/04-yaml`; `URIs.md §~-` to `vs-yaml/tilde`
      rather than `pointers/anchors`, since the book kept the deprecated tilde its own chapter;
      the `YAMLOVER_EDITOR.yo §"The CHAPTER projection"` mirrors to `server/chapter-editor`,
      the machine the split produced. Hand-finished afterwards: citations that WRAPPED across
      two comment lines (the anchor survived on the next line), a doubled
      `pointers/anchors, pointers/anchors` where two sources had collapsed into one chapter,
      three `../../../`-relative spellings made repo-root relative like every other, and one
      genuinely stale line - `ir.ts` still said `/` = document root, from before the colon
      round. 793 parser/engine + 672 yed + the server suite green, typecheck clean.
- [ ] Delete the stubs after the cycle - unblocked now that nothing in the code points at them.
- [x] The bundled agent guide caught up (2026-08-05): `tools/server/src/server/agent-docs/`
      AGENTS.md — the file `POST /api/agent-docs` installs into a USER's project, so its
      spelling is what other agents author — still taught the pre-YAML-keys forms. Respelled to
      the bare-integer position (`*pets: 1`, `*: humans: 0: name`) with the bare-token rule
      stated (digits → position, `~` → the null key, quoted `'1'` → the numeric string key, a
      plain `1:` a parse error) and the retired `[n]` demoted to a read-forever alias; the
      surviving non-literal brackets (`[.±k]`, `[]`, `[?]`) named as the exception. Two more
      corrections: `!!var` was listed as a no-op readability marker beside `!!mix` — it is a
      deprecated alias of `!!yo`, which is SEMANTIC (the data island, exempt from the enclosing
      schema), so an agent dropping it changes meaning; and the "deeper specs" pointer named the
      now-stubbed root MD files instead of the book.
- [x] The taught examples now PARSE (2026-08-05): the same `!!var` slip stood in
      `server/annotations/storage/` — an annotated markdown chunk shown as `- !!var |`, which
      under the rename marks the chunk a DATA ISLAND (the chapter renderer would hand the prose
      to the generic data view). The omni shape needs no tag at all, so the tag is simply gone
      (the shape `examples/74-deep-book/part-two` already uses). And three flow rows across
      AGENTS.md + `server/annotations/{applications,storage}` carried the §Conventions gotcha
      itself — an unquoted spacey cell (`{description: A math block, …}`) is a parse error —
      now quoted. Swept mechanically: all 274 `.yo` under `docs/`, `examples/`, `tags/` parse,
      as do the 27 embedded `text/x-yamlover` code chunks and all 10 AGENTS.md fences.
