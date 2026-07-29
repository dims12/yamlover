# yed

`@yamlover/yed` — the yamlover projectional **editor** core: IR-backed state, a pure
apply layer, and ONE grammar table shared with the production mounts. This package is
the **reference implementation** of the editor's semantics: where a production cell
layer and yed disagree, yed is right (see [`../../EDITOR.md`](../../EDITOR.md) §9 for
the design discipline, and §2/§8 for how the server mounts it).

A raw-TS npm-workspace member like the parser — consumed by relative imports, never
built. The server's default unlocked editors (`tools/server`) are mounts over this
package: the **source** projection uses `src/` (grammar, cells), the **chapter**
projection uses `src/chapter/` (the chapter machine + cells).

## Layout

```
src/                   the source-editor machine
  state.ts               the document is ALWAYS valid parser IR; incompleteness lives in the cursor
  apply.ts               pure intents (applyKey) + copy/paste + the watchdog
  grammar/               dispatch.ts + keys.ts — THE grammar table (production imports it)
  dialect.ts             language policy (yamlover default; json/json5 prepared)
  cells.tsx              framed recursive cells + the CellRegistry (format before kind)
  legend.tsx             the dry-run keyboard legend
  page.tsx / diff.ts     the debug page + line diff
src/chapter/           the chapter machine + cells (site/dispatch/apply/format/positions/watchdog)
test/                  the conformance gate (typing, corpus, substitute, clipboard, cells,
                       dom-typing, dialect, yed-dispatch, chapter-*)
debug-editor/          standalone debug page — npm run debug-editor (Vite, port 5199)
debug-chapter/         standalone chapter debug page — npm run debug-chapter (port 5198)
```

## Tests

```console
$ npm test          # vitest, from this directory (or npm --prefix tools/yed test)
```

This suite is separate from the root `npm test` (parser + engine) and from the server
suite (`tools/server`). The state diagram `YAMLOVER_EDITOR.yamlover` (repo root) is the
grammar's human-readable mirror — keep it, `yed-dispatch.test.ts`, and the code in sync.
