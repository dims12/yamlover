# EDITOR — the projectional editor

How the web client edits a yamlover node **in place**. This is the maintainer's map of the
code under `tools/server/src/client/renderers/`; for the *user-facing* "how to drive it"
guide see `UI.md`, and for the surgical write endpoint see `tools/server/README.md`
(`POST /api/edit`).

Two abstract state machines accompany this doc and must stay in sync with the code (see
§4): `YAMLOVER_EDITOR.yamlover` and `QUERY_EDITOR.yamlover` at the repo root.

## 1. What "projectional" means here

The rendered surface **is** the editable surface. There is no source textarea beside the
view — the DOM is a tree of `contentEditable` cells that mirror the instance-graph AST, and
you type into the projection. This is the MPS/JetBrains-MPS sense of *projectional*: one
model, drawn by cells; editing mutates the model and the cells re-project it.

The load-bearing consequence, stated at the top of the host
(`renderers/yamlover-editor/host.ts:9-12`): **two projections draw the same model, and only
the cells differ** — which is why the host file contains no JSX at all.

## 2. Two projections + the legacy flat editor

| Projection | Component | File | Draws the model as… |
|---|---|---|---|
| **Source** | `<EditorView>` (yed mount) | `renderers/yed-editor.tsx` | rows of yamlover cells (the `yamlover`/`json5p` data view, unlocked) — DEFAULT |
| **Chapter** | `<YedChapterEditor>` | `renderers/yed-chapter-editor.tsx` | prose, headings, sections, tables, source chunks (a chapter/task page, unlocked) — DEFAULT |

Both are yed mounts over the parser IR: load via `/api/json` → `yed-load.ts`, edit via a pure
machine (`tools/yed/src/` grammar for source, `tools/yed/src/chapter/` for chapters), persist
via the `yed-sync.ts` tree diff. They share the cell contract (`tools/yed/src/cells.tsx`) and
the never-locked laws (watchdog, positions law, dry-run legend).

**Legacy editors.** The pre-yed `<ChapterProjection>` (`chapter-editor/view.tsx`, over
`useYedHost`/`model.ts`) is **deprecated**: `?chapterEditor=projectional` brings it back for
one cycle before retirement (Stage 9 of the port plan). The pre-projectional flat
`ChapterEditor` (in-memory `renderers/chapter-model.ts` + `useChapterSync`) remains the old
escape hatch at `?chapterEditor=flat`, slated for deletion (`TODO.md`). The switch is
`chapterEditorFlavor()` (`renderers/chapter.tsx`).

```
NodeView (unlocked data view) ──► yed-editor.tsx (source)          ┐  tools/yed machine + cells
                                                                    ├─ yed-load.ts / yed-sync.ts
ChapterView (unlocked, DEFAULT) ─► yed-chapter-editor.tsx (chapter) ┘  (the SHARED yed base)

ChapterView (?chapterEditor=projectional) ─► ChapterProjection ─► host.ts/model.ts   (DEPRECATED)
ChapterView (?chapterEditor=flat) ─► ChapterEditor ─► chapter-model.ts + useChapterSync   (LEGACY, to be deleted)
```

## 3. The shared base machinery — `yamlover-editor/`

Three files own everything that is *not* a specific projection. The split is strict:

- **`host.ts`** (~839 LOC) — the non-drawing host. It fetches the node at unlimited depth,
  builds the model once, owns the op queue + debounced flush, exposes the action surface
  (`YedActions`), and runs the caret/focus machinery. The atomic unit is **`step(fn)`**
  (`host.ts:215-221`): apply `fn` to the model, enqueue the ops it returns, bump the version
  to re-render, and record a focus request. No JSX.
- **`model.ts`** (~703 LOC) — the **mutable projected tree**: `MNode` / `MEntry` / `MScalar`,
  built from the server's `/api/json` (unlimited-depth) projection plus a comments sidecar.
  Every structural mutation is a function that mutates the tree in place **and returns the
  mirroring surgical `/api/edit` ops**. It holds the "committed index" addressing discipline
  (ops are emitted against the committed index picture; see §6).
- **`cells.tsx`** (~1009 LOC) — the `contentEditable` React cell components that project the
  AST to the DOM: `NodeCells`, `ScalarCell`, `PointerCell`, `MetaTagCell`, `FlowCells`,
  `RootHole`, and the `EditableCell` primitive — plus the `YedActions` / `YedCtx` context
  types every cell consumes.

Supporting files in the same directory: `keys.ts` (typing grammar, §4), `ops.ts` (op-log +
flush, §6), `paste.ts` (clipboard yamlover → model entries).

## 4. Two state machines (and the sync convention)

Each root `.yamlover` diagram has exactly one executable mirror in the code. Keep the
diagram, its mirror, and this doc aligned when any of the three changes.

- **`YAMLOVER_EDITOR.yamlover`** — the editor's typing grammar / hole-materialization table
  (what a keystroke into an empty "hole" becomes: `- ` sequence, `key:` entry, quote, `{`/`[`
  flow, `*` pointer, `!!<` tag, block scalar…). Mirror: the pure `classifyHoleInput → HoleAction`
  in `yamlover-editor/keys.ts`, applied by `applyHoleAction` in `host.ts:60-145`; the
  `MScalar` fields even name the machine's states verbatim (e.g. `quoted_token_closed`).
  Inside a flow token the grammar adds one pair of verbs: a **comma** keeps the next element on
  this line, **Enter** puts it on the next one — which SPREADS the token to K&R and is, on disk, an
  inline concrete switch to json5p (`CONCRETES.md` §K&R). **Backspace** just past the closer joins it
  back. Spreading is skipped, not refused, for a container json5p cannot hold (a keyed+keyless
  mixture). Mirrors: `MNode.jsonp` + `setSpread`/`jsonpFits`/`flowReshape` in `model.ts`, `KrRows`
  in `cells.tsx`, `flowNext(…, spread)`/`flowJoin` in `host.ts`.
- **`QUERY_EDITOR.yamlover`** — the query/pointer editing machine (`idle` / `editing` /
  `filtered`; events `FOCUS_CELL` / `SPLIT_CELL` / `PICK` / …). Mirror: `client/breadcrumb-machine.ts`,
  a pure reducer `reduce(state, event, currentPath) → [state, effects]`; its header states
  "the human-readable state DIAGRAM lives at QUERY_EDITOR.yamlover … keep the two in sync,"
  and `breadcrumb-machine.test.ts` runs the table.

## 5. The reference / pointer PICK-mode kit

A `*` pointer or reference cell is edited with a shared **query-cell kit**, not bespoke code.
`cells.tsx:16-18` mounts `QueryCells` + `useQueryCellHost` (`client/query-cells.tsx`) with
`treeCandidateProvider` (`client/query-complete.ts`). This is the *same* `breadcrumb-machine`
reducer as the breadcrumb, run in **`pick`** mode (select commits one node path) instead of
`browse` mode (select navigates). The tag picker (`renderers/annotate.tsx`) reuses the exact
same kit. So the breadcrumb, the pointer cell, and the tag picker are one machine in three
hosts — change the reducer once.

## 6. The write path

A cell edit becomes a batch of surgical server ops:

1. A cell's `onInput` / `onCommit` (`cells.tsx` `EditableCell`) calls a `YedActions` method
   (`commitToken`, `commitText`, `holeText`, `rekey`, `holeAction`, …) from `YedCtx`.
2. The action (implemented in `host.ts`) calls **`step(fn)`** (`host.ts:215-221`): `fn` mutates
   the `model.ts` tree in place and **returns `Edit[]`** (the surgical ops); the host enqueues
   them and bumps the render version.
3. **`ops.ts` `enqueue`** appends to the op-log and **coalesces the typing case** — an adjacent
   value `emplace` at the same path replaces the previous one (keep-last), but never across a
   structural op and never for meta-carrying ops.
4. **`ops.ts` `useOpSync`** flushes the batch to the server via `editChunks(batch)` → **`POST
   /api/edit`**, **debounced 500 ms** after the last version bump, serialized (one batch in
   flight; edits arriving mid-flight ride the next batch; the queue is kept on failure).
5. `flush()` is forced on **lock, unmount, and navigation** (`host.ts:210-213`), and before an
   auto-descend into a subchapter (`chapter-editor/view.tsx:115-118`).

The op shape is `{ path, op: "emplace" | "replace" | "insert" | "remove", yamlover?, meta? }`
(`meta` carries the `!!<…>` facet). Ops address body elements by **absolute entry index**
(`:doc[3]` — keyed entries consume indices too, `CHAPTER.md`); the server applies a batch
strictly in order, re-scanning after each op. The chapter projection also auto-stamps the
document's `!!<…$defs: chapter>` meta on the first non-empty batch (`view.tsx:96-104`).

## 7. Caret / focus preservation

The editor must keep the caret exactly where the user is typing across a re-projection. The
mechanism is a **focus-request + cell registry**, applied in a `useLayoutEffect` after render:

- Each editable cell registers its DOM element by key via `YedCtx.registerCell(key, el)` into
  the host's `cellMap`.
- A mutation sets `focusReq.current = { key, at }` — the cell key is a node id (or a facet like
  `<id>:meta` / `<id>:self` / `<id>:key` / `<id>:after`); `at` is `"start" | "end" | number`
  (a visible-character offset).
- After render, `useLayoutEffect` (`host.ts:828-836`) looks up `cellMap.get(req.key)` and calls
  `focusCell(el, at)` (`host.ts:36-45`), which special-cases `<textarea>` (block scalars) vs a
  `contentEditable` range, delegating to `placeCaret` / `focusStart` / `focusEnd` in `caret.ts`.
- **DOM-reset gating:** `EditableCell` is *uncontrolled* — it rewrites its own DOM text only
  when the model's `MNode.rev` bumps (`cells.tsx:187-192`), which the model does **only** when
  it rewrites that cell's text, never mid-type. So typing never clobbers the caret.

This is the invariant the tests pin: `document.activeElement` is asserted after editor
interactions (`yamlover-editor.test.tsx`, `chapter-projection.test.tsx`), so a change that
breaks caret placement fails CI rather than shipping.

## 8. Chapter / subchapter / prose projection

**The chapter editor is a yed projection now.** The pure machine lives in
`tools/yed/src/chapter/` (`site.ts` → `dispatch.ts` → `apply.ts`, plus `format.ts`,
`positions.ts`, `watchdog.ts`, the cell layer `cells.tsx` on the yed cell contract, and the
dry-run `legend.tsx`); the server mount is `renderers/yed-chapter-editor.tsx` (marklower
codec, linked previews, image paste, the CHAPTER stamp, deferred materialization via
`renderers/yed-chapter/materialize.ts`). The superset parity gate is
`test/yed-chapter-parity.test.tsx` — its header maps every legacy behavior to its yed
counterpart. The debug page: `npm --prefix tools/yed run debug-chapter` (port 5198).
`YAMLOVER_EDITOR.yamlover` §CHAPTER is the machine's state diagram, mirrored by
`tools/yed/test/chapter-dispatch.test.ts`.

The DEPRECATED legacy projection below reads the shared `MNode` tree and branches on a
**derived** format, never on stored state (the same doctrine the port kept):

- **`chapter-editor/format.ts`** derives a `BlockFormat`
  (`chapter | table | bullets | numbered | chunk | row | row-cell`) from the spine each render:
  an explicit `!!<…$defs: X>` tag wins; otherwise the **enclosing** format decides (a container
  inside a chapter is a **subchapter**; inside a list, a sublist; inside a table, a row/cell).
- **Subchapters** ride in the body as read-only-until-descended parts; editing one **descends**
  into it (`view.tsx:64-70`), which forces a flush first (§6). `isSubchapter` / `anchorOf` /
  `CHAPTER_META` come from `chapter-model.ts`.
- **Prose chunks** — a `MNode.kind === "scalar"` node is prose (`view.tsx:43`), drawn through
  `chapter-shared.tsx` (`renderChunkBody`, `EditableLine`, `ChunkShell`) and edited by a
  **format-specific chunk editor** chosen by `chunkEditorFor(format)` in `chunk-editors.tsx`
  (a `null` editor means read-only). Markdown/marklower get the WYSIWYG contentEditable editor;
  LaTeX edits its raw source in a `<textarea>`.
- **The marklower seam.** `chunk-editors.tsx` imports `marklowerToEditableHtml` (from
  `renderers/marklower.tsx`, source → editable HTML) and `domToMarklower` (from
  `renderers/marklower-serialize.ts`, edited DOM → marklower source) — the round-trip pair.
  Emphasis edits live as markup; atomic tokens (`$$math$$`, `` `code` ``, links, `*[…](…)`
  embeds) render as single non-editable objects carrying their own source, so a round trip
  never rewrites them (`MARKLOWER.md`). `proseScalar` / `escapeYamloverScalar` decide bare vs
  quoted vs `|` block so an edit doesn't rewrite a bare chunk into a block on the first
  keystroke.

## 9. yed — the editor package, and the REFERENCE implementation

`tools/yed/` (`@yamlover/yed`, an npm-workspace member like the parser: raw TS, no build) is a
clean-room, IR-backed editor whose semantics are the reference for this whole document: where
the production cell layer and yed disagree, **yed is right** and the production layer owes a
migration. THE GRAMMAR LIVES HERE — `tools/yed/src/grammar/{dispatch,keys}.ts` — and the
production editor imports it (the dependency was inverted when the package was extracted). Run
the debug page with `npm run debug-editor` (Vite, port 5199, no server — corpus samples are
inlined at build time).

The design discipline that distinguishes it:

- **The document is always the valid parser IR** (`state.ts`); incompleteness lives in the
  CURSOR alone (pending text, a named-but-uncommitted key, the `- ` ordinal decision). There
  is no flag web and no invisible state — the page shows the cursor, the Site, the live
  serialized source, the last line-diff and the intent history at all times.
- **One grammar.** Every keystroke goes through the same `interpret(key, site)` table
  (`tools/yed/src/grammar/dispatch.ts`) that draws the on-screen keyboard legend — the
  keycaps ARE the function being run. Effects are implemented once per intent in the pure
  `apply.ts` (`applyKey(state, key) → state`), no DOM anywhere.
- **Dialects.** Language POLICY (block context, ordinals, the omni value, bare keys, scalar
  spellings) lives in `dialect.ts` — `yamlover` is the default; `json`/`json5` are prepared,
  and everything a dialect forbids refuses visibly.
- **The cell registry.** `cells.tsx` dispatches through `CellRegistry` (format before kind) —
  the plug point for prose (marklower) and format cells; a registered cell must draw a
  focusable cell for every position `positionsOf` yields in its subtree.
- **Refusal law.** An edit the state cannot take refuses visibly (`state.refused`) and
  changes nothing; moving away never drops pending text.
- **THE LEVEL RULE.** Enter commits and DESCENDS into what was committed; Shift-Tab climbs;
  a same-level sibling costs one Shift-Tab. `- ` is a decision (a keyless entry); a bare
  scalar in a block container is the container's own OMNI value.
- **Per-container layout.** A flow container spreads to K&R by ITS OWN bit only; spreading
  propagates upward (a one-liner cannot contain a multi-liner), never downward.

Its suites (`tools/yed/test/`) are the conformance gate: `typing` (grammar basics + unwind
ladders with the jam detector — no (doc, cursor) state may repeat under Backspace),
`corpus` (every `edit-examples` fixture ENTERS to its golden and DELETES to empty; honest
shrink-only allowlists), `substitute` (every expression of the E-set replaced/appended at
every site of every other), `clipboard` (subtree copy/paste as serialized text, under the
same laws typing obeys), `cells` (the framed, titled, recursive cell projection),
`dom-typing` (real key events with the caret pinned per keystroke), `dialect` (json/json5
policy smoke), `yed-dispatch` (the grammar table as data — the file
`YAMLOVER_EDITOR.yamlover` mirrors).

## File index

**`renderers/yamlover-editor/` (shared base):** `host.ts` (host, ops, focus), `model.ts`
(mutable tree + mutation→ops), `cells.tsx` (contentEditable cells + `YedCtx`), `editor.tsx`
(**DEPRECATED** — the legacy source projection, no longer the default; `?yedEditor=legacy`
brings it back during the rollout), `ops.ts` (op-log + debounced flush), `paste.ts`
(clipboard yamlover → entries). The GRAMMAR (`dispatch.ts`, `keys.ts`) moved to
`tools/yed/src/grammar/` — this layer imports it from there. Everything except `editor.tsx`
survives for the CHAPTER projection until it is ported.

**`renderers/yed-editor.tsx` + `yed-load.ts` + `yed-sync.ts` (the yed mount):** the default
unlocked-data-view editor, CONCRETE-AGNOSTIC by construction. LOAD is the `/api/json`
projection (depth `.inf`) converted to parser IR (`yed-load.ts` — omni/`selfAt`, pointers via
the sidecar's canonical text, authored raw spellings, flow/K&R meta at the switch, blobs as
opaque atoms). PERSIST is an IR tree diff emitted as PER-NODE `/api/edit` ops (`yed-sync.ts`
— whole-token emplaces at flow boundaries, self-value emplaces with `at`, removals last-first
/ insertions forward, pure key renames via `POST /api/rekey` after the flush); the backend's
concrete-inheritance rules (concrete-rules.ts) route every write, and untouched regions —
comments included — survive on disk. What the diff cannot express falls back to ONE whole-node
emplace (warned; a shrink-only ledger). Flush discipline mirrors ops.ts: 500 ms debounce, one
in flight, re-diffed (never re-queued) after a failure, flushed on unmount. `?yed=debug` turns
the debug panels on in place. THE PARITY GATE (`test/yed-parity.test.tsx`) holds the mount to
the legacy editor's storage matrix — flat files, `.yaml`, dir-backed docs, bare directories,
member dirs, deep mounts, omni, K&R, comment survival — against a real server; a mount swap
must be gated by the superset of what it replaces. `GET /api/source` remains as a diagnostic.

**`renderers/yed-chapter-editor.tsx` + `renderers/yed-chapter/materialize.ts` (the DEFAULT
chapter editor):** the yed chapter mount — load `/api/json` → IR, the pure machine in
`tools/yed/src/chapter/`, persistence through the `yed-sync.ts` diff with the exactly-once
CHAPTER stamp and deferred subchapter materialization (predicted `meta.anchorKey` keys via the
shared `concrete-rules.ts`). Gate: `test/yed-chapter-parity.test.tsx` (disk-asserting, real
handler, storage matrix; header = the behavior checklist).

**`renderers/chapter-editor/` (DEPRECATED legacy chapter projection —
`?chapterEditor=projectional`):** `view.tsx` (`<ChapterProjection>` + keys/auto-descend),
`blocks.ts` (chapter-shaped mutations, same mutate+return-ops contract as `model.ts`),
`format.ts` (`BlockFormat` derivation), `tab.ts` (Tab/Shift-Tab per enclosing format),
`format-bus.ts` (bridges the editor's format state to the node-bar control — SURVIVES, both
editors ride it).

**Related:** `renderers/chapter.tsx` (`ChapterView` + the flat/projectional switch),
`renderers/chapter-model.ts` (**legacy** flat model), `renderers/chapter-shared.tsx` (shared
chunk/heading render), `renderers/chunk-editors.tsx` (per-format chunk editors + marklower
seam), `renderers/marklower.tsx` + `renderers/marklower-serialize.ts` (the round-trip pair),
`renderers/{subchapter,list,table,depth}.tsx`, `caret.ts` (caret primitives),
`client/{query-cells,breadcrumb-machine,query-complete,toc-filter-session}.ts(x)` (the PICK/
browse query-cell kit), `client/NodeView.tsx` (mounts the source projection).

**`tools/yed/` (the editor package, §9):** `src/state.ts` (IR state + cursor + dialectOf),
`src/apply.ts` (pure intents + copy/paste + the watchdog), `src/dialect.ts` (language policy),
`src/cells.tsx` (framed recursive cells + `CellRegistry`), `src/legend.tsx` (the dry-run
keyboard), `src/page.tsx` (the debug page), `src/diff.ts` (line diff),
`src/grammar/{dispatch,keys}.ts` (THE shared grammar — production imports it from here);
`src/chapter/` (the CHAPTER machine + cells: `site/dispatch/apply/format/positions/watchdog`,
`cells.tsx` + `caret.ts` + `legend.tsx` + `chapter-cells.css` — the server injects its
capabilities through `ChapterCellsAdapter`); debug pages under `tools/yed/debug-editor/`
(port 5199) and `tools/yed/debug-chapter/` (port 5198), suites under `tools/yed/test/`.

**State machines:** `YAMLOVER_EDITOR.yamlover`, `QUERY_EDITOR.yamlover` (repo root) — keep in
sync with `keys.ts`/`host.ts` and `breadcrumb-machine.ts` respectively.
