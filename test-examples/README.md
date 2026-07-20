# test-examples — the yamlover fixture corpus

Every fixture pins three things at once: **what a source parses to** (its canonical IR),
**what the serializer emits for it** (a byte-exact golden), and **that the round-trip is
lossless** (the golden reparses to the same graph). One data-driven harness runs the whole
corpus: `tools/engine/ts/test/fixtures.test.ts` (in the engine so directory concretes can
use `walkDir`). Goldens are produced by `npm run gen:fixtures` and committed after review —
the harness never regenerates.

## Fixture ids

A fixture is a directory whose name matches `^\d{4}(-\d{2})?$` — `0000`, `0001`, …, with
`NNNN-MM` reserved for humans inserting between existing ids: `0003 < 0003-01 < 0003-02 <
0004` in plain lexicographic order. Group ranges (gaps inside are deliberate insertion room):

| range | theme |
|---|---|
| 00xx | scalars & basics |
| 01xx | containers & keyless entries |
| 02xx | pointers (scope ladder, steps, escaping) |
| 03xx | anchors & back-edges |
| 04xx | omni (self-value + fields) |
| 05xx | tags & schema (`!!set`, `!!<…>`) |
| 06xx | comments & block scalars |
| 07xx | file concretes (json / json5 / json5p / yaml ↔ yamlover) |
| 08xx | directory concretes (`input/` trees, `.yamlover/` overlays) |
| 09xx | mirrors of the human `examples/` corpus (via `from`) |
| 10xx | curated conformance cases (provenance in `===`) |
| 11xx | erroneous inputs |

## Files inside a fixture

| file | meaning |
|---|---|
| `===` | REQUIRED. One-line human title (the yaml-test-suite convention). For conformance-derived fixtures, name the provenance, e.g. `yaml-test-suite 229Q: …`. |
| `in.yamlover` | input parsed with `parseYamlover(src, uri)` |
| `in.yaml` | input parsed with `parseYamlover(src, uri, { yaml: true })` (YAML-concrete semantics) |
| `in.json` / `in.json5` / `in.json5p` | input parsed with `parseJson5p(src, uri)` |
| `input/` | a directory subtree (may contain a `.yamlover/` overlay) materialized with the engine's `walkDir(abs, { noGraft: true })` |
| `from` | one repo-relative path (e.g. `examples/06-tour.yamlover`) resolved against the repo root, then treated by the rules above — big human examples are referenced, not copied; the goldens still live here |
| `ir.json` | the canonical IR: `canonJson(parse(input))` — graph identity only (kind, values, entry order, edge kinds, pointer base/steps, anchors, `!!set`, schema, blob format/hash/size). No spans, no `raw`, no comments. |
| `out.yamlover` | golden `serializeYamlover(doc)` output, asserted **byte-for-byte**; the harness also reparses it and asserts IR-equality with the input's parse |
| `error` | for erroneous fixtures, **instead of** `ir.json`/`out.yamlover`: one line, a JS regex matched against the thrown error's message |
| `lossy` | optional marker: the input's materialized graph is not fully expressible as a yamlover file — e.g. a directory ordered by a body pointer-array keeps `array: true` on keyed entries (`walk.ts applyBody`), a projection a reparse cannot reproduce. The golden still pins the serializer byte-for-byte; only the reparse-IR-equality assertion is skipped. Content: one line saying why. |
| `out.json5p` | optional: golden `serializeJson5p(doc)` (also reparsed + IR-compared) |
| `error.json5p` | optional: one-line regex — asserts `serializeJson5p(doc)` throws a `LossyError` matching it (how a yamlover-only feature's json5p refusal is pinned) |

Exactly **one** input (`in.*`, `input/`, or `from`) per fixture — the harness fails on zero
or more than one.

### Blob-carrying fixtures

`serializeYamlover` refuses blobs (`LossyError` — a blob has no yamlover text form), so a
fixture whose IR contains a blob **omits** `out.yamlover`; the harness verifies the omission
is legitimate (the `ir.json` really contains a `"kind": "blob"` node) and asserts the
`LossyError` itself, so the refusal is the pinned behavior.

## Conventions

- All text files are LF, UTF-8, no BOM (`.gitattributes` enforces no CRLF conversion —
  goldens are BYTES; blob hashes and byte-exact comparisons depend on it).
- Inputs are hand-authored first; `ir.json` / `out.yamlover` are generator-produced, then
  **reviewed in the git diff** and committed. Reviewing that diff IS the human-readability
  audit.
- Regenerate after intentional parser/serializer changes: `npm run gen:fixtures`
  (`-- --only 09` to restrict by id prefix; `-- --check` diffs without writing — the CI
  idempotence gate).
- Keep fixture binaries under 1 MiB so `walkDir` hashes them inline and `ir.json` pins a
  real `xxh64:…` hash (larger files stay `contentHash: null` until the background hasher —
  stable, but weaker).
