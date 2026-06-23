// Directory walker — the directory concrete (YAMLOVER.md §5) → IR Document. Replaces the
// Python walker / the server's legacy `loadEntity`, mirroring its file→value semantics so the
// web UI works "as it was", but emitting the new IR (parser/ts/src/ir.ts) the engine consumes.
//
// A directory IS a mapping: each file/subdir is an entry keyed by its filename. The `.yamlover/`
// overlay dir is not itself an entry; it carries:
//   - body.yamlover — the INSTANCE overlay: a mapping merges over the dir (override/add); a
//     pointer-array (`- *file …`) imposes child ORDER (a bare dir takes filesystem order).
//   - meta.yamlover — the metadata SCHEMA: `properties.<name>.{type,format}` types a child
//     (e.g. type: binary makes a textual-looking file a Blob; format names its decoding).
//
// File → value (legacy rule): a TEXT-format extension → a string scalar (raw content); a known
// binary/opaque extension → a Blob; unknown/no extension → sniff (NUL byte or >1 MiB ⇒ Blob,
// else parse the content as yamlover → scalar/structure). A `meta` type:binary overrides to Blob.

import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import xxhash from 'xxhash-wasm';
import type { Document, Node, Mapping, Blob, Entry, Value } from '../../../parser/ts/src/ir.ts';
import { isPointer, toPlain } from '../../../parser/ts/src/ir.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { parseJson5p } from '../../../parser/ts/src/json5p.ts';
import { Store } from './store.ts';
import type { FileRecord } from './store.ts';
import { graftTaxonomy, YAMLOVER_AUTHORITY } from './mounts.ts';

// xxh64 (xxhash-wasm) is the content/manifest hash: identity, not security — chosen for SPEED
// (multiple GB/s, far above disk throughput). The `xxh64:` prefix keeps the algorithm swappable.
// The WASM module instantiates once at import (top-level await — milliseconds).
const { h64Raw, create64 } = await xxhash();
const hashBytes = (bytes: Uint8Array): string => 'xxh64:' + h64Raw(bytes).toString(16).padStart(16, '0');

const YAMLOVER_DIR = '.yamlover';
// Engine-owned files inside `.yamlover/` that must NOT be indexed: the overlays are read into the
// parent directory (applyBody/loadMeta), and the index db would otherwise index itself. Everything
// else under `.yamlover/` (the derived `thumbnails/` and `fragments/` sidecar dirs) is walked
// normally — those blobs are addressable content (just hidden). See yamloverDirNode.
const YAMLOVER_INTERNAL = new Set([
  'body.yamlover', 'meta.yamlover', 'settings.yamlover',
  'index.db', 'index.db-wal', 'index.db-shm', 'index.db-journal',
]);
// `settings.yamlover` is engine-owned (read by loadSettings, never an overlay applied to the parent)
// but — UNLIKE body/meta/index.db — it IS indexed as a HIDDEN node, so the config file is openable
// and editable at `:.yamlover:settings.yamlover` by the settings renderer (IMPORTS.md). It is the one
// YAMLOVER_INTERNAL name admitted into the overlay subtree.
const SETTINGS_FILE = 'settings.yamlover';
const skipInYamloverDir = (name: string): boolean =>
  (YAMLOVER_INTERNAL.has(name) && name !== SETTINGS_FILE) || name.startsWith('.');
const MAX_TEXT_BYTES = 1 << 20; // 1 MiB: above this we never slurp a file to sniff/parse it
const MAX_DOC_BYTES = 64 << 20; // 64 MiB: a format-matched text/doc file above this stays a Blob (never slurped)
const HASH_INLINE_MAX = 1 << 20; // 1 MiB: a blob at or under this is read + hashed inline by the walk
const HASH_CHUNK = 8 << 20; // 8 MiB: streaming-hash chunk — constant memory at any file size

export interface WalkOptions {
  /** Skip a filesystem child when this returns true for its absolute path (e.g. a `.gitignore`
   *  matcher, so a project-root walk does not descend into `node_modules`). Hidden dotfiles and
   *  the `.yamlover/` overlay dir are always skipped regardless. */
  ignore?: (absPath: string) => boolean;
  /** Hash cache: given a file's root-relative path and its current (size, mtimeMs), return its
   *  known content hash, or null to force a read. Lets a re-index skip re-reading unchanged
   *  blobs — the cost that made the old per-request rebuild block. Fed from the previous walk's
   *  manifest (Store.manifest()) by {@link reindex}. */
  cache?: (relPath: string, size: number, mtimeMs: number) => string | null;
  /** Blobs at or under this byte size are read + hashed INLINE by the walk — small files are
   *  the ones likely to collide on (size, mtime), and hashing them costs microseconds. Larger
   *  blobs are stat-only: contentHash stays null until the background hasher fills it in.
   *  Default 1 MiB. */
  hashInlineMax?: number;
  /** Suppress the `yamlover` self-import graft (IMPORTS.md §4). Set when loading the bundled
   *  taxonomy itself (mounts.ts) so the walk does not try to graft a self-import INTO it. */
  noGraft?: boolean;
}

/** One walk progress tick: `done` filesystem children processed so far, `path` the latest
 *  (root-relative). Yielded by {@link walkTreeGen} once per file/subdir. */
export interface WalkProgress {
  done: number;
  path: string;
}

/** Progress of an async reindex: `done`/`total` in walk units (filesystem children), plus a
 *  human-readable `message` (the current path, "writing index…", …). */
export interface ReindexProgress {
  done: number;
  total?: number;
  message?: string;
}

export interface AsyncWalkOptions extends WalkOptions {
  onProgress?: (p: ReindexProgress) => void;
  /** Walk steps between event-loop yields in the async drivers (default 50). */
  yieldEvery?: number;
}

/** A walk's two products: the IR Document and the file manifest (every file read, with its
 *  content identity) — the diff base for change detection and the next walk's hash cache. */
export interface WalkResult {
  doc: Document;
  files: FileRecord[];
}

/** What a re-index found changed on disk, as root-relative file paths. `moved` is the
 *  INFERRED moves (ENGINE.md tiers 2/3): a removed and an added path sharing one content
 *  hash, matched only when unambiguous — duplicate content on either side, or a content
 *  edit during the move, makes the engine decline to guess (those stay added/removed). */
export interface IndexDiff {
  added: string[];
  changed: string[];
  removed: string[];
  moved: { from: string; to: string }[];
}

/** Everything a walk threads along: the root (for manifest-relative paths), the options,
 *  the manifest accumulator (a Map to dedupe re-reads), and the running progress count
 *  (filesystem children processed). */
interface Ctx {
  root: string;
  opts: WalkOptions;
  files: Map<string, FileRecord>;
  count: number;
}

/** Walk a directory (absolute path) into an IR Document (concrete: "directory"). */
export function walkDir(absDir: string, opts: WalkOptions = {}): Document {
  return walkTree(absDir, opts).doc;
}

/** Walk a directory into an IR Document AND its file manifest (synchronously — drains
 *  {@link walkTreeGen}; the generator exists so async drivers can interleave progress
 *  reporting and event-loop yields without a second implementation). */
export function walkTree(absDir: string, opts: WalkOptions = {}): WalkResult {
  const g = walkTreeGen(absDir, opts);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/** {@link walkTree} that yields the event loop every `yieldEvery` steps and reports progress —
 *  so an HTTP server stays responsive while a big tree indexes in the background. */
export async function walkTreeAsync(absDir: string, opts: AsyncWalkOptions = {}): Promise<WalkResult> {
  const g = walkTreeGen(absDir, opts);
  const every = Math.max(1, opts.yieldEvery ?? 50);
  let r = g.next();
  while (!r.done) {
    opts.onProgress?.({ done: r.value.done, message: r.value.path });
    if (r.value.done % every === 0) await yieldLoop();
    r = g.next();
  }
  return r.value;
}

// The BUILT-IN yamlover taxonomy, embedded as source (NOT read from disk — so it survives
// bundling and ships with no data files): the `$defs/tag` schema (format x-yamlover-tag, with
// recursive sub-tags) and the `tags/colors` palette. It is grafted as the `yamlover` self-import
// into any served tree that has no `$defs/` of its own, so `*yamlover/tags/colors/…` resolves —
// and color-tag annotations validate — in a PLAIN directory, not only a yamlover project. Mirrors
// the on-disk taxonomy at the repo root; the palette hexes mirror COLOR_TAGS in annotate.tsx.
const BUILTIN_TAG_SCHEMA = 'type: object\nformat: x-yamlover-tag\nproperties:\n  color:\n    type: string\nadditionalProperties: *:: yamlover: $defs: tag\n';
// embedded fragments / annotations (ANNOTATIONS.md) — minimal so the `!!<*::yamlover/$defs/…>`
// tags resolve (and the nodes index as x-yamlover-fragment / -annotation) in a plain served tree.
const BUILTIN_FRAGMENT_SCHEMA = 'type: object\nformat: x-yamlover-fragment\n';
const BUILTIN_ANNOTATION_SCHEMA = 'type: variant\nformat: x-yamlover-annotation\n';
const BUILTIN_TAGS_BODY =
  '!!<*yamlover:$defs:tag>\ncolors: The palette\n' +
  '  yellow:\n    color: "#f9e2af"\n' +
  '  green:\n    color: "#a6e3a1"\n' +
  '  sky:\n    color: "#89dceb"\n' +
  '  mauve:\n    color: "#cba6f7"\n' +
  '  pink:\n    color: "#f5c2e7"\n' +
  '  peach:\n    color: "#fab387"\n';

let builtinTemplate: { tag: Node; tags: Node } | null = null;
/** The built-in `yamlover` graft node + its `$defs` map (for {@link applySchemas} to resolve
 *  `*yamlover:$defs:tag` without a disk read). Parsed once, then cloned per graft so a walk never
 *  mutates the shared template (applySchemas attaches derived meta to the instance it grafts). */
function builtinYamloverGraft(): { node: Node; defs: Map<string, Node> } {
  builtinTemplate ??= {
    tag: parseYamlover(BUILTIN_TAG_SCHEMA, '$defs/tag').root,
    tags: parseYamlover(BUILTIN_TAGS_BODY, 'tags/.yamlover/body.yamlover').root,
  };
  const tagCopy = structuredClone(builtinTemplate.tag);
  const fragCopy = parseYamlover(BUILTIN_FRAGMENT_SCHEMA, '$defs/fragment').root;
  const annCopy = parseYamlover(BUILTIN_ANNOTATION_SCHEMA, '$defs/annotation').root;
  const node: Node = {
    kind: 'mapping',
    array: false,
    entries: [
      {
        key: '$defs', edge: 'contain',
        value: {
          kind: 'mapping', array: false,
          entries: [
            { key: 'tag', edge: 'contain', value: tagCopy },
            { key: 'fragment', edge: 'contain', value: fragCopy },
            { key: 'annotation', edge: 'contain', value: annCopy },
          ],
        },
      },
      { key: 'tags', edge: 'contain', value: structuredClone(builtinTemplate.tags) },
    ],
  };
  return { node, defs: new Map([['tag', tagCopy], ['fragment', fragCopy], ['annotation', annCopy]]) };
}

/** The walk as a generator: yields one {@link WalkProgress} per filesystem child processed,
 *  returns the {@link WalkResult}. */
export function* walkTreeGen(absDir: string, opts: WalkOptions = {}): Generator<WalkProgress, WalkResult, void> {
  const ctx: Ctx = { root: path.resolve(absDir), opts, files: new Map(), count: 0 };
  const root = yield* dirNode(ctx.root, ctx);
  root.meta = { ...root.meta, documentRoot: true }; // the served root is always a document root
  // Resolve the SELF-IMPORT key `yamlover` — the yamlover project ({`$defs/` schemas, `tags/`
  // palette}, URI `::: yamlover.inthemoon.net`) — into the served tree, so `*::yamlover:…` (and the
  // world form `*::: yamlover.inthemoon.net:…`) resolve from ANY served root (IMPORTS.md §4). The
  // import may be AUTHORED as a root body key (`yamlover: *::: yamlover.inthemoon.net`) or left
  // IMPLICIT; either way the walk MATERIALIZES the taxonomy under the `yamlover` key (replacing the
  // import pointer with the real subtree) so no world pointer is left to dangle. A root that
  // PROJECTS AS AN ARRAY (all-keyless) is left alone — a keyed graft would flip its kind to mix.
  //
  // Three outcomes, by where the taxonomy lives:
  //  • served root IS the yamlover project (own `$defs/`): the taxonomy is ALREADY at `:$defs` /
  //    `:tags`; materializing again would DUPLICATE every node (`:yamlover:tags:…` beside the real
  //    `:tags:…`, splitting a tag's backlinks). So DE-MATERIALIZE — drop any `yamlover` key and let
  //    the resolver/query evaluator absorb `::yamlover:…` ≡ `::…` virtually (resolve.ts, query.ts).
  //  • served root is a SUBDIRECTORY of a project (taxonomy at an ancestor): graft the live ancestor
  //    `$defs`+`tags` in-tree.
  //  • a plain/foreign/DETACHED dir (no taxonomy reachable): graft the BUNDLED taxonomy (mounts.ts,
  //    shipped as package data — the full $defs incl. board/task/workflow + the tags taxonomy), so a
  //    detached copy of an example still resolves `*::yamlover:tags:workflow:dev`. Falls back to the
  //    minimal in-source builtin only if the bundle is somehow absent.
  // A `yamlover` key pointing somewhere ELSE (not the yamlover world URI) is a real user override and
  // is left untouched (IMPORTS.md §4 "until overridden").
  const defsRoot = findDefsRoot(absDir);
  const defsDir = path.join(defsRoot, '$defs');
  // served root IS a project root: it has its OWN `$defs/` direct child (findDefsRoot falls back to
  // the dir itself for a foreign tree, so the existence check is what distinguishes self from foreign).
  const selfRoot = fs.existsSync(defsDir) && path.resolve(absDir) === defsRoot;
  const arrayRoot = root.array || (root.entries?.length ? root.entries.every((e) => e.key === null) : false);
  let builtinDefs: Map<string, Node> | undefined; // the in-memory $defs for a BUNDLED/builtin graft (no disk)
  if (!opts.noGraft && !arrayRoot && root.entries) {
    const yEntry = root.entries.find((e) => e.key === 'yamlover');
    const yIsSelfImport = !yEntry || (isPointer(yEntry.value) && isYamloverWorldPointer(yEntry.value));
    if (selfRoot) {
      // de-materialize: drop any authored `yamlover` self-import key — `::yamlover:…` ≡ `::…`.
      if (yEntry && yIsSelfImport) root.entries = root.entries.filter((e) => e !== yEntry);
    } else if (yIsSelfImport) {
      let node: Node;
      if (fs.existsSync(defsDir)) {
        // an ANCESTOR's taxonomy (served root is a subdir of a project): bring it in-tree.
        const shared: Entry[] = [{ key: '$defs', edge: 'contain', value: yield* dirNode(defsDir, ctx) }];
        const tagsDir = path.join(defsRoot, 'tags');
        if (fs.existsSync(tagsDir)) shared.push({ key: 'tags', edge: 'contain', value: yield* dirNode(tagsDir, ctx) });
        node = { kind: 'mapping', entries: shared, array: false };
      } else {
        // No project taxonomy on disk: graft the BUNDLED taxonomy (full $defs + tags), falling back
        // to the minimal in-source builtin if the bundle is unavailable.
        const built = graftTaxonomy() ?? builtinYamloverGraft();
        node = built.node;
        builtinDefs = built.defs;
      }
      if (yEntry) { yEntry.value = node; yEntry.edge = 'contain'; } // materialize over the import pointer
      else root.entries.push({ key: 'yamlover', edge: 'contain', value: node });
    }
  }
  applySchemas(root, defsRoot, builtinDefs); // propagate attached !!<…> schemas down the instance
  return {
    doc: { root, source: { concrete: 'directory', uri: absDir } },
    files: [...ctx.files.values()],
  };
}

/** Build the index DB for a directory tree: walk → IR → SQLite at <root>/.yamlover/index.db.
 *  Creates the .yamlover/ dir if absent. The DB is a derived cache (ENGINE.md) — re-runnable. */
export function buildIndex(absDir: string, opts: WalkOptions = {}): string {
  const overlay = path.join(absDir, YAMLOVER_DIR);
  fs.mkdirSync(overlay, { recursive: true });
  const dbPath = path.join(overlay, 'index.db');
  const store = new Store(dbPath);
  reindex(store, absDir, opts);
  store.close();
  return dbPath;
}

/** Re-index a tree into an OPEN store and report what changed on disk since the last index.
 *  The previous manifest doubles as the hash cache — a file whose (size, mtime) is unchanged is
 *  not re-read — so this is cheap enough to run on every watcher batch / startup (the offline
 *  reconcile: ENGINE.md tier 3, move inference included: same hash gone here + appeared there
 *  ⇒ `moved`). The swap is atomic (one transaction), so concurrent readers never see a
 *  half-built index. */
export function reindex(store: Store, absDir: string, opts: WalkOptions = {}): IndexDiff {
  const prev = store.stale ? new Map<string, FileRecord>() : store.manifest();
  const { doc, files } = walkTree(absDir, { ...opts, cache: opts.cache ?? manifestCache(prev) });
  store.indexDocument(doc, files);
  return diffManifest(prev, files);
}

/** {@link reindex}, asynchronously: a cheap enumeration pre-pass gives a determinate `total`,
 *  then the walk yields the event loop between steps and reports progress. The final
 *  `indexDocument` transaction is still one synchronous commit (flagged by its own message). */
export async function reindexAsync(store: Store, absDir: string, opts: AsyncWalkOptions = {}): Promise<IndexDiff> {
  return (await reindexAsyncDoc(store, absDir, opts)).diff;
}

/** {@link reindexAsync} that also returns the assembled {@link Document} and file manifest — the
 *  server retains the doc so a later single-file edit can be patched against it in memory
 *  ({@link reindexPathAsync}) instead of re-walking and rebuilding the whole tree. */
export async function reindexAsyncDoc(
  store: Store,
  absDir: string,
  opts: AsyncWalkOptions = {},
): Promise<{ diff: IndexDiff; doc: Document; files: FileRecord[] }> {
  const prev = store.stale ? new Map<string, FileRecord>() : store.manifest();
  const onProgress = opts.onProgress;
  const total = onProgress ? await countChildren(path.resolve(absDir), opts) : undefined;
  const { doc, files } = await walkTreeAsync(absDir, {
    ...opts,
    cache: opts.cache ?? manifestCache(prev),
    onProgress: onProgress && ((p) => onProgress({ ...p, total })),
  });
  onProgress?.({ done: total ?? files.length, total, message: 'writing index…' });
  await yieldLoop(); // let the message out before the blocking commit
  store.indexDocument(doc, files);
  return { diff: diffManifest(prev, files), doc, files };
}

/** Incrementally reindex a SINGLE edited file: re-walk only the directory that owns it, splice the
 *  fresh subtree into the cached `doc`, re-apply schemas (idempotent), and patch the index for that
 *  subtree ({@link Store.patchSubtree}). Resolution stays whole-tree (in memory) so cross-file and
 *  inbound pointers remain correct; only the changed subtree's rows are rewritten. `cachedDoc` is
 *  MUTATED in place on success. Returns null — caller must fall back to {@link reindexAsyncDoc} —
 *  when the change is not locally patchable: a root-level file (re-walking the root ≡ full reindex),
 *  a change under the grafted `$defs`/`tags` taxonomy (it feeds schemas/the graft globally), a
 *  splice point not found in the cached tree, or an external-reference change the patch guard
 *  rejected. */
export async function reindexPathAsync(
  store: Store,
  absDir: string,
  cachedDoc: Document,
  changedRel: string,
  opts: WalkOptions = {},
): Promise<{ diff: IndexDiff; doc: Document } | null> {
  const root = path.resolve(absDir);
  // The splice unit is the directory that OWNS the change: for a `.yamlover/` overlay the directory
  // the overlay belongs to; for any other file, its containing directory.
  const parts = changedRel.split('/');
  const yi = parts.indexOf(YAMLOVER_DIR);
  const dirSegs = yi >= 0 ? parts.slice(0, yi) : parts.slice(0, -1);
  if (dirSegs.length === 0) return null; // a root-level file → re-walking the root is a full reindex
  if (dirSegs[0] === '$defs' || dirSegs[0] === 'tags') return null; // feeds applySchemas/the graft

  // locate the splice node's holding entry in the cached tree (navigate by filesystem key)
  let entries = cachedDoc.root.entries;
  let target: { arr: Entry[]; i: number } | null = null;
  for (let d = 0; d < dirSegs.length; d++) {
    if (!entries) return null;
    const i = entries.findIndex((e) => e.key === dirSegs[d] && !isPointer(e.value));
    if (i < 0) return null;
    if (d === dirSegs.length - 1) target = { arr: entries, i };
    else entries = (entries[i].value as Node).entries;
  }
  if (!target) return null;

  const absSpliceDir = path.join(root, ...dirSegs);
  if (!fs.existsSync(absSpliceDir) || !fs.statSync(absSpliceDir).isDirectory()) return null;

  const prev = store.stale ? new Map<string, FileRecord>() : store.manifest();
  const ctx: Ctx = { root, opts: { ...opts, cache: opts.cache ?? manifestCache(prev) }, files: new Map(), count: 0 };
  const gen = dirNode(absSpliceDir, ctx);
  let r = gen.next();
  while (!r.done) r = gen.next();
  target.arr[target.i].value = r.value; // splice the fresh subtree
  applySchemas(cachedDoc.root, findDefsRoot(absDir), graftDefs(cachedDoc.root)); // re-derive formats top-down

  const relPrefix = dirSegs.join('/') + '/';
  const P = ':' + dirSegs.join(':');
  const prevSub = new Map([...prev].filter(([k]) => k.startsWith(relPrefix)));
  const files = [...ctx.files.values()];
  const diff = diffManifest(prevSub, files);
  if (!store.patchSubtree(cachedDoc, P, files, relPrefix)) return null; // guard rejected → full reindex
  return { diff, doc: cachedDoc };
}

/** The built-in graft's `$defs` schema nodes inside a walked tree, so {@link applySchemas} can run
 *  on a spliced tree without rebuilding the built-in template. Undefined when the project has its
 *  own on-disk `$defs` (applySchemas reads those from disk; the in-tree fallback is unused). */
function graftDefs(root: Node): Map<string, Node> | undefined {
  const yam = root.entries?.find((e) => e.key === 'yamlover' && !isPointer(e.value))?.value as Node | undefined;
  const defs = yam?.entries?.find((e) => e.key === '$defs' && !isPointer(e.value))?.value as Node | undefined;
  if (!defs?.entries) return undefined;
  const m = new Map<string, Node>();
  for (const e of defs.entries) if (e.key && !isPointer(e.value)) m.set(e.key, e.value as Node);
  return m.size ? m : undefined;
}

/** The default walk cache: the previous manifest — an unchanged (size, mtime) reuses the known
 *  hash (which may itself be null for a large blob the hasher has not reached). */
function manifestCache(prev: Map<string, FileRecord>): NonNullable<WalkOptions['cache']> {
  return (rel, size, mtimeMs) => {
    const r = prev.get(rel);
    return r && r.size === size && r.mtimeMs === mtimeMs ? r.hash : null;
  };
}

/** Count the filesystem children a walk will process (same skip rules as {@link dirNode}) —
 *  the determinate `total` for progress. readdir-only; trivially cheap next to the walk. */
async function countChildren(absRoot: string, opts: WalkOptions): Promise<number> {
  let n = 0;
  // count a `.yamlover/` overlay dir's indexable sidecars (same skip-list as yamloverDirNode);
  // returns how many top-level entries survived (0 ⇒ the dir adds no node).
  const visitYamlover = async (dir: string): Promise<number> => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let top = 0;
    for (const e of entries) {
      if (skipInYamloverDir(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (opts.ignore?.(abs)) continue;
      n++; top++;
      const isDir = e.isDirectory() || (e.isSymbolicLink() && (await fs.promises.stat(abs).catch(() => null))?.isDirectory());
      if (isDir) await visit(abs);
    }
    return top;
  };
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== YAMLOVER_DIR) continue;
      const abs = path.join(dir, e.name);
      if (opts.ignore?.(abs)) continue;
      if (e.name === YAMLOVER_DIR) {
        if ((await visitYamlover(abs)) > 0) n++; // +1 for the hidden `.yamlover` node itself
        continue;
      }
      n++;
      const isDir = e.isDirectory() || (e.isSymbolicLink() && (await fs.promises.stat(abs).catch(() => null))?.isDirectory());
      if (isDir) await visit(abs);
    }
  };
  await visit(absRoot);
  return n;
}

/** Diff the new manifest against the previous. `changed` is STAT-based (size or mtime differs).
 *  Move inference matches a removed ↔ an added path by content hash when both sides have one,
 *  else by (size, mtimeMs) — a rename preserves both — and only when the match is unambiguous
 *  (duplicates on either side ⇒ decline to guess, exactly the old hash-only policy). */
export function diffManifest(prev: Map<string, FileRecord>, files: FileRecord[]): IndexDiff {
  let added: string[] = [], removed: string[] = [];
  const changed: string[] = [];
  const current = new Map(files.map((f) => [f.path, f]));
  for (const f of files) {
    const old = prev.get(f.path);
    if (!old) added.push(f.path);
    else if (old.size !== f.size || old.mtimeMs !== f.mtimeMs) changed.push(f.path);
  }
  for (const p of prev.keys()) if (!current.has(p)) removed.push(p);

  const moved: { from: string; to: string }[] = [];
  if (removed.length > 0 && added.length > 0) {
    const matched = new Set<string>();
    // identity tiers: content hash (skipping unhashed), then the stat pair
    const tiers: ((f: FileRecord) => string | null)[] = [(f) => f.hash, (f) => `${f.size}:${f.mtimeMs}`];
    for (const key of tiers) {
      const outs = groupBy(removed.filter((p) => !matched.has(p)).map((p) => prev.get(p)!), key);
      const ins = groupBy(added.filter((p) => !matched.has(p)).map((p) => current.get(p)!), key);
      for (const [k, o] of outs) {
        const i = ins.get(k);
        if (o.length !== 1 || i?.length !== 1) continue;
        const [from, to] = [o[0], i[0]];
        if (from.hash && to.hash && from.hash !== to.hash) continue; // stat tier: hashes prove different content
        moved.push({ from: from.path, to: to.path });
        matched.add(from.path);
        matched.add(to.path);
      }
    }
    if (matched.size > 0) {
      added = added.filter((p) => !matched.has(p));
      removed = removed.filter((p) => !matched.has(p));
    }
  }
  return { added, changed, removed, moved };
}

function groupBy(list: FileRecord[], key: (f: FileRecord) => string | null): Map<string, FileRecord[]> {
  const m = new Map<string, FileRecord[]>();
  for (const f of list) {
    const k = key(f);
    if (k != null) m.set(k, [...(m.get(k) ?? []), f]);
  }
  return m;
}

/** Stream-hash a file in fixed-size chunks — constant memory at ANY size (a multi-GB blob never
 *  lands in RAM whole, and never hits Node's 2 GiB buffer cap). `onChunk` reports cumulative
 *  bytes; the awaits between chunks keep the event loop responsive. The background hasher's
 *  workhorse. */
export async function hashFileAsync(abs: string, onChunk?: (bytesDone: number) => void): Promise<string> {
  const fh = await fs.promises.open(abs, 'r');
  try {
    const hasher = create64();
    const buf = Buffer.alloc(HASH_CHUNK);
    let done = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length);
      if (bytesRead === 0) break;
      hasher.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      done += bytesRead;
      onChunk?.(done);
    }
    return 'xxh64:' + hasher.digest().toString(16).padStart(16, '0');
  } finally {
    await fh.close();
  }
}

/** Record a file the walk saw into the manifest (`hash` is null for a large blob the walk did
 *  not read). Files outside the walked root (e.g. a `$defs` host found above it) are not
 *  manifested — the watcher cannot see them. */
function record(ctx: Ctx, abs: string, hash: string | null, size: number, mtimeMs: number): void {
  const rel = path.relative(ctx.root, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return;
  ctx.files.set(rel, { path: rel, hash, size, mtimeMs });
}

/** Read a file's bytes, recording its content identity in the manifest. */
function readTracked(ctx: Ctx, abs: string): Buffer {
  const stat = fs.statSync(abs);
  const bytes = fs.readFileSync(abs);
  record(ctx, abs, hashBytes(bytes), stat.size, stat.mtimeMs);
  return bytes;
}

/** Per-child metadata from `.yamlover/meta.yamlover` `properties`:
 *  { name → {type, format, uniqueItems} }. */
type Meta = Record<string, { type?: string; format?: string; uniqueItems?: boolean }>;

function loadMeta(dir: string, ctx: Ctx): Meta {
  const file = path.join(dir, YAMLOVER_DIR, 'meta.yamlover');
  if (!fs.existsSync(file)) return {};
  try {
    const plain = toPlain(parseYamlover(readTracked(ctx, file).toString('utf8'), file).root) as Record<string, unknown>;
    const props = (plain?.properties ?? {}) as Meta;
    return props && typeof props === 'object' ? props : {};
  } catch {
    return {};
  }
}

/** A directory → a Mapping node: one entry per file/subdir, then the body.yamlover overlay.
 *  A generator: yields one progress tick per child processed (subtree ticks ride through). */
function* dirNode(dir: string, ctx: Ctx): Generator<WalkProgress, Node, void> {
  const meta = loadMeta(dir, ctx);
  const names = fs
    .readdirSync(dir)
    .filter((n) => n === YAMLOVER_DIR || !n.startsWith('.')) // keep `.yamlover` (hidden subtree); drop other dotfiles
    .filter((n) => !ctx.opts.ignore?.(path.join(dir, n))) // skip git-ignored (e.g. node_modules)
    .sort(); // filesystem order = sorted names (stable; body.yamlover can re-impose order)

  const entries: Entry[] = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    if (name === YAMLOVER_DIR) {
      // index the overlay dir's derived sidecars as a HIDDEN child (omitted when it holds only
      // engine files — overlays / index db — so plain directories keep today's shape).
      const hidden = yield* yamloverDirNode(abs, ctx);
      if (hidden) {
        entries.push({ key: name, edge: 'contain', value: hidden });
        yield { done: ++ctx.count, path: path.relative(ctx.root, abs).split(path.sep).join('/') };
      }
      continue;
    }
    const child = yield* childNode(abs, meta[name], ctx);
    entries.push({ key: name, edge: 'contain', value: child });
    yield { done: ++ctx.count, path: path.relative(ctx.root, abs).split(path.sep).join('/') };
  }

  const node: Mapping = { kind: 'mapping', entries, array: false };
  return applyMeta(applyBody(dir, node, ctx), meta); // attach meta `format` to entries (incl. body-overlay ones)
}

/** A `.yamlover/` overlay dir → a HIDDEN content subtree (its derived `thumbnails/`/`fragments/`
 *  sidecars, addressable as `*:.yamlover:…`), or null when nothing indexable remains (overlay /
 *  index-db only). The engine's own files (overlays, the index db, nested dotfiles) are skipped;
 *  surviving entries walk through the normal {@link childNode}, so sidecar blobs index as usual.
 *  The node is flagged `meta.hidden` so the TOC/explorer omit it. */
function* yamloverDirNode(absYamlover: string, ctx: Ctx): Generator<WalkProgress, Node | null, void> {
  let names: string[];
  try {
    names = fs
      .readdirSync(absYamlover)
      .filter((n) => !skipInYamloverDir(n))
      .filter((n) => !ctx.opts.ignore?.(path.join(absYamlover, n)))
      .sort();
  } catch {
    return null;
  }
  const entries: Entry[] = [];
  for (const name of names) {
    const abs = path.join(absYamlover, name);
    const child = yield* childNode(abs, undefined, ctx);
    entries.push({ key: name, edge: 'contain', value: child });
    yield { done: ++ctx.count, path: path.relative(ctx.root, abs).split(path.sep).join('/') };
  }
  if (entries.length === 0) return null;
  return { kind: 'mapping', entries, array: false, meta: { hidden: true } };
}

/** A single filesystem child (file or subdir) → a Node, honoring meta type/format overrides. */
function* childNode(abs: string, m: { type?: string; format?: string } | undefined, ctx: Ctx): Generator<WalkProgress, Node, void> {
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return yield* dirNode(abs, ctx);

  const ext = path.extname(abs).toLowerCase();
  // format resolution order: meta `format:` → a recognized extension → (none → sniff/parse).
  const fmt = m?.format ?? EXT_FORMAT[ext] ?? null;
  if (m?.type === 'binary') return blob(abs, fmt ?? 'application/octet-stream', ctx);
  if (fmt && (DOC_FORMATS[fmt] || TEXT_FORMATS.has(fmt))) {
    // a format-matched doc/text file is slurped to parse — unless it is too big to slurp
    if (stat.size > MAX_DOC_BYTES) return blob(abs, fmt, ctx);
    if (DOC_FORMATS[fmt]) return parsedDoc(abs, DOC_FORMATS[fmt], ctx); // a sub-document encoding → parse (META.md)
    return textScalar(abs, fmt, ctx); // markdown/adoc/plantuml/csv → string + format
  }
  if (fmt) return blob(abs, fmt, ctx); // a known but non-text format = opaque bytes
  if (looksBinary(abs)) return blob(abs, 'application/octet-stream', ctx);
  return parsedScalar(abs, ext, ctx); // text, no format → parse by extension (json5p for .json*, else yamlover)
}

/** Apply `meta.yamlover` `properties.<key>.format` to the matching entries, so a body-overlay
 *  text entry (e.g. 59's `markdown:`) gets its (type, format) just like a file child does. A
 *  Blob already carries its format; a node with a format already wins; binary stays a Blob.
 *  `uniqueItems: true` marks the child a SET (≡ the `!!set` tag — META.md): NodeMeta.set. */
function applyMeta(node: Node, meta: Meta): Node {
  for (const e of node.entries ?? []) {
    if (e.key == null || isPointer(e.value)) continue;
    const m = meta[e.key];
    if (!m) continue;
    if (m.uniqueItems) e.value = { ...e.value, meta: { ...e.value.meta, set: true } };
    if (e.value.kind === 'blob') continue;
    if (m.format && !e.value.meta?.schema) e.value = { ...e.value, meta: { ...e.value.meta, schema: inlineFormat(m.format) } };
  }
  return node;
}

/** A Blob node: format + content hash + size; bytes live in the store, not the IR (IR.md).
 *  The hash cache short-circuits the read: an unchanged (size, mtime) reuses the known hash.
 *  On a miss, only a SMALL blob (≤ hashInlineMax) is read + hashed inline — small files are
 *  the ones likely to collide on (size, mtime). A larger blob is stat-only: its identity is
 *  (size, mtime) and contentHash stays null until the background hasher fills it in. */
function blob(abs: string, format: string, ctx: Ctx): Blob {
  const stat = fs.statSync(abs);
  const rel = path.relative(ctx.root, abs).split(path.sep).join('/');
  const cached = ctx.opts.cache?.(rel, stat.size, stat.mtimeMs) ?? null;
  if (cached) {
    record(ctx, abs, cached, stat.size, stat.mtimeMs);
    return { kind: 'blob', format, contentHash: cached, size: stat.size };
  }
  const inlineMax = ctx.opts.hashInlineMax ?? HASH_INLINE_MAX;
  const contentHash = stat.size <= inlineMax ? hashBytes(fs.readFileSync(abs)) : null;
  record(ctx, abs, contentHash, stat.size, stat.mtimeMs);
  return { kind: 'blob', format, contentHash, size: stat.size };
}

/** A textual file kept as a raw string scalar (markdown/asciidoc/plantuml/csv …). */
function textScalar(abs: string, format: string, ctx: Ctx): Node {
  const text = readTracked(ctx, abs).toString('utf8');
  return { kind: 'scalar', value: text, raw: text, meta: { schema: inlineFormat(format) } };
}

/** A structured/text file with no binary format: parse it into a node. The parser is chosen by
 *  extension — `.json`/`.json5`/`.json5p` → json5p (handles JSON/JSON5 incl. multi-line + comments,
 *  which the YAML parser does not), everything else (`.yaml`/`.yamlover`/no extension) → yamlover,
 *  the DEFAULT. So `30`→number, `"Alice"`→string, a JSON doc → a structure. Falls back to a raw
 *  string if parsing fails. */
function parsedScalar(abs: string, ext: string, ctx: Ctx): Node {
  const lang = ext === '.json' || ext === '.json5' || ext === '.json5p' ? 'json5p'
    : ext === '.yaml' || ext === '.yml' ? 'yaml' // YAML concrete: bare anchors/aliases are document-wide
    : 'yamlover';
  return parsedDoc(abs, lang, ctx);
}

/** Parse a file as a sub-document in the given surface language; falls back to a raw string.
 *  `yaml` differs from `yamlover` only in link semantics (concrete-aware — [[yaml-not-superset]]). */
function parsedDoc(abs: string, lang: 'yamlover' | 'json5p' | 'yaml', ctx: Ctx): Node {
  const text = readTracked(ctx, abs).toString('utf8');
  try {
    const doc = lang === 'json5p' ? parseJson5p(text, abs) : parseYamlover(text, abs, { yaml: lang === 'yaml' });
    const root = doc.root;
    // a parsed file is its own document; carry its head-of-file banner onto the node so it
    // survives assembly into the tree (Document.head would otherwise be lost here)
    root.meta = { ...root.meta, documentRoot: true, ...(doc.head?.length ? { head: doc.head } : {}) };
    return root;
  } catch {
    return { kind: 'scalar', value: text, raw: text };
  }
}

// --------------------------------------------------------------------------- //
// Schema application (the metadata layer): resolve a node's attached `!!<…>` schema and
// propagate (type, format) DOWN the instance via the schema's `properties`/`items`. So a
// chapter tagged only at its root makes its `children[*]` chapters and its `chunks[*]`
// text/marklower — even though the subnodes carry no tag of their own. (METADATA-only; no
// validation. Schema resolution was deferred — this is the first, targeted slice of it.)
// --------------------------------------------------------------------------- //

/** The nearest ancestor of `dir` (incl. itself) that holds a `$defs/` subtree — the
 *  yamlover-project root whose {$defs, tags} get grafted as the `yamlover` self-import
 *  key and whose schemas `*yamlover/$defs/<name>` pointers name; falls back to `dir`. */
/** True for a pointer that names the yamlover project's world URI (`*::: yamlover.inthemoon.net`) —
 *  the self-import that the walk materializes / de-materializes. A `yamlover` key pointing anywhere
 *  else is a user override and is left as authored (IMPORTS.md §4). */
function isYamloverWorldPointer(v: Value): boolean {
  return isPointer(v) && v.base.scope === 'link' && v.base.world === true && v.base.authority === YAMLOVER_AUTHORITY;
}

function findDefsRoot(dir: string): string {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '$defs'))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(dir);
    d = up;
  }
}

function applySchemas(root: Node, defsRoot: string, builtinDefs?: Map<string, Node>): void {
  const cache = new Map<string, Node | null>();
  const loadDef = (name: string): Node | null => {
    if (!cache.has(name)) {
      const defFile = path.join(defsRoot, '$defs', name);
      try {
        cache.set(name, parseYamlover(fs.readFileSync(defFile, 'utf8'), defFile).root);
      } catch {
        // no on-disk $defs/<name> → fall back to the built-in def (the graft case)
        cache.set(name, builtinDefs?.get(name) ?? null);
      }
    }
    return cache.get(name)!;
  };

  // the schema field at `key`: a Value (a sub-schema Node, or a `*…/$defs/…` Pointer)
  const field = (n: Node, key: string): Value | null => n.entries?.find((e) => e.key === key)?.value ?? null;
  const str = (n: Node, key: string): string | null => {
    const v = field(n, key);
    return v && !isPointer(v) && v.kind === 'scalar' && v.value != null ? String(v.value) : null;
  };
  const hasFormat = (inst: Node): boolean => {
    if (inst.kind === 'blob') return true;
    const s = inst.meta?.schema;
    return !!s && !isPointer(s) && s.kind === 'mapping' && !!field(s, 'format');
  };

  const apply = (inst: Node, schema: Value, depth: number): void => {
    if (depth > 64 || isPointer(inst)) return;
    // resolve a pointer schema (`*…/$defs/<name>`) to the hosted schema node
    let name: string | null = null;
    let s: Node | null;
    if (isPointer(schema)) {
      const last = schema.steps[schema.steps.length - 1];
      name = last?.sel === 'key' ? last.name : null;
      s = name ? loadDef(name) : null;
    } else s = schema;
    if (!s || isPointer(s)) return;
    // attach this node's derived (type, format): an explicit schema `format`, else an
    // object schema hosted as `$defs/<name>` → `x-yamlover-<name>` (chapter, tag, …).
    const fmt = str(s, 'format') ?? (name && str(s, 'type') === 'object' ? `x-yamlover-${name}` : null);
    if (fmt && !hasFormat(inst)) inst.meta = { ...inst.meta, schema: inlineFormat(fmt) };
    // recurse structurally — `variant`/`mixed` carry keyed fields exactly like `object`
    // (META.md vocabulary: variant = !!var, mixed = !!mix), so `properties`/
    // `additionalProperties` propagate through them too (e.g. a tag taxonomy whose tags
    // hold their description as a BODY still tags every sub-tag).
    const stype = str(s, 'type');
    if (stype === 'object' || stype === 'variant' || stype === 'mixed') {
      const props = field(s, 'properties');
      const addl = field(s, 'additionalProperties'); // a schema for keys not in `properties`
      for (const e of inst.entries ?? []) {
        if (e.key == null || isPointer(e.value)) continue;
        // A child that declares its OWN inline `!!<*…/$defs/X>` schema wins over an inherited
        // `properties`/`additionalProperties` — `walk()` applies the child's pointer separately.
        // (Without this, additionalProperties would clobber, e.g., a `$defs/workflow` node sitting
        // in a tag taxonomy back down to `x-yamlover-tag`. `hasFormat` can't guard it — a pointer
        // schema carries no `format` field yet.)
        if (e.value.meta?.schema && isPointer(e.value.meta.schema)) continue;
        const declared = props && !isPointer(props) ? field(props, e.key) : null;
        const sub = declared ?? addl; // a declared property wins, else additionalProperties
        if (sub) apply(e.value, sub, depth + 1);
      }
    } else if (stype === 'array') {
      const items = field(s, 'items');
      if (items) for (const e of inst.entries ?? []) if (!isPointer(e.value)) apply(e.value, items, depth + 1);
    }
  };

  const walk = (node: Node): void => {
    if (node.meta?.schema) apply(node, node.meta.schema, 0);
    for (const e of node.entries ?? []) if (!isPointer(e.value)) walk(e.value);
  };
  walk(root);
}

/** Wrap a `format` string as an inline schema Node (a one-line yamlover/meta `{format: …}`),
 *  matching the `!!<format: …>` tag form so the renderer keys off (type, format) uniformly. */
function inlineFormat(format: string): Value {
  return { kind: 'mapping', entries: [{ key: 'format', edge: 'contain', value: { kind: 'scalar', value: format, raw: format } }], array: false };
}

/** Merge `.yamlover/body.yamlover` over the directory mapping (YAMLOVER.md §5):
 *  - a mapping body OVERRIDES same-key children and ADDS overlay-only keys (scalars/pointers);
 *  - a pointer-array body (`- *file …`) imposes ORDER over the existing children;
 *  - a SCALAR body root with fields (the omni shape, e.g. `!!var A taxonomy` over a tag
 *    directory) gives the directory that scalar as its own BODY, fields merged as above.
 *  The body root's `meta` (e.g. a `!!<*yamlover/$defs/chapter>` tag attaching a schema to the
 *  whole directory) is carried onto the merged node, so a directory CHAPTER is recognized. */
function applyBody(dir: string, node: Mapping, ctx: Ctx): Node {
  const file = path.join(dir, YAMLOVER_DIR, 'body.yamlover');
  if (!fs.existsSync(file)) return node;
  const bodyDoc = parseYamlover(readTracked(ctx, file).toString('utf8'), file);
  const body = bodyDoc.root;
  if (body.kind !== 'mapping' && body.kind !== 'scalar') return node;
  // A scalar body has no `entries` (a bare `30`); an omni scalar body / mapping body does. Treat a
  // field-less scalar as an empty overlay so the directory still takes the scalar as its own value.
  const bodyEntries = body.entries ?? [];
  // a directory with a body.yamlover overlay is a self-contained instance = a DOCUMENT root
  // (so `*/file` inside it resolves to this directory, at any nesting depth). The body's
  // head-of-file banner rides onto the node so it survives past the parse.
  const meta = { ...node.meta, ...body.meta, documentRoot: true, ...(bodyDoc.head?.length ? { head: bodyDoc.head } : {}) };

  // a pure pointer/positional array → reorder existing children to match
  if (body.kind === 'mapping' && (body.array || (bodyEntries.length > 0 && bodyEntries.every((e) => e.key === null)))) {
    const byKey = new Map(node.entries.map((e) => [e.key, e] as const));
    const ordered: Entry[] = [];
    for (const e of bodyEntries) {
      const targetKey = isPointer(e.value) ? pointerLeafKey(e.value) : null;
      const hit = targetKey != null ? byKey.get(targetKey) : null;
      if (hit) { ordered.push(hit); byKey.delete(targetKey); }
      else ordered.push(e); // an inline element (not a pointer to a child)
    }
    for (const e of node.entries) if (e.key != null && byKey.has(e.key)) ordered.push(e); // unlisted, trailing
    return { kind: 'mapping', entries: ordered, array: true, meta };
  }

  // a mapping body: ADD overlay-only keys; for a key that matches a dir child, the overlay
  // AUGMENTS it (YAMLOVER.md §5) — e.g. a file blob + body title/tags ⇒ an omni-blob (a blob
  // that carries members), not a replacement.
  const merged = new Map(node.entries.map((e) => [e.key, e] as const));
  const order: (string | null)[] = node.entries.map((e) => e.key);
  for (const e of bodyEntries) {
    const existing = merged.get(e.key);
    if (!existing) { order.push(e.key); merged.set(e.key, e); }
    else merged.set(e.key, augmentEntry(existing, e));
  }
  const entries = order.map((k) => merged.get(k)!);
  // a scalar body root → the directory node carries that scalar as its own value (omni)
  if (body.kind === 'scalar') return { kind: 'scalar', value: body.value, raw: body.raw, entries, array: false, meta };
  return { kind: 'mapping', entries, array: false, meta };
}

/** Overlay `body`'s entry onto the directory's: keep the dir node's value/kind/format (the file
 *  bytes) and attach the overlay's fields + meta. A pointer on either side just replaces. */
function augmentEntry(base: Entry, overlay: Entry): Entry {
  if (isPointer(base.value) || isPointer(overlay.value)) return overlay;
  const b = base.value, o = overlay.value;
  // keep b's discriminated kind (mapping/scalar/blob) + value/format; attach the overlay's fields
  const value = {
    ...b,
    entries: o.entries ?? b.entries,
    array: o.entries ? o.array : b.array,
    meta: b.meta || o.meta ? { ...b.meta, ...o.meta } : undefined,
  } as Node;
  return { key: base.key, edge: 'contain', value };
}

/** The final string key a sibling pointer addresses (`*anyfile01` → "anyfile01"); null if not
 *  a simple current-scope key reference. Used to match a body pointer-array element to a child. */
function pointerLeafKey(v: Value): string | null {
  if (!isPointer(v)) return null;
  const last = v.steps[v.steps.length - 1];
  if (last?.sel === 'key') return last.name;
  if (v.steps.length === 0 && v.base.scope === 'current') return v.raw; // bare `*name`
  return null;
}

/** Heuristic: a file is binary if it is large, or a NUL byte appears in its head. */
function looksBinary(abs: string): boolean {
  try {
    if (fs.statSync(abs).size > MAX_TEXT_BYTES) return true;
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).includes(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true; // unreadable → treat as opaque
  }
}

// Extension → format (subset of the server's table; the renderer keys off it). TEXT_FORMATS are
// the formats kept inline as string scalars; every other known format is opaque (a Blob).
const EXT_FORMAT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.djvu': 'image/vnd.djvu', '.djv': 'image/vnd.djvu',
  '.psd': 'image/vnd.adobe.photoshop', '.psb': 'image/vnd.adobe.photoshop', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heic',
  '.fb2': 'application/x-fictionbook+xml', '.epub': 'application/epub+zip',
  '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.adoc': 'text/asciidoc', '.asciidoc': 'text/asciidoc', '.asc': 'text/asciidoc',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.kml': 'application/vnd.google-earth.kml+xml', '.kmz': 'application/vnd.google-earth.kmz',
  '.puml': 'text/x-plantuml', '.plantuml': 'text/x-plantuml', '.iuml': 'text/x-plantuml', '.pu': 'text/x-plantuml',
  // Plain text kept as RAW BYTES (text/plain is deliberately NOT in TEXT_FORMATS), so the
  // client decodes it under a chosen encoding (CP866/Win-1251/KOI8-R/UTF-8) — legacy
  // Cyrillic .txt files are common — rather than the server fixing UTF-8.
  '.txt': 'text/plain', '.text': 'text/plain', '.log': 'text/plain', '.ini': 'text/plain',
};

const TEXT_FORMATS = new Set(['text/markdown', 'text/asciidoc', 'text/x-plantuml', 'text/csv', 'text/tab-separated-values']);

// A `format` naming a SUB-DOCUMENT ENCODING (META.md): the file's text parses into a node in
// that surface language — `yamlover`/`yaml`/`json`/… for an instance, `…/meta` for a schema doc
// (e.g. the extensionless `$defs/*` files). These must never fall into the opaque-Blob branch.
const DOC_FORMATS: Record<string, 'yamlover' | 'json5p' | 'yaml'> = {
  'yamlover': 'yamlover', 'yaml': 'yaml', 'yamlover/meta': 'yamlover', 'yaml/meta': 'yaml',
  'json': 'json5p', 'json5': 'json5p', 'json5p': 'json5p',
  'json/meta': 'json5p', 'json5p/meta': 'json5p', 'json/schema': 'json5p',
};
