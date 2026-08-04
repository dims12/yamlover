# EDITOR - moved

The projectional editor's architecture doc now lives in the documentation book:

**[`docs/server/editor/`](docs/server/editor/)**

The state machines (formerly `YAMLOVER_EDITOR.yo` / `QUERY_EDITOR.yo` at the repo root) are now
marklower chapters - one subchapter per state:

- **[`docs/server/yamlover-editor/`](docs/server/yamlover-editor/)** - the source projection's
  typing grammar (sync mirror: `tools/yed/src/grammar/dispatch.ts`, `yed-dispatch.test.ts`).
- **[`docs/server/chapter-editor/`](docs/server/chapter-editor/)** - the chapter projection
  (sync mirror: `tools/yed/src/chapter/dispatch.ts`, `chapter-dispatch.test.ts`).
- **[`docs/server/query-editor/`](docs/server/query-editor/)** - the breadcrumb / pick machine
  (sync mirror: `tools/server/src/client/breadcrumb-machine.ts`, `breadcrumb-machine.test.ts`).

See [`DOCSMIGRATION.md`](DOCSMIGRATION.md).
