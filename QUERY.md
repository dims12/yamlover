# QUERY — the yamlover query language

Selectors over the instance graph. Companion to `URIs.md` (the pointer model this
language extends), `SEPARATOR.md` (the colon grammar and its rulings), `IR.md` (the
graph being queried), `ENGINE.md` (the evaluator's home), `QUERY-FUTURE.md` (the
proposed extensions).

> **Rewritten to the COLON grammar (SEPARATOR.md; evaluator shipped 2026-06-13).**
> A query is a bare colon-form pointer expression whose portions may be MATCHERS.
> The evaluator is `tools/engine/ts/src/query.ts`, exposed as `GET /api/query`; the
> acceptance corpus is `tools/engine/ts/test/query.cases.ts` (77 green) — every
> example below is taken from it verbatim. The old `/` separator, the `~` reverse
> axis and the `[filter]` brackets of earlier drafts are GONE from the language
> (reverse navigation is the `..` uplink family, node tests are `!!<…>` matchers).
> The dual-separator migration window is still open for *data* files — parsers
> accept legacy `/` paths there — but query strings are colon-only.
> First consumers: the breadcrumb query editor / filtered TOC, the tag-picker
> autocomplete; find-usages next (JetBrains J3).

JSONPath (RFC 9535) is the inspiration, but not the syntax: JSONPath's two core
sigils are already spoken for in yamlover — `*` is dereference and `..` is the parent
scope — and JSONPath has nothing to say about the graph (back-edges, incoming edges,
tag membership). So the constructs are rebuilt on the pointer grammar instead of
bolted beside it.

## 1. Design principles

1. **A query is a match template.** Evaluation *walks* the graph as the template
   directs; a walk that exhausts the template **succeeds** and contributes its
   result. Everything below — wildcards, descent, uplinks, matchers, and the future
   captures/branching (`QUERY-FUTURE.md`) — is one model: steps either *move* the
   walk or *test* it, and success returns a node. (Like a regex: the pattern visits
   the subject; what comes back need not be the last thing matched.)
2. **Strict superset of pointers.** Every pointer (`URIs.md` grammar) is a valid
   query, and evaluates to **at most one** result — its resolved target, or nothing
   if dangling. A query string is a *pointer expression*: the text that follows the
   `*` deref sigil in a document. (The `*` itself is the authoring embedding — it
   makes an edge; a query is asked, not authored, so it is written without it.)
3. **One lexical space.** Queries and pointers share one escaping regime and one
   metacharacter set (§2) — a key escaped for a pointer is escaped identically in a
   query, and vice versa.
4. **Queries see the normalized graph.** Evaluation is over the forwards-only view
   plus derived inverses (`ENGINE.md` `normalize`): a relation authored forward
   (`X: *b`), by an anchor (`&: a: X`), or both ways is **one edge**, and queries
   cannot tell which way it was written. The uplink family (§4.3) walks the same
   edges backwards however they were authored.

## 2. Lexical space

The metacharacter set is the pointer set of `URIs.md` (colon grammar):

```
: [ ] * & # ~ \          plus whitespace     — the pointer metachars
? ! ( ) < > = |                              — reserved for queries & extensions
```

A literal occurrence in a key is backslash-escaped (`\:`, `\?`, `\=`, …) or the key
is quoted: `: weird: cat\:dog: n`, `: tags: 'дорожный знак'`. A segment of exactly
three unescaped dots is the descent operator; the literal keys `..` and `...` are
written `\.\.` and `\.\.\.`. **A key containing a space must be quoted** — that is
what makes the matcher split inside a portion (§4.4) unambiguous.

`/` is **no longer a metacharacter** (it leaves the set when the migration window
closes): MIME-type keys (`text/html`), date keys (`01/02/2026`) and URL-ish keys
ride bare in paths — `: weird: cat/dog` is a plain two-portion path.

## 3. Grammar (ABNF-ish)

The `URIs.md` colon pointer productions, extended. Lines marked `(q)` are
query-only; **erasure property:** delete every `(q)` alternative and the grammar
that remains is exactly the `pointer` / `scope` / `portion` / `name` / `nchar`
productions of `URIs.md`. The authoring embeddings (`deref` / `define` — the `*`
and `&` *prefixes*) are deliberately absent: they make edges in a document; a query
is the bare pointer expression (§1.2). So is `relindex` (`[.±k]`, `URIs.md`
§Relative indexes): it resolves against the *host entry's* position — a link step —
and a query has no host frame, so a relative index in a query is rejected.

```
query    = base *( ":" portion )
base     = ":::" portion          ; the world: portion names the project URI/authority
         / "::" [ name ]          ; this PROJECT's root; a plain NAME portion is the
                                  ;   authority / import key (self-import absorbed) —
                                  ;   (q) a MATCHER portion instead applies AT the
                                  ;   project root (`:: ...: colors`, `:: ?`)
         / ":"                    ; this document's root
         / ".."                   ; parent node (a LEADING ".." only — §4.3)
         / portion                ; current scope: binds at the asking node
portion  = step                   ; move the walk
         / test                   ; (q) test the current node without moving
         / test SP step           ; (q) combo: test, THEN step (one portion)
step     = name [ index ]         ; exact key, with [n] suffixes folding in
         / index                  ; exact position
         / "?"                    ; (q) any string key            (§4.1)
         / "[?]"                  ; (q) any position              (§4.1)
         / name "[?]"             ; (q) key, then any position
         / "..."                  ; (q) descent: self + contain-descendants (§4.2)
         / uplink                 ; the ".." family               (§4.3)
uplink   = ".."                   ; spine parent (unambiguous — link-legal)
         / "?.."                  ; (q) ALL parents
         / "[].."                 ; (q) keyless holders
         / name ".."              ; (q) the parent who knows me as <name>
test     = valtest / meta
valtest  = number / "true" / "false" / "null"     ; (q) value equals the literal
         / ("=" / "!=" / ">" / ">=" / "<" / "<=") literal   ; (q) comparison
meta     = "!!<" metabody ">"     ; (q) metadata matcher          (§4.4)
metabody = "*" pointer            ; schema conformance
         / 1*( "type:" SP name / "format:" SP name )   ; META vocabulary
index    = "[" 1*DIGIT "]"        ; selects the integer key n
name     = 1*( nchar / "\" CHAR ) / squoted / dquoted
nchar    = <any char except unescaped  : [ ] * & # ~ ? ! ( ) < > = |  or whitespace>
```

Canonical styling writes `: ` (colon + space) between portions; the space is
optional on input. Bracket contents are disjoint by form — digits-only is the
pointer index, `?` is the position wildcard, `.±k` is the (link-only) relative
index — so no lookahead is needed. String value tests are always spelled with `=`
(`=female`): a bare word — quoted or not — is a KEY step.

## 4. Steps and matchers

### 4.1 `?` and `[?]` — wildcards

`?` as a portion matches **every string-keyed entry** of the current node; `[?]`
matches **every position** — all entries, keyed or not, *including* entries created
by anchors (`&: tags: whole[]` memberships — the O2 ruling). `?` is the keyed
subset. A query may open with a wildcard.

```text
team: ?              → :team:alice, :team:bob
pets: ?              → ∅                        (pets has only keyless entries)
pets[?]              → :pets[0], :pets[1]
pets[?]: name        → :pets[0]:name, :pets[1]:name
: tags: whole[?]     → :thirty                  (the &…[] membership, O2)
team: alice[?]       → :team:alice:age, :pets[0]   (all entries in order:
                                                    contain, then the deref'd ref)
```

`[n]` stays a pointer step: it addresses the container's own entry n and **never**
an anchor-created member (no position claims) — `: tags: whole[0]` → ∅.

### 4.2 `...` — recursive descent

`...` fans out to the current node **and every contain-descendant** (descendant-or-
self, pre-order). It walks the containment spine **only**: a `*` ref is never crossed
nor yielded by descent — reaching through refs is what explicit steps (`?`, `[?]`,
names) are for. Since the spine is acyclic and finite, `...` always terminates.
(`QUERY-FUTURE.md` §2 proposes retiring `...` in favor of a general repetition
operator; it is current syntax today.)

```text
...: !!<type: binary>            → every blob in the project
team: ...: !!<type: integer>     → :team:alice:age, :team:bob:age
: ...: !!<type: object>          → :, :team, … (descendant-or-SELF: the root itself)
thirty: ...                      → :thirty      (descent from a leaf is just self)
```

### 4.3 The `..` uplink family — reverse navigation

Reverse navigation mirrors the downward forms — `name` / `?` step down,
`name..` / `?..` step up; `?` is the ambiguity marker in both directions. (The old
`~` reverse axis is gone; `~` no longer appears in the language at all.)

| form | meaning | arity |
|---|---|---|
| `..` | up the containment spine — THE parent | ≤ 1, link-legal (M2) |
| `?..` | up to ALL parents: the spine holder + every ref/anchor holder | fan-out |
| `key..` | up to the parent who knows me as `key` | fan-out |
| `[]..` | up to the containers that hold me keyless (`&…[]` memberships) | fan-out |

A **leading** `..` is the parent *scope opener* (§3); later `..` portions are spine
steps. Containment and `*` refs are **one relation kind**: both arrive.

```text
: pets[0]: ..                    → :pets                    (spine only)
: pets[0]: ?..                   → :pets, :team:alice       (spine first, then ref holders)
: pets[0]: pet..                 → :team:alice              (the parent who knows me as pet)
: thirty: []..                   → :tags:whole              (the ordinal anchor, walked backwards)
: adam: cain: enoch: enoch..     → :adam:cain, :adam:azura  (both parents — the directed graph)
```

### 4.4 Matchers — tests between the colons

A query portion is `[scalar_matcher] [key_matcher]`, space-separated, both parts
optional but not both absent. A matcher standing alone is a **non-navigating test**:
bindings that fail drop out, those that pass continue unchanged. A `TEST key` combo
tests the current node, *then* steps.

**Scalar matchers** test the node's own value (scalars only):

| form | keeps a match when … |
|---|---|
| `12`, `true`, `null` | the value equals the bare literal |
| `=female`, `='Анна Каренина'` | value equals — the forced spelling for strings |
| `>30  >=18  <30  <=18  !=x` | the comparison holds (`>` family: both sides numeric) |

**Metadata matchers** reuse yamlover's own `!!<…>` tag with the META vocabulary —
one test language for documents and queries:

| form | keeps a match when … |
|---|---|
| `!!<type: T>` | T ∈ `binary array object string integer number boolean variant` (`variant` = a scalar with own fields — the omni shape) |
| `!!<format: F>` | the node's `format` (authored or schema-derived) equals F |
| `!!<*:: yamlover: $defs: tag>` | schema conformance — equivalent to the derived `!!<format: x-yamlover-tag>` |

There is **no edge-kind test** in v1 (the M1 ruling): a wildcard fan-out cannot
distinguish members (ref) from children (contain); node-shape matchers cover the
corpus (`?: !!<type: binary>` vs `?: !!<*:: $defs: tag>`).

```text
team: ?: age: >10                → :team:alice:age          (standalone test)
team: ?: age: 31                 → :team:alice:age          (bare number = equality)
pets[?]: species: =cat           → :pets[1]:species         (string equality needs =)
: rating: !!<type: variant>      → :rating                  (the omni node)
: rating: 5 scale                → :rating:scale            (combo: value 5 ✓, then step)
: thirty: 30 ..                  → :                        (combo: test, then step UP)
```

## 5. Semantics — the template walk

A query denotes a **template**; evaluation transforms a set of **bindings**, each
`(path, node, via-edge)`:

1. **Start.** The context node (for the engine API: the node the query is asked at;
   for an authored pointer: the holding mapping) becomes the single initial binding.
   The base moves it first: `:` to the document root, a leading `..` up, `::`/`:::`
   to the named authority's root.
2. **Steps.** Each template step maps every current binding to zero or more
   successors: a name or `[n]` *navigates or fails* (≤1 successor); `?`, `[?]`,
   `...`, the uplinks *fan out*; a matcher *tests without moving*. A binding with
   zero successors leaves the walk; it does not fail the query.
3. **Success.** A binding that survives the whole template is a successful walk; its
   **capture** joins the result. In v1 the capture is always the final binding — the
   explicit capture sigil `!` (`QUERY-FUTURE.md`) generalizes exactly this point.

Concrete rules (the O/M rulings of `SEPARATOR.md` §8 folded in):

- **Result** = an ordered sequence of `(path, node)`, **deduplicated by canonical
  path, keep-first** — path is identity in the store, and a node reached by several
  routes appears once. Canonical paths are COMPACT colon on every machine surface
  (`:team:alice:age`, root `:` — the M4 ruling); only the browser URL stays
  slash-transported.
- **Order = entry order** (O1): members of a container arrive in the container's
  document order, and a deref'd member keeps its position — `: playlist[?]` yields
  Intro, Verse, its title, Chorus, then the deref'd `:pets[0]`, in that order.
  There is no global re-sort by path.
- **Wildcards see anchor-created entries** (O2): `?`/`[?]` enumerate keys grafted by
  keyed anchors and members appended by ordinal anchors alike, after the container's
  own entries; `[n]` never addresses them (no position claims).
- **Implicit dereference.** Stepping into an entry whose value is a pointer yields
  the *target* node, transitively and cycle-safely — exactly pointer resolution.
  `team: alice: pet` therefore yields `:pets[0]`, not a pointer.
- **Termination.** Every v1 query terminates: the template is finite, each fan-out
  is finite (`...` ranges over the acyclic spine; uplinks over stored edges), and
  pointer-following is cycle-safe. Stated once so every extension must re-earn it.
- **Link scope.** `:: auth: …` / `::: uri: …` evaluate only against mounted/grafted
  authorities. **Self-import absorption:** inside a project, the `yamlover` import
  key is the project itself, so `:: X` ≡ `:: yamlover: X` — both reach the SAME real
  node. A bare `::` (or `::` followed by a matcher) binds the project root itself, so
  `:: ...: colors` descends the whole project — the grafted taxonomy included, which
  document-scoped descent (`: ...`) deliberately does not see (the ladder is honored:
  `:` is the document, `::` the project). An unmounted authority yields the **empty
  result plus an "external" diagnostic** — a link is an identifier, not a fetch.
- **Empty vs error.** A syntactically valid query never errors at evaluation. A
  pointer-shaped query whose target is missing yields ∅ with a *dangling*
  diagnostic, aligned with the engine's `dangling` table: reported, never dropped.

## 6. Pointers are the singleton fragment

Every `URIs.md` production maps to itself:

| Pointer form | As a query | Result |
|---|---|---|
| `cat` | same text | the sibling entry's node, or ∅ |
| `..: x` | same | parent, then key `x`, or ∅ |
| `: pets[1]` | same | document-root walk — `{ :pets[1] }` |
| `[2]` | same | position 2 of the current mapping |
| `:: yamlover: tags: colors` | same | the grafted node, or ∅ + external |
| `chief` (a declared anchor) | same | the anchored node — the anchor grafts a real root key |
| `: weird: cat\:dog: n` | same | escaping unchanged — `{ :weird:cat:dog:n }` |
| `\.\.` | same | the literal key `..`, or ∅ |

**Conformance obligations** (met by the shipped evaluator):

1. Every pointer case in `tools/engine/ts/test/resolve.test.ts` passes unchanged
   through the query evaluator: `eval(p)` is the singleton of the resolver's target,
   or ∅ exactly when the resolver reports unresolved.
2. For every pointer-shaped query `p`: `|eval(p)| ≤ 1`.
3. Erasure: the §3 grammar minus `(q)` alternatives is the `URIs.md` grammar.
4. Normalization invisibility: evaluating over the authored graph and over its
   normalized form gives identical results.
5. Determinism: results arrive in walk order, stable across runs and re-indexes.

## 7. Idioms

Compositions of the primitives above — **not** new syntax:

| Want | Query |
|---|---|
| members of tag *T* (embedded model) | `T: ?..: ?..: !!<type: binary>` — annotated materials reach the tag *forward* through their `yamlover-annotations`, so members are two uplinks away (array element, then its owner) |
| tags applied to node *N* | `: N: yamlover-annotations: [?]: !!<format: x-yamlover-tag>` — forward, N's own annotation array |
| sub-tags of *T* (not members) | `T: ?: !!<*:: yamlover: $defs: tag>` |
| all tag nodes (the tag-picker) | `:: ...: !!<format: x-yamlover-tag>` (project-wide, graft included) |
| find-usages of *N* | `N: ?..` (all parents: the spine holder + every ref/anchor holder) |
| every blob under here | `...: !!<type: binary>` |

## 8. Worked examples

Copied from the acceptance corpus (`tools/engine/ts/test/query.cases.ts`); expected
results are complete lists, in result order.

### `examples/06-tour.yamlover`

```text
: pets[?]: name       → :pets[0]:name, :pets[1]:name, :pets[2]:name
: playlist[?]         → :playlist[0], :playlist[1], :playlist:title,
                        :playlist[3], :pets[0]        (O1: encore, a deref'd member,
                                                       keeps its 5th position)
: playlist: ?         → :playlist:title, :pets[0]
: rating[?]           → :rating[0], :rating[1], :rating:scale, :humans[0]
                                                      (omni fields in entry order)
: rating: 5 scale     → :rating:scale                 (combo: value 5 ✓, then step)
: rating: !!<type: variant> → :rating
chief                 → :boss                         (&: chief grafts a root key)
: boss: lead..        → :team
: boss: chief..       → :                             (the anchor edge, walked backwards)
: boss: ?..           → :, :team                      (spine + graft dedup to :, then team.lead)
: pets[1]: ?..        → :pets, :humans[0], :          (spine first, then ref holders in edge order)
: fan: []..           → :favorites, :crew             (both &…[] memberships)
: favorites[?]        → :pets[0], :fan                (own entry first, then the member — O2)
: weird: cat\:dog: n  → :weird:cat:dog:n              (the query escapes the literal colon;
                                                       the store path is raw)
```

### `examples/58-genealogy-dag`

```text
: adam: cain: enoch: enoch..  → :adam:cain, :adam:azura   (spine father + the maternal
                                                           &: adam: azura: enoch edge)
: eve: ?                      → :adam:cain, :adam:seth, :adam:azura   (her children, deref'd)
: adam: cain: cain..          → :adam, :eve       (containment and refs are ONE kind:
                                                   the spine father also knows him as cain)
: adam: azura: ?..            → :adam, :eve       (her two parents; a both-ways pair folds)
: adam: azura: ..             → :adam             (spine only)
: eve: ?: ?..                 → :adam, :eve       (fan out, up, dedup)
```

### `examples/67-pdf-tags`

Tags here use the **embedded model**: a paper's tags live in its own
`yamlover-annotations` array — tags are DOWNSTREAM of the material, not parents.

```text
: tags: genre: humor: deadpan: ?..: ?..: !!<type: binary>
    → the three member PDFs                        (members of a tag: two uplinks)
: tags: genre: brevity: ?: !!<*:: yamlover: $defs: tag>
    → …brevity:shortest-paper, …:one-word-answer, …:empty-body   (sub-tags by shape — M1)
: tags: genre: brevity: ?: !!<type: binary>
    → ∅                                            (brevity links no papers directly)
: jaba00061-0143a.pdf: yamlover-annotations: [?]: !!<format: x-yamlover-tag>
    → its three tags                               (tags-on-node: FORWARD, format-filtered)
: jaba00061-0143a.pdf: ?..
    → :                                            (its only parent is the containment root)
: ...: !!<type: binary>
    → the five PDFs, in walk order                 (the tags subtree holds none)
```

### The self-import graft (`:: yamlover: …`)

```text
:: yamlover: tags: colors: ?                        → the palette tags (through the
                                                      virtual self-import key → real nodes)
:: yamlover: tags: ...: !!<format: x-yamlover-tag>  → THE TAG-PICKER QUERY
                                                      (descendant-or-self, format-filtered)
:: tags: colors: yellow                             → the same node (self-import synonymy:
                                                      ::X ≡ ::yamlover:X)
:: nowhere: x                                       → ∅ + an external diagnostic
```

## 9. Future directions

Live in **`QUERY-FUTURE.md`** (colon grammar throughout): repetition/quantifiers
`{m,n}` `*` `+` (subsuming `...`), regex matching `=~` / `!~`, branching
`( age: >30 && status: =active )`, the capture sigil `!`, projection, SQLite-backed
indexing. Of the old sketches here, **comparison steps have SHIPPED** (they are the
§4.4 value tests); capture and branching remain future. The characters
`! ( ) < > = |` (and `{ }` per QUERY-FUTURE.md) stay reserved so none of it changes
the meaning of a v1 query when it lands.

## 10. Evaluator notes (non-normative)

The engine's evaluator (`tools/engine/ts/src/query.ts`) runs over the Store
(`tools/engine/ts/src/store.ts`):

- `parseQuery` strips the scope opener, `splitPortions` splits on unescaped/unquoted
  `:` (with `!!<…>` atomic), `parsePortion` classifies each portion in the §3 order
  (descent, spine, uplinks, meta, combo, value test, pointer fragment).
- The uplink family (`uplinks`) is a set of indexed lookups over incoming edges —
  contain parents, `back`-edge containers, ref-source holders — filtered by label
  (`key..`), label-less (`[]..`), or unfiltered (`?..`); `deriveInverses` exists
  precisely so incoming axes need no stored inverses.
- `...` (`descend`) is the recursive walk over `contain` edges, pre-order by `pos`.
- `!!<…>` (`metaOk`) reads `node` columns (`format`, type shape, own-child presence
  for `variant`); `!!<*schema>` compares against the derived `x-yamlover-<name>`.
- Dedup-by-path keep-first and entry-order results come from walking own entries by
  stored `pos`, then anchor entries by holder path (`ownEntries` / `anchorEntries`).

The evaluator's acceptance gate is §6's obligation list plus the corpus
(`tools/engine/ts/test/query.cases.ts`), run over the existing pointer-conformance
fixtures.
