# TYPES — yamlover's type lattice (draft)

yamlover keeps **JSON Schema's `type`** and adds `binary`, `mixed`, `variant`. But its *one ordered
container* (`YAMLOVER.md` §4) lets a node carry a **self-value AND elements at once**, so the kinds
are not mutually exclusive boxes — a type is a **predicate over a node's shape**, and a node may
satisfy several at once. This document gives every type as such a predicate over **three facets**,
so adding fields to a node (e.g. `yamlover-annotations` onto a markdown string — `ANNOTATIONS.md`)
never flips its type out from under a consumer.

A type *is* a predicate, so JSON Schema's two boolean schemas are the bounds:

- **`true`** (`{}`) — accepts everything — the **top** `⊤`.
- **`false`** — accepts nothing — the **bottom** `⊥`.

Companion specs: `META.md` (schema vocabulary), `YAMLOVER.md` §4 (omni/mix), `QUERY.md` (the
`!!<…>` matcher), `ANNOTATIONS.md` (why omni nodes appear).

## 1. The three facets (the capability cube)

Every node is described by three independent **facets** — capabilities it may exercise:

| facet       | keyword    | meaning                                                   |
|-------------|------------|-----------------------------------------------------------|
| **value**   | `value:`   | a scalar **self-value** (the A axis — §2)                 |
| **keyed**   | `keyed:`   | **named** entries `key: …` (JSON `properties`/…)          |
| **ordinal** | `ordinal:` | **positional** entries `- …` (JSON `prefixItems`/`items`) |

A facet keyword takes a **sub-schema**, or **`false` to forbid** it; **omitting** it leaves it
**allowed (open)**. So the empty schema `{}` forbids nothing — that is `true`/`⊤`. Each facet ∈
{`false`, allowed} gives the **`2³` cube**; ordering corners by *capability-subset* **is** the
subtype lattice (`000` bottom, `111` top).

## 2. The value axis (A)

The self-value's type — JSON Schema kept, **not flat**: it has its own subtyping.

- **`null`** — the **singleton**: its only value is `null` (yamlover `~`, or a bare `a:`). A type
  that is also a value.
- **`boolean`** · **`number`** · **`integer` `<:` `number`** (`integer` = `number ∧ value ∈ ℤ`).
- **`string`** — refined by `format` (`text/markdown`, `text/x-latex`, …).
- **`binary`** (yamlover) — opaque bytes, refined by `format` (`image/png`, `application/pdf`,
  `int32/le`, …). YAML's `!!binary` (base64) is the same value.
- **`scalar`** = the alias `value: {type: [null, boolean, integer, number, string, binary]}` — "any
  leaf value." Closed (`scalar`, no fields) vs. the open **value facet** (§8) differ on omni nodes.

`format` is **not a type** — it refines a facet (usually `value`), with its own open sub-lattice
(§10).

## 3. The kinds as facet records

`false` clears a bit; an omitted facet stays open. The named kinds are shorthands:

| kind                                        | facet record                                         | bits  |
|---------------------------------------------|------------------------------------------------------|:-----:|
| `null`                                      | `{value: {const: ~}, keyed: false, ordinal: false}`  | `000` |
| a scalar (`string`, `integer`, `binary`, …) | `{value: {type: …}, keyed: false, ordinal: false}`   | `A00` |
| `object`                                    | `{value: false, ordinal: false}`                     | `010` |
| `array`                                     | `{value: false, keyed: false}`                       | `001` |
| `mixed` (`!!mix`)                           | `{value: false, keyed: {min: 1}, ordinal: {min: 1}}` | `011` |
| `variant` (`!!var`) ≡ `true`                | `{}`                                                 | `111` |
| value+keyed                                 | `{ordinal: false}`                                   | `110` |
| value+ordinal                               | `{keyed: false}`                                     | `101` |

> **`variant` ≡ omni ≡ `true` ≡ `⊤`.** The "permits any shape" formula is a tautology — every node
> is a `variant`. Do **not** read `variant` as the specific scalar-plus-fields *region*; as a
> *schema* it constrains nothing. The `!!var` surface tag *enables* that region but its type is
> `true`.

## 4. Presence — the `all` / `exists` quantifiers

The facet bit is *permission*; element **counts** are *presence*. This separates the two:

```
all keyed      →  ordinal: false        # no ordinal element may exist
exists keyed   →  keyed:   {min: 1}
all indexed    →  keyed:   false
empty          →  keyed: false, ordinal: false
```

So `object` (`value:false, ordinal:false`) permits keyed and *forbids* ordinal — "all keyed",
empty included (vacuously). `mixed` *requires* both (`{min: 1}` each).

## 5. The bottom — `null`, `{}`, `[]`

yamlover's surface offers exactly three empties, so the bottom is forced:

```
a:   ≡  a: ~   →  null            # the bare key IS null
a: {}          →  empty object
a: []           →  empty array
```

There is **no syntax** for an "empty container that is neither `null` nor a committed `{}`/`[]`",
so the abstract `000 = (no-value, no-keyed, no-ordinal)` corner has **no writable inhabitant** — it
collapses. Consequences:

- `empty object` ≡ `empty array` ≡ that corner — all reduce to `{value: false, keyed: false,
  ordinal: false}` (a container forbidding everything). One predicate, three spellings.
- **`object ⊓ array = 000`** — and yamlover names that bottom **`null`** (the bare `a:`). So `null`
  *doubles* as the empty/nothing; that is the one wart, inherent to `a:` meaning `null`.
- Which face an empty container shows JSON (`{}` vs `[]`) is the engine's **`is_array` flag** — a
  **serialization hint** (`concrete:`/projection), **not** a type fact.

## 6. YAML / collection types — refinements, not new corners

YAML's extra "types" are either a **value-axis type** or a **semantics flag** on a facet:

```yamlover
binary     →  {value: {type: binary, format: image/png}, keyed: false, ordinal: false}   # value axis
timestamp  →  {value: {type: string, format: date-time}, keyed: false, ordinal: false}    # value axis
set (!!set)→  {value: false, ordinal: {uniqueItems: true}}        # dedup-by-identity FLAG (META.md)
omap       →  {value: false, ordinal: false}                     # = object — yamlover maps are ALREADY ordered
pairs      →  {value: false, keyed: false,
              ordinal: {items: {prefixItems: [<key>, <value>]}}}  # ordered [k,v]s; keys may repeat
```

So a facet carries a small fixed set of **modifier keywords** beyond `false`/schema — `uniqueItems`
(set), `propertyNames`/key-uniqueness (omap vs pairs), ordering (yamlover's default) — almost all
kept verbatim from JSON Schema. `merge` (`<<`) and `!!value` (`=`) are *mechanisms*, not types.

## 7. Compound types & the algebra

`type: [ … ]` and JSON Schema's boolean combinators are kept — the full algebra over the facets:

```
T ∧ U          →  allOf: [T, U]
T ∨ U          →  anyOf: [T, U]
¬T             →  not: T
exactly one    →  oneOf: [ … ]          # one-hot — NOT XOR (parity also fires on the all-set corner)
```

```yamlover
# [object, array] — a container, either shape (excludes mixed)
value: false
anyOf: [ {ordinal: false}, {keyed: false} ]

# [scalar, object, array] — exactly one structural kind (excludes variant AND the empty bottom)
oneOf: [ {keyed: false, ordinal: false}, {value: false, ordinal: false}, {value: false, keyed: false} ]
```

`allOf: [object, array]` = `{value:false, keyed:false, ordinal:false}` = the empty bottom (§5). ✓

## 8. Relations between types (derived, not written)

Types are predicates, so **every Boolean relation** holds — and these are **judgments a validator
computes from the formulas**, not schemas you author:

| relation           | meaning                           | example                                            |
|--------------------|-----------------------------------|----------------------------------------------------|
| subtype `T <: U`   | `T ⇒ U`                           | `integer <: number`; everything `<: true`          |
| equivalent `T ≡ U` | `T ⇔ U`                           | `empty object ≡ empty array` (§5)                  |
| disjoint           | `T ∧ U ≡ false`                   | `object ⌿ scalar`; `variant`-region `⌿ object`     |
| overlap            | `T ∧ U` satisfiable, incomparable | `value-markdown` ⟂ `has-keyed` (meet = omni nodes) |
| complement `¬T`    | what `T` rejects                  | `¬scalar` = "no self-value"                        |

**Closed vs open** is *also* just the algebra: closed `string` = `{value: {type: string}, keyed:
false, ordinal: false}`; the **open value facet** = `{value: {type: string}}` (element facets left
open) — which *includes* an omni node that gained fields. This split is §9's whole point.

## 9. Matching — consumers carry their own type formula (renderers, in code)

The spec mandates neither open nor closed matching. A **consumer** (renderer, query, validator)
carries **its own acceptance formula** and claims a node **iff the node satisfies it** — *what it
doesn't test, it tolerates*. A renderer that wants markdown must not test the element facets, so a
node that gained `yamlover-annotations` still matches.

Today this is encoded **in code** (the registry; a declarative `!!<…>` form is future — §10). A
matcher reads the node's **type facets** (the value facet's `(type, format)`, and whether keyed /
ordinal elements exist):

```ts
type ScalarType = "null" | "boolean" | "integer" | "number" | "string" | "binary";

/** The facets a matcher inspects — the projection exposes these alongside the kind. `format`
 *  refines the value facet for scalars, or names the renderable SHAPE for a container. */
export interface TypeFacets {
  value: ScalarType | null;   // the scalar self-value's type — null = no value facet
  format: string | null;      // value-format (text/markdown, application/pdf) | shape-format (x-yamlover-chapter)
  keyed: boolean;             // has ≥1 named element
  ordinal: boolean;           // has ≥1 positional element
}

/** A consumer's acceptance — a hand-coded type formula. What it omits, it tolerates. */
export type Accepts = (f: TypeFacets) => boolean;

interface Renderer {
  name: string;
  accepts: Accepts;
  specificity: number;        // higher wins among matches; a stricter formula outranks a looser one
  render: (node: NodeJson) => JSX.Element;
}
```

Matchers — note each tests **format AND/OR facets**, and the tolerant ones simply never mention
`keyed`/`ordinal`:

```ts
// TOLERANT — a markdown VALUE facet, whatever the structure. This is the fix: it never tests
// `keyed`/`ordinal`, so a markdown chunk that gained annotation keys (an omni node) still matches.
const markdown: Accepts = (f) => f.format === "text/markdown";

// TOLERANT — a renderable container SHAPE by format, regardless of extra facets.
const chapter:  Accepts = (f) => f.format === "x-yamlover-chapter";

// a binary value-format (an omni-blob PDF — bytes + yamlover-annotations — still matches).
const pdf:      Accepts = (f) => f.format === "application/pdf";

// STRICT — only a bare string, no fields (a consumer that genuinely needs purity opts in).
const plainStrict: Accepts = (f) => f.value === "string" && f.format === null && !f.keyed && !f.ordinal;

// a plain object explorer — any keyed container with no special shape-format.
const explorer: Accepts = (f) => f.value === null && f.keyed && f.format === null;
```

Each matcher is the in-code image of a facet formula — e.g. `markdown` ≡ `{value: {format:
text/markdown}}` (element facets omitted ⇒ open ⇒ tolerant); `plainStrict` ≡ `{value: {type:
string}, keyed: false, ordinal: false}`.

Dispatch picks the **most specific** satisfied consumer:

```ts
export function pick(rs: Renderer[], f: TypeFacets): Renderer | null {
  return rs.filter((r) => r.accepts(f)).sort((a, b) => b.specificity - a.specificity)[0] ?? null;
}
```

Walk-through (the breakage, fixed): a `text/markdown` chunk gains `yamlover-annotations`. Its facets
become `{value: "string", format: "text/markdown", keyed: true, ordinal: false}`. The old registry
keyed on the exact tuple `(variant, text/markdown)` and missed. `markdown(f)` tests **only**
`f.format`, so it still returns `true` → the markdown renderer is chosen; the annotation layer
(`AnnotatedMaterial`) reads the `keyed` facet separately. A node also satisfying `plainStrict` would
be ranked by `specificity`.

This replaces the registry's exact `(type, format)` equality (the closed, intolerant form) with
per-renderer `accepts` predicates — the consumer decides its own tolerance, honoring **both** the
structural facets and `format`.

## 10. Status

Draft. Open: the **`format` sub-lattice** (`text/markdown <: text/plain <: string`? how `binary`
formats subtype); the declarative **`!!<…>` matcher grammar** for authoring a consumer's formula
(`QUERY.md`); and the **projection change** to expose `TypeFacets` (the value facet's `(type,
format)` + `keyed`/`ordinal` booleans) instead of today's single-tag `displayKind` (`node-kind.ts`)
— §9 needs at least the value facet surfaced beside the kind.
