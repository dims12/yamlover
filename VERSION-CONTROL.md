# Version control — problems and design notes

How yamlover should relate to version control (git first), what it can borrow,
what it must keep for itself, and which ideas from other VCSes fit better.
Companion to `ENGINE.md` (§Filesystem interaction & sync, §Identity is the path).

## Ground rules (from ENGINE.md)

- The filesystem is **shared truth, not the engine's exclusive property** — a
  `git pull`, a hand edit, another tool may change it at any time. Therefore git
  support is an **optional accelerator and intent source, never a requirement**:
  a served tree that is not a repo must work exactly as today.
- Identity is the path, no durable ids. A move is an operation (tier 1) or an
  inference (tiers 2/3), not tracked identity.

## Current state

- Git-awareness exists only in `tools/server/src/server/gitignore.ts`: find the
  git root, build a `.gitignore` predicate, hide ignored strays from the walk.
- Content identity is the engine's own: xxh64 (`xxhash-wasm`) over raw bytes,
  in the `file` manifest keyed by `(size, mtimeMs)` (walk.ts); a background
  hasher fills in large blobs; `diffManifest` infers moves by **exact** hash
  match, declining on ambiguity.
- The engine-mediated move (`tools/engine/ts/src/mv.ts`) is `fs.renameSync` +
  an inbound-pointer rewrite pass. ENGINE.md says "like `git mv`", but nothing
  talks to git yet. Known gap: case-only renames on a case-insensitive FS are
  rejected (mv.ts NOTE).

## Problem 1: borrowing git's hashes

`.git/index` stores, per tracked file, the blob OID **plus stat data** — git's
own version of the manifest's stat-cache trick. For tracked-and-clean files the
engine can read one small binary file and get content hashes for the whole tree
with **zero file reads** — killing most first-index hashing work in a repo.

Caveats:

- **Different bytes hashed.** A blob OID is SHA-1 (or SHA-256) of
  `"blob <size>\0" + clean content` — after CRLF/filters. On Windows with
  `autocrlf` it does NOT equal a hash of the on-disk bytes. Fine (even better —
  line-ending-invariant) as content identity; never recomputable from disk
  bytes naively.
- **Partial coverage.** Untracked / modified / ignored files have no valid
  OID — xxh64 stays the fallback. The `xxh64:` prefix scheme already allows
  algorithms to coexist (`git-sha1:` …).
- **Move-inference trap.** `diffManifest` matches hashes by string equality: a
  file that disappears with an `xxh64:` hash and reappears with a `git-sha1:`
  hash won't match on the hash tier. Either compute both for small files or
  normalize per-file to one scheme.
- **The bigger prize: git's rename detection.** Similarity-based
  (`--find-renames`) — recovers *moved-and-edited* files, which the exact-hash
  reconcile currently reports as removed+added. Diffing old-HEAD..new-HEAD
  after an offline `git pull` and feeding the result to `relinkMoved()` is a
  strict upgrade to tier 3.

## Problem 2: moving files via `git mv`

`git mv` is only: fs rename + index update (drop old entry, add new with the
**same OID** and fresh stat — no re-hash; commits store no rename metadata).
So `mv()` becomes git-aware without changing shape: after its rename, if inside
a repo and the source was tracked, update the index. Wins:

- `git status` shows a clean `R` rename immediately; the staged rename survives
  later edits (similarity detection alone might lose it).
- Pointer-rewrite edits to other files are ordinary modifications — no special
  handling.
- Closes the case-only-rename TODO (the historical reason `git mv` exists).

Caution: index writes must honor `.git/index.lock` and invalidate the
cache-tree (TREE) extension — take this from a library, don't hand-roll.
On a non-repo tree the path stays plain `fs.renameSync`.

## Problem 3: sub-file nodes (the granularity boundary)

yamlover addresses parts of files as nodes (`:file.yamlover:key`, chunks,
fragments); git only knows whole-file blobs. This is the natural boundary, not
a conflict:

- Borrowed git hashes slot into the **file manifest layer only**; per-node
  identity/change detection below file level stays yamlover's own (IR-derived).
- Future intra-document key moves look to git like an ordinary content edit of
  the holding file — correct and harmless; nothing to stage as a rename.
- Design rule: node identity and move inference must never *depend* on git —
  git input degrades gracefully to "one file changed", and the engine
  re-derives the sub-file picture by parsing, as today.

## Problem 4: replicate git logic ourselves?

Split git into two halves:

- **Working-tree logic** (identity, stat-cache, diff, rename inference) —
  mostly already replicated. The one worthwhile addition: **similarity-based
  rename scoring** (chunk both sides, score shared content, accept above a
  threshold) with xxh64 chunk/line hashes — and it would work at *node*
  granularity, which git itself cannot do.
- **Repository logic** (object store, commit DAG, packfiles, refs) — do NOT
  replicate. It is a whole VCS, and a shadow object store would compete with
  the user's real repo instead of composing with it (violates "shared truth").
  For history, stay an overlay and let actual git own versioning.

## Problem 5: better models than git — Jujutsu, Perforce

yamlover's model is closer to these than to git:

- **Jujutsu**: auto-snapshots the working copy, no staging — exactly the
  watcher/reconcile loop. Worth stealing: the **operation log** — record every
  engine mutation (`mv`, `put`, rewrites; already transactional) as an
  undoable op → free undo + audit trail. jj's durable change IDs are
  explicitly rejected here (identity is the path).
- **Perforce**: moves are explicit intent recorded as metadata, never
  inferred — precisely the tier-1 `mv()` philosophy; its huge-binary handling
  matches the blob/background-hasher design. Validates the design; nothing new
  to borrow.

"Replicate" ≠ "interoperate": conceptually borrow jj's op log; practically
interop means git — that's what users' trees are versioned with.
**jj's ideas, git's plumbing.**

## Libraries (git without the CLI)

| Library | Nature | Fit |
|---|---|---|
| **isomorphic-git** | Pure JS, no native deps | Best for `npx` zero-friction. Index/objects/status/add/remove (compose = `git mv`). SHA-1 repos only, no rename detection, slower on huge repos. |
| **es-git** (Toss) | Rust/libgit2 via napi-rs | Fast, modern TS, prebuilt binaries — good for desktop/Electron; native weight for `npx`. |
| **wasm-git** | libgit2 in WASM | Portable but rough emscripten-FS ergonomics; niche maintenance. |
| **nodegit** | libgit2, node-gyp | Unmaintained, painful builds — avoid. |
| **simple-git / dugite** | CLI wrappers | Excluded (CLI); dugite is a middle ground — bundles its own git binary. |

Zero-dep option, matching the engine's `node:sqlite` ethos: for **read-only**
hash borrowing, `.git/index` is a stable documented format — a `(path, OID,
size, mtime)` parser is ~200 lines, no deps. Reserve libraries for **writes**
(locking + TREE invalidation make hand-rolling risky).

## Staged plan (each slice independent, git strictly optional)

1. **Borrow hashes**: parse `.git/index` (zero-dep) to pre-populate content
   hashes for tracked-clean files — biggest cheap win, kills most background
   hashing on first index of a repo.
2. **git-aware `mv()`**: update the git index on engine-mediated moves
   (isomorphic-git for the pure-JS path); also fixes case-only renames.
3. **Better tier-3 reconcile**: use git rename detection across offline
   `git pull`s to feed `relinkMoved()`; optionally add native similarity
   scoring for non-repo trees (and sub-file nodes).
4. **(from jj) Operation log**: record engine mutations as undoable ops.
