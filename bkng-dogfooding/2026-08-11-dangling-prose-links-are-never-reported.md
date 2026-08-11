# A prose link that resolves to nothing is never reported, by anything

**Date:** 2026-08-11
**Found in:** upgrading a real doc tree (71 `.yo` files, 71 prose links) across the new link law
(`2d6cb53` / `2289cb0`) on `npx yamlover .`
**Severity:** medium — no data loss, but a whole tree's cross-references can go dead invisibly
**Note:** directory and node names below are anonymized placeholders (`P`, `holder`, `target`,
`sib`). Only the tree *shape* and the ref *spellings* are reproduced.
**Resolved:** 2026-08-11 — the INVARIANT is now the system's, not a side script's. (1) The
doctor learned links: `link/dead-target` warnings (validate.ts + server/link-check.ts, the
same `scanTextLinks` frames the planner and the client use), listed by `/api/doctor`, logged
at startup and on every reconcile (first 8 spelled out + a count). The examples sweep now
enforces it on everything the repo ships — and its first run caught 3 dead links in our own
docs/examples, fixed. `linkcheck.mjs` is thereby retired (kept beside this report as the
origin story). (2) The client marks a dead in-tree intent VISIBLY (`.deadlink`, wavy danger
underline + title) — a pointer-spelled target that cannot resolve, and the reserved `&…`,
never degrade to silent plain text. (3) Presentational containers are TRANSPARENT frames on
both sides: `*..:sib` inside a `bullets` item or a table cell means exactly what it means in
a `- >` block (engine `PRESENTATIONAL_FORMATS` skip in scanTextLinks; client `holderPath`
threading through list/table renderers) — pinned by the bullets repro from this report in
`relink-links.test.ts`. (4) The `*:x` re-scoping (Defect 3) needs no code: the doctor warning
IS the migration diagnostic — release-note line added below. Frame law documented in
`link-targets/index.yo`.

**Verified (tester, 2026-08-11) at `ed2914a`:** (1), (3) and (4) confirmed against the original
fixtures. The doctor reports at startup, on every reconcile and via `/api/doctor`, with node path
and fs path, `severity: warning` / `allowed: true`. The frame fix holds three levels deep — a
`- >` block, a `bullets` item and a `table` cell (two containers down, the stampless-row case) all
report `holder: ":P:holder"` now, and the bullets link is **rewritten** on a move where it used to
be silently skipped. Client agrees: both spellings render the same `href`. Suites: parser+engine
644/648 (the 4 are the missing conformance submodules), server vitest 1465/1465.

**(2) is narrower than stated.** `.deadlink` fires when a target cannot be *spelled* into a path
(verified: a reserved `&some:mark` gets the wavy underline and the title). A target that spells
fine but names **no node** still renders as an ordinary clickable link, because the client has no
store to check against — `resolveLink` returns `DEAD` only on `path === null`. In a browser against
a live server, `dead [b](*..:target)` with `target` moved away renders
`<a href=":P:target">b</a>`; clicking it navigates, `GET /api/content/P/target` 404s in the
console, and the view keeps the previous chapter's title with nothing marking the failure. So the
*log/doctor* half of Defect 1 is fixed and the *UI* half is not — which is also the still-open half
of Defect 2 in `2026-08-10-dir-move-leaves-refs-dangling.md`. The server now computes the dead set
anyway, so shipping it with the node payload would let `NavLink` reuse `.deadlink` as-is.

**Follow-on defect found while verifying:** the doctor's `.md` coverage (the thing `linkcheck.mjs`
lacked) exposed that a ``` fence desynchronizes the code-span tokenizer, so a link target inside
`` `code` `` is scanned as live — false `link/dead-target` warnings, and worse, `relinkMoved`
rewrites the author's literal example. Filed as
`2026-08-11-fences-desync-code-spans-so-moves-edit-examples.md`.

## Summary

The new law is a real improvement — one `parseLinkTarget` seam, and the parent-scope prose link
that was Defect 4 of `2026-08-10-dir-move-leaves-refs-dangling.md` now rewrites correctly on a
move, relative spelling preserved. Three things surfaced while migrating a tree onto it:

1. **Nothing reports a link that resolves to nothing** — not the parser, not the server log, not
   `doctor`, not `/api/dangling`, not the UI. 29 of 71 links in the tree were dead and the only
   way I found out was writing an external checker.
2. **Relative scopes count presentational containers.** Inside a `bullets` or `table` item the
   frame is that sequence, so `*..:x` addresses a different node than the identical text in a
   `- >` block — silently, and a move then skips it without reporting.
3. **The law change re-scoped `*:x`** from "unresolved" to "document scope", so a tree that used
   `*:sibling` comes out of the upgrade parseable, resolvable-looking, and wrong. Adding the sigil
   to `::` targets is mechanical; this part is not, and nothing flags it.

## Defect 1 — a dangling prose link has no diagnostic anywhere

`doctor` / `validateTree` (`tools/server/src/validate.ts`) never calls `linkTargets`,
`parseLinkTarget` or `scanTextLinks` — it is a layout sweep over nodes and fs paths. `/api/dangling`
is fed from the store's `dangling` table, which `store.ts:11` documents as "`*`/`~` pointers": the
*structural* refs only. A prose link is neither, so:

- it does not make the chapter degraded (the file parses fine),
- `reconcile:` logs nothing,
- `resolveLink` returns `UNRESOLVED` and `NavLink` renders the label as plain text — the reader
  sees unstyled words, with no way to tell an intentional plain phrase from a broken link,
- `relinkMoved`/`relinkRenamed` only ever look at links a *move* strands, so a link that was
  already dead, or that a law change killed, is outside their remit by construction.

On the real tree that came to 29 of 71. Verified by reindexing and resolving every link against
the store — that check is 30 lines using the engine's own seams (`walkTree`, `scanTextLinks`,
`Store.node`) and now lives beside this report as `linkcheck.mjs`:

```
$ node --experimental-strip-types bkng-dogfooding/linkcheck.mjs <tree>
files: 71  prose links: 71  parse errors: 0
DANGLE kb/…/holder/index.yo  [t](*:sib)  ->  :kb:…:holder:sib
…
29 problem(s)
```

**Suggested fix:** teach the doctor sweep the link check. Everything needed is already exported
and already shared with the client, so the rule is small and cannot drift from navigation:
`scanTextLinks(doc)` → for each `kind: 'pointer'` ref whose nominal path is non-null, assert the
store has that node; report `&…` as reserved-not-checked. Emitting it as a *warning* fits the
existing `refuse` production mode (it is content, not corruption). A second, cheaper half: have
`NavLink` mark an unresolved in-tree target visibly instead of degrading it to plain text — the
author's `[label](*::…)` intent is right there in the source, so silence is the wrong default.

## Defect 2 — the relative frame counts presentational containers

The law says `*..: sib` is anchored at "the **parent** of the mapping the prose belongs to". For a
top-level `- >` block that parent is the chapter's own parent, as expected. For prose inside a
`bullets` item the holder is the *bullets sequence*, so one `..` only reaches the chapter — the
same token means two different nodes depending on where in the body it sits.

Scan of one file holding both spellings, one per body element (tree-level `scanTextLinks`, the
frames `relinkRenamed` actually plans against):

```
{"raw":"[t](*..:target)","from":":P:holder:1",  "holder":":P:holder",  "target":":P:target"}        <- in a `- >` block
{"raw":"[t](*..:target)","from":":P:holder:2:0","holder":":P:holder:2","target":":P:holder:target"} <- in a bullets item
```

The second is wrong for any author who wrote it meaning the first. From a bullet the sibling needs
`*..:..:target` (which does resolve — verified), and from a table cell presumably a hop more.

It compounds with Defect 1 twice over. The client agrees with the engine here
(`marklower.tsx holderOf` = drop the last segment, same rule), so the link is consistently dead
rather than inconsistently — but nothing says so. And on a move, `rewrite.ts:158`

```ts
if (t.target === null || !under(t.target, oldStore)) continue;
```

drops it with no `unrewritten` entry, because its wrong target simply isn't under the moved path.
That is the `mv.ts:4` promise ("REPORTED, never silently dropped") failing again, from a new
direction: the ref is invisible not because the planner can't spell it, but because it was
mis-framed before the planner saw it.

**Suggested fix:** decide which the law means and make both sides say it.

- If `bullets`/`table` are presentational (they are — they exist to render, not to scope), the
  holder walk should skip container nodes that aren't documents, so `*..` from a bullet and from a
  `- >` block agree. One helper, used by `scanTextLinks` and `holderOf` alike.
- If the frame is meant to be literal, then `link-targets/index.yo` should say so in the table
  itself — "counts every enclosing container, including a `bullets`/`table` wrapper" — because the
  current wording ("the mapping the prose belongs to") reads as the chapter, and a bullets
  sequence is not a mapping.

Either way, `continue` at `rewrite.ts:158` deserves a `missLink(...)` when `t.target` is non-null
but names no node: a ref that points nowhere is exactly what the report is for.

## Defect 3 (migration) — `*:x` changed meaning silently

Before `2d6cb53`, `resolveLink` tested `::`, `:`, `//`, a URI scheme and `/`, and returned
`UNRESOLVED` for anything else — a `*`-sigiled target was **not a link at all** (it rendered as
plain text, and the engine ignored it too; that is what the earlier report's Defect 4 was). After
the change `*:x` is a valid document-scope pointer.

So for a tree that had used `*:sib` for a sibling, the upgrade turns a visibly-dead link into an
invisibly-wrong one: it parses, it classifies as `kind: 'pointer'`, it produces a nominal path, and
that path names a child that does not exist. Nothing in the upgrade path — parse, index, reconcile,
doctor — mentions it.

`2289cb0` migrated the repo's own docs, which is the right call, but the repo only ever used `*::`
(402) and `*:child` (17) and no relative spellings at all, so its migration was purely mechanical
sigil-adding. A user tree that used the relative forms gets no such luck.

**Suggested fix:** nothing to change in the law — this is Defect 1's fix doing its job. A doctor
link check turns a silent re-scoping into a startup warning listing every dead target, which is all
a migration needs. Worth a line in the release note either way: *"a `*`-prefixed prose target used
to be inert; it is now a pointer — re-check any relative link targets."*

## Reproduction

No external tree needed.

```bash
mkdir -p /tmp/ps/P/holder /tmp/ps/P/target
printf 'Target\ndescription: t\n'                       > /tmp/ps/P/target/index.yo
printf 'P\ndescription: p\n- *: holder\n- *: target\n'  > /tmp/ps/P/index.yo
cat > /tmp/ps/P/holder/index.yo <<'YO'
Holder
description: h
- >
  block [t](*..:target)
- !!<*yamlover: $defs: bullets>
  - 'bullet [t](*..:target)'
YO
npx yamlover /tmp/ps
```

Both links read identically in the source. The one in the `- >` block navigates; the one in the
bullet is plain text, and no log line, doctor diagnostic or `/api/dangling` entry says why. Then
`mv /tmp/ps/P/target /tmp/ps/moved` — the first is rewritten to `[t](*::moved)`, the second stays
`[t](*..:target)` and `unrewritten` is `[]`.

## What the new law got right

Worth recording, since the previous report left it open:

- the parent-scope prose link (old Defect 4) rewrites on a move now, and **keeps its relative
  spelling** when the target stays in frame — `[t](*..:target)` → `[t](*..:renamed)` on an
  intra-parent rename, escalating to `*::moved` only when the target leaves the frame. That is the
  judgment call the earlier report asked for, implemented exactly.
- one seam, two consumers: `parseLinkTarget` is imported by both `links.tsx` and `resolve.ts`, so
  the client/engine divergence that produced Defects 2 and 4 is now structurally hard to
  reintroduce.
- migrating the tree was 42 project-scope targets by regex and 27 judgment calls; the checker
  reduced the second group to a list instead of a hunt.

## Environment

- yamlover: working copy at `2289cb0`, `dir/index.yo` overlay flavor
- node v22.16.0, macOS (Darwin 25.5.0), `npx yamlover .` live/Vite, not read-only
- suite at `2289cb0`: 642/647 pass. The 5 failures are environmental, not regressions — 4 are
  missing conformance submodules (`git submodule update --init`), and
  `reconcile.test.ts` "watchTree batches new-file events" is timing-flaky under a parallel run and
  passes alone. `npm test` itself needs `--experimental-strip-types` on this node
  (`ERR_UNKNOWN_FILE_EXTENSION` on every `.ts` test otherwise).
