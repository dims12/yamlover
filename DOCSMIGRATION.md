# DOCSMIGRATION — the MD specs become the `docs/` yamlover book

The root-level `*.md` specs migrate into a **yamlover document tree under `docs/`** — a
directory chapter (the `examples/66-pet-keeper-handbook` shape): `docs/` is the book, each
chapter its own subdirectory with an `index.yo` (the overlay stepped out of `.yo/` — the
`dir/index.yo` concrete), prose in marklower chunks, structure in the positional body. The book
is read, edited, and dogfooded through the yamlover server itself — the documentation becomes
the largest real instance of the thing it describes. Marklower features are expected to
**improve along the way** (§Conventions lists the constructs the MD sources use that marklower
does not carry yet).

**The migration itself is DONE** (sources stubbed 2026-08-04, stubs deleted 2026-08-07). Since
2026-08-09 this file is also **the standing plan for syncing the book with the code** —
§Syncing at the bottom.

## Target structure

Decided 2026-08-01: **`docs/language/` is the self-contained spec** — it absorbs the pointer,
type, concrete, and query material (the planned `pointers/`, `types/`, `concretes/`, `query/`
toplevel chapters were dropped; `meta/` and `transform/` joined as toplevels 2026-08-09).
Storage follows the **default model, recursively**: every chapter's own content lives in its
directory's `index.yo`, and ALL subchapters are subdirectories, the same way at every depth.

```
docs/
  index.yo           — the book root: title, intro prose, the ordered chapter pointers
  .yo/settings.yo    — project settings (already present; docs/ is a served root)
  language/          — The yamlover language: the spec, five parts:
    model/             the abstract model: values, members, order, format, meta (the !!<> tag),
                       graph, matching, terminology, constructs
    concretes/         storage laws (storage, choosing, invariants) + the per-language
                       catalogs (yamlover, yaml, json5p, json5_code, json_code)
    pointers/          paths, scopes, deref, anchors, escaping + queries/ nested
    principles/        one subdirectory per principle (order-is-data, one-node, …)
    vs-yaml/           the kept surface + every deliberate break, one each
  meta/              — Yamlover meta: the JSON-Schema replacement (2026-08-09; holds the
                       facets/type cube and the absorbed metadata vocabulary)
  transform/         — Transforms: the meta extension for reshaping (2026-08-09)
  documents/         — Documents (chapters, marklower, tables, lists)
  server/            — the demo server: UI, projectional editors, machines, annotations
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
- [x] The stubs DELETED (2026-08-07) - the fifteen redirect files are gone (thirteen `*.md` plus
      `YAMLOVER_EDITOR.yo` / `QUERY_EDITOR.yo`), and the last 255 citations of them repointed at
      book chapters by the same method as the 2026-08-05 code sweep. Where the 2026-08-05 round
      had covered the TS sources, this one caught what it had missed: the JetBrains Kotlin, the
      onenote2yamlover C#/PowerShell, `styles.css`, `yed/package.json`, nine `tools/**/README.md`,
      the `$defs/` schema headers, every `.yo/settings.yo` comment (now matching the template
      `settings.ts` writes), the `examples/` + `slides/` file comments, and the eleven root specs
      that stayed MD (`PLAN.md`, `IR.md`, `ENGINE.md`, `IMPORTS.md`, `JSON5P.md`, `QUERY-FUTURE.md`,
      `TICKETS.md`, `PRIOR-ART.md`, `FUTURE.md`, `TODO.md`, `edit-examples/README.md`). Section
      anchors dropped as before, the chapter name carrying them - the section-level mapping read
      off this file's own 2026-08-05 note and the pre-stub headings in git, so `QUERY.md §4.3`
      lands on `pointers/queries/uplinks`, `§5` on `queries/semantics`, `MARKLOWER.md §Status` on
      `marklower/known-divergence`, `EDITOR.md §9` on `editor/yed`. PROVENANCE mentions are
      deliberately kept: this file's mapping table, `YOMIGRATION.md`'s extension inventory, and
      the "Sources:" header comments of the book's own `index.yo` files still name the MD sources
      they were made from. Hand-finished where a dropped anchor broke the sentence (a wrapped
      `URIs.md §The null` in JSON5P, a doubled anchors citation in IR, PLAN's Phase A "Spec DONE"
      log, four QUERY-FUTURE sentences that had cited sections by number, the orphaned
      `§Header widths` in `61-table.yo`, `slides/06`'s "and §7"). All 345 tracked `.yo` re-vetted;
      800 parser/engine + 672 yed + 1407 server green, typecheck clean. One fixture regenerated
      (`test-examples/0925`) - the dev-board example whose ticket prose cited a spec by file name.
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
- [x] The meta language got its own toplevel chapter (2026-08-09): `docs/meta/` — yamlover meta
      presented as the replacement for JSON Schema, shaped like the "Understanding JSON Schema"
      book — inserted between `language` and `documents` in the root body. `language/model/facets`
      moved in whole (`git mv` → `meta/facets`); `language/model/metadata` absorbed and retired:
      its blocks now seed `meta/` (root body), `meta/attaching`, `meta/structuring`, and
      `meta/vs-json-schema` (which adds the keyword-by-keyword equivalence table). New stub
      chapters await prose: `value`, `keyed`, `ordinal`, `enum-const`, `annotations`, `format`,
      `composition`, `conditionals`. `meta/principles/` states the two design commitments:
      more-than-validation (why "meta", not "schema") and terse-keywords (yaml-style short
      names, kebab-case TBD). All live citations repointed (`::language:model:metadata` → `::meta`,
      `docs/language/model/{metadata,facets}` → `docs/meta{,/facets}`) across the book, the root
      MDs, `$defs/chapter`, both `.yo/meta.yo` overlays, and the tools' code comments; this log
      keeps the historical spellings.
- [x] The model grew its missing chapters (2026-08-09): `model/members` (members as nodes on
      spine edges; the membership-constraint table - seq/map/set/mix/yo with JSON Schema names
      and examples), `model/format` (format as a NAMED CONSTRAINT on any node's content - a
      scalar is just a node without members - with the known-formats table read off the engine's
      EXT_FORMAT/TEXT_FORMATS/DOC_FORMATS + the builtin x-yamlover-* schemas), and `model/meta`
      (the `!!<...>` attachment tag: a meta-language expression or a `*` reference inside `<>`;
      a bare `!!name` is a NAMED meta, `!!yo` included - its content sparsely hardcoded today).
      The values chapter's type table widened (JSON Schema names + examples columns, the
      `binary` row); `terminology` gained the `spine edge` entry; model children reordered by
      hand (terminology demoted toward the end).
- [x] Transforms named (2026-08-09): `docs/transform/` - a toplevel chapter between `meta` and
      `documents`. A transform is the meta EXTENSION describing conversions between yamlover
      shapes, typed like a function prototype: metas for the arguments, a meta for the result,
      plus the reshaping between. Terminology settled the same round: "projection" stays the
      storage-derived read view, "transform" is the data-to-data reshaping. `!!omap`, `!!pairs`,
      `!!binary` reframed as TRANSFORM NAMES (hardcoded today, written out later) consistently
      across `model/values`, `model/members`, `model/meta`, and the transform chapter itself.

## Syncing — the standing plan (2026-08-09–)

The book and the code are now one system evolving together: dogfooding surfaces representation
bugs, doc rounds surface undocumented behavior, and design rounds (the `meta`/`transform`
chapters, the `entries:` keyword) deliberately run AHEAD of the code. The rules:

- **The book is the spec.** Code comments cite chapters by repo-root path (the 2026-08-05/07
  convention); a restructure repoints every live citation in the same change set
  (`DOCSMIGRATION.md` and `.yo/.trash` keep historical spellings).
- **No silent divergence.** A doc statement the code contradicts is either a defect to fix or
  gets an explicit "hardcoded today / to be written out" marker in the prose. TBD stubs are
  legal; unmarked divergence is not.
- **Design-ahead chapters say so** in their own text (the transform chapter, `!!yo`'s content,
  the terse-keyword spellings), so a reader can always tell law from plan.
- **No implementation details in the book's prose** (ruled 2026-08-09): implementation status
  lives ONLY in a small italic note at the TOP of a chapter (`*Status: design - …*`), never
  inline in sentences or table cells. The `docs/server` chapters are the exception by charter -
  they are the maintainer's map and cite files/endpoints as their subject.
- Every edited `.yo` is vet-parsed before commit (the reconcile-poisoning gotcha), and
  structural checks run against a SCRATCHPAD copy - never the live served index.

### Sync checklist

- [x] Full three-way consistency audit RAN (2026-08-09): book-internal claims + links;
      `model`/`meta`/`transform` vs parser+engine; structure + `documents`/`server` vs
      tools/server. STRUCTURE IS CLEAN: 246 chapters, every child pointer and all 390 absolute +
      17 relative links resolve, zero orphans; the meta/facets+metadata repoint fully propagated.
      Strong matches worth knowing: the tables chapter ($defs/table ↔ doc ↔ renderer) is
      three consistent copies; THE ROLES LAW is verbatim in roles.ts; `!!set` ≡ `uniqueItems`
      holds end-to-end incl. projection dedup; json5p refuses-never-drops as documented;
      settings-are-defaults near-verbatim in settings.ts; `!!yo` exemption exact. Findings
      filed as the items below.
- [ ] DECIDE the `!!mix` story - four positions coexist: a constraint requiring one entry of
      each (meta/facets:29,51; model/members:47), a no-op marker parsed-and-discarded
      (principles/one-node:19, vs-yaml/differences/{mixtures:7,set:7} - matching the parser,
      yamlover.ts:478), a named meta (model/meta:20). One ruling, then respell the losers.
- [ ] DECIDE `type: variant` - "constrains nothing, a tautology" (meta/facets:34) vs
      load-bearing in documents/*: asserts fully-omni AND derives `x-yamlover-*` formats
      (tables/schema:5, lists:21). State the schema-derives-format reading in facets or split
      the meanings.
- [x] MARKED (2026-08-09) as one-line top-of-chapter status notes: `meta/facets` ("the facet
      keywords and their quantifiers are not implemented yet"), `meta/attaching` ("the overlay
      route reads one level today"), `docs/transform` ("this layer is not implemented yet").
      The original finding, for the record: the facet keywords
      `value:`/`keyed:`/`ordinal:` and the `min`/`max` quantifiers are implemented nowhere -
      the engine's whole schema vocabulary is type/format/properties/additionalProperties/
      items/anyOf/allOf (walk.ts:1016-1044; compileMeta returns [] - validate.ts:192);
      `$defs/chapter` even authors `value:` and the engine ignores it (a chapter title never
      receives text/marklower from the schema). Same marker for meta/attaching's "nests under
      the JSON-Schema keywords" (reality: one level, three keywords - walk.ts:699-715, which
      validate.ts:179 itself calls FUTURE).
- [x] SOFTENED (2026-08-09): "hardcoded today" is gone - the three names are "reserved" /
      "planned" transform names across transform, model/values, model/members, model/meta, and
      the transform chapter's top note carries the status. (The underlying facts, for the
      record: none parse - the bare-tag regex is `!!(mix|var|omni|yo|set)`, yamlover.ts:429;
      `!!binary` exists only as client output decoration; `int32/le` decodes only in the
      superseded legacy loader, server/yamlover.ts:436 - landing the codec in the engine walk
      stays a code ticket.)
- [ ] FIX the model-root vocabulary: model/index.yo defines "relations" carrying per-edge
      "ordinals" - terminology has entry/member/spine edge/ref edge and no "relation" (used
      undefined in 9 more chapters; "ordinal" also means the facet). Standardize
      "self-value" (3 spellings live), and "tree" where the book insists on "graph".
      (The plain typos are FIXED 2026-08-09: "Nodeas"/"ombivorous", both unclosed parens,
      "ptah"/"alos"/"ot"/"1th"/"it's", the vs-yaml grammar slip.)
- [ ] ADD the `back` edge to terminology: anchors realize as EdgeKind 'back', not 'ref'
      (resolve.ts:81, ir.ts:175; store adds 'derived'), and the load-bearing rule "reverse
      members never change a node's kind" (node-kind.ts:20-28 - why a tagged PDF stays binary)
      is documented nowhere; terminology:22 says an `&` anchor creates a ref edge.
- [ ] FIX or file as defects: the query type matcher lacks `mixed`/`null`/`scalar`
      (query.ts:386-398 - `!!<type: mixed>` silently matches nothing while `mixed` is a live
      display kind); blob/binary is a first-class node kind beside scalar in code
      (node-kind.ts:10), folded into scalar by the book; `text/html` is NOT in TEXT_FORMATS so
      an .html file becomes a Blob while the format table says string (a CODE gap now - the
      book keeps the design claim); `int32/le` decode missing from the engine walk (same).
      (Doc side DONE 2026-08-09: the resolution fallback respelled to the real
      sniff-then-parse, meta/index:19; the `x-yamlover-tag`/`-annotation` row now says omni.)
      Also: "grafts the `yamlover` self-import into EVERY served root" - on the self-root it
      DE-materializes instead (walk.ts:312-345); `json5/meta` missing from DOC_FORMATS while
      the book generalizes "the .../meta variants" (and `json/schema` is code-only).
- [x] REPOINTED (2026-08-09) - the vs-yaml split leftovers: `vs-yaml/tilde` (10 sites, all
      about back-edge/reverse membership) → `docs/language/pointers/anchors`, the chapter that
      owns the mechanism; `vs-yaml/mixtures` → `differences/mixtures` (13 sites incl. two
      examples); `vs-yaml/null-keys` → `similarities/null-keys` (IR.md, JSON5P.md). Zero stale
      spellings remain outside this log and `.yo/.trash`.
- [x] REFRESHED (2026-08-09) docs/server for the one-wire migration: `/api/json` →
      the `/api/content` envelope (editor/file-index ×2, editor/projections incl. the ASCII
      diagram), `yed-load.ts` → `yed-content-load.ts`, `derive-concrete.ts` →
      `concrete-rules.ts` + `concrete.ts`; ui/editing's `:doc[3]` respelled to the bare-integer
      `: doc: 3`; the `*`/`~` "edges" wording → `*` pointers and `&` anchors (ui/views,
      key_cell_editing); annotations/storage's example moved off the legacy keyed `title:` to
      the self-value title.
- [ ] SMALL BOOK FIXES: documents/chapter/schema:11-14 quotes a 3-branch body union
      ($defs/chapter has 5 - bullets/numbered missing; the sibling tables/schema lists all 5);
      $defs/chunk:3 comment says "markdown prose" (schema and book say marklower);
      source-header comments name deleted files (docs/server/index.yo:2,
      docs/documents/index.yo:1, docs/documents/chapter/index.yo:1); model/index:27 tags its
      example `$defs: xyflow` - no such def (renders only via derived-format leniency,
      store.ts:615); pointer chapters conflict on quoted `'..'` (paths:90 "any quoted portion
      is a string key" vs escaping:10 "both meaning parent") and on `null`/`<<`/`-` as path
      tokens vs the normative ABNF (paths:54-66 vs :106-115); three tail-ordering stories
      (order:21 lexicographic vs chapter/model:25 scan order vs order-is-data:20 keyed-only);
      model/format:8 points at the meta/format stub for a resolution order the stub doesn't
      state (it lives in meta/index:19).
- [ ] Meta stub chapters await prose: `value`, `keyed`, `ordinal`, `enum-const`, `annotations`,
      `format`, `composition`, `conditionals` (the `keyed`/`ordinal` pair may merge into an
      `entries` chapter - next item)
- [ ] Spec the `entries:` design round (2026-08-09 discussion) into `meta/`: ONE omni
      `entries:` keyword - a keyed clause describes the same-named entry (`properties`), the
      k-th keyless clause the k-th keyless entry (`prefixItems`), selector clauses sweep by
      pattern/index-range; `others:` covers what no clause matched (`additionalProperties`/
      `unevaluated*`); per-clause `min`/`max` subsume `required`/`contains`; a clause position
      keyword (`at:` - restart the ordinal count from N, `~` = floating). Add the rows to
      `meta/vs-json-schema`.
- [ ] Decide the terse keyword spellings (kebab-case TBD) and respell `meta/vs-json-schema`'s
      "yamlover meta" column
- [ ] Write out the named metas/transforms that are hardcoded today: `!!yo` (the yamlover meta
      itself), `!!omap`, `!!pairs`, `!!binary` - `docs/transform` carries the frame
- [ ] Root `docs/index.yo` header comment still says `.yo/body.yo` - respell to `index.yo`
      when next touching the file
