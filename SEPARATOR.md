# SEPARATOR — `:` replaces `/`; links vs queries; AWS-like URIs

Design round decided in conversation 2026-06-12/13 (follows the ANCHOR_REFACTOR.md
playbook; sections marked **OPEN** await a ruling). This supersedes the path grammar
of `URIs.md` and §2–§4 of `QUERY.md` — those documents get rewritten when the window
closes, not patched twice.

> **Dual window IMPLEMENTED (2026-06-13; 416+207 tests green).** Parsers accept BOTH
> separators (detection: an unescaped/unquoted `:` ⇒ colon form; `scheme://` stays
> legacy); the full ladder parses (`:`/`::`/`:::` — `:::` keeps a `world` flag on the
> link base so the rung re-emits); spacey keys must be quoted (enforced); colon-form
> anchors run to end of line. Serializers emit CANONICAL colon (spaced; compact in
> flow; same-line anchors quoted, own-line bare); round-trip identity is base+steps,
> not raw text. `mv` rewrites are STYLE-PRESERVING (colon-authored files get colon
> rewrites, legacy stay slash). The committed corpus is MIGRATED (16 files,
> span-surgical, edge-set-verified); 05-tour stays the plain-YAML baseline; untracked
> annotations keep parsing via the window. yaml-test-suite case W5VH (an anchor NAME
> containing `:`) reclassified diverges-by-design. NOT yet done: `/` still in the
> metachar set (leaves at window close); the authoring-time ARITY check (§5).
> The 3g EVALUATOR shipped 2026-06-13 on this grammar (matcher portions, the
> uplink family, `!!<…>` matchers — `engine/ts/src/query.ts`, `GET /api/query`,
> 77-case gate). M4 is IMPLEMENTED: store keys, API payloads and display are
> compact colon (`:team:alice:age`, root `:`, store schema v4); the browser URL is
> the one slash-transported surface, converted in client paths.ts.

> **Superseded in part 2026-08-01 (the YAML-keys round).** YAML conventions
> outrank the self-made index syntax: a **bare integer portion IS the integer
> key** — a position (`: pets: 1`; store `:pets:1`) — and the literal `[n]`
> reads forever as an alias, written never. A numeric STRING key is quoted
> (`'1':` in data, `: '1'` in paths; a PLAIN `1: v` is a parse error on the
> yamlover surface). The **null key** `~` is adopted from YAML (`: v` ≡ `~: v`,
> addressed by the bare `~` portion). Value tests are **operator-only** (`=31`,
> `=true`) and stand as their own portions — the bare-literal test and the
> `TEST step` combo of §4 are dead. This retires §3's "`[n]` attaches" rule,
> §4's `[n]` matcher row and bare-literal rows, and respells §5's arity table —
> all updated in place below, with the old spellings noted where they were
> normative. Surviving brackets are the non-literal position operators only:
> `&path[]`, `[?]`, `[.±k]`. Spec text: `URIs.md` (grammar, §The null key),
> `QUERY.md` §3–§4.

## 1. The idea

Colon is THE key marker of the JSON/YAML family: `key: value` means "this key leads
to that value". A path is the same statement, chained — so the path separator should
be the same character:

```yamlover
my:
  tiny:
    object: 12
  another: *tiny: object      # current scope: sibling `tiny`, key `object` → 12
```

`a: b: c` reads "key, leads to key, leads to key" — one meaning for the colon
everywhere. YAML's own lexical rule cooperates: a key/value colon requires a
following space, and yamlover adopts the same **styling**: the canonical emission is
`: ` (colon + space); a colon without the space also parses.

What `/` gains by leaving: it stops being a metacharacter, so MIME-type keys
(`text/html`), date keys (`01/02/2026`) and URL-ish keys ride bare in paths.

## 2. The scope ladder — more colons, wider scope

```
current: object: path                         # bare       — current scope
: document: rooted: path                      # :          — this document's root
:: project: rooted: path                      # ::         — this project's root
::: yamlover.inthemoon.net: $defs: tag        # :::        — the world
```

### AWS-like URIs (the `:::` scope)

A project's URI is an **identity, not a transport** — like an ARN
(`arn:aws:s3:::bucket`), it is a pure colon-chained name. This project's main URI:

```
::: yamlover.inthemoon.net
```

The DNS name is kept as the identifying authority; `https://`, ports, and paths-with-
slashes are gone from the identifier. How an engine *reaches* that project — https,
ssh, a local checkout, several sync mirrors of the same URI — is engine
configuration (the future multi-host sync), never part of the name. The old
`scheme://host/path` link form is retired with the slash; nothing remains in the
grammar that needs `//`.

Imports are root-level keys whose value is a world-scoped link:

```yamlover
yamlover: *::: yamlover.inthemoon.net
```

Inside this project the import is the project itself (the self-import), so
`:: $defs: tag` ≡ `:: yamlover: $defs: tag` — synonyms, as decided.

*Rejected alternative:* an ARN-faithful fixed first portion (`yamlover: inthemoon…`
mirroring `arn:`). The ladder needs no reserved word and keeps "more colons = wider"
as the single rule.

## 3. Portions, styling, quoting

- A path is a sequence of **portions** separated by `:`. Canonical styling writes
  `: ` after each separator; the space is optional on input.
- A **bare integer portion is the integer key** — a position: `: some: path: 12:
  with: ordinal`. *(Retired 2026-08-01, the YAML-keys round: the old rule here —
  "`[n]` attaches to a portion", `: some: path[12]` — is superseded; `[n]` reads
  forever as an alias, written never.)* A numeric **string** key rides quoted
  (`: '12'`), as do the `~` key-that-is-a-tilde, spacey, and empty keys.
- **Relative indexes** keep the bracket spelling: `[.]` / `[.-1]` / `[.+2]` —
  `.` is "my own position at this depth", an offset is arithmetic on it (the surviving
  bracket bodies stay disjoint by form: `.` = relative, `?` = wildcard, empty = anchor
  append; an absolute position is a bare-integer portion). The frame is
  the pointer HOST's own path, depth-aligned after `..` ascents: `*[.-1]` is my previous
  sibling; `*..[.-1][.]` is "previous row, my column" — the table merge idiom (`MARKLOWER.md`;
  full resolution rule in `URIs.md` §Relative indexes). Link-legal (§5); **rejected in `&`
  anchors** — a relative position claim is still a position claim (§7).
- **A key containing a space MUST be quoted** (decided): `: tags: 'дорожный знак'`.
  This is what keeps portion tokenization unambiguous. Quoting is the string
  quoting of the host surface (`'…'` / `"…"`).
- Escaping: `:` joins the metachar set — a literal colon in a key is `\:` (or the
  key is quoted): `schedule: 09\:30`. `/` has LEFT the set (the migration window
  closed 2026-07-24 — a slash never separates; `*/pets` is the literal key
  "/pets"). The literal keys `..` and `...` stay `\.\.` and `\.\.\.`.

## 4. Queries: matchers between the colons

A query portion is a **step** (move the walk) or a **test** (test the current node
without moving), colon-separated like any other portion. *(Retired 2026-08-01, the
YAML-keys round: the old "`[scalar_matcher] [key_matcher]` in one space-separated
portion" combo is dead — a test is a portion of its own.)*

**Key/position steps** (move the walk):

| form | meaning |
|---|---|
| `name` | exact key (the simplest form) |
| `12` (bare integer) | exact position — the integer key (`[n]` reads as an alias) |
| `~` | the null key |
| `?` | any string key |
| `[?]` | any position — all entries, incl. keyless and `[]`-memberships |

**Value tests** (test the current node's own value; ALWAYS carry an operator —
a bare integer is a position, a bare word a key step):

| form | meaning |
|---|---|
| `=12  =true  =null  =female  ='Анна Каренина'` | value equals the literal |
| `>30  >=18  <30  <=18  !=x` | comparison |

```
*: some: path: =12: myfield: continued    # node with value 12 AND key myfield;
                                          # the walk continues inside myfield
*: rating: =5: scale                      # 06-tour: rating is omni value 5 → scale (10)
*: users: ?: age: >30                     # standalone test: the ages over 30
```

**Metadata matchers** reuse yamlover's own `!!<…>` tag with the META vocabulary —
one test language for documents and queries:

```
*: ...: !!<type: binary>                  # every blob
*: ?: !!<type: variant>                   # omni nodes
:: tags: ...: !!<format: x-yamlover-tag>  # format test
:: ...: !!<*:: $defs: tag>                # schema-conformance: every tag node
                                          # (the tag-picker query)
```

The bracket-keyword filters of the old QUERY.md draft (`[mapping]`, `[ref]`,
`[format=…]`) are gone — node tests are `!!<…>`; a position is the bare integer
portion, and the surviving brackets are the operators `[?]` / `[.±k]` / `[]`.

**RESOLVED (M1, 2026-06-13): v1 has NO edge-kind test** — a wildcard fan-out cannot
distinguish members (ref) from children (contain); the node-shape workaround
(`? !!<type: binary>` vs `? !!<*:: $defs: tag>`) covers the current corpus.
**Recorded hypothesis (the user's, for the future design):** the ref/contain split
is really a CONCRETE distinction — the same child is sometimes INLINED (the
yaml/instance concrete) and sometimes REFERENCED (the pointer concrete). Edge kind
would then be queried as a concrete test (META.md already has the `concrete`
keyword; cf. PLAN.md 2d per-node concrete), e.g. `!!<concrete: …>` — not a new
`edge:` pseudo-meta. Design it together with NodeMeta.concrete.

## 5. Links vs queries — the static arity classification

Every expression is classified **by its form alone** (the parser decides; no graph
needed):

- **Unambiguous** — every portion guarantees ≤ 1 successor, so the whole expression
  does. These are **links**: legal after `*` (an edge) and after `&` (an anchor).
- **Ambiguous** — at least one portion may fan out. These are **queries**: askable
  through the engine, **never authorable as an edge** — `something: *: team: ?` is a
  parse-time error ("ambiguous expression — a query, not a link").

| portion | class |
|---|---|
| `name`, a bare integer `n` (position; `[n]` reads as its alias), `~` (the null key), scope openers `:`/`::`/`:::`, import keys | unambiguous |
| `[.]`, `[.±k]` (relative index, §3) | unambiguous |
| `?`, `[?]`, `...` | ambiguous |
| every value test (operator-only) / metadata matcher | ambiguous |
| `key..`, `[]..`, `?..` (§6) | ambiguous |
| `..` (spine parent) | unambiguous — **RESOLVED (M2)**, see §6 |

**Future widening:** "static" can grow from syntax-only to **schema-aware** — a META
constraint proving "exactly one parent holds this relation" would admit `key..` into
links for conforming nodes. Syntax-only now; the classification point is designed so
only the table above changes.

## 6. The uplink family (replaces the `~` query axis)

```
: x: ..                  # up the containment spine — THE parent
: x: ?..                 # up to ALL existing parents (containment + refs/anchors)
: x: stepdaughter..      # up to the parent who knows me as `stepdaughter`
: x: []..                # up to the containers that hold me keyless ([]-memberships)
```

With this, `~` disappears from the query language too (it already left data syntax
in the anchor refactor): reverse navigation is the `..` family, fully mirroring the
downward forms — `name`/`?` down, `name..`/`?..` up; `?` is the ambiguity marker in
both directions.

The genealogy example, reclassified:

```yamlover
stepbrother: *: mother: daughter: stepdaughter..: son
```

contains `stepdaughter..` → **ambiguous → a query**, not authorable as a link until
a schema proves the step unique (§5). 

**RESOLVED (M2, 2026-06-13): the split is ACCEPTED** — `..` is the spine parent
(unambiguous, link-legal; the corpus stays valid), `?..` is all parents
(query-only). Noted for later: once edge kinds become queryable (the M1
hypothesis), an edge-qualified uplink could subsume/refine `?..`.

The uplink's downward twin is the **relative index** (§3): after `..` ascents, `[.±k]`
re-descends *aligned to the host* — up the spine, back down a neighboring column
(`*..[.-1][.]`, the table rowspan idiom).

## 7. Anchors, ordinals, the deprecated forms

```yamlover
boss: &: chief                 # path anchor, colon-styled
adam:
  cain:
    &: eve: cain               # "eve holds me as cain"
fan:
  &: favorites[]               # ordinal membership
  &: crew[]
thirty: 30
  &:: tags: whole[]            # the two-line tagged scalar, project-scoped
```

Anchor paths must be **unambiguous** (§5) — they create real keys; this subsumes the
existing "no position claims" rule (a position tail — bare `3`, old `[3]` — was already rejected; matchers
and wildcards are now rejected by classification).

**RESOLVED (M3, 2026-06-13):** the quoted same-line form is ALLOWED
(`path: &': another: path' 12`), but the CANONICAL style puts anchors on their own
lines in the node's block, after the value:

```yamlover
path: 12
  &: another: path
```

Serializers emit this form; the parser accepts both (own-line tokens run to EOL).

## 8. Result model (settled rulings folded in)

- **Order = entry order** (the O1 ruling): members of a container arrive in the
  container's document order; a deref'd member keeps its position — `: playlist[?]`
  yields Intro, Verse, Greatest Hits, Chorus, then the deref'd `: pets: 0`, in that
  order. There is no global re-sort by path.
- **Wildcards see anchor-created entries** (the O2 ruling): `?`/`[?]` enumerate keys
  grafted by keyed anchors and members appended by ordinal anchors alike; dedup by
  canonical path absorbs a node reachable both ways.
- Dedup by canonical path; implicit transitive deref; ∅-with-diagnostic (dangling /
  unmounted-world) instead of evaluation errors — all as in QUERY.md §5, restated
  here because the §5 "anchor precedence" wording is stale (the rule was deleted in
  the anchor refactor) and the "sort by document order" wording is corrected by O1.

**RESOLVED (M4, 2026-06-13):** canonical paths are COMPACT colon (`:team:alice:age`)
on every machine surface — the STORE keys themselves (the user: "change in the
database too — no sudden escaping/conversion problems"), API payloads, and the
breadcrumb/display. The BROWSER URL alone stays slash-transported (`/team/alice` —
"we don't have a choice here"), converted at the client path boundary. Store schema
bumped (v4) — on-disk indexes regenerate.

## 9. Migration sketch (implementation round, after this doc is approved)

Same playbook as the anchor refactor — a **dual window**:

1. Parsers accept BOTH separators (`/` deprecated, `:` canonical); the arity
   classification lands at the same time (ambiguous-after-`*` becomes an error —
   the corpus contains none).
2. Serializers emit `:` with spaced styling; the corpus migrates by re-emission
   (tours, genealogy, 67, bodies, annotations) plus comment passes.
3. Store canonical paths, `rewrite.ts` path rendering, server path utilities, the
   URL surface (the browser URL stays slash-transported, translated at the
   path-encoding boundary — or adopts colons; decide with M4), JetBrains lexers.
4. `/` leaves the metachar set only when the window closes; until then `\/` keeps
   parsing.
5. THEN 3g: `query.cases.ts` regenerated in colon syntax (the 68 cases carry over
   mechanically; the `~`-axis cases respell as the `..` family), and the evaluator
   is built against the new grammar once.

## 10. Supersedes / interacts

- `URIs.md`: the pointer grammar §, scope ladder, escaping table, link scope.
- `QUERY.md`: §2 lexical extensions (`?` stays; `~` axis removed), §3 grammar,
  §4 axes/filters (matcher portions replace them), §5 order + anchors wording.
- `ANCHOR_REFACTOR.md`: unchanged semantically; anchor spellings restyle.
- Layout: the project-URI model here is what motivated removing the `yamlover/`
  wrapper directory ($defs at the project root; the engine grafts the `yamlover`
  self-import key — executed alongside this doc).
