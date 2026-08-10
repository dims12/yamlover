# A directory move leaves every inbound ref dangling, silently

**Date:** 2026-08-10
**Found in:** dogfooding a real doc tree (`~/docs`, 15-chapter `privacy/` subtree) on `npx yamlover .`
**Severity:** high — silent data-integrity loss on a routine reorganization; no diagnostic, no log line
**Resolved:** 2026-08-10 — all three defects fixed. `relinkMoved` now collapses overlay files
to their owning directory (`walk.ts ownerNodePath`) and coalesces fully-vacated directories
into one directory-level move, so the unmediated tier relinks like tier-1. Marklower prose
links are scanned (`resolve.ts scanTextLinks`) and reported in `unrewritten` — rewriting the
text itself stays future work. Rewrites keep the authored spacing style (a compact `*::a:b`
no longer comes back spaced). Regression tests: engine `mv.test.ts`/`walk.test.ts`/
`resolve.test.ts`, server `reconcile.test.ts` (the exact external-`mv` scenario).

## What happened

`mv privacy kb/privacy` in a shell, with the server watching. The engine detected the move
correctly and said so:

```
yamlover 14:38:26.591  watch: 3 change(s) — kb, privacy, kb/privacy
yamlover 14:38:26.591  [reconciling] started
yamlover 14:38:26.622  [reconciling] done in 0.0s
yamlover 14:38:26.622  reconcile: +0 ~0 −0 →15
```

`→15` is `diff.moved.length` (`engine-api.ts:434`) — all 15 chapters inferred as moved, nothing
lost. But all 15 inbound cross-references still spell the old location, and nothing said a word:

```
$ grep -ro '::privacy' ~/docs --include='*.yo' | wc -l
15
$ grep -ro '::kb:privacy' ~/docs --include='*.yo' | wc -l
0
```

This is supposed to be handled: `engine-api.ts:409-432` calls `relinkMoved` on exactly this tier
("An UNMEDIATED move (mv in a shell, a file manager) shows up as an inferred `moved` — relink the
inbound refs the way the mediated tier would"). It ran and rewrote nothing. There are **two
independent defects** behind that, either one of which is sufficient to lose the refs.

## Defect 1 — `relinkMoved` cannot see a directory move at all

`walk.ts:138` documents `IndexDiff` as **file** paths, so a moved directory reaches
`relinkMoved` only as its N moved overlay files — never as the directory itself:

```
privacy/.yo/body.yo  →  kb/privacy/.yo/body.yo        (×15)
```

`relinkMoved` maps each straight through `storeOf` (`mv.ts:71`, `mv.ts:126-128`), yielding
`oldStore = ':privacy:.yo:body.yo'`. No inbound ref is ever `under()` that path, because the
overlay is *consumed* — the node's store path is `:privacy`. So the `stale` filter at
`mv.ts:96-100` matches nothing and the planner is handed an empty set.

Tier-1 `mv()` is unaffected: it calls `storeOf(relFrom)` on the directory the caller named
(`mv.ts:49`), getting `:privacy`. So **mediated moves relink and unmediated directory moves do
not** — the two tiers disagree, which is precisely what `engine-api.ts:410` says they must not.

Reproduced with a real `*` pointer (`probe.yo: ptr_ref: *::privacy:taxonomy`), same tree, same
`relinkMoved` call, only the shape of `moved` differing:

| `moved` fed to `relinkMoved` | rewritten | unrewritten | editedFiles |
|---|---|---|---|
| 15 file-level entries (`privacy/.yo/body.yo → kb/privacy/.yo/body.yo`, …) — what the watcher produces | 0 | 0 | 0 |
| 1 directory-level entry (`privacy → kb/privacy`) — what tier-1 `mv()` produces | 1 | 0 | `['probe.yo']` |

**Suggested fix:** before planning, normalize `moved` from FS paths to *node* store paths —
collapse an overlay file to the directory it belongs to (`X/.yo/body.yo → X`, `X/index.yo → X`,
per the `dir/.yo` and `dir/index.yo` concretes) and coalesce entries sharing a common moved
prefix into the single directory move. That also removes 15 redundant `planRewrites` passes.

## Defect 2 — markdown-link cross-references are never rewritten, and never reported

Even given the correct directory-level move (row 2 above), the prose link in the same probe file
was left untouched:

```yaml
ptr_ref: *:: kb: privacy: taxonomy              # rewritten
md_link: 'see [taxonomy](::privacy:taxonomy)'   # NOT rewritten, NOT reported
```

`[label](::a:b)` is a first-class in-app link: `client/links.tsx:65-73` (`resolveLink`) reads
`::` as project-root and `:` as document-relative, and `NavLink` turns it into SPA navigation.
The repo's own docs are written this way throughout
(`docs/language/concretes/03-yamlover/01-dir/index.yo` and friends), so the repo's own tree has
the same exposure.

But such a link is *not* an IR pointer. It never becomes a `ResolvedEdge`, so
`resolveDocument` → `planRewrites` → `mv`/`relinkMoved` cannot see it. Consequences:

- `mv.ts:4` promises "Refs the engine cannot rewrite are REPORTED, never silently dropped" —
  these are neither rewritten nor reported. `unrewritten` was empty.
- `resolveLink` does no existence check, so the dead link stays *clickable* and navigates to a
  path with no node behind it. Nothing marks it broken in the UI or the log.
- This one hits **tier 1 too**: an in-app move via the UI loses prose links just as silently.

**Suggested fix:** two parts, in order of value.

1. *Report* them. Scan text scalars for link targets in pointer spelling (`(::…)` / `(:…)`)
   during planning and emit them as `unrewritten` with a reason, so the promise at `mv.ts:4`
   holds and a move at least tells the user what it broke.
2. *Rewrite* them. The targets are spans in known text, so the same surgical-edit machinery
   applies; the parse just has to reach inside marklower/AsciiDoc link syntax. Alternatively
   surface a `doctor`-style dangling-link check, which also catches hand-authored typos.

## Defect 3 (minor) — rewritten pointers are emitted non-canonically

The rewrite produced `*:: kb: privacy: taxonomy`, spaces and all, from an authored
`*::privacy:taxonomy`. It still resolves (verified: `:kb:privacy:taxonomy`, `kind: 'node'`), so
this is cosmetic — but `rewrite.ts:5` states "Rewrites are emitted in CANONICAL colon form only",
and a rename refactor rewriting a user's file should not restyle the token while it is there.

## Reproduction

```bash
mkdir -p /tmp/t/a/x && cd /tmp/t
printf 'A\n- *: x\n'                       > a/index.yo
printf 'X\n- >\n  see [a](::a) and *::a:x\n' > a/x/index.yo
printf 'ptr: *::a:x\nmd: "[x](::a:x)"\n'   > probe.yo
npx yamlover .          # then, in another shell:
mkdir kb && mv a kb/a   # log shows `reconcile: … →N`; both refs in probe.yo stay `::a…`
```

## Environment

- yamlover: working copy at `~/personal/yamlover`, `.yo` overlay flavor (post-YOMIGRATION)
- node v22.16.0, macOS (Darwin 25.5.0), `npx yamlover .` live/Vite, not read-only
- tree: `~/docs` — 15 `dir/.yo` chapters under `privacy/`, plus 2 `dir/index.yo` chapters under
  `tickets/`; refs authored as marklower links, `::`-rooted
