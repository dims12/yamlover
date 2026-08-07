# Legacy Python tools — `walker` & `collector` (DEPRECATED)

`tools/walker/` and `tools/collector/` are the **Python predecessors** of the current
TypeScript effort. They are **deprecated** as of 2026-06-07 and are no longer the focus:

- **`walker`** — materialized a yamlover tree (mixed concretes) into one logical tree and
  let you `cd`/`ls`/`cat`/`json`/`yaml` over it.
- **`collector`** — assembled a tree into one Yamlover JSON Schema.

**Superseded by:** `tools/parser/` (json5p & yamlover → the IR, `../IR.md`) and
`tools/engine/` (pointer resolver; SQLite-backed `node`/`edge` graph + a directory walker
to come, `../ENGINE.md`). The sources are kept for reference only — not run in CI, need
Python 3.10 + PyYAML, and exercise the **old example numbering (01–15)** and the **old
model**. Don't extend them.

## Why deprecated — model changes that retired them

| Legacy mechanism (walker/collector) | Replaced by |
|---|---|
| **Schema-as-storage** — data pinned in `.yamlover/schema.yaml` via `const:` (schema ↔ instance correspondence) | **Instance-only.** The instance graph is the only thing stored; schema is a *separate, deferred validator* (`../PLAN.md` Phase 6). A directory's overlay is now `.yamlover/body.yamlover`. |
| **`x-yamlover.rel`** up-edges + **`^name`** ascent + **`.`-prefixed virtual children** (the DAG mechanism) | **`*` pointers** (the only edge-creator) + **`~` back-edges**; one general graph "kept as written", `normalize` to forwards-only (`docs/language/pointers`). |
| **`$ref`/`$defs`** (JSON-Pointer in schema space) + sibling-keyword merge | Pointers live in **instance** space (`*`, scopes `/` `//` `..`); schema `$ref` is out of scope for the instance model. |
| `json-schema/instantiate` / `yaml-schema/instantiate` commands | Not needed (no schema-as-storage). Serialization is IR → concrete (Phase 2d). |

## Durable knowledge to carry into the engine (Phase 3b walker + directory concrete)

These behaviors are **independent of the old model** and the future directory walker /
serializers should reproduce them. Detailed prose lives in `walker/README.md` &
`collector/README.md` (kept for reference).

- **Concrete taxonomy** (how a node is physically stored), to preserve for the directory
  concrete:
  - `dir` — a plain directory (object of its entries); `file` — a plain file (type inferred).
  - `file/yaml` · `file/json` · `file/binary` — a value in its own file, with that encoding.
  - `yaml` · `json` — a value *inside* a parent's collapsed document file (the file interior).
  - (Legacy-only: `yamlover` = dir with `.yamlover/schema.yaml`; `*-schema/instantiate` =
    pinned in schema. The new equivalent is a dir with `.yamlover/body.yamlover`.)
- **Directory → logical node mapping:** a file/subdir is an entry (filename → string key);
  bytes → a `Blob` (`../IR.md`); **undescribed, non-hidden files are surfaced** as extra
  entries; **hidden entries** (`.git`, `.yamlover`, …) and files **claimed** by an overlay
  key are omitted. Files & subdirectories are equivalent ways to store one node.
- **Binary/format handling:** a binary leaf has a `format` (e.g. `image/png`, `int32/le`);
  it round-trips through YAML as `!!binary` but has **no JSON form** (JSON projection must
  error/skip). → `Blob{format, contentHash, size}` in the IR.
- **Ordering on a filesystem:** directory entries have no order; the overlay fixes it
  (legacy used schema `prefixItems`; new model uses the `body.yamlover` pointer-array). The
  canonical fixture is an array whose elements live in arbitrarily-named files.
- **Depth-limited rendering:** container nesting can be elided (`"{...}"`/`"[...]"`) beyond
  a depth — useful for the engine's `toc`/preview output.
- **Provenance:** each fs-backed node carried `os` (`path`, `size`, `mtime`) — keep as
  node metadata (CRC/hash for FS-sync per `../ENGINE.md`).

## Test scenarios to re-create as engine/parser tests

`walker/test_walker.py` was **data-driven** over `examples/` (expected materialized value,
reported concrete, and round-trip per example). Those tables are a ready checklist for the
future **directory-walker** tests (examples since renumbered 01–15 → **50–71**):

- the same object in four concretes (schema/yaml/json/dir) → identical materialized value
  — now: dir + `body.yamlover`, and the `01/02/03/05/06-tour.*` file concretes;
- scalar as file / plain dir / binary file (`int32/le`, PNG bytes) — blob handling;
- mid-tree **concrete switch** (a node continues in a separate file);
- **array of files** with order fixed by the overlay;
- the **genealogy DAG** (now `58-genealogy-dag`) re-expressed with `~` back-edges (the
  canonical graph fixture, `../IR.md`);
- a **recursive doc tree** (chapters/chunks);
- **stray-file surfacing** and **hidden-entry omission**.

## Removal

Kept in-tree for now as reference. Safe to delete once the engine's directory walker lands
and the scenarios above are covered by TS tests. (`.pytest_cache/` is disposable.)
