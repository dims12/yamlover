# PLAN — instance-only yamlover: grammars, parsers, engine

Working plan for the next build phase. Companion to `URIs.md` (pointer model),
`ENGINE.md` (engine), `FUTURE.md` (platform/language). Living document.

## Decisions locked this round

- **Instance-only.** Schema is *validation*, not a stored concrete. The only thing
  stored is the **instance graph**, in some concrete.
- **Concretes are a supersession lattice, not isomorphic.** `json ⊂ json5 ⊂ json5p`
  and `yaml ⊂ yamlover`; **json5p / yamlover / directory+`body.yamlover`** are the
  full-graph concretes (first-class pointers). Plain **json / yaml are tree-only** —
  a graph serialized to them is **lossy**.
- **One ordered container** (not two). No separate list/dict: a mapping is ordered and
  its **positions are integer keys** (added as `*`-aliases to keyed entries; a keyless
  `:` entry's value lives at its integer key). `[n]` = integer key, `/x` = string key.
  Order is data — text order in a file; a `body.yamlover` pointer-array for a directory.
- **`.yamlover/` holds two overlays** (+ engine cache), both keyed by node path:
  **`body.yamlover`** = the *instance* (data; replaces the old `schema.yaml`-as-storage),
  and **`meta.yamlover`** = the *metadata schema*. A bare dir has neither.
- **Schema kept as METADATA, not storage** (refined 2026-06-07; see `META.md`). A
  **JSON-Schema-equivalent for yamlover** — same/close vocab (`properties`, `type`,
  `format`, `prefixItems`, …), written *in yamlover*, **purpose = metadata** (typing,
  `format`/decoding, `concrete`, presentation — the server renders by `(type,format)`),
  **validation secondary/optional**. What was dropped is schema-*as-storage* (`const`
  pinning). References use `*` pointers, not `$ref`; keep meta minimal (`concrete` is
  inferable). Used now in `55-scalar-as-binary`.
- **Deprecate `tools/walker` and `tools/collector`** (Python); the engine's walker
  supersedes them. **DONE 2026-06-07** — banners added; durable knowledge (concrete
  taxonomy, directory→node mapping, binary/ordering/depth, test-scenario checklist)
  extracted to `tools/LEGACY.md`. Kept for reference; removable once the engine's
  directory walker covers the scenarios.
- **Engine v1 = TypeScript in the existing server + better-sqlite3** (FUTURE.md:
  keep core TS, JetBrains is a thin client/sidecar not in-process). Rust/Cozo later.
- **Parsers hand-written** (recursive descent); **json5p first**.
- **JetBrains support = a standalone Kotlin/Gradle module** (`tools/jetbrains-plugin/`),
  not an in-process core; filetype + highlighting now, engine-protocol client later.

## Phase 1 — Foundations & specs (design before code)

1a. **Finalize the pointer/path grammar** in `URIs.md` — scopes (`# / ..` + URI
   authority), `* ~ &`, `[n]` indexing, backslash escaping, name rules. One ABNF,
   shared by both surface languages.
1b. **AST / IR contract** — **DRAFTED in `IR.md`** (2026-06-07). The in-memory
   instance-graph model the parsers emit and the engine consumes: `Node` =
   Mapping|Scalar|Blob; `Entry` carries an optional string key + `EdgeKind`
   (contain|ref|back); pointers are **unresolved `Pointer` edges, not nodes**;
   positional integer-key aliases (`[n]`) are **derived, not double-stored**; `&`
   anchors recorded for the resolver; bytes externalized by hash. Includes the
   IR→engine table mapping and the genealogy worked example. **Review before the
   json5p parser builds against it.**
1c. **Directory-overlay semantics** *(addition, core)* — exactly how
   `body.yamlover` overlays a real directory: file → node/blob mapping, scalar/inline
   overrides, precedence when a key and a file collide, how a file's bytes attach to a
   node. **Ordering**: files supply the string keys (filenames → blobs); the overlay
   is a **pointer-array** (`- *file1.ext …`) that assigns the integer-key positions; a
   pure directory with no overlay takes filesystem order. This is the heart of "YAML
   overlay over the filesystem."
1d. **`.yamlover/` directory contract** — `body.yamlover` (instance) **and**
   `meta.yamlover` (metadata schema, `META.md`); plus reserved names for the SQLite cache;
   plus, in the **project root** only, `settings.yamlover` — the **project configuration**
   (added 2026-06-10, see `META.md` §Settings): e.g. the *default* location for new
   annotations. Settings never constrain *where* a node may live (a maintainer may put
   annotations in any directory and they keep working — that's the point of the graph);
   they only set defaults for where the server *creates* things.

## Phase 2 — Grammars & parsers

> **Started 2026-06-07** in `tools/parser/` — layout is **per implementation language**:
> `tools/parser/ts/` (TypeScript, current; dependency-light, Node ≥22 native
> type-stripping, `node:test`) and a future `tools/parser/rust/`, over **shared**
> conformance corpora at `tools/parser/conformance/` (JSON, JSON5, YAML submodules).
> Surface languages (json5p, yamlover) are modules inside each impl. Specs written:
> `JSON5P.md`, `YAMLOVER.md`.

2a. **Pointer parser** (shared) — **DONE** (`ts/src/pointer.ts`): pointer expr →
   `{base, steps[], raw}`, backslash escaping, scopes (`/`=doc, `//`=link, `..`, current).
2b. **json5p**: **DONE** (`ts/src/json5p.ts` → IR). Passes **188 tests**: unit + JSON
   (`nst/JSONTestSuite`, all 95 `y_` accept & match `JSON.parse`) + JSON5
   (`json5/json5-tests`, all positive `.json`/`.json5`). Anchors `&`, back-edges `~`.
2c. **yamlover**: **DECIDED hand-write** (`ts/src/yamlover.ts` → IR; consistent with
   json5p — no stock YAML parser exposes hooks to reinterpret `*alias`/`~key`, and the
   Rust port wants a spec-driven parser). **Practical subset DONE** (280 tests total):
   block maps/sequences (incl. compact `- key:`, `- &anchor`), flow `{}`/`[]`, plain &
   quoted scalars, basic block scalars (`|`/`>` with `-`/`+` chomping), `#` comments,
   yamlover tags (`!!mix`/`!!omni`/`!!<…>`), plus extended `*`, `&` anchors, `~`
   back-edges; parses `examples/05-tour.yaml` & `06-tour.yamlover`. **Gate WIRED**
   (2026-06-08): `yaml-test-suite` conformance at **43/208** must-accept cases, locked
   shrink-only allowlist + roadmap in `tools/parser/YAML-CONFORMANCE.md`. **Remaining**
   (by corpus impact): multi-doc (~71 cases), standard YAML tags, block-scalar
   headers/multi-line scalars, multi-line flow, merge keys.
2d. **Serializers** — IR → yamlover / json5p / directory. Needed early: `mv` rewrites
   refs, `normalize`, and round-tripping all require graph → concrete. **Text concretes
   DONE (2026-06-11):** `serialize-yamlover.ts` / `serialize-json5p.ts` — FREE-FORM
   canonical emission (the IR keeps the graph, not the typography: comments/quote
   styles/block layout re-render; reparse is **IR-equal**). Pointer `raw` verbatim,
   anchors re-placed by node identity, `!!set`/`!!<…>` carried, `!!mix` re-derived
   from shape, `!!omni` implied (explicit only at the root). **Lossy policy = REFUSE**
   (`LossyError`, never drop): blobs / non-finite numbers (yamlover); `!!mix`/`!!omni`/
   `!!set`/`!!<…>` (json5p → route via the meta layer, as 03-tour already documents).
   **Remaining:** the *directory* concrete (graph → tree + `body.yamlover`);
   **inlined binary** — a blob must also be emittable INLINE in a text concrete
   (YAML-`!!binary`-style base64; META.md already has `type: binary` + codec
   `format`, cf. `55-scalar-as-binary`) — the same node in a different concrete,
   file-on-disk vs inline scalar; needs a byte source (the IR carries only the hash —
   the engine's blob store/manifest resolves it), at which point the blob refusal
   becomes an emission *choice*; **per-node concrete / mid-tree switches** (added
   2026-06-11) — concrete is a property of the NODE, not the document: YAML already
   embeds JSON as flow style, a directory switches concrete at every file boundary,
   and inline-binary-vs-blob-file is the same choice again. Today the parsers ACCEPT
   the switch (flow inside block) but the IR forgets it, so SeDe normalizes everything
   to one style. The work: record the authored concrete on the node
   (`NodeMeta.concrete`, aligning with META.md's `concrete` keyword — there it is
   *prescribed*, here it is *observed*), have the serializers honor it on re-emission
   (a flow/json5p subtree re-emits as flow inside a block yamlover doc), and define
   the legal switch lattice (which concrete may nest in which — `json ⊂ json5 ⊂
   json5p` / `yaml ⊂ yamlover` constrains it); and span-preserving surgical edits
   (for `mv` in hand-authored files — needs IR source spans, see 3e).
2e. **Parser/serializer test suites** — round-trip fixtures; the genealogy DAG is the
   canonical graph fixture. **Round-trip suite DONE (2026-06-11):**
   `test/serialize.test.ts` (42 tests) — IR-equality (canon ignoring typography) over
   unit cases + EVERY repo fixture (tours 01/02/03/05/06, every
   `examples/*/.yamlover/body.yamlover`, `yamlover/tags`), plus cross-concrete
   (03-tour → yamlover, genealogy → json5p) and lossy-refusal cases.

## Phase 3 — Engine + SQLite (first version)

> **Started 2026-06-07** in `tools/engine/ts/` (per-impl layout like the parser; imports
> the parser's IR; Node ≥22 + `node:test`).

3a. **SQLite schema** — **DONE (2026-06-08)** `tools/engine/ts/src/store.ts`:
   `node(path, type, format, value, content_hash, size, is_array, meta)` +
   `edge(from_path, to_path, label, kind ∈ {contain,ref,back,derived}, pos)`. `Store`
   class: `indexDocument(doc)` (IR→tables, one txn), `node(path)`, `toc(root, depth)` (recursive
   CTE over `contain`), `relationships(path)` (in/out + on-demand `derived` inverses). Uses Node's
   built-in **`node:sqlite` (DatabaseSync)** — zero dependency, supersedes the planned better-sqlite3
   on Node ≥22. Positions stay a *derived view* (keyed entries store under their string key; keyless
   under `[i]`; `[n]` for keyed is a resolver alias, not double-stored).
3b. **Walker** — **DONE (2026-06-08)** `tools/engine/ts/src/walk.ts`: `walkDir(dir)`→IR Document,
   `buildIndex(dir)`→writes `<dir>/.yamlover/index.db`. Mirrors the legacy server's file→value rule
   (text-format ext → string scalar; binary/opaque ext → Blob{format,sha256,size}; no/unknown ext →
   sniff NUL/size, else parse as yamlover) + `meta.yamlover` `properties.<name>.{type,format}` override
   + `body.yamlover` overlay (mapping merge: override/add; pointer-array: impose order ⇒ `array`).
   Replaces the Python walker. 22 engine tests (incl. 50/51/53/56/65 dir examples).
3c. **Resolver** — **DONE** (`ts/src/resolve.ts`, in-memory over the IR; SQLite-backed
   variant later). Scopes (current / `..` / `/` document / `//` link), transitive
   `*`-following, cycle-safe, anchor precedence. `resolveDocument()` resolves every `*`/`~`.
   6 tests green incl. resolving the `03-tour.json5p` & `06-tour.yamlover` pointers.
3d. **Derive + normalize** — **DONE** (`ts/src/graph.ts`): `buildGraph` (containment +
   resolved ref/back; external/unresolved split), `deriveInverses` (on-demand reverse
   edges for incoming queries), `normalize` → **forwards-only** (folds each `~` back-edge
   into the forward `ref` it reverses, deduped). 6 graph tests green; json5p & yamlover
   agree on the shared normalized edges. (Transitive closure: later, as needed.)
3e. **FS sync** — watcher + 3-tier reconcile (mediated / watched / offline), per
   `ENGINE.md`. **Watched-live + offline tiers DONE (2026-06-10):** the index gained a
   persistent **file manifest** (`file(path, hash, size, mtime_ms)`) that doubles as a
   **hash cache** — `reindex(store, root)` re-walks against it (an unchanged blob is
   never re-read), swaps the tables in one transaction, and returns an
   `{added, changed, removed}` diff; a schema-version pragma invalidates old-era DBs.
   The server (`engine-api.ts`) reindexes at startup (offline reconcile — edits made
   while down show up) and on FS-watcher batches (`engine/ts/src/watch.ts`: recursive,
   debounced, gitignore- and `.yamlover`-internal-filtered), broadcasting diffs over
   `GET /api/events` (SSE) — the client refreshes its TOC branches + current node;
   `POST /api/reindex` is the manual fallback. Unresolved pointers persist in a
   `dangling` table (`GET /api/dangling`) — reported, never dropped. **Milestone
   COMPLETE (2026-06-11):** (i) **pointer source spans** — both parsers record
   `Pointer.span` (the whole `*…` deref token; yamlover via exact column threading,
   json5p via offsets); (ii) the **MEDIATED tier** — `POST /api/mv` / `engine/ts/src/
   mv.ts` moves a file/dir and **surgically rewrites inbound refs** at their spans
   (`rewrite.ts` `planRewrites`: scope-form-preserving, metachar-escaping, anchor-
   skipping; unrewritable refs REPORTED, no tombstones); (iii) **move INFERENCE** —
   `IndexDiff.moved` (removed+added with one unambiguous hash), and the server
   **auto-relinks** inferred moves via nominal-path matching (`relinkMoved`), so an
   external `mv` in a shell heals refs too. **Known deferral:** a `body.yamlover`
   key that augments a moved file BY NAME is not renamed (a key edit needs ENTRY
   spans — `EntryMeta.span` is still unfilled); the leftover key keeps its reverse
   edges on a phantom node. Also deferred: intra-document key moves, `!!<…>` schema-
   pointer rewriting, tombstones for unreachable external refs.
3f. **Engine API** — `resolve/node/toc/relationships/derive/blob/query` + `mv/rm/put/
   link/normalize` + `changed/added/removed` events, as the versioned contract.
   **Read side DONE in practice** (the server's `engine-api.ts` exposes node/toc/
   relationships/blob over HTTP, backed by the `Store`); the **change events exist**
   (3e's reindex diff over SSE; `moved` included); **write side:** `annotate`/`paste`
   and now **`mv` LIVE (2026-06-11** — `POST /api/mv`, the mediated move with
   inbound-ref rewriting**)**; `rm/put/link/normalize` remain — `put`/`normalize`
   are unblocked by the serializers (2d), `rm` is mostly the mv plumbing minus the
   rename.

3g. **Query language** *(added 2026-06-11)* — JSONPath-inspired selectors, specced as
   a **strict superset of the pointer grammar** (`URIs.md`): every pointer is a valid
   query with at most one result. **Spec DONE (2026-06-11): `QUERY.md`** — core model
   is the **match template** (a query walks the graph; success returns a capture).
   v1 constructs: `?` / `[?]` wildcards, `...` descent (contain-only), the `~` sigil
   as the **reverse axis** (`~name` / `~?` find-usages / `~-`), bracket **filters**
   (kind, `contain`/`ref`, `!!tag`, `format=`). `? ! ( ) < > = |` joined the shared
   metachar set (URIs.md amended) — `! ( ) < > = |` are reserved for the sketched
   future constructs (comparison steps `age/>30`, capture `!`, branching
   `(… && …)`, projection). **Remaining: the evaluator** — in the engine over the
   store (the `edge` table + `deriveInverses` already make reverse axes cheap),
   exposed as `query` (3f); acceptance gate = QUERY.md §6 conformance obligations
   over the existing resolve.test.ts corpus (and `pointer.ts` catching up to the
   enlarged metachar set). Pure read-side — runs **parallel to the serializers
   (2d)**. First consumers: the tag-picker autocomplete (TODO) and JetBrains
   find-usages (J3).

> **Language decision — CONFIRMED & DONE:** engine v1 is **TypeScript inside the
> existing server**, on Node's built-in **`node:sqlite`** (superseded the planned
> better-sqlite3 — zero dependency on Node ≥22). `FUTURE.md`'s
> language-per-component rule holds; the Rust/Cozo core is deferred until
> derivation/embedding demands it.

## Phase 4 — Server integration

**DONE (2026-06-08, commit `c2d8772`).** `tools/server` runs on the engine:
`src/server/engine-api.ts` is the only live API handler (`bin/yamlover.js` loads it) —
it indexes via `buildIndex`/`Store` and answers every request from SQLite; no ad-hoc
walking remains on the live path. The React client and its renderers are unchanged;
`npx yamlover` kept working throughout (v0.3.0 published). The legacy walker port
(`src/server/yamlover.ts`, `api.ts`) is kept for reference only. Server tests target
`engine-api.ts` (`tools/server/test/api.test.ts`, `engine-api-write.test.ts`,
`reconcile.test.ts`). **Remaining from this phase:** the engine API as a *versioned*
protocol (OpenAPI).

## Phase 5 — Migrate samples (one by one; some retire)

**DONE (0.2.0 examples rework + follow-ups).** The corpus was renumbered (tours
01–06; instance dirs 50–59; chapters 60–69; plain dirs 70–72) and no
`.yamlover/schema.yaml` remains in `examples/` — schema-as-storage ceremony is gone.
- **58-genealogy-dag** (was 14) — migrated; the reference graph example, single
  `body.yamlover` with `*` cross-edges + `~` reverses.
- **67-pdf-tags** (was 18) — migrated (commit `c2d8772`): `rel` tables → a
  `!!<*yamlover/$defs/tag>` taxonomy with `*`-pointer membership authored both ways.
- Schema-pinning / `rel` / `$ref`-in-schema demos retired (`62-defs-and-refs`
  dropped pending the meta-authoring rethink, see `META.md`).

## Phase 6 — Schema: metadata now, validation later

**Reframed 2026-06-07 (see `META.md`):** the schema is **not** deferred — it returns as a
**metadata layer** (`.yamlover/meta.yamlover`), a JSON-Schema-equivalent for yamlover whose
job is typing / `format`-decoding / `concrete` / presentation (the engine & server consume
it). It exists now (`55-scalar-as-binary`). Remaining spec work:
- **`META.md` vocabulary** — pin `type` (+`binary`), `format`, `concrete` (inferable),
  `properties`/`prefixItems` nesting, `*`-refs (not `$ref`); meta-path → instance-path map.
- **Optional validation pass** (later) — the *same* document checked over the resolved
  graph: `concrete` keyword, graph constraints (edge target types, cardinality,
  `~`-inverse consistency). Design after the engine exists.

## Phase J — JetBrains filetype plugin (parallel track)

Independent of the engine (pure editor support), so it runs alongside Phases 1–3.
Scaffolded under `tools/jetbrains-plugin/` (Kotlin + IntelliJ Platform Gradle Plugin).

- **J1 (done, builds):** `.yamlover` **and `.json5p`** file types + icons;
  heuristic lexers (`YamloverLexer`, `Json5pLexer`) driving syntax highlighting; plus
  **Markdown code-fence injection** (` ```yamlover `/` ```json5p ` highlighted in
  `.md` via `CodeFenceLanguageProvider`, optional on the Markdown plugin). One plugin
  covers the whole family. **Builds clean** (2026-06-07) on Gradle 8.14.5 + Kotlin
  2.0.21, toolchain JDK 17 → `build/distributions/yamlover-jetbrains-0.1.0.zip`; wrapper
  checked in. The Markdown `CodeFenceLanguageProvider` API is version-sensitive.
- **J2:** swap the heuristic lexer for the **shared yamlover lexer/grammar** (Phase 2),
  add PSI + parser → structure view, folding, brace matching.
- **J3:** pointer **reference resolution & navigation** (go-to-def, find-usages) via
  the **engine protocol** (thin client), per FUTURE.md.
  **Heuristic v1 SHIPPED (2026-06-10, plugin 0.2.0):** Ctrl+click / Ctrl+B on a `*pointer`
  navigates via a pure-text path index of the same file (`PointerNavigation.kt` +
  `PointerGotoDeclarationHandler`) — current/`..`/`/` scopes, `[n]` positions, anchors,
  escapes; `body.yamlover` document-scope segments also reach the overlaid directory's
  files. `//` links and cross-document resolution stay for the engine-protocol J3.

## What else (gaps I'd add to your list)

- **IR/AST contract** (1b) and **overlay semantics** (1c) — the two specs everything
  else hangs on.
- **Serializers / write-back** (2d) — graph → concrete; required by `mv`/`normalize`.
- **File identity** — extensions/MIME for `.yamlover`, json5p; how the engine knows a
  file's concrete.
- **Directory child ordering** — disk has none; the overlay must define it.
- **Lossy-projection policy** — what happens serializing a graph to plain yaml/json.
- **Test migration** — `tools/walker/test_walker.py` coverage moves to engine tests.
- **Transition safety** — don't break the published `npx yamlover` while rebuilding.
- **Materialization** — the graph → concrete direction (defaults/instantiation) is the
  inverse of parsing and underpins serving and `normalize`.

## Risks / open decisions

1. **yamlover parser approach** (2c) — extend an existing YAML parser vs hand-write.
   Biggest engineering risk.
2. **Engine language** — TS-v1 (recommended) vs starting the Rust/Cozo core.
3. **Lossy concretes** — define behavior when a graph can't fit plain yaml/json.
4. **Overlay precedence** — file vs overlay-key collisions, ordering, scalar overrides.

## Suggested immediate next step

Phase **1a + 1b + 1c** (grammar finalize, IR contract, overlay semantics), then start
the **json5p** parser (smaller grammar) to validate the IR before tackling yamlover.
