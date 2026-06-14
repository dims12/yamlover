I am thinking to remove reversed key ~ syntax in favor of broader role and syntax of &

I noticed, that

```yamlover
child:
    ~child_name_in_another_parent: *path/to/another/parent
```

can be tha same as (if we allow path-like anchor names)

```yamlover
child: &path/to/another/parent/child_name_in_another_parent
```

If we additionally allow line wrap before anchoring

```yamlover
child:
    &path/to/another/parent/child_name_in_another_parent
```

it will even look close to reverse child syntax

We should also allow multiple anchors

```yamlover
child:
    &path/to/another/parent/child_name_in_another_parent
    &path/to/third/parent/child_name_in_third_parent
```

whe scalar yamlover would also allow this

```yamlover
&put/me/here/into/path
30
```

The line order doesn't matter, so we can write

```yamlover
30
&put/me/here/into/path
```

NB:

The order of scalar in !!var objects doesn't matter

```yamlover
30
- one
two: three
```

is the same as

```yamlover
- one
30
two: three
```

Yaml syntax of anchors is changed, so our language stops beind superset of yaml, but turning into improved yaml

```yaml
humans:
  - age: 30
    pet: &supercat
      species: cat
      color: pink
  - age: 10
    pet: *supercat
```

in yamlover will be

```yamlover
humans:
  - age: 30
    pet: &/supercat
      species: cat
      color: pink
  - age: 10
    pet: */supercat
```

I.e. anchors are real keys of current document

In yamlover `!!var` is default from now on (no more yaml compat)

Imported aliases like `yamlover` are real keys defined ot project level

```yamlover
yamlover: *https://yamlover.inthemoon.net/
```

We decide, what are we exporting from the project, currently it is only `$defs` so tha one can use

```yamlover
tags: !!<*//yamlover/$defs/tag> A small taxonomy for short / deadpan papers — two axes, field and genre
```

Ordinal memberships will be encoded with empty brackets

```yamlover
12
&/some/number/sequnce[]
```

or

```yamlover
12
&/some/number/sequnce[?]
```

Deprecate

```yamlover
~reverse
```

and

```yamlover
~-reverse
```

Collisions

Valid if they are equal, valids

```yamlover
some:
    path: &/another/path 12
        
another:
    path: 12
        
```

---

## Resolved 2026-06-12 — decisions & where they landed

This sketch is now **decided and spec'd** (this round was spec-only; implementation
is PLAN.md **Phase A**). The decisions:

1. **Scope: spec first.** The normative semantics live in `URIs.md` §`&` (path
   anchors, ordinal `[]`, multiplicity/placement, no anchor namespace, collisions)
   with surface treatments in `YAMLOVER.md` §2/§3/§4 and `JSON5P.md` §`&`; the
   parsers/engine still implement the old forms until Phase A lands.
2. **Ordinal membership = `&path[]`** (empty brackets, append semantics — the `~-`
   replacement). `[?]` stays query-only (`QUERY.md`), avoiding one token with two
   meanings; `&path[n]` (claiming a position) is rejected, as `~[n]:` was.
3. **`!!var` is the default; `!!mix`/`!!var` remain parseable as optional no-op
   markers** (existing files round-trip; `!!set` is NOT a no-op — it keeps its
   dedup semantics). The scalar value line may sit anywhere in its block, at most
   one per block; legal at the document root.
4. **`~` / `~-` are deprecated, not removed**: accepted through the migration
   window, serializers will emit anchors only. Equivalences: `~key: *P` ≡ `&P/key`,
   `~- *P` ≡ `&P[]`. The QUERY.md `~` reverse axis is unaffected.
5. **Imports/exports** (project-level keys like `yamlover: *https://…`, $defs
   export control) — **deferred to its own design round**; noted in PLAN.md.

Acceptance test for Phase A: the Chemical-Free blob's three `~chemical-free:`
lines round-trip as three path anchors producing the same three normalized edges,
and the two-line tagged-scalar file (`30` + `&//tags/…[]`) parses with the node
staying a plain `integer`.


