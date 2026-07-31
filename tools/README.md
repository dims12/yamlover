# tools

Reference tooling for working with yamlover entities. The model itself is a
design spec (see the [top-level README](../README.md)); these are small,
self-contained programs that demonstrate it.

**Active:**
- [`parser/`](parser/) — hand-written parsers (`ts/`, future `rust/`) for **json5p** &
  **yamlover** → the IR (`../IR.md`); gated by JSON/JSON5 conformance corpora.
- [`engine/`](engine/) — the stateful core: pointer **resolver**, SQLite-backed
  `node`/`edge` graph, directory walker, FS watcher with three-tier sync,
  mediated `mv`, and the query evaluator (`../ENGINE.md`).
- [`yed/`](yed/) — `@yamlover/yed`, the projectional **editor** core (the typing
  grammar, cells, the chapter machine) the server's unlocked views mount; a raw-TS
  workspace member like the parser, no build (`../EDITOR.md` §9).
- [`server/`](server/) — browse **and edit** a yamlover tree in the web browser:
  `npx yamlover <root>` serves a React SPA over an engine-backed JSON API.
- [`desktop/`](desktop/) — Electron wrapper: runs the local server (127.0.0.1, prod
  build) and opens a native window.
- [`demo/`](demo/) — multi-tenant demo host: hands each visitor a private, disposable
  yamlover instance behind one host, reaped after a TTL (powers `yamlover.inthemoon.net`).
- [`jetbrains-plugin/`](jetbrains-plugin/) — `.yo`/`.json5p` file types + highlighting.

**Importers:**
- [`onenote2yamlover/`](onenote2yamlover/) — imports Microsoft OneNote notebooks into a
  yamlover tree of chapters + marklower prose (C#/.NET WPF app + `.Core` library; a legacy
  PowerShell prototype it was ported from also ships). See its
  [`README`](onenote2yamlover/README.md).

**Deprecated (2026-06-07)** — Python predecessors, superseded by `parser/` + `engine/`;
kept for reference only, knowledge extracted to [`LEGACY.md`](LEGACY.md):
- [`walker/`](walker/) — explored a tree via `cd`/`ls` (old schema-as-storage model).
- [`collector/`](collector/) — assembled a tree into one Yamlover JSON Schema.
