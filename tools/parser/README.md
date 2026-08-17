# yamlover parsers

Parsers for the yamlover family of surface languages → the shared **IR**
(`../../IR.md`). The specs are language-agnostic and live at the repo root
(`docs/language/pointers`, `IR.md`, `JSON5P.md`, `docs/language`); each implementation here is written
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
| `ts/`   | ✅ done | ✅ practical subset | full `node:test` suite green; Node ≥22 native TS |
| `rust/` | — | 🚧 writer half | IR + the escaping/scalar laws, gated against `ts/` by `tests/ts_parity.rs`; serializer next, reader after |

`rust/` is deliberately building the **writer** first (IR → serializer → materializer): it is
what an importer needs, it is the third of the surface that can be gated byte-for-byte against
the existing `out.yo` goldens, and it defers the reader until there is something to read back.
Its `tests/ts_parity.rs` runs both implementations over one committed corpus — the
cross-implementation harness `../jetbrains-plugin/README.md` has wanted for its Kotlin lexer.
It found a signed-hex round-trip bug in `ts/` on its first run.

json5p is gated by the full JSON + JSON5 positive corpora. yamlover covers block/flow,
block scalars (`|`/`>`) + the extensions (parses both `tour` examples), and the
yaml-test-suite gate runs with the divergence allowlist (`YAML-CONFORMANCE.md`);
multi-doc (`---`) and merge keys (`<<`) are the remaining Phase 2c work.
