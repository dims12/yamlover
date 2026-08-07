# PRIOR-ART — the omnivorous node, surveyed

Companion to `docs/language/vs-yaml/mixtures` (*One ordered container*), `IR.md` (the model being
claimed), `docs/language/model/facets` (`variant` / the `omni` top type), and
`tools/parser/YAML-CONFORMANCE.md` (how far the YAML surface is actually shared).

> **Why this doc.** Surveyed 2026-07-30, in answer to a direct question: *has the yamlover
> node been invented before?* The short answer is that every **ingredient** has decades of
> prior art, two human-readable formats already carry the same triple, and YAML's own type
> repository ships scalar-plus-mapping. What survives the survey is **narrower and sharper**
> than "omnivorous elements" — §5. Nothing here blocks the work (§7: no patents exist to
> clear), and none of it is a defect in the design. It exists so that the claim we make in
> public is the one we can defend when someone arrives with a link to KDL.

---

## 1. The claim under test

From `docs/language/vs-yaml/mixtures`, an untagged yamlover node may carry, at once:

- **at most one own scalar value** (its self-value, at any line position in the block),
- **keyless entries** — positional, the `- item` spelling,
- **keyed entries** — `key: value`,

and a keyed entry **also occupies a position**: `*playlist: 2` and `*playlist: title` resolve
to the *same* node. There is no separate list type and no separate dict type.

That bundles two independent properties, and they must be tested separately, because the
prior art differs sharply between them:

| | property |
|---|---|
| **(O) omnivory** | one node carries a scalar **and** children simultaneously |
| **(U) unification** | ordered and keyed children are **one** compartment over **one** entry set — not two side-by-side compartments |

## 2. Verdict

| Property | Earliest / closest prior art | Novel? |
|---|---|---|
| (O) alone | SGML **mixed content**, 1986; XML 1998; DOM `Node` (text + children + attributes) | **No** — canonical |
| (O) + (U) with children and keys in **separate compartments** | XML (attributes vs child elements), SDLang ~2005, KDL 2021, JCR 1.0 | **No** — SDLang and KDL are direct hits |
| (O) on the **YAML** surface specifically | YAML 1.1 `!!value` / the `=` default key | **No** — YAML's own type repository |
| (U) with keys **disjoint** from positions | Lua tables 1993, PHP arrays, BSON, libucl, Windows registry keys | **No** — widespread |
| (U) where a keyed entry **also** occupies a position | XML child elements (reachable by name *and* by index) — but names are **non-unique**, and the unique-keyed compartment (attributes) is scalar-only and unordered | **Partly** — no exact match found |
| (O) + (U) together, **unique keys**, on YAML's indentation surface | *nothing found* | **Yes** — but this is a much narrower claim than "omnivorous elements" |

## 3. The prior art, by family

### 3.1 SGML → XML → DOM → XDM (1986 →)

The original omnivore. An element carries **attributes** (keyed, unique), **child elements**
(ordered), and **text content** (scalar) — all three at once, and "mixed content" is
precisely a scalar interleaved with children. The DOM formalises exactly the two child kinds
yamlover names: `NodeList` (ordered) and `NamedNodeMap` (keyed). XPath/XQuery's XDM gives the
same node a typed value *and* children.

**Where it differs:** attributes are scalar-only (they cannot nest) and unordered, so XML has
*two* compartments, not one. Child elements are ordered and name-addressable — genuinely (U)
— but names are not unique, so `foo/title` is a node-set, not a node. The attribute-vs-element
choice is the eternal XML design argument; yamlover's answer is to delete the distinction.

### 3.2 SDLang (~2005) and KDL (2021) — the direct hits

**[SDLang](https://sdlang.org/)**: "a tag can contain a namespace, a name, a **value list**,
**attributes**, and **children**. For values and child tags order is significant and
duplicates are allowed; for attributes order is not significant and duplicates are not
allowed." That is the same triple, in a human format, twenty years ago.

**[KDL](https://kdl.dev/spec/)**, whose data model reads: a node has a name, *a list of
arguments*, *a set of properties*, *a list of children* — explicitly designed as "XML
semantics, YAML ergonomics".

**Where they differ:** both keep three separate compartments, and arguments/properties hold
*values*, not nestable children. Both use braces, not indentation. Neither claims YAML
kinship at the syntax level.

### 3.3 YAML already ships the scalar-plus-mapping node

The [`!!value` type and the `=` default key](https://yaml.org/type/value.html), YAML 1.1,
exists for exactly this: *"it is useful to evolve a schema so that a scalar value is replaced
with a mapping"* while keeping the scalar reachable. So (O)-on-YAML is prior art **inside
YAML's own type repository** — which also means our `!!var` shape has an ancestor to cite
rather than a competitor to fear.

### 3.4 One container for ordered and keyed (U), keys disjoint

- **Lua tables** (1993) — a single value with an array part and a hash part; integer and
  string keys in one container.
- **PHP arrays** — an ordered map where integer and string keys interleave and insertion
  order is preserved across both. The closest match to "ordered and keyed children
  interchangeably" *as a data structure*.
- **BSON / MongoDB** — an array **is** a document whose keys are `"0"`, `"1"`, `"2"`; the two
  are literally the same structure.
- **libucl / UCL** — a repeated key implicitly becomes an array.
- **Windows registry key** — an unnamed default value **plus** named values **plus** subkeys:
  (O) without ordering.
- **JCR / Jackrabbit** — properties plus *orderable* child nodes, two compartments.
- **Lisp property lists** (1960s) — one cons list holding a head, positional items and
  keyword pairs.

**Where they differ, and it matters:** in all of these the keyed and positional members are
*disjoint*. `['a' => 1, 2]` puts `2` at index `0`; `'a'` gets no position. yamlover's keyed
entry occupies a position **as well** — a stronger unification, and the one place the survey
came up empty.

### 3.5 One-node-type indentation formats

- **[OGDL](https://ogdl.org/spec/)** (2002) — nodes are strings, edges are space or
  indentation; every node has content *and* children, so (O) is unified by construction. Keys
  are just nodes whose child is the value, so keyed-vs-ordered is not modelled at all.
- **[Tree Notation](https://arxiv.org/abs/1703.01192)** (Yunits, ~2012) — one node type:
  content words plus indented children, keyed access via the first word, ordered by position.

## 4. The YAML-indentation lineage

"Inherits YAML's indentation" is a crowded field, in three distinct buckets:

| Bucket | Examples | Relationship to YAML |
|---|---|---|
| **Extends YAML from inside** | **[YAMLScript / YS](https://yamlscript.org/about/)** — a functional language whose syntax *is* YAML, by **Ingy döt Net, a YAML co-author**, compiling to Clojure, where "all valid YAML code is valid YAMLScript code"; plus ytt, Emrichen, Yglu, CloudFormation's `!Ref`/`!GetAtt` | Grammar untouched; meaning added through YAML's own tag and comment escape hatches. **The node model is never changed.** |
| **Reimplements the indentation, different model** | **[NestedText](https://nestedtext.org/en/latest/alternatives.html)** ("inspired by YAML, but eschews its complexity"; every leaf a string), StrictYAML (a subset), OGDL, Tree Notation | Syntax family resemblance, incompatible model — and the model is *simplified*, never widened. |
| **Indentation-significant, non-YAML lineage** | Haml, Sass (`.sass`), Slim, Pug, Stylus, CoffeeScript, Starlark, sweet-expressions (SRFI-110) | Python/Ruby ancestry; unrelated. |

The lesson for positioning: *a language built on YAML's indentation* is already claimed, by an
inventor of YAML. What nobody in either of the first two buckets does is **widen YAML's node
model** — bucket 1 keeps `scalar | seq | map` and layers semantics above it; bucket 2 forks the
syntax and shrinks the model. Adding a third node shape is the unoccupied move.

## 5. What is actually unclaimed

Not the omnivorous node. State the claim as the conjunction, which is what the survey could
not find:

> One node kind — self-scalar ⊕ positional entries ⊕ **uniquely** keyed entries in a
> **single** ordered compartment, where a keyed entry also holds a position — carried on
> YAML's indentation surface, with the pointer layer (`*` / `~` / path anchors) addressing
> both indices uniformly, and the same logical document projectable to a file **or** a
> directory tree.

Every clause is load-bearing. Drop "single compartment" and it is KDL. Drop "unique keys" and
it is XML. Drop the YAML surface and it is SDLang. Drop the pointer/concrete layer and it is
an incremental format. The defensible contribution is the **combination plus the machinery
built on it** — mixture tolerance as the default rather than an opt-in tag, the pointer graph,
the concrete projections, the editor — not the shape of the node.

## 6. What reviewers will attack

- **"This is KDL / SDLang / XML with different punctuation."** Answer with §5's conjunction,
  and cite KDL and SDLang *first, ourselves*. Volunteering the nearest prior art is what makes
  the narrow claim credible; letting someone else produce the link makes it look missed.
- **"You are calling it YAML."** The opening of `docs/language` already takes the correct posture —
  *"It is **not** a superset of YAML — it is a distinct, closely-related language"* — and
  should stay verbatim in every public description. Note the wording to align:
  `tools/parser/YAML-CONFORMANCE.md:3` says the parser is "a **superset of a subset** of
  YAML", which is true of the *parser's* accept set (43 of 208 must-accept suite cases read
  correctly today) but reads, out of context, as the superset claim the spec disclaims.
- **"Then a YAML parser can read my file."** It cannot, and that is deliberate: a stock YAML
  parser fed a mixture or a self-value either errors or reads a different value, and §3 of the
  spec reinterprets some YAML spellings on purpose. Compatibility is a *surface-familiarity*
  claim, never a round-trip one. YAMLScript bought round-tripping by never leaving the model;
  we bought the model by giving up round-tripping. Say which trade we took.

## 7. Patents and licensing — nothing to clear

None of the formats surveyed is patented. YAML itself never was: it is an open spec under a
permissive licence, where copyright covers the **spec text** (attribution and licence terms),
not the format or its ideas — which is exactly why it spread. Precedence in this field is
established by dated public publication and honoured by citation norms, not by a registry and
not by enforceable rights. Practical consequences:

1. **Nothing to license, nothing to infringe.** Implementing any construct above is free.
2. **Priority is protected only by publishing.** The dated spec files and their git history
   *are* the record; there is no further step to take and no filing to make.
3. **Cite generously.** The only real currency is attribution, and spending it costs nothing.

## 8. Sources

| Subject | Source |
|---|---|
| KDL spec & data model | <https://kdl.dev/spec/> · <https://github.com/kdl-org/kdl/discussions/183> |
| SDLang | <https://sdlang.org/> |
| YAML `!!value` / `=` default key | <https://yaml.org/type/value.html> |
| YAMLScript / YS | <https://yamlscript.org/about/> · <https://github.com/ingydotnet/yamlscript> |
| NestedText (and its own alternatives survey) | <https://nestedtext.org/en/latest/alternatives.html> |
| OGDL | <https://ogdl.org/spec/> |
| Tree Notation | <https://arxiv.org/abs/1703.01192> |
| DOM Level 1 (`NodeList` / `NamedNodeMap`) | <https://www.w3.org/TR/REC-DOM-Level-1/level-one-core.html> |
| JCR orderable child nodes | <https://developer.adobe.com/experience-manager/reference-materials/spec/jcr/1.0/7.1.11_Ordering_Child_Nodes.html> |
| Lua table array/hash parts | <https://luatic.dev/posts/lua-map/> |
