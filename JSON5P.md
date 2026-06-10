# json5p — JSON5 + pointers

**json5p** is one of yamlover's full-graph *concretes* (storage surfaces): the
brace-notation surface over the shared pointer model. It is a strict superset of JSON5,
which is itself a strict superset of JSON:

    JSON  ⊂  JSON5  ⊂  json5p

So anything you can write in JSON or JSON5 is already valid json5p; json5p only **adds**
the pointer layer — the `*` dereference family, keys-as-pointers, `~` back-edges, and
`&` anchors. This document specifies the json5p *concrete syntax*. The pointer grammar it
embeds is defined once in `URIs.md`; the abstract model both produce is `IR.md`.

File extension **`.json5p`**; suggested media type `application/json5p`.

## 1. Everything from JSON5

json5p inherits all of JSON5 verbatim. The features that matter most in practice:

| Feature | Example |
|---|---|
| Line + block comments | `// note` &nbsp; `/* note */` |
| Unquoted object keys (ECMAScript identifiers) | `name: 1` |
| Single **or** double quotes | `'a'`, `"a"` (interchangeable) |
| Trailing commas | `[1, 2, 3,]`, `{a: 1,}` |
| Hex numbers | `0xDECAF` |
| Leading / trailing decimal point | `.5`, `5.` |
| Explicit sign, `Infinity`, `-Infinity`, `NaN` | `+42`, `Infinity`, `NaN` |
| Multiline strings (escaped newline) | `'one \`<br>`two'` |

Because `'` and `"` are **interchangeable** string delimiters in JSON5, they carry *no*
semantic distinction — which is why pointer escaping is backslash-based, not quote-based
(see §4).

## 2. The pointer extension

### `*` — dereference (in value position)

A value may be a **pointer**: the sigil `*` immediately followed by a string literal
whose contents are a pointer expression.

```json5p
{
  pets: [ { name: 'Rex' }, { name: 'Whiskers' } ],
  feline: *'pets[1]',          // a shared edge to pets position 1 — NOT a copy
}
```

`*` is the **only edge-creator** beyond containment. Resolution yields a **graph edge**,
not a copy: the target node is *shared*. It is lazy and cycle-safe — a `*` is never
expanded inline.

### Keys are pointers; `[n]` vs `/x`

Every key is addressable, so it can be a `*` target. Arrays and objects are the **one
ordered container** (see `URIs.md`): a position is an **integer key**, a name is a
**string key**, and the two access forms are kept apart:

- **`[n]`** selects the **integer key** `n` (a position) — `*'pets[1]'`.
- **`/x`** selects the **string key** `x` — `*'pets[1]/name'`.

The brace/bracket surface is still ordinary JSON5 (`{…}` objects, `[…]` arrays); the
*semantics* is the single ordered mapping.

### Scopes (where a pointer starts)

A leading sigil sets the base; with none, the base is the **current mapping**. Full rules
in `URIs.md` — summarized:

| Form | Base |
|---|---|
| `*'name'`, `*'../x'` | current mapping / its parents (`..`) |
| `*'/…'` | current **document** root |
| `*'//auth/…'`, `*'scheme://auth/…'` | a **link** — any *other* start (project, sibling doc, external); a **virtual identifier**, scheme ignored, never fetched |

### `~` — back-edges (in key position)

A key prefixed with `~` is the **reverse** of the forward relation named by the key. The
`~` is a **sigil that sits *outside* the key**, so the key part is written normally —
unquoted if it is an identifier (`~cain`), or quoted if it needs to be (`~'odd/key'`). The
quotes wrap the key, **not** the sigil.

```json5p
{
  eve:  { cain: *'/adam/cain' },   // forward:  eve --cain--> the shared node
  adam: { cain: { ~cain: *'/eve' } },  // reverse of eve's cain-edge -> eve  (~ outside the key)
}
```

(`~name` is a json5p extension — JSON5 keys are identifiers or strings; the `~`/`&`/`*`
sigils are exactly what json5p adds on top.)

A `~` edge is up / non-owning (not part of the containment spine), never expanded inline,
and materializes on a filesystem as a symlink. The graph is **kept exactly as written** —
author the forward edge, its `~` reverse, or both; the engine's `normalize` reduces a pair
to forwards-only.

### `~*` — reverse *positional* membership (keyless)

The keyless counterpart: a member of an object or array of the form **`~*'…'`** — the
sigil tight against a pointer, no key, no colon — declares that the pointed-at container
holds a positional element pointing back at this node (yamlover spells it `~- *…`; json5p
has no `-` marker, so the sigil prefixes the pointer directly):

```json5p
{
  my_node: {
    name: 'x',
    ~*'/some/other/location',   // ⇒ that container has an element pointing at my_node
  },
}
```

It is **unpositioned** (a member never claims the container's order — no reverse index)
and **additive**: with no label and no index there is no identity to dedup on, so each
declaration adds one element, even alongside a forward element pointing at the same node —
unless the container's metadata says `uniqueItems: true` (the schema-keyword route to set
semantics; json5p has no tags, so yamlover's `!!set` is unavailable here). Full semantics
in `URIs.md` §`~-`.

### `&` — anchors (in value position)

`&name` declares an **anchor** — a reusable name for the value that follows — and `*name`
references it (the YAML idea, added to JSON5). An anchored node is *shared*, not copied:

```json5p
{
  boss: &chief { name: 'Rex', species: 'dog' },
  team: { lead: *'chief' },   // same node as boss — a shared edge, not a copy
}
```

Anchors are **intra-document** and name-only (no paths); anything cross-position or
cross-document is the job of `*` with a scope (`/`, links). Precedence follows `URIs.md`:
a declared anchor wins, else `*name` is a structural sibling pointer. Both surfaces share
`&`; only `*` differs — unquoted in yamlover (`*chief`), a quoted string in json5p
(`*'chief'`).

## 3. One container, no schema

- **Ordered mapping only** — no separate list/dict type at the model level, even though
  the surface keeps JSON5's `[]`/`{}`. Order is data: it follows text order in the file.
- **Instance-only** — json5p stores data + pointers, never schema. Validation is a
  separate, deferred layer (see `PLAN.md`).

## 4. Escaping: two layers

A literal key may contain a metacharacter (`/ [ ] * & # ~ \` or the segment `..`). It is
escaped with a **backslash inside the pointer expression**. But the pointer lives inside a
**JSON5 string**, which has its *own* backslash escaping — so a literal backslash reaching
the pointer layer must be written `\\` in the source string:

```json5p
{
  'odd/key': { n: 1 },
  oddRef:  *'odd\\/key/n',   // JSON5 'odd\\/key/n' -> pointer text  odd\/key/n
                             // -> first segment is the literal key "odd/key", then /n
  dotsRef: *'\\.\\.',        // -> pointer text  \.\.  -> the literal key ".." (not parent)
}
```

Rule of thumb: **one** backslash escapes a metachar at the *pointer* layer; write **two**
in the JSON5 string to deliver one backslash through the *string* layer.

## 5. Relationship to the rest of the system

- **IR** (`IR.md`): a json5p object/array → `Mapping` (ordered entries); a `*` value →
  an `Entry` with `edge:"ref"` carrying an unresolved `Pointer`; a `~`-key → `edge:"back"`.
  Positions are the derived integer keys (array index), not double-stored.
- **Engine** (`ENGINE.md`): a parsed json5p document populates `node`/`edge`; the resolver
  walks pointers lazily over the graph.
- **Sibling concrete** (`yamlover`): the indentation / filesystem surface over the *same*
  model — `*`, `~`, `[n]`/`/x`, scopes are identical; it additionally has `&` anchors and
  the directory + `body.yamlover` overlay.

## 6. Worked example

The supersession is shown as three single files over the **same dataset**:

- **`examples/01-tour.json`** — strict JSON: the data, fully spelled out, no sharing.
- **`examples/02-tour.json5`** — JSON5 ergonomics (comments, unquoted keys, trailing
  commas, hex/`Infinity`/`NaN`) — still no pointers, so a shared node is a *copy*.
- **`examples/03-tour.json5p`** — json5p: the same JSON5, now with `*` pointers (the
  copy becomes a *shared edge*), `~` back-edges, scopes, and escaping. The inline comments
  are themselves a json5p (JSON5) feature.
