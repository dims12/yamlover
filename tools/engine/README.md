# yamlover engine

The stateful core that turns parsed documents (the IR from `tools/parser/`) into a
queryable graph: pointer resolution, derivation/normalize, a SQLite-backed node/edge index,
and FS sync. Design: `../../ENGINE.md`.

## Layout

Per implementation language (like `tools/parser/`):

```
engine/
  ts/      # TypeScript implementation (current)
  rust/    # planned (reimplemented from the specs)
```

## Status (`ts/`)

- **resolver** (`ts/src/resolve.ts`) — done. Resolves IR `Pointer`s over the containment
  graph: scopes (current / `..` / `/` document / `//` link), transitive `*`-following,
  cycle-safe, anchor precedence. `resolveDocument()` resolves every `*`/`~` in a document.
- **graph + derive + normalize** (`ts/src/graph.ts`) — done. `buildGraph()` → a flat edge
  list (containment + resolved ref/back, with external/unresolved split out);
  `deriveInverses()` adds on-demand reverse edges (incoming queries); `normalize()` →
  forwards-only (folds each `~` back-edge into the forward `ref` it reverses, deduped).
- **SQLite index** (`ts/src/store.ts`) — done. Node/edge property graph on built-in
  `node:sqlite`, plus a `file` manifest (path + hash + size + mtime) and a `dangling` table.
- **directory walker** (`ts/src/walk.ts`) — done. Directory concrete → IR → store, with
  **stat-first indexing**: files identified by `(size, mtime)`, content hashes (size-tiered
  xxh64) filled in by a background task.
- **FS sync** (`ts/src/watch.ts` + reconcile) — done. All three tiers: live watcher,
  offline reconcile at startup, move inference with auto-relink. **Mediated `mv`**
  (`ts/src/mv.ts`/`rewrite.ts`) moves a file/dir and surgically rewrites inbound refs.
- **query evaluator** (`ts/src/query.ts`) — done. The 3g colon-grammar match templates
  over the store, gated by the 77-case corpus (`query.cases.ts`).
- **settings** (`ts/src/settings.ts`) — done. Loads/materializes `.yamlover/settings.yamlover`.
- **engine API protocol** (versioned, per `../../ENGINE.md`) — TODO. Today the server
  (`tools/server`) consumes the engine directly: relative-path imports in dev, an esbuild
  bundle (`dist/server.js`) in the published package.

Imports the parser via relative path (`../../../parser/ts/src/…`); no npm install (Node ≥22
native type-stripping, `node:test`). Run: `npm test`.
