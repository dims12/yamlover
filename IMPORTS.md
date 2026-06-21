# Exports & Imports — project linking

How one yamlover project references the nodes of another. Builds directly on the scope ladder
(SEPARATOR.md §2) and pointer resolution (URIs.md, resolve.ts) — an import is an ordinary pointer
key, nothing more. Transport (actually fetching a remote project) is **out of scope** here; this
spec defines the *naming and resolution* model. The one project that resolves with no transport is
yamlover itself, which ships bundled with the tool (§4).

## 1. Project identity — the URI

A project MAY declare a URI in its config, `<root>/.yamlover/settings.yamlover`:

```yamlover
uri: ::: yamlover.inthemoon.net
```

The URI is an **identity, not a transport** — an AWS-ARN-like pure colon-chained name
(SEPARATOR.md §2). The authority (`yamlover.inthemoon.net`) is what other projects name when they
import it. `how` an engine would reach that authority — https, ssh, a local checkout, a sync mirror
— is engine configuration, never part of the name. A project with no `uri` cannot be imported by
others (it can still import them).

The config parses `uri` from either a bare `::: host` scalar or a world pointer `*::: host`; both
yield the authority string (settings.ts `uriSetting`).

## 2. Exports — what a project offers

A project lists the paths it exports in the same config, as a sequence of pointer/query texts
(QUERY.md — a query is a generalized pointer):

```yamlover
exports:
- *:: $defs          # the hosted schemas
- *:: tags           # the tag taxonomy (palette + workflows)
- *:: $defs: config  # the config schema itself
```

Each entry names a subtree (or a query result set) that importers may reference. Exports are the
declared contract; reading is otherwise location-independent (a node is recognized by its schema
wherever it sits). For the bundled yamlover project the engine ships the exported taxonomy as data
regardless (§4) — the `exports` list documents the contract and drives any future transport.

## 3. Imports — naming another project

An import is an ordinary **root-level pointer key in `body.yamlover`** whose value is a world link:

```yamlover
# <root>/.yamlover/body.yamlover  (or the root document itself)
acme: *::: acme.example
```

Thereafter anywhere in the importing project the imported project is reached through its alias under
**project scope** (`::`):

```yamlover
usage: *:: acme: some: path: inside
```

Resolution is the existing two-step pointer walk (resolve.ts): step into the root key `acme`, then
follow its pointer value to the named project, then continue with the remaining steps. No new
mechanism — an import alias is just a pointer-valued key, and pointer-through-pointer following is
how every `*` chain already resolves.

Because transport is out of scope, a world authority that is **not mounted** (every authority except
yamlover's, §4) resolves to an `external` reference on a miss — a legitimate "elsewhere", not a
dangling error. Plain `::`-scope (intra-project) misses remain dangling typos, as before
(SEPARATOR.md §2; resolve.ts distinguishes `world` from project scope).

## 4. The yamlover self-import (bundled)

Every project implicitly imports the yamlover project under the alias `yamlover`:

```yamlover
yamlover: *::: yamlover.inthemoon.net
```

so that `*:: yamlover: $defs: …` and `*:: yamlover: tags: …` resolve from **any** served root. This
key is **implicit** — the engine injects it when absent — but a project MAY write it out explicitly
(the yamlover project itself does, for documentation). Writing it changes nothing; omitting it
changes nothing.

yamlover is the **one** authority that resolves with no transport: its exported taxonomy
(`$defs` + `tags`) ships as **package data**, copied to `dist/builtin-taxonomy/` at build and loaded
by the engine (mounts.ts), so a detached copy of any project — even one with no taxonomy of its own
— still resolves `*:: yamlover: tags: workflow: dev` and renders, validates, and tags correctly.

How the engine realizes the self-import (walk.ts), by where the taxonomy lives relative to the
served root:

| served root | how `yamlover` resolves |
|---|---|
| **is** the yamlover project (its own `$defs/`) | **de-materialized** — the `yamlover` key is dropped; `:: yamlover: X` is absorbed to `:: X` → the SAME real node (no duplicate taxonomy, no split backlinks) |
| a **subdirectory** of a project (taxonomy at an ancestor) | the live ancestor `$defs` + `tags` are grafted in-tree under `yamlover` |
| a **detached / foreign** dir (no taxonomy reachable) | the **bundled** taxonomy is grafted under `yamlover` |

In every materialized case the walk replaces the import *pointer* with the resolved *subtree*, so no
world pointer is left to dangle. The world form `*::: yamlover.inthemoon.net: X` is an alias for
`*:: yamlover: X` (resolve.ts / query.ts), so both spellings land on the same node.

**Until overridden.** A project may override the self-import by authoring its own `yamlover` key
pointing elsewhere (e.g. a pinned local checkout) — the engine leaves any non-yamlover-URI `yamlover`
key untouched. A project that defines its own `$defs/` taxonomy at its root likewise wins (its
taxonomy is real and authoritative; the self-import de-materializes).

## 5. Resolution & the scope ladder

Imports ride the existing scope ladder (SEPARATOR.md §2, URIs.md):

```
current: object: path        # bare  — current scope
: document: rooted: path     # :     — this document's root
:: project: rooted: path     # ::    — this project's root (import aliases live here)
::: authority: path          # :::   — the world (a cross-authority URI)
```

- `:: alias: …` — project scope; the alias is a root key (an import). Intra-project, so an
  *unmounted-but-present* alias that fails to step is a dangling typo.
- `::: authority: …` — world scope; names another project by URI. Stays `external` on a miss unless
  the authority is mounted. Only `yamlover.inthemoon.net` is mounted today (bundled); all others
  await transport.

Transport (resolving an arbitrary `:::` authority over the network, caching, sync mirrors) is a
future round — see FUTURE.md / the engine design. Until then the model above is fully usable for the
yamlover self-import and for *authoring* cross-project links that a future engine will resolve.
