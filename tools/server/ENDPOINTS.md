# ENDPOINTS — the yamlover server's HTTP API

The complete route table of the live server (`src/server/engine-api.ts`, mounted by
`bin/yamlover.js`; the older `src/server/api.ts` is a reduced legacy handler set kept for
embedding). Everything a renderer or editor does goes through these — clients never touch
storage. All paths are **colon paths** (`:a:b:0` — keys and absolute entry indexes in one
address space; a positional segment may alias a keyed member). Errors are
`{ error: string }` with a 4xx/5xx status.

> The representation note (2026-08-04): the ONE WIRE landed. `/api/json` is RETIRED — clients
> fetch `/api/content` (a yamlover envelope), parse in-browser with the shared `tools/parser`,
> and derive the legacy NodeJson shape locally (`src/client/derive-node.ts`, pinned by the
> derivation goldens). Bytes ride `/api/blob`, never the text wire.

## Reading

| Endpoint | Method | Params | Returns |
|---|---|---|---|
| `/api/info` | GET | — | `{ root, readOnly }` — the served root's display name (its title, else the folder name) and the server's read-only posture |
| `/api/tree` | GET | `path`, `depth` (default 3) | The TOC subtree: `TreeNode` rows (label, type, format, concrete, `hasChildren`), children to `depth` |
| `/api/schema` | GET | `path`, `depth` | The node's derived instance schema |
| `/api/content/{slash-path}` | GET | `depth` (document boundaries; default per concrete: dir=1, text=∞) | **THE YAMLOVER WIRE** (`text/yamlover`): a yamlover envelope — header keys, `source` (the merged-IR subtree serialized with comments; cut members respelled as their authored pointers `- *: name` / `name: *: name`; blobs always cut), `side` (fragment-keyed sidecar: `anchorKey`/`member` provenance, derived formats, resolved ref targets, cut-member `$yamloverLink` stubs), `relations`. The path rides IN the URL, slash-spelled (`/part-one/2`, digits = positions, `~` = null key) |
| `/api/source` | GET | `path` | `{ source }` — the yamlover TEXT: the raw body file at a document root; a deeper node re-serializes its parsed subtree |
| `/api/blob` | GET | `path` | The file-backed node's raw bytes, streamed with its content type |
| `/api/thumb` | GET | `path`, `w`, `h` | A lazily generated JPEG thumbnail (content-addressed sidecar cache); `415` when no server decoder exists |
| `/api/query` | GET | `q`, `path` (evaluation root), `shape` (`paths` \| `tree` \| `filter`) | The colon-grammar query evaluator: matching paths; `tree` = TreeNode rows (dropdown candidates); `filter` = one pruned TOC of matches + ancestors, capped |
| `/api/dangling` | GET | — | Pointers that did not resolve at index time (`{ from, raw, reason }[]`) |
| `/api/annotations` | GET | `path` | Annotations whose `target` is this node (the reverse link) |
| `/api/tagged` | GET | `path` | Materials filed under this tag (annotations resolved to targets, deduped) |
| `/api/config` | GET | — | `{ source, settings, path }` — the project config (`<root>/.yo/settings.yo`), raw + parsed |
| `/api/doctor` | GET | — | The layout-rule sweep over the whole tree (a filesystem walk — finds what the index cannot see) |
| `/api/tasks` | GET | — | Long-running server tasks in flight (indexing, hashing); updates ride `/api/events` |
| `/api/events` | GET (SSE) | — | The server-push stream: reindex diffs as they land, keep-alive pings |

## Writing

All writes are serialized through one queue; each reindexes what it touched and broadcasts
the diff over `/api/events`.

| Endpoint | Method | Body | Does |
|---|---|---|---|
| `/api/edit` | POST | one edit `{ path, op, yamlover?, meta?, concrete?, name?, at? }` or `{ edits: […] }` | THE SURGICAL EDITOR. Ops: `emplace` (replace only the facets the payload carries), `replace` (drop all four facets, assign), `insert` (at the position `path` names), `remove` (TRASH ON DELETE: never destroys — a member document detaches from its parent AND its storage archives into the parent's `.yo/.trash/`, collision-suffixed, post-commit; an already-orphaned member archives the same way). `yamlover` is inline SOURCE, parsed to validate then spliced verbatim — comments and spellings elsewhere survive. Returns `{ ok, path? }` (where a creator should navigate) |
| `/api/rekey` | POST | `{ path, key }` | Rename a key — ONE verb, storage-routed (THE CONCRETE IS NOT A STATE): an fs-backed member renames on disk with inbound pointers rewritten; an inline entry has its key token rewritten in place |
| `/api/mv` | POST | `{ from, to }` (keyed segments only) | Move/rename a file or directory; rewrites every inbound `*`/`~` pointer (surgical span edits) |
| `/api/paste` | POST | `{ path, filename, contentBase64 }` \| `{ path, text }` \| `{ path, rich }` | Upload: a file lands in the directory (a chapter also gains a `*` pointer chunk); text appends as a chunk; rich HTML becomes chunks + subchapters |
| `/api/annotate` | POST / DELETE | POST `{ target, tag, description?, params? }`; DELETE `?target&tag` | Apply / remove a tag application in the target's `yamlover-annotations` |
| `/api/fragment` | POST | `{ target, selector, imageBase64? }` | Mark a fragment (a region) under the target's `yamlover-fragments`, optional crop sidecar; returns `{ slug, fragmentPath }` |
| `/api/tag` | POST | `{ name }` | Create a named tag in the taxonomy location (`settings.tags`); idempotent |
| `/api/board` | POST | `{ path, lanes: string[][] }` | Persist a board's lane configuration (tag pointers in the directory overlay) |
| `/api/reindex` | POST | — | Manual reconcile (the watcher's fallback); responds with the diff |
| `/api/agent-docs` | POST | — | Install/refresh the bundled AGENTS.md + CLAUDE.md guidance into the served root (marker-fenced; human text never clobbered) |

## Stateless (no served tree touched)

| Endpoint | Method | Body | Does |
|---|---|---|---|
| `/api/preview` | POST | `{ source }` | Render a standalone yamlover text as a CONTENT ENVELOPE (`text/yamlover`), exactly as `/api/content` serves a node (parse → throwaway index → envelope) — the browser-settings document's renderer |
| `/api/edit-text` | POST | `{ source, edits }` | The `/api/edit` ops applied to a standalone text; returns the new `{ source }` — the caller persists it |

## Read-only mode (`--read-only` / `YAMLOVER_READ_ONLY`)

The rule is an **allowlist** (`src/server/read-only-policy.ts`), checked before any route:
GET/HEAD always answer; of the non-GET routes only `/api/preview`, `/api/edit-text`
(stateless) and `/api/reindex` (index housekeeping) pass. Everything else — every route in
the *Writing* table above, and any future one — answers **403**
`{ error: "server is read-only", readOnly: true }`. Two write paths hide behind reads and are
degraded rather than blocked: `/api/thumb` serves only pre-existing sidecars (a cache miss
answers `415`, the client's glyph fallback) and a reconcile (`/api/reindex`, the FS watcher)
indexes an externally inferred move **without** relinking — source files are never rewritten.
The server still maintains `<root>/.yo/index.db`; `settings.yo` is not materialized.
