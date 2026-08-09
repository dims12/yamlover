# LSP — the language server as the one yamlover protocol

> **Status (2026-08-08).** Nothing built. This is the design for replacing the
> implicit HTTP API in `tools/server/src/server/engine-api.ts` (4885 lines) with a
> **Language Server Protocol** server that every host speaks: VS Code, JetBrains,
> the existing React client, and the desktop shell. It is the concrete answer to
> `FUTURE.md`'s standing rule — *"spec the protocol before porting anything"* — and
> to `ENGINE.md`'s *"spec the engine API first"*: LSP **is** that versioned
> contract, already written, with mature client libraries in TypeScript, Kotlin,
> Rust, Python and Go.

Forward-looking design, not a commitment (companion to [`FUTURE.md`](FUTURE.md),
[`ENGINE.md`](ENGINE.md) and [`IR.md`](IR.md)). Where `ENGINE.md` describes the
stateful core, this document describes the **wire** in front of it and what
happens to `tools/server` once that wire exists.

## The claim

We have been writing a bespoke protocol by accident. `tools/server/ENDPOINTS.md`
documents ~30 routes plus an SSE channel; `tools/jetbrains-plugin` reimplements
the highlighter and pointer navigation in Kotlin because it cannot reach them; a
VS Code extension would be a third reimplementation. LSP collapses all three into
one server and turns the reimplementations into thin clients.

The trade is explicit: **roughly half of our surface is standard LSP and half is
custom `yamlover/*` methods.** That is normal — rust-analyzer, Metals and
sourcekit-lsp all carry large custom namespaces — but it must be argued rather
than assumed, so the gaps get their own section below.

What we get that a hand-rolled protocol does not give:

- **Free editor UI** for the text half. Diagnostics, go-to-definition,
  find-references, rename, completion, hover, semantic tokens and folding all have
  finished UI in every editor. This is the entire content of the JetBrains plugin
  today and most of the VS Code extension we would otherwise write.
- **A negotiated, versioned contract.** `initialize` capability exchange is exactly
  the versioning story `FUTURE.md` asked for, without inventing one.
- **One transport for three hosts.** stdio for editors, WebSocket for the browser
  client — the same JSON-RPC message set on both.
- **Language-swappable server.** If the Kotlin/Rust question in `FUTURE.md` ever
  resolves away from TypeScript, the clients do not change.

## Shape

One process, three doors:

```text
                    ┌──────────────────────────────────────┐
  VS Code ──stdio──▶│                                      │
  JetBrains ─stdio─▶│   yamlover-lsp  (tools/lsp)          │
  Web client ─WS───▶│   JSON-RPC: standard LSP + yamlover/*│
                    │                                      │
  <img>, pdf.js ──▶ │   byte listener: /blob /thumb /convert│
  SPA assets ─────▶ │   static: dist/client                 │
                    └───────────────┬──────────────────────┘
                                    │ in-process
                    ┌───────────────▼──────────────────────┐
                    │ tools/engine  (Store, walk, watch,   │
                    │ resolve, query, mv, rewrite)         │
                    │ tools/parser  (IR, spans, highlight) │
                    └──────────────────────────────────────┘
```

**Decision — keep a byte channel.** JSON-RPC cannot stream binary, and base64 in a
JSON envelope is the wrong answer for a 40 MB PSD or a PDF that `pdf.js` wants to
range-request. The renderers already consume `/api/blob` and `/api/thumb` as *URL
strings* fed to `<img src>`, `<iframe>` and `pdf.js` — they are URL-shaped by
nature. So the process keeps a minimal HTTP listener for bytes and static assets,
and everything structured moves to JSON-RPC. "Replace the TypeScript server" means
**replace the API**, not abolish HTTP.

## What is standard LSP

Half the surface needs no invention. This is also the half that retires hand-written
plugin code.

| Capability | LSP method | Replaces |
|---|---|---|
| Parse errors, dangling refs, doctor findings | `textDocument/publishDiagnostics` | `/api/doctor`, `/api/dangling` (push half) |
| Pointer navigation | `textDocument/definition`, `declaration` | `PointerNavigation.kt` (539 lines) |
| Inbound references to a node | `textDocument/references` | not built today |
| Rename a key | `textDocument/rename` → `WorkspaceEdit` | `/api/rekey`, `/api/mv` |
| Syntax colouring | `textDocument/semanticTokens/full` + `/delta` | `HlLexerBase.kt` (357), `client/highlight.tsx` |
| Key / pointer / tag completion | `textDocument/completion` | not built today |
| Resolved target, `(type, format)` | `textDocument/hover` | not built today |
| In-document outline | `textDocument/documentSymbol` | part of `/api/tree` |
| Query results as symbols | `workspace/symbol` | part of `/api/query` |
| Round-trip through the serializer | `textDocument/formatting` | not exposed today |
| Mapping / block folding | `textDocument/foldingRange` | not built today |
| Fix dangling, explode node to directory | `textDocument/codeAction` | not built today |
| Indexing / hashing / thumbnail progress | `$/progress` + `window/workDoneProgress/create` | `/api/tasks`, `{type:task}` SSE |
| External file changes | `workspace/didChangeWatchedFiles` + `watch.ts` | watcher half of `/api/events` |
| Root name, read-only posture | `initialize` result | `/api/info` |
| Editor-side preferences | `workspace/didChangeConfiguration` | part of `/api/config` |

**`WorkspaceEdit` is stronger than it looks.** With
`workspace.workspaceEdit.resourceOperations` advertised, one edit may carry text
splices *and* `CreateFile` / `RenameFile` / `DeleteFile` together. That is exactly
the shape of a yamlover move: rename the file, rewrite inbound pointer spans in
other files, in one atomic client-applied transaction. `mv.ts` + `rewrite.ts`
already compute precisely this; they currently have nowhere good to send it.

## The gaps, and what fills them

These are the places where LSP has no opinion or the wrong one. Each is listed with
the resolution we intend, because "there can be gaps" is not a plan by itself.

### Gap 1 — a node is not a document

LSP addresses everything as `(textDocument.uri, position)`. A yamlover node may be
a file, a *subtree inside* a file, a directory, or a directory plus its `.yo/`
overlay. Only the first is a text document.

**Resolution — a URI convention, not a new concept.**

| Node kind | URI | Range |
|---|---|---|
| Whole file | `file:///abs/path.yo` | full span |
| Node inside a file | `file:///abs/path.yo` + fragment `#:key:0` | `EntryMeta.span` |
| Directory | `file:///abs/dir` | — |
| Directory with overlay | `file:///abs/dir` | anchor into `.yo/body.yo` at `0:0` |

Colon paths stay the identity in `yamlover/*` params (matching `ENGINE.md`'s
"identity is the path"); `file:` URIs plus ranges are used only where LSP demands a
`Location`. A directory target resolves to its `.yo/body.yo` at position zero when
one exists, and otherwise to the bare directory URI — which VS Code will reveal in
the explorer rather than open. That is a UX decision, not a protocol violation.

Contrast worth keeping in mind: rust-analyzer's modules are also file-or-directory
(`foo.rs` vs `foo/mod.rs`), and Go and Java packages *are* directories. Directory
as semantic unit is mainstream. What is genuinely unusual here is that a directory
**carries a value** and can be a *definition target*, which is why the anchor rule
above has to exist at all.

### Gap 2 — byte offsets vs UTF-16 positions

`IR.md` fixes spans as `{ uri, start, end }` in **byte offsets**. LSP `Position` is
`{ line, character }`, where `character` counts UTF-16 code units by default
(`positionEncoding` in 3.17 negotiates `utf-8`/`utf-32`, but never raw offsets).

**Resolution.** A per-document line index maintained alongside the text overlay,
converting `Span ↔ Range` in both directions. Negotiate `utf-8` when the client
offers it to make the conversion a pure line lookup; fall back to UTF-16 scanning
otherwise. This is a small module (~150 lines) but it is on *every* hot path —
diagnostics, tokens, definitions, edits — so it lands in Phase 1 with its own
property tests over astral-plane and CRLF fixtures.

### Gap 3 — the parser is fail-fast

`parseYamlover` throws `SyntaxError` at the first problem and returns no partial
AST. A language server is asked for tokens, symbols and completions against
*half-typed* text, continuously.

**Resolution, in two layers.**

1. **Tokens never depend on the parser.** `tools/parser/ts/src/highlight.ts` is
   already documented as the lexer that "never fails and tokenizes any text,
   half-typed source included". Semantic tokens come from it. This is the reason it
   exists and it is already ported to Kotlin, which validates the shape.
2. **Structure falls back to last-good IR.** Keep the most recent successfully
   parsed `Document` per open buffer. While the buffer does not parse, publish the
   one syntax diagnostic and answer structural requests from the stale IR, marked
   as such. Real error recovery in the parser is desirable and out of scope here;
   this plan must not block on it.

### Gap 4 — no whole-tree, lazily-deepened TOC

`textDocument/documentSymbol` is per-document and eager; `workspace/symbol` is a
flat filtered list. Our TOC is a lazily expanded tree spanning thousands of files,
with `(type, format)`, concrete, and child-presence flags per row.

**Resolution.** Custom `yamlover/toc` taking `{ path, depth }` and returning the
existing `TreeNode` shape. `documentSymbol` is still implemented for the in-file
outline, because editors give it a free UI.

### Gap 5 — no server-pushed "the index changed"

LSP pushes diagnostics and progress; there is no notification for *the workspace
graph moved under you*. Our SSE `{type: diff}` frame drives every client refresh
(`ENGINE.md`: "one signal, no ad-hoc refresh paths").

**Resolution.** Custom notification `yamlover/didChangeIndex` carrying the existing
`IndexDiff` (`{added, changed, removed, moved}`). Same payload, same single-signal
discipline, different envelope. Progress keeps using standard `$/progress`.

### Gap 6 — projectional editing has no LSP analogue

LSP assumes a text editor sending `didChange` deltas. yed is a *projectional*
editor: a keystroke is an intent applied to IR, and incompleteness lives in the
cursor, not the document.

**Resolution — yed stays a client.** Its core (`state.ts`, `apply.ts`,
`grammar/`) is already pure, DOM-free TypeScript; it runs in the browser today and
would run in a VS Code webview unchanged. It computes new source and persists
through the ordinary edit path. Pushing keystroke semantics across JSON-RPC would
add a round-trip per keypress and buy nothing. **Do not move yed server-side.**

### Gap 7 — renderers are UI, not protocol

The 11 218 lines under `src/client/renderers/` are views (chapter, table, board,
map, PDF, e-book, explorer grids). LSP has nothing to say about them and should
not.

**Resolution.** They stay client code. The web client keeps them as-is. A VS Code
custom editor would host the same React bundle in a webview; a JetBrains tool
window would either embed a JCEF view or do without. This is the one area where
"one server, three clients" does not mean "one UI" — and where the honest estimate
is that VS Code gets text editing first and rich views much later, if ever.

### Gap 8 — mode and posture flags

No LSP concept covers `--read-only`, `--no-gitignore`, or the mount/import
configuration from `settings.yo`.

**Resolution.** Report them as a custom block in the `initialize` result's
`capabilities.experimental.yamlover`, and re-report on change via
`yamlover/didChangeIndex`. `settings.yo` is *project data*, not editor
configuration, so it is read through `yamlover/config` rather than
`workspace/configuration`.

## Custom method catalogue

Namespace `yamlover/*`, one method per surviving endpoint. Params take colon paths.

| Method | Kind | Replaces |
|---|---|---|
| `yamlover/toc` | request | `GET /api/tree` |
| `yamlover/content` | request | `GET /api/content` |
| `yamlover/schema` | request | `GET /api/schema` |
| `yamlover/source` | request | `GET /api/source` |
| `yamlover/query` | request | `GET /api/query` (all three shapes) |
| `yamlover/annotations` | request | `GET /api/annotations` |
| `yamlover/tagged` | request | `GET /api/tagged` |
| `yamlover/dangling` | request | `GET /api/dangling` |
| `yamlover/config` | request | `GET /api/config` |
| `yamlover/preview` | request | `POST /api/preview` (stateless) |
| `yamlover/editText` | request | `POST /api/edit-text` (stateless) |
| `yamlover/didChangeIndex` | notification | `{type:diff}` SSE frame |

Mutations go through `workspace/executeCommand`, so an editor can bind them to
menus and the server can answer with a `WorkspaceEdit` the client applies:

| Command | Replaces |
|---|---|
| `yamlover.edit` | `POST /api/edit` |
| `yamlover.paste` | `POST /api/paste` |
| `yamlover.mv` / `yamlover.rekey` | `POST /api/mv`, `/api/rekey` (also via `textDocument/rename`) |
| `yamlover.annotate` / `yamlover.unannotate` | `POST`/`DELETE /api/annotate` |
| `yamlover.fragment`, `yamlover.tag`, `yamlover.board` | `POST /api/fragment`, `/api/tag`, `/api/board` |
| `yamlover.reindex`, `yamlover.agentDocs` | `POST /api/reindex`, `/api/agent-docs` |

Surviving HTTP, bytes only: `/blob`, `/thumb`, the future `/convert` from
`FUTURE.md`, and the SPA static mount.

## The engine change this forces

One real piece of engine work, and it is not about directories.

`Store` answers from SQLite and `walk.ts` reads the filesystem
(`reindexPathAsync` takes a path it will `readFile`). A language server must answer
from the **editor's unsaved buffer**, which is not on disk. Today's single-writer
queue plus `selfWrites` TTL assumes the server itself is the only mutator between
disk states.

**Resolution — a VFS overlay in front of the filesystem**, the same structure
rust-analyzer and gopls use: open documents shadow their on-disk contents, and the
walker reads through the overlay rather than calling `node:fs` directly. Concretely
this means threading a `readFile` seam through `walk.ts` and `settings.ts`, and
letting `reindexPathAsync` splice from an in-memory string. `patchSubtree`'s
external-edge guard already gives us the correctness check for a spliced subtree,
so the invalidation logic is in place; only the source of bytes changes.

Two consequences worth stating: dirty buffers must **not** reach `store.patchSubtree`
persistently (the index describes disk), so overlay-derived IR lives in the cached
`Document` only; and the web client, which has no notion of unsaved buffers, is
unaffected because it always saves through the edit path.

This is worth doing regardless of LSP — it is also what would let the web editor
answer instantly instead of round-tripping every keystroke to disk.

## Phases

Each phase ends at something usable, in `tools/lsp/` as a new workspace member.

**Phase 0 — the contract.** Write the method/params/capability spec before code, per
`FUTURE.md`. Deliverable: this document plus a `tools/lsp/PROTOCOL.md` with TypeScript
interfaces for every `yamlover/*` payload. Reuse the existing `TreeNode`,
`IndexDiff`, `Annotation`, `EditInput` types verbatim — they are the de-facto
protocol already.

**Phase 1 — skeleton and the text half.** `vscode-languageserver` over stdio;
document sync; the span↔position module; the VFS overlay in the engine; semantic
tokens from `highlight.ts`; diagnostics from the parser and `validate.ts`.
Deliverable: a VS Code extension with highlighting and live errors that already
exceeds the JetBrains plugin.

**Phase 2 — navigation.** `definition`, `references`, `hover`, `documentSymbol`,
`foldingRange`, `completion` over keys, pointer segments and tags — all backed by
`resolve.ts` and the `edge` table, so `::` and `:::` cross-tree resolution works,
which the heuristic Kotlin navigator cannot do.

**Phase 3 — the custom read namespace.** `toc`, `content`, `query`, `schema`,
`annotations`, `dangling`, `config`, plus `didChangeIndex` and `$/progress`. At the
end of this phase the LSP server can feed a read-only web client.

**Phase 4 — the write path.** Commands, `rename`, `codeAction`, `WorkspaceEdit`
with resource operations. The writer queue moves behind LSP unchanged; read-only
policy becomes a capability plus per-command refusal.

**Phase 5 — cut over the web client.** The narrow part: live `/api/` call sites in
`src/client/` are `api.ts` (477 lines), `content.ts`, and the `EventSource` in
`App.tsx`/`live.ts` — under ~600 lines total; every other mention is a comment.
Retarget them to JSON-RPC over WebSocket, keep `blobUrl`/`thumbUrl` as HTTP URL
builders. Then delete the route layer of `engine-api.ts`. Note that a large part of
that 4885-line file is *not* routing — envelope building, embedding, concrete
rules, paste routing — and that logic **moves rather than dies**.

**Phase 6 — JetBrains.** Adopt the server via **LSP4IJ**, not the platform's own
LSP API, which is Ultimate-only while the plugin targets IDEA Community 2023.2.
Delete `HlLexerBase.kt` and `PointerNavigation.kt` (~900 lines of hand-ported
heuristics) in favour of server-computed tokens and definitions. Keep the file
types, icons and Markdown fence injection.

## Risks and open questions

- **Is this a reskin?** If most calls end up custom, we have renamed REST to
  JSON-RPC. The defence is Phases 1–2: the standard half is real, is where all the
  free editor UI lives, and is the part we are currently paying for three times.
  If Phase 2 does not visibly beat the JetBrains plugin, stop and reconsider.
- **Position conversion on every hot path.** Byte spans are baked into `IR.md` and
  `rewrite.ts`. Changing them is not on the table, so the conversion layer must be
  fast and correct; benchmark it in Phase 1 rather than discovering it in Phase 5.
- **TOC scale.** `yamlover/toc` over a large tree with a JSON-RPC framing has
  different cost characteristics than HTTP with browser caching. Measure before
  the web-client cutover.
- **Parser recovery.** The last-good-IR fallback is a workaround. If completion
  quality inside a broken buffer matters, real recovery becomes a parser project of
  its own.
- **Rich views in VS Code.** Deliberately deferred. Text-first is the honest
  scope; webview-hosted renderers are a separate decision.
- **Language.** Nothing here changes `FUTURE.md`'s open Kotlin-vs-TypeScript
  question — it *defuses* it. Once the contract is LSP, the server can be rewritten
  in another language without touching a client, which is precisely the outcome
  `FUTURE.md` wanted from spec-first.
