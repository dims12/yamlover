# @yamlover/parser

Hand-written parsers for the yamlover family → the **IR** (`../../../IR.md`). Dependency-light
TypeScript, run directly on Node ≥ 22 (native type-stripping; tests via `node:test`).

## Status

- **json5p** (`src/json5p.ts`) — done. JSON5 + pointers (`*`), anchors (`&`), back-edges
  (`~`). Spec: `../../../JSON5P.md`. Gated by the full JSON & JSON5 positive corpora.
- **yamlover** (`src/yamlover.ts`) — practical subset done. Block maps/sequences (incl.
  compact `- key:`, `- - nested` and `- &anchor`), flow `{}`/`[]`, plain/quoted scalars, `#` comments,
  block scalars (`|`/`>` with chomping), plus the extensions (`*`/`&`/`~`). Parses
  `examples/05-tour.yaml` & `06-tour.yamlover`; the yaml-test-suite gate runs with the
  divergence allowlist (`../YAML-CONFORMANCE.md`). **TODO:** multi-doc (`---`), merge
  keys (`<<`), the remaining tag/header edge cases. Spec: `../../../YAMLOVER.md`.
- **pointer** (`src/pointer.ts`) — shared pointer-expression parser (`../../../URIs.md`).
- **ir** (`src/ir.ts`) — the IR types + `toPlain()` projection.

## Test

```sh
npm test                 # everything: unit + serialize/spans/comments + JSON/JSON5/YAML conformance
npm run test:unit
npm run test:conformance
```

## Conformance corpora (git submodules)

The superset claim is gated by upstream, language-independent suites in the **shared**
`../conformance/` dir (init with `git submodule update --init`):

| dir | source | used by |
|---|---|---|
| `json/`  | `nst/JSONTestSuite`   | json5p must accept every `y_*` and match `JSON.parse` |
| `json5/` | `json5/json5-tests`   | json5p must accept every `.json`/`.json5` (and match `JSON.parse` on valid JSON) |
| `yaml/`  | `yaml/yaml-test-suite` (`data` branch) | for the yamlover parser (Phase 2c) |

**Superset is one-directional:** we assert only that *valid* fixtures parse and match the
reference value. Negative fixtures (`n_`, `.js`/`.txt`, YAML `error:`) are not asserted —
json5p/yamlover are deliberately more permissive. See `../../../IR.md` and the conformance
notes for the YAML divergence allowlist.
