# A directory move leaves every inbound ref dangling, silently

**Date:** 2026-08-10
**Found in:** dogfooding a real doc tree (15-chapter subtree) on `npx yamlover .`
**Note:** all directory and node names here are anonymized placeholders — `area`, `section`,
`sub`, `group`, `target`, `child`, `topic`. Only the tree *shape* and the ref *spellings* are
reproduced from the real trees; nothing else about them is needed to reproduce any defect.
**Severity:** high — silent data-integrity loss on a routine reorganization; no diagnostic, no log line
**Resolved:** 2026-08-10 — all three defects fixed. `relinkMoved` now collapses overlay files
to their owning directory (`walk.ts ownerNodePath`) and coalesces fully-vacated directories
into one directory-level move, so the unmediated tier relinks like tier-1. Marklower prose
links are scanned (`resolve.ts scanTextLinks`) and reported in `unrewritten` — rewriting the
text itself stays future work. Rewrites keep the authored spacing style (a compact `*::a:b`
no longer comes back spaced). Regression tests: engine `mv.test.ts`/`walk.test.ts`/
`resolve.test.ts`, server `reconcile.test.ts` (the exact external-`mv` scenario).

**Reopened:** 2026-08-10 as **Defect 4** — verifying the fix on a second, larger tree found one
scope spelling still unhandled: a prose link written in PARENT scope (`[t](*:name)`) is neither
rewritten nor reported. See "Round 2 verification" below. Defects 1-3 confirmed fixed.

**Resolved (Defect 4):** 2026-08-11 — by an ARCHITECTURE ruling, not a patch. Investigating the
`*:` spelling revealed the doc/architecture mistake: the client never resolved sigil-prefixed
targets at all, and the text-level embed token `*[label](target)` overloaded the same `*`. The
corrected law (docs/documents/marklower/{grammar,embeds,link-targets}): a link target IS a
yamlover pointer expression — `[t](*::a:b)` project, `[t](*:a)` document, `[t](*..:x)` parent,
`[t](*name)` current — one seam (`parseLinkTarget`) shared by the client's navigation and the
engine's move planner, so every scope the client navigates is a scope a move rewrites (the
`retarget` law is shared with `*` pointer tokens). Bare colon targets read forever as an alias;
rewrites and the repo-wide migration emit the sigiled COMPACT form (spaced would re-split a bare
scalar line). `&…` targets are reserved (reported on moves, not resolved) for the annotations
rework. The embed token is REMOVED — embedding is structural: a chapter body element (`- *:
member`, or a chunk whose entire text is one media URL renders as the figure). Regression matrix:
`tools/engine/ts/test/relink-links.test.ts` (incl. the parent-scope Defect-4 pin and the `&`
reserve pin).

## What happened

`mv area kb/area` in a shell, with the server watching. The engine detected the move
correctly and said so:

```
yamlover 14:38:26.591  watch: 3 change(s) — kb, area, kb/area
yamlover 14:38:26.591  [reconciling] started
yamlover 14:38:26.622  [reconciling] done in 0.0s
yamlover 14:38:26.622  reconcile: +0 ~0 −0 →15
```

`→15` is `diff.moved.length` (`engine-api.ts:434`) — all 15 chapters inferred as moved, nothing
lost. But all 15 inbound cross-references still spell the old location, and nothing said a word:

```
$ grep -ro '::area' . --include='*.yo' | wc -l
15
$ grep -ro '::kb:area' . --include='*.yo' | wc -l
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
area/.yo/body.yo  →  kb/area/.yo/body.yo        (×15)
```

`relinkMoved` maps each straight through `storeOf` (`mv.ts:71`, `mv.ts:126-128`), yielding
`oldStore = ':area:.yo:body.yo'`. No inbound ref is ever `under()` that path, because the
overlay is *consumed* — the node's store path is `:area`. So the `stale` filter at
`mv.ts:96-100` matches nothing and the planner is handed an empty set.

Tier-1 `mv()` is unaffected: it calls `storeOf(relFrom)` on the directory the caller named
(`mv.ts:49`), getting `:area`. So **mediated moves relink and unmediated directory moves do
not** — the two tiers disagree, which is precisely what `engine-api.ts:410` says they must not.

Reproduced with a real `*` pointer (`probe.yo: ptr_ref: *::area:topic`), same tree, same
`relinkMoved` call, only the shape of `moved` differing:

| `moved` fed to `relinkMoved` | rewritten | unrewritten | editedFiles |
|---|---|---|---|
| 15 file-level entries (`area/.yo/body.yo → kb/area/.yo/body.yo`, …) — what the watcher produces | 0 | 0 | 0 |
| 1 directory-level entry (`area → kb/area`) — what tier-1 `mv()` produces | 1 | 0 | `['probe.yo']` |

**Suggested fix:** before planning, normalize `moved` from FS paths to *node* store paths —
collapse an overlay file to the directory it belongs to (`X/.yo/body.yo → X`, `X/index.yo → X`,
per the `dir/.yo` and `dir/index.yo` concretes) and coalesce entries sharing a common moved
prefix into the single directory move. That also removes 15 redundant `planRewrites` passes.

## Defect 2 — markdown-link cross-references are never rewritten, and never reported

Even given the correct directory-level move (row 2 above), the prose link in the same probe file
was left untouched:

```yamlover
ptr_ref: *:: kb: area: topic              # rewritten
md_link: 'see [topic](::area:topic)'   # NOT rewritten, NOT reported
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

## Defect 3 (minor) — a rewrite restyles the author's pointer

The rewrite produced `*:: kb: area: topic`, spaces and all, from an authored
`*::area:topic`. It still resolves (verified: `:kb:area:topic`, `kind: 'node'`), so this is
cosmetic: a rename refactor rewriting a user's file should not restyle the token while it is there.

**Correction (2026-08-11):** this section was originally titled "emitted non-canonically" and
leaned on `rewrite.ts:5` ("Rewrites are emitted in CANONICAL colon form only") as if the spaced
form were the wrong one. That premise was wrong — the `: `-spaced spelling **is** canonical for a
structural pointer token, and the emitter was within its rights. The defect is only that it
overrode the author's spelling, which is what the fix addressed (rewrites now preserve the authored
spacing style). Compact is separately *required* inside prose, since a `: `-spaced target on a bare
scalar line would re-split it as key/value — but that is the new link law's rule, not this
section's claim.

## Reproduction

```bash
mkdir -p /tmp/t/a/x && cd /tmp/t
printf 'A\n- *: x\n'                       > a/index.yo
printf 'X\n- >\n  see [a](::a) and *::a:x\n' > a/x/index.yo
printf 'ptr: *::a:x\nmd: "[x](::a:x)"\n'   > probe.yo
npx yamlover .          # then, in another shell:
mkdir kb && mv a kb/a   # log shows `reconcile: … →N`; both refs in probe.yo stay `::a…`
```

## Round 2 verification

Re-tested against a second tree — 53 `dir/index.yo` chapters, refs authored in all three scopes —
by moving a 4-chapter subtree out of its parent with a shell `mv`, server running, not read-only.
The shape is what matters: a 3-level parent chain, target moved to the top level.

```bash
mv kb/section/sub/group/target kb/target
```

```
yamlover 19:57:31.198  watch: 2 change(s) — kb/section/sub/group/target, kb/target
yamlover 19:57:31.326  reconcile: +0 ~0 −0 →4
```

11 inbound refs broke. Progression across the two fix rounds:

| ref spelling | count | at `38767a6` | at `233f4fb` |
|---|---|---|---|
| prose link, project scope — `[t](::kb:section:sub:group:target:child)` | 5 | reported, not rewritten | **rewritten** → `::kb:target:child` |
| pointer node, parent scope — `- *: target` | 1 | refused: "target left the holder's document" | **rewritten** → `- *:: kb: target` |
| prose link, parent scope — `[t](*:target:child)` | 5 | absent from every report | **absent from every report** |

`relinkMoved` at `233f4fb`: `rewritten: 6, unrewritten: 0, editedFiles: 5`. Six of eleven refs
repaired; the remaining five are the parent-scope prose links, and `unrewritten: 0` means the
`mv.ts:4` promise ("REPORTED, never silently dropped") still does not hold for them.

The pointer case is worth noting as a clean pass: parent scope escalated to the project form
rather than being refused, and the authored `: `-spaced style carried through.

## Defect 4 — a parent-scope prose link is invisible to the planner

`scanTextLinks` (`resolve.ts:315-330`) branches on two prefixes only:

```ts
if (t.startsWith('::'))     out.push({ …, scope: 'link',     target: t.slice(1), … });
else if (t.startsWith(':')) out.push({ …, scope: 'document', target: (dr === ':' ? '' : dr) + t, … });
```

A `*`-prefixed target matches neither, so it never becomes a `TextLinkRef` and `planRewrites`
never sees it — hence no rewrite *and* no `unrewritten` entry. The equivalent pointer *node*
(`- *: name`) is handled, so this is specific to the target sitting inside prose.

**Correction (2026-08-11):** this section originally claimed the client supported the spelling
("`resolveLink` reads a bare/`*` target as parent-or-current scope"). It did not. At `38767a6`
`resolveLink` tested `::`, `:`, `//`, a scheme, `/` and returned `UNRESOLVED` for everything else,
and its signature had no holder frame at all — so a `*`-spelled prose link rendered as **plain
text**, unclickable. The defect as filed still stands (the engine neither rewrote nor reported
it), but the spelling was dead on both sides, not just the engine's.

**Judgment call worth stating in the fix:** a parent-scope link should NOT always be rewritten.
If the target moves but stays under the same parent, `*:name` is still correct and must be left
alone. It is when the move takes the target out of the holder's parent frame that the link dies
and has to be re-rooted (`::…`) — or, failing that, reported.

**Repro** — three invented files, no external tree needed. Drops into
`tools/engine/ts/test/relink-links.test.ts`, whose `tmpRoot()` helper and existing fixture cover
`:x.md`, `*..: x.md` and `::D:x.md` but no `*:name`-spelled prose link:

```ts
test('relink-links: a PARENT-SCOPE prose link is rewritten when the target leaves the parent', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'P', 'target'), { recursive: true });
  mkdirSync(join(root, 'P', 'holder'), { recursive: true });
  writeFileSync(join(root, 'P', 'target', 'index.yo'), 'Target\n');
  // the two spellings side by side: only the `::` one survives the move today
  writeFileSync(join(root, 'P', 'holder', 'index.yo'),
    'Holder\n- >\n  rel [t](*:target) abs [t](::P:target)\n');

  const s = new Store(':memory:');
  reindex(s, root);
  renameSync(join(root, 'P', 'target'), join(root, 'moved'));
  const r = relinkMoved(root, reindex(s, root).moved);

  const holder = readFileSync(join(root, 'P', 'holder', 'index.yo'), 'utf8');
  assert.equal(holder, 'Holder\n- >\n  rel [t](::moved) abs [t](::moved)\n');
  assert.equal(r.unrewritten.length, 0);
});
```

```
$ node --experimental-strip-types --test tools/engine/ts/test/relink-links.test.ts
+ actual - expected
+ 'Holder\n- >\n  rel [t](*:target) abs [t](::moved)\n'
- 'Holder\n- >\n  rel [t](::moved) abs [t](::moved)\n'
```

Both links address the same node from the same line: the `::` one is re-rooted, the `*:` one is
untouched.

## Not yet exercised

Scope of the round-2 check, so the gaps are known rather than assumed: one cross-parent directory
move, unmediated tier, `dir/index.yo` flavor. Untested and possibly carrying the same
prefix-blindness — an in-place rename (`relinkRenamed` entry point), the `dir/.yo/body.yo` flavor,
embed tokens `*[label](target)`, and a mediated move through the UI/API.

**Update (2026-08-11):** the embed-token gap is void — `*[label](target)` was REMOVED from
marklower by `2d6cb53`; embedding is structural now (a chapter body element, or a chunk whose whole
text is one media URL), so there is no such token to relink. The in-place rename path has since
been exercised (`relinkRenamed`, intra-parent rename, relative spelling correctly preserved). Still
untested: the `dir/.yo/body.yo` flavor and a mediated move through the UI/API.

**Still open from Defect 2 (2026-08-11):** the second bullet — "`resolveLink` does no existence
check, so the dead link stays *clickable* and navigates to a path with no node behind it. Nothing
marks it broken in the UI or the log." The **log** half is fixed: `ed2914a` added the
`link/dead-target` doctor warning. The **UI** half is not. `ed2914a`'s `.deadlink` marker fires
only when a target cannot be spelled into a path at all (or is a reserved `&…`); a target that
spells fine but names no node still renders as a normal `<a>`, and clicking it 404s
`/api/content/…` in the console with nothing shown to the reader. Verified in a browser at
`ed2914a`. Detail in `2026-08-11-fences-desync-code-spans-so-moves-edit-examples.md`.

## Environment

- yamlover: working copy at `~/personal/yamlover`, `.yo` overlay flavor (post-YOMIGRATION)
- node v22.16.0, macOS (Darwin 25.5.0), `npx yamlover .` live/Vite, not read-only
- tree: a private doc tree — 15 `dir/.yo` chapters under `area/`, plus 2 `dir/index.yo` chapters
  under `tickets/`; refs authored as marklower links, `::`-rooted
