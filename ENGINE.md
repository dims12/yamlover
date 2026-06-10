# ENGINE — the yamlover core

> **Status (2026-06-10).** Stage 1 exists: `tools/engine/ts/` implements the
> node+edge SQLite store (`store.ts`, on built-in `node:sqlite` — not better-sqlite3),
> the directory walker (`walk.ts`), the pointer resolver (`resolve.ts`), and
> derive/normalize (`graph.ts`); the server (`tools/server/src/server/engine-api.ts`)
> runs on it and exposes the read queries (node/toc/relationships/blob) over HTTP.
> **Not yet built:** serializers (graph → concrete; blocks the `mv`/`rm`/`put`/
> `normalize` write path), the FS watcher / 3-tier reconcile (external edits need a
> server restart), the event stream, and the versioned protocol. The rest of this
> document is the design those pieces build toward.

Forward-looking design, not a commitment (companion to [`FUTURE.md`](FUTURE.md) and
the pointer model in [`URIs.md`](URIs.md)). Where `FUTURE.md` covers *serving* a
tree and the implementation-language axis, this document describes the **stateful
core** that should sit behind the protocol: the thing that turns a filesystem tree
into a live, queryable **property graph** and keeps it in sync.

The goal is one **universal yamlover engine** that many frontends (web client,
JetBrains plugin, desktop apps, reference/mind-map/tag managers) talk to, so the
Node server becomes a thin adapter over it.

## What the engine is for

These needs are all one thing — a graph index with a resolver and a watcher:

| Need                       | Engine responsibility                                                    |
|----------------------------|--------------------------------------------------------------------------|
| index the tree             | build a **node + edge** store from a walk                                |
| hold a TOC                 | the TOC *is* a projection of the **containment edges** (the acyclic spine) |
| cache relationships        | materialize resolved `*` / `&` / `~` edges so they aren't re-resolved per request |
| keep what is written       | store forward / backward (`~`) / both edges as authored; impose no canonical owner |
| validate & derive on demand| check forward/backward pairs don't contradict; compute inverse / transitive for queries + `normalize` (never silently injected) |
| sync on file move          | a **watcher** + stable node identity so edges survive renames            |

## Data model: a property graph

The store is small and is the heart of the engine:

```
node(path, type, format, content_hash, meta…)   # path IS the identity
edge(from_path, to_path, label, kind)            kind ∈ { contain, ref, back, derived }
```

- **contain** — the tree spine (parent → child). The **TOC** is a traversal of
  `contain`. Acyclic by construction.
- **ref** — a `*pointer` edge; may point anywhere in the graph (incl. other trees /
  external URIs).
- **back** — a `~` edge (see `URIs.md`): excluded from the spine, **never inlined**,
  may point to an ancestor. Materializes onto the filesystem as a **symlink**, not a
  nested directory.
- **derived** — computed and cacheable (inverses, transitive closures); always
  recomputable from the other kinds.

This is where the pointer model from `URIs.md` lives at runtime: the engine is the
component that **resolves** `*`, `&`, `~`, `..`, `#`, `/`, and URIs — mapping
names/paths to node ids lazily, then caching the result as `ref` / `back` edges.
Containment stays acyclic; reference edges may form cycles, so all traversal is
cycle-safe (visited-set) and `*` is never expanded inline to infinity.

### Keep what is written

Placement is the author's choice: a node lives wherever it is written inline and is
reused elsewhere by `*` alias, so the engine imposes **no canonical owner**. For a
relation, the forward edge, its `~` reverse, or **both** may be authored — the engine
stores them verbatim and only **validates** that a forward/backward pair does not
contradict (disagree on endpoints). Inverses and closures are **derived on demand**
(for queries and `normalize`), never silently injected into the stored graph: the
`derived` kind is a cache, while `contain` / `ref` / `back` are authored.

## Engine API (spec the contract first)

Per `FUTURE.md`'s rule — **specify the contract before adopting any storage** — the
engine is defined by the queries it answers and the events it emits, not by its
implementation. A first sketch:

```
resolve(pointer, base) → path               # the URIs.md pointer model
node(path)             → node attributes
toc(root, depth?)      → containment subtree
relationships(path)    → edges in/out of a node, by kind
derive(rule)           → on-demand inverse / transitive / tag-closure (queries + normalize)
blob(path)             → raw bytes              # already in tools/server today
```

Mutations — the **write path**. The engine owns filesystem changes (like `git mv`),
so callers mutate the tree through commands rather than raw `mv` / `rm`:

```
mv(from, to)                  # move/rename; rewrites inbound refs, one transaction
rm(path)                      # delete; unrewritable inbound refs become lost (reported)
put(path, value)              # create / replace a node
link(from, to, label, kind)   # add a ref / back edge
normalize(root?)              # canonicalize to forwards-only: ensure each forward X, drop its ~X
```

Events (for live clients and cache invalidation):

```
changed(path)                 # content edited (detected via content_hash)
added(path) / removed(path)
moved(old, new)               # engine-mediated or hash-inferred move (see sync, below)
```

Once this is a versioned protocol (OpenAPI + JSON-Schema, extending the implicit
`tools/server` API), the storage choice below becomes a swappable detail and any
host — web, JetBrains, desktop — speaks the same engine API.

## Build vs. buy: an embeddable engine, staged

Do **not** hand-roll graph traversal, caching, and invalidation — "derive
relationships" is recursive/rule-based, exactly what query engines already do well.

- **Stage 1 (now): embedded SQLite.** The two tables above + **recursive CTEs** for
  TOC, ancestors, and transitive tag closures. Zero extra dependency, embeds in the
  current Node server, trivially portable later. Covers a long way.

- **Stage 2 (when derivation gets rule-heavy, or we want one polyglot core): an
  embeddable Datalog / graph engine.** Both candidates are **Rust cores with
  bindings for Node / Python / JVM / WASM** — i.e. the "embed everywhere" story that
  also serves as the universal engine:

  | Engine     | Model            | Why                                                                 |
  |------------|------------------|---------------------------------------------------------------------|
  | **CozoDB** | Datalog (+ relational + vector) | Inverse/transitive/tag-closure rules become declarative one-liners; backends in-mem / SQLite / RocksDB; bindings for exactly our hosts. **Preferred** for the derivation-heavy future. |
  | **Kùzu**   | Property graph (Cypher) | Columnar/fast; better if we think in graph patterns than Datalog rules. |

  Avoid server-heavy graph DBs (Neo4j, RedisGraph) — they break the embed-everywhere
  / `npx`-zero-install property.

With Datalog, derivation is nearly free, e.g.:

```
ancestor(x, z) :- contain(x, y), ancestor(y, z).
ancestor(x, y) :- contain(x, y).
inverse(b, a, label) :- ref(a, b, label).      # the ~edge / "my name" relation
```

…replacing a pile of imperative traversal and ad-hoc cache code.

## Identity is the path (decided)

There are **no durable node ids**. A node's identity is its location in the graph —
its path. This is consistent with the `URIs.md` pointer model, which is itself
path/location-based (`*../../pets[1]`, `*#/…`, `*/…`): references address *where a
node sits*, so a move legitimately *is* a graph change rather than something to
track and repair.

Consequences:

- **A "move" is an operation, not tracked identity.** Identity *is* the path, so
  changing the path changes identity — but when the engine knows or infers the move,
  it propagates the change to references (next section). Only when intent cannot be
  recovered does the old identity truly vanish.
- **Cache invalidation keys off path.** On a change under path *P*, invalidate cached
  `ref` / `back` / `derived` edges whose endpoints fall under *P* (path-prefix match).
- **Keep a reverse edge index by target path** — used both to *rewrite* inbound refs
  when a node moves, and to *report* the danglers it cannot rewrite.

`content_hash` is kept as both a **change fingerprint** (did content actually change,
vs. a bare mtime touch — validates caches) and the **recovery signal**: when a file
appears/disappears without the engine being told, a matching hash is what lets it
*infer* a move and relink. Prefer a fast non-crypto hash (**xxh3** / **BLAKE3**) over
CRC32 — same speed class, far fewer collisions.

## Filesystem interaction & sync

The engine is the **primary mediator of filesystem changes** — in normal flow the
directory tree is the engine's storage and you mutate it through engine commands
(`mv` / `rm` / …), like `git mv`, not raw shell `mv` / `rm`.

But the filesystem is **shared truth, not the engine's exclusive property.** The
engine never takes an exclusive lock and must tolerate external modification — a hand
edit, a `git pull`, another tool. This is non-negotiable: yamlover *is* a YAML overlay
*laid over* the filesystem, so the directory must stay a first-class, directly-usable
tree. An engine that demanded exclusive ownership would stop being an overlay and
become just a database with a directory backend. The engine therefore reconciles
whatever it did not do itself.

Three tiers of change follow, by how much intent the engine has:

1. **Engine-mediated (normal, exact).** A `mv` / `rm` / `put` command knows the
   semantic operation, so the engine updates the FS and the index in one transaction
   and **rewrites inbound references** to the new path (an IDE-style "rename
   refactor"). Nothing is lost.
2. **Watched live (best-effort).** While running, the engine watches the FS for
   external edits. A `delete here` + `create there` with a **matching content_hash**
   is inferred as a move and relinked; otherwise it is `removed` + `added`.
3. **Offline reconcile (best-effort, on startup).** If changes happened while the
   engine was down, it diffs its persisted index against the FS by **path +
   content_hash**: same path + hash = unchanged; same hash at a new path = inferred
   move; hash gone = removed. What it can recover, it relinks; **what it cannot, it
   marks as lost** — dangling refs are reported, never silently dropped.

Move inference is a heuristic: **duplicate content** (one hash in several places), or
a content edit *during* a move, makes it ambiguous — there the engine declines to
guess and the affected links are treated as lost. Graceful degradation, not silent
corruption.

**Decided — a move rewrites references.** The engine edits every file holding an
inbound `*` / `~` pointer to the new path (an IDE-style rename refactor). One move can
touch many files (large diffs) — accepted, for a clean end state. A **redirect /
tombstone** (a forwarding marker at the old path) is kept only as the fallback for
refs the engine *cannot* reach and rewrite — e.g. an external tree pointing in via a
URI.

## Language & embedding

"Universal engine for various applications" maps to `FUTURE.md`'s
**Rust-core-with-bindings** option — and CozoDB/Kùzu *are* that pattern, so leaning
on one gets embed-everywhere without writing the FFI by hand. The Node server then
becomes a thin adapter that calls the core (e.g. a napi binding) and exposes the HTTP
protocol — the "thinner Node server" we want. If the JetBrains in-process question
(see `FUTURE.md`) lands on Kotlin/JVM instead, the same protocol still applies; only
the binding changes.

## Bottom line

1. Model it as a **property graph**: `node` + typed `edge {contain, ref, back, derived}`.
   TOC = the `contain` projection; the `URIs.md` pointer model is the resolver that
   fills `ref` / `back`.
2. **Spec the engine API first** (`resolve` / `node` / `toc` / `relationships` /
   `derive` / `blob` + `changed` / `moved` events).
3. **Start on embedded SQLite + recursive CTEs**; graduate to **CozoDB** when
   derivation gets rule-heavy — that doubles as the universal embeddable engine.
4. **Identity is the path** — no durable ids. Mutate through the engine (`mv` / `rm`
   / …) so moves rewrite inbound refs transactionally; external changes are reconciled
   best-effort via `content_hash` (xxh3/BLAKE3), and whatever can't be recovered is
   reported as lost (via the reverse edge index), never silently dropped.
