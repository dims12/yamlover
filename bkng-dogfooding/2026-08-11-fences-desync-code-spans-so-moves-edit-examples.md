# A ``` fence desyncs the code-span scanner, so a move rewrites documented examples

**Date:** 2026-08-11
**Found in:** verifying `ed2914a` (THE LINK INVARIANT) against the trees from the two previous
reports, on `npx yamlover .`
**Severity:** medium — an unrequested edit to a user's prose (a link target inside `` `code` ``
gets rewritten), plus false `link/dead-target` warnings on any markdown file that has a fenced
block
**Note:** all names below are invented placeholders. The fixtures are self-contained.
**Resolved:** 2026-08-11 — Defect 1: `TOKEN` gained a FENCE arm ahead of the code arm
(`` `{3,} `` … matched to the same-length closer by backreference), consumed whole and passed
through verbatim/atomic in both the read and editable renderers — the leak matrix (A–E) is
pinned in `resolve.test.ts` and the move-edits-example repro byte-exact in
`relink-links.test.ts`. Defect 3 (carried): closed — the server ships the dead TARGET set
(`GET /api/dead-links`, from the same link-check), the client holds it in a diff-refreshed
module store (`client/dead-links.ts`), and `NavLink` renders a resolved link whose target
names no node as `.deadlink` instead of a live anchor into a 404; healing a target clears the
mark on the same diff event that reindexes it. Defect 2 (flow-cell links reported, not
rewritten) stays a stated limitation — reported, doctor-caught, nothing silent.

## Verification first: `ed2914a` holds

All three findings of `2026-08-11-dangling-prose-links-are-never-reported.md` check out fixed.

- **The invariant reports.** Dead links surface at startup, on every reconcile, and in
  `/api/doctor` with both the node path and the fs path, as `warning` with `allowed: true`:
  ```
  yamlover 11:09:44.673  reconcile: +0 ~2 −0 →0
  yamlover 11:09:44.673  validate warning: link/dead-target at :P:1 — prose link [t](*::nowhere) addresses :nowhere, which names no node
  ```
- **Presentational frames are transparent.** The same `*..:target` in a `- >` block, a `bullets`
  item and a `table` cell now share one holder — and the table cell is two containers deep, so the
  stampless-row case works too:
  ```
  {"from":":P:holder:1",    "holder":":P:holder","target":":P:target","resolves":true}
  {"from":":P:holder:2:0",  "holder":":P:holder","target":":P:target","resolves":true}
  {"from":":P:holder:3:1:0","holder":":P:holder","target":":P:target","resolves":true}
  ```
  The bullets link is now **rewritten** on a move, where before it was silently skipped. Client
  side agrees: both spellings render `href=":P:moved"` from the same frame.
- **`*:x` re-scoping** needs no code, agreed — the warning is the migration diagnostic.
- Suites: parser+engine 644/648 (the 4 failures are the missing conformance submodules), server
  vitest **1465/1465**.

Retiring `linkcheck.mjs` is right, and the doctor is strictly better than it was: it scans `.md`
files, which my checker skipped. That is how it found the bug below.

## Defect 1 — a ``` fence shifts every later code span by one backtick

The code arm of `TOKEN` (`marklower-links.ts:35`) is a single-backtick span:

```ts
"`([^`]+?)`|" + // 2: code
```

Against a ``` fence the alternation matches from the **third** backtick of the opener to the
**first** backtick of the closer, consuming the fence body and leaving the closer's other two
backticks loose. Those pair off with the opening backtick of the next inline code span — so the
span's *contents* are exposed, and a `[label](target)` inside it is scanned as a live link.

Minimal, no tree needed:

```
A inline only                skipped (correct)
B one fence then inline      LEAKED ["::dead"]
C fence w/ info string       LEAKED ["::dead"]
D two fences then inline     LEAKED ["::dead"]
E fence containing backtick  LEAKED ["::dead"]
```

where A is ``x `[t](::dead)` y`` and B is that same line preceded by a ```` ```\ncode\n``` ````
block. One fence anywhere upstream is enough. Two also leak, so it is not simple parity — each
fence leaves a residue. A link *inside* a fence is correctly skipped, and `` ``…`` `` (a two-
backtick span) is fine; a 4-space indented code block leaks, but marklower may not claim that
construct.

**Verified (tester, 2026-08-11) at `e4c1da9`:** the fence arm is correct on every case above — A–E
all skip now, the real `AGENTS.md` is down to its one external URL (all four backticked examples
skipped), and the move repro below keeps the backticked target literal while rewriting the real link
beside it. The dead-link UI is correct in both directions: `GET /api/dead-links` →
`{"targets": [":P:gone"]}`, the target renders as `SPAN.deadlink` with `href: null` and the path in
its `title`, creating the missing node heals the mark on the reconcile diff with no reload, and
deleting it again brings both the mark and the warning straight back. Suites: parser+engine 646/650
(the 4 are the conformance submodules), server vitest 1465/1465. Defect 2 (flow cell) re-confirmed
as the stated limitation.

The indented-code residual is **real, and `.md`-only**: the marklower renderer has no indented-code
construct either, so there the scanner and the renderer agree — but a `.md` node is rendered by
`marked`, which does. Four CommonMark constructs diverge that way (indented block, `~~~` fence, HTML
comment, backslash escape), each of them still rewritten by a move. Filed separately, with the
reasoning for why no further arm in the *shared* tokenizer can fix it, as
`2026-08-11-md-files-are-scanned-with-the-wrong-grammar.md`.

`marklower/grammar` only defines the atomic single-backtick span, so a ``` fence is arguably not
marklower syntax at all. It is still standard in the **markdown** files the same scanner is pointed
at: `PROSE_TEXT_FORMATS` (`resolve.ts:321`) includes `text/markdown`, so every `README.md` /
`AGENTS.md` in a served tree is scanned with the marklower tokenizer, and every such file has
fenced blocks.

### The consequence that matters: a move edits the example

Not just a bad warning — `relinkMoved` acts on the leaked target and rewrites prose the author
marked literal. Two files identical but for a fenced block:

~~~bash
mkdir -p /tmp/fz/P/target && cd /tmp/fz
printf 'Target\ndescription: t\n'              > P/target/index.yo
printf 'P\ndescription: p\n- *: target\n'      > P/index.yo
cat > NOTES.md <<'MD'
# Notes

```bash
echo hi
```

Now a documented example that must stay literal: `[t](*::P:target)`.
MD
# then move the target: mkdir Q && mv P/target Q/target
~~~

```
with the fence:     rewritten [[": target",":: Q: target"],["[t](*::P:target)","[t](*::Q:target)"]]
                    editedFiles ["P/index.yo","NOTES.md"]
                    -> Now a documented example that must stay literal: `[t](*::Q:target)`.

same file, no fence: rewritten [[": target",":: Q: target"]]
                    editedFiles ["P/index.yo"]
                    -> Now a documented example that must stay literal: `[t](*::P:target)`.
```

The code span is the author saying "do not interpret this". `marklower/grammar:17` agrees —
"**Atomic** means the contents are never re-interpreted as markup". A refactor silently editing
inside one is the same class of harm as Defect 3 of the first report (a rewrite restyling a token
it had no business touching), one level worse because it changes meaning, not spacing.

### And the false warnings

The doctor's first run on a real tree produced exactly two `link/dead-target` warnings, both
false — both are backticked examples in the tree's own `AGENTS.md`, one in a table cell:

```
validate warning: link/dead-target at :AGENTS.md — prose link [criteria](*:criteria) addresses :criteria, which names no node
validate warning: link/dead-target at :AGENTS.md — prose link [t](::a:b) addresses :a:b, which names no node
```

The renderer disagrees with the scanner about both: in the browser they are `<code>` elements, not
links, and carry no `.deadlink` marker. That is precisely the "one law, three consumers" property
`link-check.ts` is built on, failing on its first real input — and a false warning in a brand-new
invariant is expensive, because the fix for it is to edit correct documentation.

**Suggested fix:** give the tokenizer a fence arm ahead of the code arm, so a fenced block is
consumed whole and its delimiters never leak into inline scanning — one more alternative in
`TOKEN`, e.g. a ```` ```…``` ```` (or generally `` `{3,} … `{3,} ``) arm returning undefined like
math and code already do. That fixes the warning and the rewrite together, since both read
`linkTargets`. Worth a pin in the examples sweep: a fenced block followed by a backticked link
example, asserting zero targets.

## Defect 2 (minor) — a link in a table *cell* is reported but never rewritten

With the frame fix in, the bullets case rewrites. A link in a flow table cell does not — but it is
now correctly *reported*, so `mv.ts:4` holds:

```
rewritten   [[": target",":: moved"],["[t](*..:target)","[t](*::moved)"]]
unrewritten [{"from":":P:holder:3:1:0","raw":"[t](*..:target)",
              "reason":"marklower prose link — no source span/reader (report only)"}]
```

Fine as a stated limitation; noting it only so the gap is known rather than assumed. The doctor
does catch the resulting dead link, so nothing goes silent.

## Defect 3 (minor, carried over) — a dead *node* still renders as a live link

`ed2914a` makes a target that cannot be **spelled** into a path render `.deadlink` (verified: a
reserved `&some:mark` gets the wavy underline and the title). A target that spells fine but names
no node still renders as an ordinary clickable link, because the client has no store:

```
live [a](*..:moved) dead [b](*..:target)   ->   <a href=":P:moved">a</a>  <a href=":P:target">b</a>
```

Clicking `b` navigates, `GET /api/content/P/target` 404s in the console, and the view keeps the
previous chapter's title with nothing marking the failure. This is the second half of Defect 2 in
`2026-08-10-dir-move-leaves-refs-dangling.md` ("`resolveLink` does no existence check, so the dead
link stays clickable"), still open. Now that the server computes the dead set anyway, the cheap
version is to ship it with the node payload and let `NavLink` reuse `.deadlink`.

## Environment

- yamlover at `ed2914a`, `dir/index.yo` flavor
- node v22.16.0, macOS (Darwin 25.5.0), `npx yamlover .` live/Vite, not read-only
- client checks driven through a real browser against the running server
