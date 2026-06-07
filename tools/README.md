# tools

Reference tooling for working with yamlover entities. The model itself is a
design spec (see the [top-level README](../README.md)); these are small,
self-contained programs that demonstrate it.

**Active:**
- [`parser/`](parser/) — hand-written parsers (`ts/`, future `rust/`) for **json5p** &
  **yamlover** → the IR (`../IR.md`); gated by JSON/JSON5 conformance corpora.
- [`engine/`](engine/) — the stateful core: pointer **resolver** now, SQLite-backed
  `node`/`edge` graph + directory walker to come (`../ENGINE.md`).
- [`server/`](server/) — browse a yamlover tree in the web browser:
  `npx yamlover <root>` serves a React SPA. Being re-backed by the engine.
- [`jetbrains-plugin/`](jetbrains-plugin/) — `.yamlover`/`.json5p` file types + highlighting.

**Deprecated (2026-06-07)** — Python predecessors, superseded by `parser/` + `engine/`;
kept for reference only, knowledge extracted to [`LEGACY.md`](LEGACY.md):
- [`walker/`](walker/) — explored a tree via `cd`/`ls` (old schema-as-storage model).
- [`collector/`](collector/) — assembled a tree into one Yamlover JSON Schema.
