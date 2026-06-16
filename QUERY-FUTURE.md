# QUERY-FUTURE — proposed extensions to the query language

Forward-looking design, not commitments. Companion to `QUERY.md` (the shipped
language and its `§9` sketches), `SEPARATOR.md` (the COLON grammar this builds on),
`ENGINE.md` (the evaluator's home, `tools/engine/ts/src/query.ts`), `IR.md` (the
graph being queried).

> **Why now.** The evaluator shipped on the colon grammar and has its first consumers
> (tag-picker autocomplete; find-usages next). The recurring asks — *filter the TOC*,
> *find anything by name or content* — need capabilities the v1 language can't express:
> substring/regex matching, depth-bounded descent, and logical branching. This doc
> specs them **in the colon grammar** (QUERY.md `§2–§4` bracket syntax is superseded
> by SEPARATOR.md `§4–§6`), promotes QUERY.md `§9.3` branching from sketch to proposal,
> and proposes **retiring `...`** as a primitive in favor of a general repetition
> operator that subsumes it.

All examples use the colon grammar: `:` document scope, `::` link scope, `..` parent,
bare = current; portions separated by `:`; `?` any keyed entry, `[?]` any position,
`..` spine/uplink, `!!<type: …>` / `!!<format: …>` / `!!<*schema>` metadata matchers.

---

## 1. Repetition / controlled depth — the unifier

A **quantifier** suffix on the preceding portion or `( … )` group repeats it a bounded
or unbounded number of times. This is the headline construct: it generalizes descent,
ancestry walks, and any fixed-or-ranged traversal.

```
{m,n}     repeat m..n times (inclusive)
{m,}      m or more
{n}       exactly n
*         = {0,}      (zero or more)
+         = {1,}      (one or more)
```

`?` is **not** reused as the `{0,1}` quantifier — it is already the any-key portion
(ambiguity), so optional repetition is `{0,1}` spelled out. Newly reserved
metacharacters: `{ }` (a grep over `examples/` + `yamlover/` must confirm zero keys
contain them, per QUERY.md `§2`'s migration discipline; a literal becomes `\{`).

**Semantics.** A quantified pattern denotes the **union** over `k ∈ [m,n]` of the walk
that applies the inner pattern exactly `k` times. Results are deduplicated by canonical
path and returned in document order (QUERY.md `§5`), so overlapping depths collapse to
one node each. `k = 0` contributes the *current* binding unchanged (descendant-or-self
falls out of `*` / `{0,…}`).

```text
: (:?){2,5}            every node 2 to 5 keyed-levels below the document root
: team: (:?)+          every keyed descendant of team (one or more levels)
x: (:..enoch){1,3}     holders reachable by 1–3 hops of the reverse `enoch` edge
:: yamlover: tags: (:?)*: !!<format: x-yamlover-tag>   every tag, any depth (see §2)
```

**Termination.** Bounded forms (`{m,n}`, `{n}`) always terminate. Unbounded forms
(`*`, `+`, `{m,}`) terminate iff the repeated axis is finite under the visited-set:
over the acyclic CONTAIN spine, trivially; over a ref-crossing axis, because dedup by
canonical path + a finite node set bounds the walk (pointer-following is already
cycle-safe, QUERY.md `§5`). **Consequence:** the visited-set makes ref-crossing closure
safe — which QUERY.md `§9` "Also deferred" had punted on for cycle reasons. So a
repetition over `[?]` (which derefs) becomes a legal, terminating *transitive closure
across refs* — a genuinely new capability, not just sugar.

---

## 2. Retire `...` in favor of repetition

`...` (recursive descent: descendant-or-self over CONTAIN only, no deref, pre-order)
becomes a **special case** of `§1` and should be removed as a primitive.

Leading candidate (syntax TBD): **`(:?)*`** for the keyed case, **`(:[?])*`** to
include keyless (array) members. The `* = {0,}` supplies the *-or-self*; the inner step
supplies the fan-out.

**Two subtleties to settle before removal** — they are why this is a proposal, not a
mechanical rename:

1. **Contain-only vs deref.** `...` walks containment **and never crosses a `*` ref**.
   But the ordinary `?`/`[?]` steps **deref** when an entry's value is a pointer
   (QUERY.md `§5` implicit dereference). So `(:[?])*` is *ref-crossing closure*, which
   is **broader** than `...`. To replace `...` exactly we need a **contain-only child
   axis** (a non-dereferencing wildcard) to quantify — propose a distinct token, or a
   per-step "no-deref" modifier. The richer ref-crossing form is desirable too (it is
   the new capability above); both should be expressible, with clearly different sigils.
2. **Self-inclusion** comes from `k = 0`; confirm `(:?)*` at a leaf yields the leaf
   (matches `...` descendant-or-**self**).

**Migration.** Same dual-window method as SEPARATOR.md: (i) parse `...` as sugar for
the chosen canonical form; (ii) serializers emit the canonical form; (iii) rewrite the
`query.cases.ts` corpus and the QUERY.md idioms/examples; (iv) drop `...` from the
grammar once nothing emits it. The acceptance gate: every `...` case in
`query.cases.ts` produces an identical result through its replacement.

---

## 3. Regex matching — keys, values, or both

Substring is the degenerate case of regex; spec regex and get substring for free.

**Regex literal (syntax TBD):** `/pattern/flags` (JS `RegExp` dialect; `i`, `s`, …).
This depends on the `/`-window closing (QUERY.md frontier (iii) / SEPARATOR.md: `/`
leaving the metachar set), which frees `/` to delimit literals. If that lands later, a
fallback delimiter (e.g. `` `…` ``) is the contingency. A literal `/` inside the
pattern is `\/` as usual.

Three uses, mapping onto the existing portion taxonomy (navigate vs test):

- **Key regex (navigating fan-out).** A regex-literal *segment* matches every entry
  whose KEY matches — `?` narrowed by pattern:
  ```text
  : /^chap/            entries of the root whose key starts with "chap"
  : team: /alice|bob/  team members keyed alice or bob
  ```
- **Value regex (non-navigating test).** Extends the `§9.1` comparison family with
  `=~` (matches) and `!~` (does not); keeps a binding only if it is a scalar whose
  value matches:
  ```text
  : (:?)*: =~/poisson/i     every scalar anywhere matching /poisson/i (returns the scalars)
  : papers: [?]: title: =~/^On /   papers whose title starts with "On "
  ```
- **Both (key OR value).** Falls out of branching (`§4`) rather than new syntax —
  *the* query a TOC filter / quick-open box wants:
  ```text
  : (:?)*: ( /\Qfoo\E/ || =~/\Qfoo\E/ )   nodes whose key OR scalar value contains "foo"
  ```
  Open: testing a node's **own** key (the edge label from its parent) inside a
  non-navigating group needs an own-label test; spell out whether that is `..`-relative
  or a dedicated `&key` form. Record as design work.

**Engine note:** regex is not indexable (`§5`); leading-anchored patterns degrade to a
`LIKE 'prefix%'` fast path, everything else is FTS-prefiltered or a scan.

---

## 4. Branching — parallel walks, logically joined

Promotes QUERY.md `§9.3` to the colon grammar. A parenthesized group is a
**non-navigating test** built from sub-walks: each branch evaluates from the current
binding as an existence test; the boolean operators combine them; surviving bindings
continue from **before** the group (so the group filters, it does not move the walk).

```text
: users: [?]: ( age: >30 && status: =active )   users matching both
: users: [?]: ( age: >30 || vip: =true )         users matching either
```

Operators `( ) | ` and the comparison sigils `! < > =` are **already reserved**
(QUERY.md `§2`), so this lands without changing any v1 query. `&&`/`||` bind as usual;
parentheses nest. Capture (`§9.2`, the `!` suffix) selects which binding returns when a
group sits mid-template. **Negation stays open** — `!` is spent on capture; candidates
(`not(...)`, a distinct sigil) are recorded, decision deferred (as in QUERY.md `§9.3`).

---

## 5. SQLite indexing & performance

The store (`tools/engine/ts/src/store.ts`) is shaped for the v1 axes (QUERY.md `§10`);
these extensions add cost the index should absorb.

- **Depth-bounded descent → recursive CTE.** Today `descend()` is an N+1 walk (one
  child query per node, QUERY.md `§10`). `{m,n}` repetition maps cleanly to a
  `WITH RECURSIVE … depth < n` CTE over `contain` (or, for ref-crossing closure, over
  the unified edge set with a `visited` guard) — one statement, depth-pruned, instead
  of recursion in JS. This also speeds up plain `...`/`(:?)*`.
- **Containment closure table.** For frequent unbounded descent, a materialized
  `closure(ancestor, descendant, depth)` derived alongside the index turns
  descendant-or-self into a single indexed range scan; the FS-sync diff already knows
  which subtrees changed, so the closure can be maintained incrementally.
- **Text / regex on values → FTS5.** Regex can't use a btree index. Add an FTS5 table
  over scalar `value` (and optionally keys) so `=~`/substring prefilters to candidate
  rows, then the regex confirms. Leading-anchored patterns take a `LIKE 'p%'` index
  fast path instead.
- **Kind/format filters → covering indexes.** `!!<type: …>` / `!!<format: …>` read
  `node(type, format)`; add a composite index so format-filtered descents (the
  tag-picker query) don't scan. `edge(to_path)` already backs the reverse axes.
- **Key matching.** Exact key is a point lookup; key *regex* is a scan of a node's
  entries (small fan) or, for cross-tree key search, the same FTS/`LIKE` treatment.

Guidance: **measure first.** v1 latency is fine at current corpus sizes; add the CTE
when depth-bounded queries ship, FTS when value-regex ships, the closure table only if
unbounded descent profiles hot.

---

## 6. Reserved characters & interaction summary

| Construct | New metachars | Status before this doc |
|---|---|---|
| repetition `{m,n} * +` | `{ }` (`*`/`+` already exist) | new |
| retire `...` | — (removes a token) | new |
| regex literal `/…/` | `/` (freed by the `/`-window close) | pending window |
| value regex `=~ !~` | — (`! = ~` already reserved/used) | new operator |
| branching `( … && … )` | — (`( ) ! < > = \|` reserved, QUERY.md `§2`) | sketch → proposal |

Precedence/order to pin down: quantifier vs. trailing filter on the same step; whether
a quantifier may suffix `( … )` branch groups (it should — `(a|b){2,3}`); how capture
`!` composes with repetition.

## 7. Open questions

1. The contain-only child axis needed to replace `...` exactly (`§2`) — new token or a
   no-deref modifier on `?`/`[?]`?
2. Regex literal delimiter if the `/`-window slips (`§3`).
3. "Own key OR value" test for the filter idiom — own-label syntax (`§3`).
4. Negation in branching (`§4`).
5. Quantifier on reverse/ref-crossing axes: confirm the visited-set bound and document
   order over closures that revisit via multiple routes (`§1`).
