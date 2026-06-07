# yamlover — YAML + pointers (+ concretes)

**yamlover** is the indentation / filesystem surface over the shared pointer model — the
twin of `JSON5P.md`'s brace surface. It is a superset of YAML *in features*:

    YAML  ⊂  yamlover

Anything expressible in YAML has a yamlover meaning; yamlover **adds** the pointer layer
(the extended `*`, `~` back-edges, keys-as-pointers; `&` stays) and **adds concretes** —
the same logical document can live in one file *or* as a directory tree. Unlike json5p
(which is a clean strict superset of JSON5), yamlover **deliberately breaks YAML** in a few
spots, so it is *not* byte-for-byte conformant and needs its own parser (see §3, §9).

File extension **`.yamlover`**; a directory is the other concrete (§5).

## 1. Everything from YAML (kept)

yamlover keeps the YAML surface you know:

| Feature | Example |
|---|---|
| Block mappings & sequences | `key: value` / `- item` |
| Flow style | `{a: 1, b: 2}`, `[1, 2, 3]` |
| Comments | `# note` |
| Scalars (plain/quoted/folded/literal) | `a`, `'a'`, `"a"`, `>`, `\|` |
| `null` spellings, incl. `~` **in value position** | `key: ~`  → null |
| `&` anchors and `*` aliases | `&a {…}` … `*a` |

A YAML `- item` sequence entry is the same thing as a keyless `:` entry in the one-ordered
container (§4) — both are an entry with no string key.

## 2. What yamlover adds

The pointer layer, identical in meaning to json5p (grammar in `URIs.md`):

- **Extended `*` — dereference.** Beyond a plain anchor name, `*` takes a **pointer
  expression**: a path with scopes. Unquoted on this surface.
  ```yamlover
  feline: *pets[1]        # current mapping (a sibling) — a shared edge, not a copy
  manager: */pets[1]      # / = current document root
  remote:  *//pet.store.com/pets   # // = a link (any other start); scheme optional, never fetched
  ```
- **Keys are pointers; `[n]` vs `/x`.** Positions are integer keys (`*pets[1]`), names are
  string keys (`*pets[1]/name`). Arrays and mappings are the **one ordered container** (§4).
- **`~` — back-edges (key sigil).** A key prefixed with `~` is the reverse of the forward
  relation it names. The `~` is a **sigil outside the key**:
  ```yamlover
  adam:
    cain:
      ~cain: */eve        # reverse of eve's "cain" edge → eve   (~ = sigil, key = "cain")
  ```
- **`&` anchors — unchanged.** Exactly YAML anchors: a single intra-document name, no
  paths; `*name` reuses the node (precedence: a declared anchor wins over a sibling key).

## 3. Where yamlover deliberately breaks YAML

These are the *only* incompatibilities — everything else is YAML:

| Construct | YAML means | yamlover means |
|---|---|---|
| `*alias` | alias to anchor `alias` (name only) | **pointer** — a path/scope expression (`*a` still hits anchor `a` by precedence, but `*a/b`, `*/x`, `*pets[1]` are new) |
| `~key:` (key position) | the plain-scalar key `"~key"` | **back-edge** sigil on key `key` |
| `~` (value position) | null | **unchanged — still null** |

So a YAML file whose anchor names contain pointer metacharacters (`&a/b` … `*a/b`), or
whose **plain keys begin with `~`**, will read differently. Everything else round-trips.
This is the documented divergence set our conformance harness allowlists (see
`URIs.md` and the conformance notes).

## 4. One ordered container

No separate list/dict type. A mapping is **ordered**; positions are integer keys. A keyless
entry (a `- item` sequence element, or the `:` spelling) takes only its position; a keyed
entry's position is a `*`-alias to it. Access: **`[n]`** = integer key (position), **`/x`**
= string key. Order is data — text order in a file; for a directory, the `body.yamlover`
overlay imposes it (§5). Full treatment in `URIs.md` (*Lists and dicts are one ordered
mapping*).

## 5. Concretes: one file, or a directory

yamlover instances materialize two ways (same logical graph):

- **File concrete** — a single `.yamlover` file holds the whole instance (see
  `examples/06-tour.yamlover`).
- **Directory concrete** — a directory *is* the mapping: each file/subdir is an entry
  (filename → string key, bytes → a `Blob`/sub-document). Its `.yamlover/` holds up to two
  overlays:
  - **`.yamlover/body.yamlover`** — the *instance* overlay: adds scalars/pointers over the
    directory and — as a pointer-array (`- *file1 …`) — imposes child **order** (a bare
    directory takes filesystem order).
  - **`.yamlover/meta.yamlover`** — the *metadata* schema (types, `format`/decoding,
    `concrete`, presentation): a **JSON-Schema-equivalent written in yamlover**, used e.g.
    to say an on-disk blob is `type: binary, format: int32/le`. Metadata-first, validation
    optional — see **`META.md`**.

  The precise overlay-merge precedence (directory ∪ `body.yamlover`, plus `meta`) is the
  Phase 1c spec (`PLAN.md`); `<<:` (extended to `<<: *pointer`) is the explicit merge tool.

A file and a subdirectory are equivalent ways to represent the same node.

## 6. Escaping

Backslash-based, **not** quote-based (in YAML `'` and `"` are interchangeable, so they
cannot carry a literal-vs-interpreted distinction). A literal metachar (`/ [ ] * & # ~ \`
or the segment `..`) in a key is escaped with `\`:

```yamlover
weird: *../cat\/dog/x    # second step is the literal key "cat/dog"
dots:  *\.\.             # the literal key ".." (not the parent scope)
star:  *\*boss           # the literal key "*boss"
```

## 7. Scopes (summary)

Identical to json5p (full rules in `URIs.md`), only unquoted here:

| Form | Base |
|---|---|
| `*name`, `*../…` | current mapping / its parents |
| `*/…` | current **document** root |
| `*//auth/…`, `*scheme://auth/…` | a **link** — any other start (project, sibling doc, external) |

## 8. Relationship to the rest of the system

- **IR** (`IR.md`): a mapping/sequence → `Mapping` (ordered entries); a `*` value → an
  `Entry` with `edge:"ref"` and an unresolved `Pointer`; a `~`-key → `edge:"back"`; a `&`
  anchor is recorded for the resolver. Bytes in the directory concrete → `Blob` by hash.
- **Engine** (`ENGINE.md`): a parsed yamlover document/dir populates `node`/`edge`.
- **json5p** (`JSON5P.md`): the brace twin — same `*`/`~`/`&`, `[n]`/`/x`, scopes; differs
  only in surface (`*` is quoted there: `*'…'`) and in that json5p is a *clean* superset of
  JSON5, while yamlover breaks YAML per §3.

## 9. Worked examples & conformance

- **`examples/05-tour.yaml`** — plain YAML (the base): native `&`/`*` anchor sharing, no
  paths/`~`.
- **`examples/06-tour.yamlover`** — the same data with the full pointer layer.

Because yamlover is a *feature* superset (not byte-for-byte), the YAML conformance corpus
(`yaml/yaml-test-suite`) is run as **"accept all positive cases except a documented
divergence allowlist"** (§3), not 100% — see the conformance harness.
