# A `.md` file is rendered with CommonMark but scanned with the marklower tokenizer

**Date:** 2026-08-11
**Found in:** verifying `e4c1da9` (the fence arm) — the residual noted at the end of
`2026-08-11-fences-desync-code-spans-so-moves-edit-examples.md`, run down properly
**Severity:** medium — same harm class as the fence bug (an unrequested edit inside text the author
marked literal, plus false `link/dead-target` warnings), reached by four constructs the fence arm
does not cover
**Note:** all names below are invented placeholders. Both fixtures are self-contained.
**Resolved:** 2026-08-11 — by Dmitry's FORMAT-BOUNDARY ruling, the root cut rather than a
fifth arm: `.md`/`.adoc` support links in THEIR OWN format only (relative file paths, made
navigable GitHub-style by the markup renderers), and the yamlover engine neither scans,
rewrites, nor doctor-checks them — `text/markdown` is removed from the engine's PROSE scan
set (`resolve.ts`), so all four divergences (and any future CommonMark construct) disappear
at the source: no false warnings, no move ever edits an `.md` file. The cost is explicit and
accepted: a move may break a native md/adoc link, and the author fixes it by hand. Renderer
highlighting of broken md/adoc links, and engine-managed updates for them, are recorded as
FAR-FUTURE features (docs/documents/marklower/link-targets states the boundary). Defect 2
(the chapter tag gating the renderer's inline pass but not the scan of format-less prose)
remains open as a UI question — the scan keeps managing format-less `.yo` prose, which is
the original probe.yo contract.

## Verification first: `e4c1da9` holds

Recorded in the two reports it closes; not repeated here. The fence arm is correct on every case
the previous report filed (leak matrix A–E clean, the move-edits-example repro keeps the backticked
target literal while rewriting the real link beside it), and the dead-link UI is correct in both
directions — creating the missing target heals the mark on the reconcile diff with no reload,
deleting it brings the mark and the warning straight back. Suites: parser+engine 646/650 (the 4 are
the missing conformance submodules), server vitest **1465/1465**.

## Defect 1 — four CommonMark constructs still leak, and only in `.md`

`PROSE_TEXT_FORMATS` includes `text/markdown`, so a `.md` node is scanned by `linkTargets` — the
**marklower** tokenizer. But a `text/markdown` node is *rendered* by `marked`
(`renderers/registry.tsx:274` → `text.tsx:1`, `new Marked(...)`), a real CommonMark engine. Two
grammars, one scanner. Wherever they disagree about what is code, the scanner sees a link the reader
never sees.

Four constructs disagree. Scanner vs. what `marked` actually puts in the DOM, one `.md` file, six
labelled links, all spelling the same missing target:

| | construct | `linkTargets` | DOM from `marked` | verdict |
|---|---|---|---|---|
| A | 4-space indented block | LEAKED | `<code>` | divergent |
| B | `~~~` tilde fence | LEAKED | `<code class="language-bash">` | divergent |
| C | `<!-- HTML comment -->` | LEAKED | *not in the DOM at all* | divergent |
| D | backslash escape `\[t](…)` | LEAKED | literal text in `<p>` | divergent |
| E | triple-backtick fence | skipped | `<code class="language-bash">` | agrees (the `e4c1da9` fix) |
| F | `` `code` `` span | skipped | `<code>` | agrees |

A tab-indented block leaks the same way as A, and `~~~bash` the same as `~~~`. The page carrying
all six has **zero** anchors in its body — every link on it is inside something CommonMark calls
code — and the server logged **four** `link/dead-target` warnings for it:

```
validate warning: link/dead-target at :NOTES.md — prose link [t](*::P:nowhere) addresses :P:nowhere, which names no node
    (×4 — A, B, C and D; E and F correctly skipped)
```

C is the worst of the four to debug: an HTML comment is invisible in the rendered page, so the
warning names a link the reader cannot see at all.

### And the move edits all four

`relinkMoved` acts on every leaked target, exactly as it did through the fence bug. Same file,
`mv P/target Q/target`:

~~~~
editedFiles ["P/index.yo","NOTES.md"]

    A [t](*::Q:target)        <- rewritten (indented code block)
~~~bash
B [t](*::Q:target)            <- rewritten (tilde fence)
~~~
<!-- C [t](*::Q:target) -->   <- rewritten (HTML comment)
D \[t](*::Q:target)           <- rewritten (backslash escape)
```bash
E [t](*::P:target)            <- correctly left alone
```
F `[t](*::P:target)`          <- correctly left alone
G a real link: [t](*::Q:target)   <- correctly rewritten
~~~~

### Why no arm in the shared tokenizer fixes this

The fence arm was safe because a ``` fence means "code" in *both* grammars — hiding it served the
marklower renderer and `marked` alike. The other four are code in CommonMark **only**, and
marklower is right not to have them: verified in a tagged chapter, the identical indented line
renders as a real live link, marked `.deadlink` when the target is missing, so renderer and scanner
**agree** there.

```
- >
  indented next:

      A [t](*::P:nowhere)

  and inline B [t](*::P:nowhere)
```
```html
<p class="chapter-prose"><span>indented next:\n\n    A </span>
  <span class="deadlink" title="link target names no node: :P:nowhere"><span>t</span></span>
  <span>\n\nand inline B </span>
  <span class="deadlink" title="…"><span>t</span></span></p>
```

So adding a 4-space arm to `TOKEN` would fix `.md` by breaking marklower. The seam is one grammar
short, not four arms short.

**Suggested fix**, in order of value:

1. **Scan `text/markdown` with a markdown link extractor**, not `linkTargets`. `marked` is already
   a dependency and already the renderer of record: a `marked` walk-tokens pass that collects
   `link` tokens *and their offsets* gives the scanner exactly the set the reader can click, for
   free, and cannot drift from what is rendered — the same "one law, N consumers" property
   `link-check.ts` is built on, applied to the second grammar in the tree. `PROSE_TEXT_FORMATS`
   becomes a dispatch instead of a union.
2. Failing that, make the divergence explicit and cheap: `known-divergence` already records that
   marklower refuses block structure, so add a line saying a `.md` file is scanned with the
   marklower grammar and list what that costs. A reader can then at least recognise the false
   warnings.
3. Whichever way it goes, pin it: a `.md` fixture holding all six constructs above, asserting one
   target (G) — and a move over it asserting E, F **and** A–D come out byte-identical.

## Defect 2 (minor) — the chapter tag gates rendering but not the scan

Adjacent, found while pinning the marklower side of Defect 1. Without
`!!<*yamlover: $defs: chapter>` the inline pass does not run: the text lands in a
`<p class="chapter-prose">` verbatim, `**bold**` and all. The scanner does not care about the tag.

```
P
description: p
- >
  untagged **bold** and [t](*::P:nowhere)
```
```html
<p class="chapter-prose">untagged **bold** and [t](*::P:nowhere)</p>   <- no <strong>, no link, no .deadlink
```
```
validate warning: link/dead-target at :P:1 — prose link [t](*::P:nowhere) …
GET /api/dead-links -> {"targets": [":P:nowhere"]}
```

Adding the tag to the same file renders both the `<strong>` and the `.deadlink`. And a move
rewrites the untagged one:

```
- >
  untagged, renders literal: [t](*::Q:target)     <- rewritten, though nothing renders it as a link
```

Which side is wrong is a call for you. From here the **renderer** looks like the wrong one — the
author wrote a link, the node is prose by format, and the element is literally classed
`chapter-prose` — in which case the tag should not gate the inline pass. If instead the tag is the
law, the scan needs to respect it, or the doctor will keep reporting "prose links" in text the
product does not treat as prose.

## Reproduction

```bash
mkdir -p /tmp/md/P/target && cd /tmp/md
printf 'Target\ndescription: t\n'         > P/target/index.yo
printf 'P\ndescription: p\n- *: target\n' > P/index.yo
cat > NOTES.md <<'MD'
# Notes

    A [t](*::P:target)

~~~bash
B [t](*::P:target)
~~~

<!-- C [t](*::P:target) -->

D \[t](*::P:target)

G a real link: [t](*::P:target)
MD
npx yamlover /tmp/md      # 4 false link/dead-target warnings; the page has one anchor (G)
# then: mkdir Q && mv P/target Q/target   -> A, B, C and D are all rewritten
```

## Environment

- yamlover at `e4c1da9`, `dir/index.yo` flavor
- node v22.16.0, macOS (Darwin 25.5.0), `npx yamlover .` live/Vite, not read-only
- DOM checks driven through a real browser against the running server; move checks through
  `relinkMoved` over a real `reindex` diff
