# QUERY — the yamlover query language

Selectors over the instance graph. Companion to `URIs.md` (the pointer model this
language extends), `IR.md` (the graph being queried), `ENGINE.md` (the evaluator's
home).

> **Status (2026-06-13): the evaluator SHIPPED** — on the COLON grammar of
> `SEPARATOR.md` (matcher portions, the `..` uplink family replacing the `~` axis,
> `!!<…>` metadata matchers replacing this doc's bracket filters), implemented in
> `tools/engine/ts/src/query.ts` over the Store and exposed as `GET /api/query`.
> The acceptance corpus is `tools/engine/ts/test/query.cases.ts` (77 green). This
> document's §2–§4 grammar is SUPERSEDED by SEPARATOR.md §4–§6 and will be
> rewritten when the dual-separator window closes; §1 (the template-walk model),
> §5's binding semantics and §9's sketches remain the design record. First
> consumers: the tag-picker autocomplete, find-usages (JetBrains J3).

JSONPath (RFC 9535) is the inspiration, but not the syntax: JSONPath's two core
sigils are already spoken for in yamlover — `*` is dereference and `..` is the parent
scope — and JSONPath has nothing to say about the graph (back-edges, incoming edges,
tag membership). So the constructs are rebuilt on the pointer grammar instead of
bolted beside it.

## 1. Design principles

1. **A query is a match template.** Evaluation *walks* the graph as the template
   directs; a walk that exhausts the template **succeeds** and contributes its
   result. Everything below — wildcards, descent, axes, filters, and the future
   comparisons/captures/branching (§9) — is one model: steps either *move* the walk
   or *test* it, and success returns a node. (Like a regex: the pattern visits the
   subject; what comes back need not be the last thing matched.)
2. **Strict superset of pointers.** Every pointer (`URIs.md` grammar) is a valid
   query, and evaluates to **at most one** result — its resolved target, or nothing
   if dangling. A query string is a *pointer expression*: the text that follows the
   `*` deref sigil in a document. (The `*` itself is the authoring embedding — it
   makes an edge; a query is asked, not authored, so it is written without it.)
3. **One lexical space.** Queries and pointers share one escaping regime and one
   metacharacter set (§3) — a key escaped for a pointer is escaped identically in a
   query, and vice versa.
4. **Queries see the normalized graph.** Evaluation is over the forwards-only view
   plus derived inverses (`URIs.md` §`~`, `ENGINE.md` `normalize`): a relation
   authored forward (`X: *b`), reverse (`~X: *a`), or both ways is **one edge**, and
   queries cannot tell which way it was written.

## 2. Lexical extensions

The metacharacter set grows. In pointers (`URIs.md` §Grammar) the reserved characters
are `/ [ ] * & # ~ \` plus whitespace; queries — and, after this spec, pointers too,
keeping the one-lexical-space principle — additionally reserve:

```
?           wildcard            (§4.1)             — v1
...         recursive descent   (§4.2; whole-segment, like `..`)
! ( ) < > = |                   (§9; reserved now, constructs later)
```

A literal occurrence in a key is backslash-escaped, exactly like the existing
metachars: `\?`, `\!`, `\(`, `\<`, `\=`, `\|`. A segment of exactly three unescaped
dots is the descent operator; the literal key `...` is written `\.\.\.` (mirroring
`\.\.` for the literal key `..`). Names that merely *contain* dots
(`Chemical-Free.pdf`) are untouched.

**Migration.** Greps over `examples/` and `yamlover/` (2026-06-11) found **zero**
keys or filenames containing any newly reserved character — the only hits are scalar
*values* (PlantUML arrows, prose) and value-position `!!<…>` tags, neither of which
is a path segment. Reserving these characters costs nothing today; a future key that
needs one escapes it, as keys-as-pointers already must for `/` or `~`.

## 3. Grammar (ABNF-ish)

The `URIs.md` pointer productions, extended. Lines marked `(q)` are query-only;
**erasure property:** delete every `(q)` alternative and the grammar that remains is
exactly the `pointer` / `scope` / `link` / `index` / `name` / `nchar` productions of
`URIs.md` (with this spec's enlarged metachar set). The authoring embeddings
(`deref` / `define` / `backedge` — the `*`, `&`, `~` *prefixes*) are deliberately
absent: they make edges in a document; a query is the bare pointer expression (§1.2).

```
query    = pointer                ; a query IS an extended pointer expression
pointer  = scope *( "/" ( name / ".." / qseg ) / index / filter )
scope    = link                   ; any OTHER start: project, sibling doc, external
         / "/"                    ; current document root  (a single leading "/")
         / ".."                   ; parent node
         / name                   ; STRING key in the current mapping
         / index                  ; INTEGER key (position) in the current mapping
         / qseg                   ; (q) a query may open with a wildcard/descent/axis
link     = ( scheme "://" / "//" ) authority   ; scheme optional & ignored
index    = "[" 1*DIGIT "]"        ; selects the integer key n
qseg     = "?"                    ; (q) any string key            (§4.1)
         / "..."                  ; (q) descent: self + contain-descendants (§4.2)
         / "~" ( name / "?" / "-" )  ; (q) reverse axis            (§4.3)
filter   = "[" fbody "]"          ; (q) extends the index bracket  (§4.4)
fbody    = "?"                    ; (q) any position (fan-out, navigating)
         / kind                   ; (q) node-kind test
         / ekind                  ; (q) via-edge-kind test
         / "!!" name              ; (q) yamlover-tag test (!!mix / !!var / !!set)
         / "format=" *fchar       ; (q) format test
kind     = "mapping" / "scalar" / "blob"
ekind    = "contain" / "ref"
fchar    = <any char except unescaped "]">
name     = 1*( nchar / "\" CHAR ) ; selects a string key; "\" escapes a metachar
nchar    = <any char except unescaped  / [ ] * & # ~ ? ! ( ) < > = |  or whitespace>
```

Bracket contents are disjoint by form — digits-only is the pointer index, `?` is the
position wildcard, everything else is a keyword test — so no lookahead is needed.

## 4. Steps and axes

### 4.1 `?` and `[?]` — wildcards

`?` as a segment matches **every string-keyed entry** of the current node; `[?]`
matches **every position** — and since every entry has a derived integer position
(`URIs.md` §one ordered container), `[?]` matches *all* entries, keyed or not,
including reverse-projected `~-` members. `?` is the keyed subset.

```text
/pets[?]/name      → the three pet names           (pets' entries are keyless)
/pets/?            → ∅                              (no entry of pets has a string key)
/playlist/?        → the keyed entries only         (title, encore)
/playlist[?]       → all five entries, in order
```

### 4.2 `...` — recursive descent

`...` fans out to the current node **and every contain-descendant** (descendant-or-
self, pre-order). It walks the containment spine **only**: a `*` ref is never crossed
nor yielded by descent — reaching through refs is what explicit steps (`?`, `[?]`,
names) are for. Since the spine is acyclic and finite, `...` always terminates.

```text
/...[blob]             → every blob in the document
/weird/...[scalar]     → /weird/cat\/dog/n
```

### 4.3 `~` — the reverse axis

The reverse axis reuses the authoring sigil: in a document, `~X: *a` *writes* the
reverse of relation `X`; in a query, the step `~X` *walks* it. (A `~`-prefixed path
segment is illegal in pointers — `~` is excluded from `nchar` — so this is free
syntax space, not an overload.)

> **Note (2026-06-12):** the *authoring* `~` forms are deprecated in data syntax in
> favor of path anchors (`~X: *P` ≡ `&P/X`, `~- *P` ≡ `&P[]` — `ANCHOR_REFACTOR.md`,
> `URIs.md` §`&`). The query axis here is **unchanged** — and once the migration
> window closes, `~` will mean "reverse" only in the query language, which removes
> the last data/query overload of the sigil. The axis walks the same edges however
> they were authored: forward, `~`-reverse, or anchor-created.

- `x/~name` — every holder of a `name`-labelled edge landing on `x`. Containment and
  `*` refs are the same relation kind (`URIs.md` §`~`), so both arrive.
- `x/~?` — every incoming edge, any label: "**what points here**" (find-usages),
  including the spine parent.
- `x/~-` — every holder of a **keyless** (positional) edge into `x` — the reverse of
  `- *x` membership, mirroring `~-` authoring exactly.

```text
/adam/cain/enoch/~enoch   → { /adam/cain, /adam/azura }    (both parents — the DAG)
/pets[1]/~manager         → { /humans[0] }
/pets[1]/~?               → { /, /pets, /humans[0] }        (deduped; / holds feline AND secondPet)
/fan/~-                   → { /favorites, /crew }           (one authored forward, one reverse — invisible)
```

There is **no outgoing-ref axis**: stepping through a name already dereferences
transitively (pointer semantics), enumeration is `?`/`[?]`, and the `[ref]` filter
(§4.4) restricts to ref-attached entries. Alternatives considered and rejected:
arrow sigils (`<-` / `->`) spend two more metachars for a worse read; XPath-style
named axes (`in::name`) are verbose and alien to the sigil family.

### 4.4 Filters

A bracket whose body is not digits (and not `?`) is a **filter**: a non-navigating
test over the current matches — those that fail drop out, those that pass continue
unchanged. Chained brackets AND. (In template terms, §5: a filter is a step that
tests without moving — the future comparison steps of §9 are the same category, over
scalar values.)

| Filter | Keeps a match when … |
|---|---|
| `[mapping]` `[scalar]` `[blob]` | the node is of that kind |
| `[contain]` `[ref]` | the edge that *produced* this match is containment / a `*` ref (vacuous at scope position) |
| `[!!mix]` `[!!var]` `[!!set]` | the node carries that yamlover tag |
| `[format=x-yamlover-tag]` | the node's `format` (authored or schema-derived) equals the text |

```text
/tags/genre/brevity/?[contain]   → the three sub-tags     (shortest-paper, one-word-answer, empty-body)
/tags/genre/humor/deadpan/?[ref] → the three member papers
/...[blob]                       → the five PDFs
```

## 5. Semantics — the template walk

A query denotes a **template**; evaluation transforms a set of **bindings**, each
`(path, node, via-edge)`:

1. **Start.** The context node (for the engine API: the node the query is asked at;
   for an authored pointer: the holding mapping) becomes the single initial binding.
   Scope forms move it first: `/` to the document root, `..` up, a link to its
   authority's root.
2. **Steps.** Each template step maps every current binding to zero or more
   successors: a name or `[n]` *navigates or fails* (≤1 successor); `?`, `[?]`,
   `...`, `~…` *fan out*; a filter *tests without moving*. A binding with zero
   successors leaves the walk; it does not fail the query.
3. **Success.** A binding that survives the whole template is a successful walk; its
   **capture** joins the result. In v1 the capture is always the final binding — the
   explicit capture sigil `!` (§9) generalizes exactly this point.

Concrete rules:

- **Result** = an ordered sequence of `(path, node)`, **deduplicated by canonical
  path** — path is identity in the store, and a node reached by several routes
  appears once. (A deliberate divergence from RFC 9535 nodelists, justified because
  the instance is a graph: routes multiply, identity doesn't.) Canonical paths use
  the string key where an entry is keyed, `[i]` where keyless, and keep the `//auth`
  prefix for link-scope results.
- **Order** = document order: pre-order over the containment spine, entries by their
  stored position, reverse-projected `~-` members after the container's own entries
  (lexicographically by member path — the `URIs.md` projection rule). Results sort
  by this total order regardless of the route that matched them.
- **Implicit dereference.** Stepping into an entry whose value is a pointer yields
  the *target* node, transitively and cycle-safely — exactly pointer resolution.
  `/playlist[?]` therefore yields `/pets[0]` for the `encore` entry, not a pointer.
- **Termination.** Every v1 query terminates: the template is finite, each fan-out
  is finite (`...` ranges over the acyclic spine; `~…` over stored edges), and
  pointer-following is cycle-safe. Stated once so every extension must re-earn it.
- **Anchors.** At scope position the pointer rule applies unchanged: a declared `&`
  anchor wins over a sibling key. Wildcards match **entries only** — an anchor name
  is reachable by explicit name, never by `?`.
- **`[?]` vs `?` overlap.** A keyed entry matches both; dedup absorbs it.
- **Link scope.** `//auth/…` evaluates only against mounted/grafted authorities
  (e.g. `//yamlover/…`, grafted into every served root). An unmounted authority
  yields the **empty result plus an "external" diagnostic** — a link is an
  identifier, not a fetch.
- **Empty vs error.** A syntactically valid query never errors at evaluation. A
  pointer-shaped query whose target is missing yields ∅ with a *dangling*
  diagnostic, aligned with the engine's `dangling` table: reported, never dropped.

## 6. Pointers are the singleton fragment

Every `URIs.md` production maps to itself:

| Pointer form | As a query | Result |
|---|---|---|
| `cat` | same text | the sibling entry's node, or ∅ |
| `../x` | same | parent, then key `x`, or ∅ |
| `/pets[1]` | same | document-root walk — `{ /pets[1] }` |
| `[2]` | same | position 2 of the current mapping |
| `//yamlover/tags/colors` | same | the grafted node, or ∅ + external |
| `chief` (a declared anchor) | same | the anchored node (anchor beats sibling key) |
| `weird/cat\/dog/n` | same | escaping unchanged — `{ /weird/cat\/dog/n }` |
| `\.\.` | same | the literal key `..`, or ∅ |

**Conformance obligations** for the evaluator milestone:

1. Every pointer case in `tools/engine/ts/test/resolve.test.ts` passes unchanged
   through the query evaluator: `eval(p)` is the singleton of the resolver's target,
   or ∅ exactly when the resolver reports unresolved.
2. For every pointer-shaped query `p`: `|eval(p)| ≤ 1`.
3. Erasure: the §3 grammar minus `(q)` alternatives is the `URIs.md` grammar.
4. Normalization invisibility: evaluating over the authored graph and over its
   normalized form gives identical results.
5. Determinism: results arrive in document order, stable across runs and re-indexes.

## 7. Idioms

Compositions of the primitives above — **not** new syntax:

| Want | Query |
|---|---|
| members of tag *T* | `T/?[ref]` (keyed-slug membership) or `T[?][ref]` (positional) |
| tags applied to node *N* | `N/~?[format=x-yamlover-tag]` |
| all tag nodes (the tag-picker) | `//yamlover/tags/...[format=x-yamlover-tag]` |
| find-usages of *N* | `N/~?[ref]` (drop `[ref]` to include the spine parent) |
| every blob under here | `...[blob]` |

## 8. Worked examples

Hand-traced against the shipped fixtures; expected results are complete lists, in
result order.

### `examples/06-tour.yamlover`

```text
/pets[?]/name        → /pets[0]/name, /pets[1]/name, /pets[2]/name        (Rex, Whiskers, Bubbles)
/pets/?              → ∅                                  (pets has no keyed entries)
/playlist[?]         → /playlist[0], /playlist[1], /playlist/title,
                       /playlist[3], /pets[0]             (encore deref'd to Rex)
/playlist/?          → /playlist/title, /pets[0]
/rating[?]           → /rating[0], /rating[1], /rating/scale, /humans[0]  (!!var fields; author deref'd)
/boss/~lead          → /team
/boss/~?             → /, /team                            (containment from /, ref via the &chief anchor)
/pets[1]/~?          → /, /pets, /humans[0]                (feline+secondPet both bind /; deduped)
/pets[1]/~?[ref]     → /, /humans[0]                       (spine parent filtered out)
/favorites[?]        → /pets[0], /fan                      (own entry first, then the ~- reverse member)
/fan/~-              → /favorites, /crew                   (normalization invisible: one authored
                                                            reverse, one forward into a !!set)
/weird/...[scalar]   → /weird/cat\/dog/n
/weird/cat\/dog/n    → /weird/cat\/dog/n                   (a pointer — singleton)
```

### `examples/58-genealogy-dag`

```text
/adam/cain/enoch/~enoch → /adam/cain, /adam/azura     (spine father + *-edge mother: the DAG)
/eve/?                  → /adam/cain, /adam/seth, /adam/azura   (her children, deref'd)
/adam/azura/~?          → /adam, /eve                 (her two parents: containment + eve's ref;
                                                       the authored ~azura folds into eve's forward edge)
/adam/azura/~?[ref]     → /eve
/adam/?                 → /adam/cain, /adam/seth, /adam/azura
```

### `examples/67-pdf-tags`

```text
/tags/genre/humor/deadpan/?[ref]   → /jaba00061-0143a.pdf, /1110.2832v2.pdf,
                                     /1105-2_abstract_….pdf          (the three members)
/tags/genre/brevity/?[contain]     → …/brevity/shortest-paper, …/brevity/one-word-answer,
                                     …/brevity/empty-body            (sub-tags, not members)
/tags/genre/brevity/?[ref]         → ∅                               (brevity links no papers directly)
/jaba00061-0143a.pdf/~?[ref]       → /tags/field/psychology/behavior-analysis,
                                     /tags/genre/brevity/empty-body,
                                     /tags/genre/humor/deadpan       (its three tags; equivalently
                                                                      ~?[format=x-yamlover-tag])
/...[blob]                         → the five PDFs (root children; the tags subtree holds none)
```

### `yamlover/tags` (the built-in palette — grafted, so link scope)

```text
//yamlover/tags/...[format=x-yamlover-tag]  → //yamlover/tags, //yamlover/tags/colors,
                                              …/colors/yellow, green, sky, mauve, pink, peach
                                              (descendant-or-self; the `color` scalars fail the
                                               format test — exactly the tag-picker's list)
//yamlover/tags/colors/?/color              → six hex scalars (…/yellow/color … …/peach/color)
```

## 9. Future directions (sketches — syntax reserved, constructs not yet normative)

The template-walk model (§5) was chosen for these. Characters `! ( ) < > = |` are
reserved metachars **now** (§2) so that none of the following changes the meaning of
any v1 query when it lands.

### 9.1 Comparison steps — values in the path

A segment beginning with an unescaped `<`, `>`, `=`, or `!=` is a **value test**: a
non-navigating step (the same category as §4.4 filters) that keeps a binding only if
it is a scalar satisfying the comparison.

```text
users[?]/age/>30      → the age values over 30      (walks to age, tests, returns the ages)
users[?]/sex/=female  → the matching sex values
```

Note the bare-name ambiguity this sigil resolves: `sex/female` is a *key step*
(navigate into `female`), so value equality must be spelled `=female`. Type
discipline (numeric vs string comparison, coercion) is deliberately unspecified
here — it is the bulk of the future design work.

### 9.2 Capture `!` — return something other than the walk's end

Like a regex capture group: `!` suffixed to a step marks **which binding is
returned** when the walk succeeds. The default capture is the final binding (§5);
`!` moves it.

```text
users[?]!/age/>30     → the USERS older than 30      (same walks as above, different capture)
```

One capture per template in this sketch; multiple captures are projection territory
(§9.4). Lexically `!` is a step suffix — distinct from `[!!name]` (a filter body)
and from yamlover's `!!tag` (value position, never a path).

### 9.3 Branching — parallel walks, logically joined

A parenthesized group is a **non-navigating test** built from sub-walks: each branch
is evaluated from the current binding as an existence test, the boolean operators
combine them, and the surviving bindings continue from *before* the group.

```text
users[?]!/(age/>30 && sex/=female)   → users matching both branches
users[?]/(age/>30 || vip/=true)      → ditto, either branch — and since a group does
                                       not move the walk, the users themselves return
                                       even without `!` when the template ends there
```

Negation is an open question: `!` is spent on capture — candidates (`not`, a
distinct sigil) are listed here so the tension is recorded; decision deferred.

### 9.4 Projection — deliberately not designed yet

Returning *shapes* (several captures, computed fields) rather than nodes. Named so
the result model stays honest: §5's "ordered sequence of captures" is the extension
point, and nothing in v1 may assume a capture is always a single node.

### Also deferred

Text/substring search on keys and scalar values; edge-kind refinements (querying
`back` vs folded edges — normalization invisibility would need an explicit escape
hatch); descent that crosses `*` refs (a closure with cycle questions v1 refuses).

## 10. Evaluator notes (non-normative)

The engine's store is already shaped for this (`tools/engine/ts/src/store.ts`):

- `~name` / `~?` / `~-` are single indexed lookups on `edge(to_path)` —
  `deriveInverses` exists precisely so incoming axes need no stored inverses.
- `...` is the `toc()` recursive CTE over `contain` edges.
- `[format=…]` / kind / `!!` tests read `node` columns (`format`, `type`, `meta`).
- Dedup-by-path and document-order are `GROUP BY`/`ORDER BY` over canonical paths
  and stored `pos`.

The evaluator's acceptance gate is §6's obligation list, run over the existing
pointer-conformance corpus.
