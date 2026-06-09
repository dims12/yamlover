# YAML conformance — supported subset & roadmap

The yamlover parser is a **superset of a subset** of YAML: it reads plain YAML *plus* the
yamlover extensions, but does not yet read every YAML construct. This doc tracks the gap,
backed by the gate in `ts/test/conformance.yaml.test.ts`, which runs the
[`yaml-test-suite`](https://github.com/yaml/yaml-test-suite) corpus
(`conformance/yaml/`) against the parser.

## Status

Of the **208** single-document "must-accept" cases (a case dir with `in.json` and no `error`;
23 further multi-document cases are out of scope):

| | count |
|---|---|
| **read correctly** (accept + value matches `in.json`) | **43** |
| known gaps (see below) | 165 |

The gate locks the 43 (they must never regress) and asserts every gap **still** diverges, so
the allowlist can only shrink: implement a feature, delete the ids it fixes, and the test tells
you if you missed any. Aliases are compared by following the pointer edge to its target (YAML ⊂
yamlover *at the value level* — yamlover models `*alias` as an edge, not an inlined copy).

## Reading modes (target)

- **As YAML** — a `.yaml` file should read with full YAML semantics. Closing the gaps below is
  what makes this true; the gate measures progress.
- **As yamlover** — the same bytes read as yamlover, where a few YAML spellings are
  *reinterpreted* (below). On those, yamlover deliberately diverges or rejects; that is a
  feature, not a gap.

## Unsupported YAML features — roadmap (to support in future)

Ordered roughly by impact (corpus cases) × independence. Counts are positive-corpus cases.

1. **Multi-document streams** — `---` document markers and `...` end markers (~71 cases, the
   largest bucket). Split a stream into documents; the engine already has a `documentRoot`
   concept to hang each one on. Unblocks the most cases for the least grammar work.

2. **Standard YAML tags** — `!!str !!int !!float !!bool !!null !!seq !!map !!binary`, local
   `!foo`, verbatim `!<…>`, and non-specific `!` (~9 parse failures + several value mismatches,
   e.g. `!!str 12` → the string `"12"`). Must **coexist** with yamlover's own `!!mix` / `!!omni`
   / `!!<…>` tags. This is the YAML-tag ↔ JSON-Schema-type mapping (`!!int`→integer, `!!seq`→
   array, …); see `META.md`.

3. **Multi-line & folded scalars** — the largest *grammar* gap, spread across many cases:
   - **Plain scalars spanning lines** (line folding: newline → space, blank line → newline).
   - **Quoted scalars spanning lines** — single- and double-quoted line breaks + folding.
   - **Full block-scalar headers** — the indentation indicator (`|2`, `>3`), chomping
     (`-` strip / `+` keep / clip), and "more-indented" folding. (Basic `|`/`>` already work;
     this is the header grammar + chomping/indent edge cases — several value mismatches.)

4. **Multi-line flow collections** — flow `{}` / `[]` that span lines, flow line-folding,
   adjacent values (`{a:b}` with no space), single-pair flow mappings, and `?` in a flow key.
   The flow parser is currently single-line.

5. **Explicit keys** — the `? key` / `: value` complex-mapping syntax, incl. multi-line and
   non-scalar keys (~9 cases).

6. **Tabs as separation** — tabs after indentation, tab-indented flow, "legal tab" positions.
   The lexer currently counts only spaces for indentation.

7. **Whitespace flexibility** — space before the mapping colon (`key : value`), whitespace
   after scalars in flow, and related separation rules.

8. **Plain-scalar character set & edge cases** — URLs with colons in flow
   (`http://example.org`), leading/embedded colons, `key:#novalue` adjacency, and the full set
   of characters YAML permits in plain scalars and keys.

9. **Merge keys** — `<<: *anchor` mapping merge. (0 cases in the positive corpus, but a common
   real-world YAML feature; listed for completeness.)

10. **Nested block-collection edge cases** — a few "sequence in sequence" / "mapping of
    mappings" / "block sequence entry types" cases error on indentation forms that look basic.
    **Investigate first** — some may be quick parser bugs rather than missing features.

## Intentional divergences (NOT gaps — keep diverging)

When read *as yamlover*, these YAML spellings change meaning by design (see `URIs.md`):

- `*alias` extends to **path pointers** (`*/pets[1]`, `*a/b`) and scopes/links — a plain anchor
  alias still resolves, but the syntax space is yamlover's.
- A key prefixed with `~` (`~name:`) is a **back-edge**, not a literal key.
- `!!mix` / `!!omni` / `!!<…>` are **yamlover tags** (mixed/variant containers, inline schema),
  occupying the `!!` space that YAML uses for type tags.

These are not on the roadmap above; the YAML-mode reader (item-by-item, once built) is what
should accept the YAML meaning, while yamlover-mode keeps the reinterpretation.
