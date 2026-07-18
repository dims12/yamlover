# yamlover parsers

Parsers for the yamlover family of surface languages → the shared **IR**
(`../../IR.md`). The specs are language-agnostic and live at the repo root
(`URIs.md`, `IR.md`, `JSON5P.md`, `YAMLOVER.md`); each implementation here is written
*from* those specs.

## Layout

```
parser/
  conformance/     # shared, language-agnostic test corpora (git submodules):
    json/          #   nst/JSONTestSuite
    json5/         #   json5/json5-tests
    yaml/          #   yaml/yaml-test-suite  (data branch)
  ts/              # TypeScript implementation (current) — see ts/README.md
  rust/            # Rust implementation (planned; reimplemented from the specs)
```

- **Top level = implementation language.** A Rust parser is a separate toolchain and
  artifact, reimplemented from the specs — it shares no code with the TS one (the
  `FUTURE.md` "language-per-component" direction). So each lives in its own subdir.
- **Surface languages (json5p, yamlover) are modules *inside* each implementation**
  (e.g. `ts/src/json5p.ts`, `ts/src/yamlover.ts`), over a shared pointer parser + IR.
- **Conformance corpora are shared**, so every implementation is gated by the *same*
  fixtures. Each impl's tests reference `../conformance/…`.

Init the corpora after cloning:

```sh
git submodule update --init
```

## Status

| impl | json5p | yamlover | notes |
|------|--------|----------|-------|
| `ts/`   | ✅ done | ✅ practical subset | 199 tests green; Node ≥22 native TS, `node:test` |
| `rust/` | — | — | planned |

json5p is gated by the full JSON + JSON5 positive corpora. yamlover covers block/flow,
block scalars (`|`/`>`) + the extensions (parses both `tour` examples), and the
yaml-test-suite gate runs with the divergence allowlist (`YAML-CONFORMANCE.md`);
multi-doc (`---`) and merge keys (`<<`) are the remaining Phase 2c work.
