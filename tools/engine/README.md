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
- **SQLite index, directory walker, FS sync, engine API** — TODO (Phase 3a/3b/3e/3f).

Imports the parser via relative path (`../../../parser/ts/src/…`); no npm install (Node ≥22
native type-stripping, `node:test`). Run: `npm test`.
