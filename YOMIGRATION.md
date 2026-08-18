# YOMIGRATION — every place the name `yamlover` is a default

An inventory for the planned rename of the default name `yamlover` → `yo` (primarily the
filename extension). Each item says **what** is defaulted, **where** the defining code lives,
and **what switching it to `yo` touches**. Nothing here is a decision — mark each item
switch / alias-both / keep.

The same seven letters play *different roles*; renaming one role does not force the others.
The roles, most-visible first:

## Status: EXECUTED (2026-07-31)

The decisions below are implemented:

- **§1 alias** — `concrete.ts` maps both `.yo` and `.yamlover` to `file/yamlover`; the splice
  gate (`YAMLOVER_ONLY`/`BLOCK_YAML`), live-refresh filter, engine parser fallback, and the
  JetBrains plugin (`extensions="yo;yamlover"`) accept both. Everything newly created —
  chapter files, pasted documents, `chapterFileName` — is born `.yo`.
- **§2/§3 hard switch** — the overlay is `.yo/` with `body.yo` / `meta.yo` / `settings.yo`
  (walk.ts, watch.ts, settings.ts, validate.ts, engine-api.ts). The old spelling is NOT read.
- **Repo data renamed** — all overlay dirs/files, `examples/**`, `slides/**`, `$defs/`, `tags/`,
  `test-examples/` + `edit-examples/` corpora (readers, `from`/`===` goldens, SKIPPED.md), the
  state diagrams `YAMLOVER_EDITOR.yo` / `QUERY_EDITOR.yo`.
- **One-time migration for other trees**: `node tools/migrate-yo.mjs <root> [--dry-run] [--files]`
  renames `.yamlover/` overlays and deletes stale `index.db*`; `--files` also renames standalone
  `*.yamlover` files (optional — they stay readable).
- Historical mentions of the retired `.yamlover/schema.yaml` model keep the old spelling on
  purpose (docs, LEGACY.md, walker/collector).

Follow-ups, both closed:
- `doc/` is fully migrated (the `index.db` lock belonged to a since-stopped server).
- `tools/onenote2yamlover` (C# + the ps1 prototype) now generates `.yo/` overlays and
  `*.yo` chapter files; its 141 tests pass.

## Decisions

Fill the **Decision** column: `switch` (rename to `yo`), `alias` (accept both, emit new),
`keep` (stays `yamlover`), or `defer`. Notes are yours.

| §  | Role                                                        | Decision | Notes |
|----|-------------------------------------------------------------|----------|-------|
| 1  | File extension `.yamlover`                                  | alias    | new files are born `.yo`; readers accept both `.yo` and `.yamlover` |
| 2  | Overlay directory `.yamlover/`                              | switch   | `.yo/` — repo's own trees renamed in the same change; old external trees need a one-time rename |
| 3  | Overlay file names `body/meta/settings.yamlover`            | switch   | `body.yo` / `meta.yo` / `settings.yo` |
| 4  | Concrete ids (`yamlover`, `file/yamlover`, `dir/.yo`)  | keep     | `ir.json` goldens untouched |
| 5  | yed dialect id `yamlover`                                   | keep     |       |
| 6  | Format names `x-yamlover-*`                                 | keep     |       |
| 7  | JSON API marker keys `$yamlover*`                           | keep     |       |
| 8  | Reserved node keys `yamlover-annotations/-fragments/-thumbnails` | switch | 2026-08-18 (the dot-yo unification): the reserved key is `.yo:` (`fragments`/`lanes`/`thumbnails` under it); legacy `yo:` and `yamlover-thumbnails:` read forever, reused in place, never written anew; `yamlover-annotations` stays retired (husk-pruned on untag only). Any dot-prefixed key is HIDDEN by default. Migrate a tree with `node tools/migrate-dot-yo.ts <root> [--dry-run]`; the doctor's `annotations/legacy-overlay-spelling` (info) lists what it would touch |
| 9  | Self-import key + world URI `yamlover.inthemoon.net`        | keep     |       |
| 10 | Edit-API field name `yamlover:`                             | keep     |       |
| 11 | Package / binary / product / repo names                     | keep     | avoids the `npx yo` / Yeoman collision entirely |
| 12 | Virtual paths & UI fixtures                                 | keep     | but §2/§3 spellings inside them follow: gear path becomes `:.yo:settings.yo` |
| 13 | Docs, state diagrams, repo's own data                       | keep     | prose stays "yamlover"; file *names* under examples/corpus follow §1–§3 where renamed |
| 14 | Meta vocabulary v2 (2026-08-14): `members:`/`others:` clauses, per-member `concrete:` decode | switch | legacy `properties`/`items`/`additionalProperties` and format-as-decoder (`format: int32/le`, `format: yamlover/meta`) read FOREVER, never authored; the authored corpus states the new spellings. Index invalidation via `SCHEMA_VERSION` 11→12 (store.ts) — first serve reindexes |

---

## 1. The file extension `.yamlover`

The user-facing default the migration is mainly about.

### 1.1 Extension → concrete map (server)
- `tools/server/src/concrete.ts:116` — `EXT_FILE_CONCRETE = { ".yamlover": "file/yamlover", … }`;
  `dataFileConcrete()` is THE single extension oracle for the server (validate.ts, engine-api.ts
  both call it). A `.yo` file today falls to `null` → treated as a `file/yaml` raw-string scalar.
- **Switch**: add/replace the key here and most of the server follows automatically.

### 1.2 Extension → parser choice (engine)
- `tools/engine/ts/src/walk.ts:817-821` — `parsedScalar()`: `.json*` → json5p, `.yaml/.yml` →
  yaml, **everything else → yamlover (the default branch)**. So the engine would already parse a
  `.yo` file as yamlover with no change — but only because *unknown* extensions default that way;
  `.yo` would not be listed as a *data* extension by 1.1, so the two layers would disagree.
- `tools/engine/ts/src/walk.ts:1163-1164` — `DOC_FORMATS` maps the format string `'yamlover'` →
  surface language.

### 1.3 Write-gates that test the extension literally
- `tools/server/src/server/engine-api.ts:2349-2354` — the surgical splice engine accepts a
  standalone file only when it `endsWith(".yamlover")` (chapter/paste/annotate flows; dir-backed
  bodies checked the same way).
- `tools/server/src/client/live.ts:25` — `touchesYamlover`: SSE diff refresh triggers only for
  paths ending `.yamlover`. A `.yo` file would not refresh the UI live.

### 1.4 Where new files are BORN with the extension
- `tools/server/src/server/engine-api.ts:2619-2629` — new object document: `base + ".yamlover"`
  (file concrete) or `<base>/.yamlover/body.yamlover` (dir concrete).
- `tools/server/src/server/engine-api.ts:2574-2581` — chapter materialization writes
  `<chDir>/.yamlover/body.yamlover`.
- The paste-to-chapter flow ("else → a new chapter .yamlover file", engine-api.ts:723,
  client `api.ts:334-341`).

### 1.5 IDE / editor integrations
- JetBrains plugin: `tools/jetbrains-plugin/src/main/kotlin/net/inthemoon/yamlover/YamloverFileType.kt:9`
  — `getDefaultExtension() = "yamlover"`; `src/main/resources/META-INF/plugin.xml:34` —
  `extensions="yamlover"` (the actual file-pattern binding; supports a comma list, so
  `yamlover,yo` is a cheap alias).
- Markdown code-fence language injection (`yamlover-markdown.xml`) keys off the language *name*,
  i.e. the fence label ` ```yamlover ` — a naming default of its own.

### 1.6 Corpus & golden file names
- `test-examples/*/in.yamlover` — read by name in `tools/yed/test/corpus.test.ts:164-169`,
  `tools/server/test/edit-corpus.test.tsx`, chapter-machine tests.
- `edit-examples/*/out.yamlover`, `in.yamlover` — `edit-examples/README.md`, the `from` files
  point at `test-examples/*/in.yamlover`; `edit-examples/.gitattributes` pins these as bytes.
- `examples/` — `06-tour.yamlover`, `60-simple-chapter.yamlover`, etc., plus every
  `.yamlover/body.yamlover` overlay. `examples/README.md` names them all.
- **Switch**: a mass `git mv` + updating the reader constants; goldens are byte-pinned, so the
  contents don't change, only names. (Per repo law, corpus dirs need `* -text` before/after.)

### 1.7 The spec itself
- `YAMLOVER.md:17` — "File extension **`.yamlover`**". Also §5 (directory concrete),
  CONCRETES.md, CHAPTER.md, ANNOTATIONS.md examples — all show the extension.

---

## 2. The overlay directory name `.yamlover/`

Same string, different creature: the *marker directory* that makes a plain dir a yamlover
entity. Renaming the extension does NOT rename this — decide separately (`.yo/`?).

- `tools/engine/ts/src/walk.ts:34` — `YAMLOVER_DIR = '.yamlover'` (the walker's marker; also the
  splice-unit anchor at walk.ts:465-468).
- `tools/server/src/validate.ts:34` — `OVERLAY_DIR = ".yamlover"` (layout law: nested-overlay,
  reserved names, "the one legal dot-name").
- `tools/engine/ts/src/settings.ts:90,101,164` — `<root>/.yamlover/settings.yamlover` joins.
- `tools/engine/ts/src/watch.ts:46-53` — the watcher's dot-dir exception for `.yamlover/`.
- `tools/engine/ts/src/store.ts:18` + `engine-api.ts:109` — the index DB at
  `<root>/.yamlover/index.db`.
- `tools/server/src/server/engine-api.ts` — dozens of `path.join(…, ".yamlover", …)` sites
  (settings, sidecars at 1963-1975, host-body resolution at 1994-2009, overlay pruning at 2197,
  tags location at 2223-2238, overlay materialization at 2634-2637).
- Sidecar dirs live inside it: `.yamlover/thumbnails/`, `.yamlover/fragments/`
  (walk.ts:22 `YAMLOVER_SIDECAR_DIRS`, validate.ts:40-41).
- Housekeeping: `.gitignore:22-23` (`**/.yamlover/*.db*`), `tools/clean-index.mjs:46`.
- JetBrains: `PointerGotoDeclarationHandler.kt:42` — overlay-aware navigation checks
  `body.yamlover` inside `.yamlover`.
- Legacy: `tools/server/src/server/yamlover.ts:21`, `tools/walker/walker.py:46`,
  `tools/collector/collector.py:30` (all `.yamlover/schema.yaml`-era, kept as reference).
- **Note**: this is a *disk format* default — existing user trees carry `.yamlover/` dirs, so a
  rename needs either a migration step or the walker accepting both markers.

## 3. The overlay file names `body.yamlover` / `meta.yamlover` / `settings.yamlover`

Doubly defaulted: the fixed basenames AND the extension inside them.

- `tools/engine/ts/src/walk.ts:39-47` — `YAMLOVER_INTERNAL` set + `SETTINGS_FILE`.
- `tools/engine/ts/src/watch.ts:18` — `OVERLAY_FILES` set (must stay in sync with walk.ts).
- `tools/server/src/validate.ts:38` — the overlay vocabulary (`body/meta/settings.yamlover`,
  `index.db*`).
- `tools/engine/ts/src/settings.ts:71-83` — `DEFAULT_SETTINGS_SOURCE` writes the header comment
  naming the file and tags it `!!<*yamlover:$defs:config>` (crosses into role 8).
- Every `body.yamlover` / `meta.yamlover` under `examples/` and in this repo's own
  `.yamlover/` (`body`, `meta`, `settings`), `doc/.yamlover/settings.yamlover`,
  `$defs/board` and `$defs/config` doc-comments.

## 4. Concrete / language identifiers (`'yamlover'`, `file/yamlover`, `dir/.yo`)

Internal enum values, but they leak into goldens and API payloads.

- `tools/parser/ts/src/ir.ts:37` — `Document.source.concrete`:
  `'yamlover' | … | 'multi-yamlover'` (reserved).
- `tools/server/src/concrete.ts:14,36` — the `file/yamlover` concrete;
  `tools/server/src/concrete-rules.ts:31,39` — `ChildConcrete = "yamlover" | "file/yamlover" |
  "dir/.yo"` (what the editor offers when a child is born).
- `tools/server/src/validate.ts:128,373-382` — `dir/.yo` vs marker agreement.
- `tools/server/src/server/engine-api.ts:1141-1157, 4409-4430, 4480` — concrete strings in the
  edit API (`concrete: yamlover | file/yamlover | dir/.yo | dir`) and storage reporting.
- **Golden impact**: `test-examples/*/ir.json` embed `"concrete": "yamlover"` — renaming the id
  rewrites the IR goldens (mechanical, but a real diff).

## 5. The yed dialect id `yamlover`

- `tools/yed/src/dialect.ts:8,32-33,82` — `DialectId = "yamlover" | "json5" | "json"`,
  `YAMLOVER` dialect object, `DIALECTS` registry.
- `tools/yed/src/state.ts:43,54,59` — the *default* dialect: `s.dialect ?? "yamlover"`; new
  empty docs get `source.concrete: "yamlover"`.
- `tools/yed/src/page.tsx:103` — the debug panel prints the default name.

## 6. Format names `x-yamlover-*`

The derived-format vocabulary — stored in the index DB and matched by queries.

- `tools/yed/src/chapter/format.ts:28-45` — the map (`x-yamlover-table/-bullets/-numbered/
  -chapter/-task`), the `x-yamlover-${name}` constructor, `CHAPTERISH` set (line 164).
- `tools/engine/ts/src/walk.ts:207-216, 953` — builtin schemas (`x-yamlover-onto`,
  `x-yamlover-fragment`, `x-yamlover-annotation`) and the hosted-schema rule
  `$defs/<name>` → `x-yamlover-<name>`.
- `tools/engine/ts/src/store.ts:320, 599-611` — formats persisted into the index;
  `tools/engine/ts/src/query.ts:391` — schema test matches `row.format === "x-yamlover-<name>"`.
- `tools/yed/src/chapter/apply.ts:649,674` — derivedFormat stamping.
- `x-yamlover-config` (settings), `x-yamlover-thumbnail`-ish sidecar handling in
  `tools/server/src/server/extract/thumbnails.ts`.
- Legacy `x-yamlover` provenance block: `tools/server/src/server/yamlover.ts:262,1015`,
  `tools/walker/walker.py:51,215`, `tools/collector/collector.py`.
- **Note**: these live in user data (meta files can author `format:` explicitly) and in the
  derived index — renaming needs a reindex, plus tolerance for docs authored with the old names.

## 7. JSON API marker keys `$yamlover*`

The client/server wire protocol.

- `tools/server/src/server/engine-api.ts:89-100` — `$yamloverLink`, `$yamloverBinary`,
  `$yamloverMixed`, `$yamloverRef`, `$yamloverNum`.
- Mirrored in the legacy materializer `tools/server/src/server/yamlover.ts:827,858,913` and
  decoded throughout `tools/server/src/client/` (render.tsx, NodeView.tsx, renderers).
- Internal only (client and server ship together), so a rename is safe but wide.

## 8. Reserved node keys `yamlover-annotations` / `yamlover-fragments` / `yamlover-thumbnails`

Stored *inside user documents* — the strongest on-disk coupling after the overlay dir.

**Executed 2026-08-18 as the dot-yo unification.** The one reserved key is `.yo:` — the same
namespace as the on-disk `.yo/` dir — with `fragments:` / `lanes:` / `thumbnails:` under it,
and the shared vocabulary lives in `tools/parser/ts/src/overlay-keys.ts` (every consumer —
walk, engine-api, embed, roles.ts, the clients — imports THOSE predicates). Read-both /
write-new: legacy `yo:` and `yamlover-thumbnails:` are recognized forever and REUSED in place
(a file never carries two overlay keys); `yamlover-fragments` was already dead;
`yamlover-annotations` stays retired (read + husk-pruned on untag, never grown). The
migration pass is `node tools/migrate-dot-yo.ts <root> [--dry-run]` (IR-level, comment-
preserving, parse-checked); `annotations/legacy-overlay-spelling` (an `info` doctor
diagnostic) lists what it would touch. Any dot-prefixed key is HIDDEN by default — off the
TOC/listings/queries, reachable by direct path; the `.yo` subtree is additionally SPECIAL
(engine-managed): browsed directly it renders as the generic read-only data view, and the
edit routes refuse it (`:.yo:settings.yo` excepted). docs/annotations is the spec.

## 9. The self-import key `yamlover` and world URI `yamlover.inthemoon.net`

The project's own name as a *namespace*.

- `tools/engine/ts/src/mounts.ts:20` — `YAMLOVER_AUTHORITY = 'yamlover.inthemoon.net'`
  (mirrored as local literals in `resolve.ts:25` and `query.ts:216`).
- `tools/engine/ts/src/walk.ts:274-340` — the `yamlover` root key grafted/de-materialized;
  `resolve.ts:180-190`, `query.ts:228-236` — `::yamlover:…` absorption.
- Every schema tag in every document: `!!<*yamlover/$defs/chapter>`, `!!<*yamlover:$defs:config>`
  (settings.ts:77, examples, builtin schemas walk.ts:212-218, engine-api tag creation:658).
- JetBrains `PointerNavigationTest.kt:28-29` hardcodes the authority.
- **Note**: this is the *brand* in data. If `yo` becomes the project name, the world URI, the
  self-import key, and every authored tag pointer are affected — the deepest rename of all.

## 10. The edit-API field name `yamlover:`

- `tools/server/src/server/engine-api.ts:4476-4480` — an edit op is
  `{ path, op, yamlover?, meta?, concrete?, name? }`; the *value payload field* is literally
  named `yamlover`. Client side: yed sync `yed-sync.ts` (the legacy `yamlover-editor/` stack
  that also spelled it is deleted); many tests pin the shape.
- Internal protocol — renamable to `yo:` (or `value:`) in one sweep.

## 11. Package, binary, product, and repo names

- npm: `tools/server/package.json` — package **`yamlover`**, bin **`yamlover`**
  (`npx yamlover <root>`), keywords; scoped packages `@yamlover/engine`, `@yamlover/parser`,
  `@yamlover/yed`, `@yamlover/demo`; root `yamlover-workspace` (scripts run
  `tools/server/bin/yamlover.js`).
- Desktop: `tools/desktop/package.json` — `yamlover-desktop`, appId `dev.yamlover.desktop`,
  productName `yamlover`; `main.js` looks for `bin/yamlover.js`.
- Demo: bin `yamlover-demo`, Docker image `dimskraft/yamlover-demo`, env `YAMLOVER_BIN`,
  email from `noreply@yamlover.inthemoon.net` (`tools/demo/src/config.js`).
- JetBrains: plugin id `net.inthemoon.yamlover`, Kotlin package, gradle group.
- GitHub: `github.com/dims12/yamlover` (package.json repo URL, demo REPO_URL, register.html).
- CI: `.github/workflows/ci.yml` references the names/paths.
- **Note**: `npx yo` collides with Yeoman's long-established `yo` npm package — the CLI/bin
  rename needs its own decision (e.g. keep `yamlover` bin, or pick `yolo`/`yover`/scoped
  `@yo/…`).

## 12. Virtual paths & UI fixtures

- `tools/server/src/client/browser-settings.ts:25` — `BROWSER_SETTINGS_PATH =
  ":.browser:settings.yamlover"` (a *virtual* file name chosen to look native).
- `App.tsx:122` — the gear button opens `:.yamlover:settings.yamlover`.
- Renderer/module names: `server/yamlover.ts`
  (legacy), parser file names `yamlover.ts` / `serialize-yamlover.ts`, `onenote2yamlover/`
  tool dir — cosmetic, internal (`renderers/yamlover-editor/` is deleted).

## 13. Docs, state diagrams, and this repo's own data

- `YAMLOVER.md` (the spec, and its own name), `YAMLOVER_EDITOR.yamlover` +
  `QUERY_EDITOR.yamlover` (state diagrams — repo law: keep in sync with machine changes),
  `CONCRETES.md`, `CHAPTER.md`, `ANNOTATIONS.md`, `EDITOR.md`, `META.md`, `IMPORTS.md`,
  `README.md`, `tools/*/README.md`, `$defs/*` schema docs, `edit-examples/SKIPPED.md`
  (lists corpus paths by name), agent docs (`tools/server/src/server/agent-docs/CLAUDE.md`).

---

## Cross-cutting notes for the decision

- **Cheapest first step (extension only, alias mode):** add `.yo` beside `.yamlover` in
  concrete.ts §1.1, the splice gate §1.3, live.ts §1.3, and the JetBrains
  `extensions="yamlover,yo"` §1.5 — both extensions then work, nothing on disk moves, and
  new-file creation §1.4 can be flipped to emit `.yo` when you're ready.
- **Disk-format items** (§2 overlay dir, §3 overlay names, §8 reserved keys, §9 tag pointers)
  change what user trees *contain* — each needs read-both tolerance or a migration tool
  (`yamlover doctor`-style sweep) before the old spelling can be dropped.
- **Derived-state items** (§4 concrete ids, §6 formats) invalidate the index DB and the
  `ir.json` goldens — mechanical to regenerate, but noisy diffs.
- **Identity items** (§9 world URI, §11 packages/plugin id) are the brand rename, separable
  from the extension rename entirely.
