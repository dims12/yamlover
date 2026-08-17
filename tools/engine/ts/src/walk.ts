// Directory walker — the directory concrete (docs/language/concretes) → IR Document. Replaces the
// Python walker / the server's legacy `loadEntity`, mirroring its file→value semantics so the
// web UI works "as it was", but emitting the new IR (parser/ts/src/ir.ts) the engine consumes.
//
// A directory IS a mapping: each file/subdir is an entry keyed by its filename. The `.yo/`
// overlay dir is not itself an entry; it carries:
//   - body.yo — the INSTANCE overlay: a mapping merges over the dir (override/add); a
//     pointer-array (`- *file …`) imposes child ORDER (a bare dir takes filesystem order).
//   - meta.yo — the metadata SCHEMA: `properties.<name>.{type,format}` types a child
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
import { pathOfSegs } from '../../../parser/ts/src/pathseg.ts';
import { graftTaxonomy, YAMLOVER_AUTHORITY } from './mounts.ts';

// xxh64 (xxhash-wasm) is the content/manifest hash: identity, not security — chosen for SPEED
// (multiple GB/s, far above disk throughput). The `xxh64:` prefix keeps the algorithm swappable.
// The WASM module instantiates once at import (top-level await — milliseconds).
const { h64Raw, create64 } = await xxhash();
const hashBytes = (bytes: Uint8Array): string => 'xxh64:' + h64Raw(bytes).toString(16).padStart(16, '0');

const YAMLOVER_DIR = '.yo';
const BODY_FILE = 'body.yo';
// The `dir/index.yo` flavor keeps its INSTANCE OVERLAY in a plain file inside the directory it
// controls instead of under `.yo/` (docs/language/concretes/03-yamlover/01-dir/01-dir_index_yo).
// The file is CONSUMED — never an entry — so such a directory cannot hold a member of that name.
const INDEX_FILE = 'index.yo';
// Engine-owned files inside `.yo/` that must NOT be indexed: the overlays are read into the
// parent directory (applyBody/loadMeta), and the index db would otherwise index itself. Everything
// else under `.yo/` (the derived `thumbnails/` and `fragments/` sidecar dirs) is walked
// normally — those blobs are addressable content (just hidden). See yamloverDirNode.
const YAMLOVER_INTERNAL = new Set([
  'body.yo', 'meta.yo', 'settings.yo',
  'index.db', 'index.db-wal', 'index.db-shm', 'index.db-journal',
]);
// `settings.yo` is engine-owned (read by loadSettings, never an overlay applied to the parent)
// but — UNLIKE body/meta/index.db — it IS indexed as a HIDDEN node, so the config file is openable
// and editable at `:.yo:settings.yo` by the settings renderer (IMPORTS.md). It is the one
// YAMLOVER_INTERNAL name admitted into the overlay subtree.
const SETTINGS_FILE = 'settings.yo';
const skipInYamloverDir = (name: string): boolean =>
  (YAMLOVER_INTERNAL.has(name) && name !== SETTINGS_FILE) || name.startsWith('.');
const MAX_TEXT_BYTES = 1 << 20; // 1 MiB: above this we never slurp a file to sniff/parse it
const MAX_DOC_BYTES = 64 << 20; // 64 MiB: a format-matched text/doc file above this stays a Blob (never slurped)
const HASH_INLINE_MAX = 1 << 20; // 1 MiB: a blob at or under this is read + hashed inline by the walk
const HASH_CHUNK = 8 << 20; // 8 MiB: streaming-hash chunk — constant memory at any file size

export interface WalkOptions {
  /** Skip a filesystem child when this returns true for its absolute path (e.g. a `.gitignore`
   *  matcher, so a project-root walk does not descend into `node_modules`). Hidden dotfiles and
   *  the `.yo/` overlay dir are always skipped regardless. */
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
  /** Pass an empty object and {@link walkTreeGen} fills in `current` — a provisional snapshot of
   *  the tree walked SO FAR, assembled on demand between generator steps (completed subtrees by
   *  reference, in-progress directories as provisional mappings). Powers partial index commits
   *  ({@link reindexAsyncDoc} `partialCommitMs`) so a TOC can populate while a big walk runs. */
  snapshot?: PartialSnapshot;
  /** A file the walk could not parse, by root-relative POSIX path. The walk NEVER fails a whole
   *  tree over one bad file — a broken node degrades (a data file to its raw text, a directory
   *  overlay to the plain filesystem mapping) and the reason is reported here. */
  onFileError?: (relPath: string, err: unknown) => void;
}

export interface PartialSnapshot {
  /** Assemble the tree walked so far, or null when no snapshot is available (walk not started,
   *  already complete, or currently in an out-of-tree graft walk). `filePaths` is the manifest
   *  paths recorded so far, in discovery order — the caller diffs consecutive snapshots by index. */
  current?: () => { root: Node; filePaths: string[] } | null;
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

export interface ReindexAsyncOptions extends AsyncWalkOptions {
  /** Commit a PROVISIONAL index of the tree walked so far at most every this many ms, so the TOC
   *  populates while a big walk runs. Adaptive: the interval stretches to 5× the last commit's
   *  duration, bounding commit overhead on huge trees. Off when absent (the default — the plain
   *  library API keeps the single atomic commit). Partial commits write nodes/edges only (never
   *  the file manifest), so the final diff against the previous manifest is unaffected; derived
   *  formats/grafts refine at the final commit. */
  partialCommitMs?: number;
  /** After each partial commit: the manifest paths (root-relative POSIX) that became visible
   *  since the previous one — the caller broadcasts them as an incremental `added` diff. */
  onPartial?: (addedPaths: string[]) => void;
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

/** One in-progress directory on the partial-snapshot stack: its name (filesystem key in the
 *  parent), the entries completed so far (the LIVE array {@link dirNode} appends to — snapshots
 *  copy it), and any node meta the finished node would carry (`.yo` → hidden). */
interface PartialFrame {
  name: string;
  entries: Entry[];
  meta?: Node['meta'];
}

/** Everything a walk threads along: the root (for manifest-relative paths), the options,
 *  the manifest accumulator (a Map to dedupe re-reads), and the running progress count
 *  (filesystem children processed). `open` (only when snapshots are requested) is the stack of
 *  directories currently being walked, root-first — {@link assemblePartial} folds it into a
 *  provisional tree. */
interface Ctx {
  root: string;
  opts: WalkOptions;
  files: Map<string, FileRecord>;
  count: number;
  open?: PartialFrame[];
}

/** Fold the open-directory stack into a provisional root: each frame's node holds its completed
 *  entries plus the next (deeper) frame's provisional node under its name. O(depth) fresh wrapper
 *  objects; completed subtrees ride by reference (they are never mutated after completion — the
 *  walk only appends to the OPEN frames' entry arrays, which are copied here). */
function assemblePartial(open: PartialFrame[]): Node | null {
  let child: { name: string; node: Node } | null = null;
  for (let k = open.length - 1; k >= 0; k--) {
    const f = open[k];
    const entries: Entry[] = child
      ? [...f.entries, { key: child.name, edge: 'contain', value: child.node }]
      : [...f.entries];
    child = { name: f.name, node: { kind: 'mapping', array: false, entries, ...(f.meta ? { meta: { ...f.meta } } : {}) } };
  }
  return child?.node ?? null;
}

/** Walk a directory (absolute path) into an IR Document (concrete: "dir"). */
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
// bundling and ships with no data files): the `$defs/onto` schema (format x-yamlover-onto, with
// recursive sub-tags) and the `ontos/colors` palette. It is grafted as the `yamlover` self-import
// into any served tree that has no `$defs/` of its own, so `*yamlover/ontos/colors/…` resolves —
// and color-tag annotations validate — in a PLAIN directory, not only a yamlover project. Mirrors
// the on-disk taxonomy at the repo root; the palette hexes mirror COLOR_ONTOS in annotate.tsx.
const BUILTIN_ONTO_SCHEMA = 'type: variant\nformat: x-yamlover-onto\nmembers:\n  color:\n    type: string\nothers: *:: yamlover: $defs: onto\n';
// embedded fragments / annotations (docs/annotations) — minimal so the `!!<*::yamlover/$defs/…>`
// tags resolve (and the nodes index as x-yamlover-fragment / -annotation) in a plain served tree.
const BUILTIN_FRAGMENT_SCHEMA = 'type: object\nformat: x-yamlover-fragment\n';
const BUILTIN_ANNOTATION_SCHEMA = 'type: variant\nformat: x-yamlover-annotation\n';
const BUILTIN_ONTOS_BODY =
  '!!<*yamlover:$defs:onto>\ncolors: The palette\n' +
  '  yellow:\n    color: "#f9e2af"\n' +
  '  green:\n    color: "#a6e3a1"\n' +
  '  sky:\n    color: "#89dceb"\n' +
  '  mauve:\n    color: "#cba6f7"\n' +
  '  pink:\n    color: "#f5c2e7"\n' +
  '  peach:\n    color: "#fab387"\n';

let builtinTemplate: { onto: Node; ontos: Node } | null = null;
/** The built-in `yamlover` graft node + its `$defs` map (for {@link applySchemas} to resolve
 *  `*yamlover:$defs:onto` without a disk read). Parsed once, then cloned per graft so a walk never
 *  mutates the shared template (applySchemas attaches derived meta to the instance it grafts). */
function builtinYamloverGraft(): { node: Node; defs: Map<string, Node> } {
  builtinTemplate ??= {
    onto: parseYamlover(BUILTIN_ONTO_SCHEMA, '$defs/onto').root,
    ontos: parseYamlover(BUILTIN_ONTOS_BODY, 'ontos/.yo/body.yo').root,
  };
  const tagCopy = structuredClone(builtinTemplate.onto);
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
            { key: 'onto', edge: 'contain', value: tagCopy },
            { key: 'fragment', edge: 'contain', value: fragCopy },
            { key: 'annotation', edge: 'contain', value: annCopy },
          ],
        },
      },
      { key: 'ontos', edge: 'contain', value: structuredClone(builtinTemplate.ontos) },
    ],
  };
  return { node, defs: new Map([['onto', tagCopy], ['fragment', fragCopy], ['annotation', annCopy]]) };
}

/** The walk as a generator: yields one {@link WalkProgress} per filesystem child processed,
 *  returns the {@link WalkResult}. */
export function* walkTreeGen(absDir: string, opts: WalkOptions = {}): Generator<WalkProgress, WalkResult, void> {
  const ctx: Ctx = { root: path.resolve(absDir), opts, files: new Map(), count: 0, open: opts.snapshot ? [] : undefined };
  if (opts.snapshot) {
    opts.snapshot.current = () => {
      const partial = ctx.open?.length ? assemblePartial(ctx.open) : null;
      return partial ? { root: partial, filePaths: [...ctx.files.keys()] } : null;
    };
  }
  const root = yield* dirNode(ctx.root, ctx);
  // Disable snapshots from here on: the graft walks below (an ancestor `$defs`/`tags`) are
  // OUT-OF-TREE — their frames would masquerade as the root.
  ctx.open = undefined;
  root.meta = { ...root.meta, documentRoot: true }; // the served root is always a document root
  // Resolve the SELF-IMPORT key `yamlover` — the yamlover project ({`$defs/` schemas, `tags/`
  // palette}, URI `::: yamlover.inthemoon.net`) — into the served tree, so `*::yamlover:…` (and the
  // world form `*::: yamlover.inthemoon.net:…`) resolve from ANY served root (IMPORTS.md §4). The
  // import may be AUTHORED as a root body key (`yamlover: *::: yamlover.inthemoon.net`) or left
  // IMPLICIT; either way the walk MATERIALIZES the taxonomy under the `yamlover` key (replacing the
  // import pointer with the real subtree) so no world pointer is left to dangle.
  //
  // THE UNIFORM GRAFT: the graft applies to EVERY root, whatever its shape — array, omni, scalar,
  // mapping. yamlover is tolerant of mixtures and omnis by design: a keyed entry beside keyless
  // ones is a well-formed mix, the node's `array` flag keeps an authored seq projecting as the seq
  // it is, and hidden entries are plumbing the views filter anyway. There are NO shape
  // special-cases here — an earlier one ("skip array roots, a keyed graft would flip their kind")
  // silently broke schema resolution for every untitled directory chapter, which is exactly the
  // kind of divergence an ad-hoc skip breeds. Behavior must stay unified for every root.
  //
  // Three outcomes, by where the taxonomy lives:
  //  • served root IS the yamlover project (own `$defs/`): the taxonomy is ALREADY at `:$defs` /
  //    `:tags`; materializing again would DUPLICATE every node (`:yamlover:ontos:…` beside the real
  //    `:ontos:…`, splitting a tag's backlinks). So DE-MATERIALIZE — drop any `yamlover` key and let
  //    the resolver/query evaluator absorb `::yamlover:…` ≡ `::…` virtually (resolve.ts, query.ts).
  //  • served root is a SUBDIRECTORY of a project (taxonomy at an ancestor): graft the live ancestor
  //    `$defs`+`tags` in-tree.
  //  • a plain/foreign/DETACHED dir (no taxonomy reachable): graft the BUNDLED taxonomy (mounts.ts,
  //    shipped as package data — the full $defs incl. board/task/workflow + the tags taxonomy), so a
  //    detached copy of an example still resolves `*::yamlover:ontos:workflow:dev`. Falls back to the
  //    minimal in-source builtin only if the bundle is somehow absent.
  // A `yamlover` key pointing somewhere ELSE (not the yamlover world URI) is a real user override and
  // is left untouched (IMPORTS.md §4 "until overridden").
  const defsRoot = findDefsRoot(absDir);
  const defsDir = path.join(defsRoot, '$defs');
  // served root IS a project root: it has its OWN `$defs/` direct child (findDefsRoot falls back to
  // the dir itself for a foreign tree, so the existence check is what distinguishes self from foreign).
  const selfRoot = fs.existsSync(defsDir) && path.resolve(absDir) === defsRoot;
  let builtinDefs: Map<string, Node> | undefined; // the in-memory $defs for a BUNDLED/builtin graft (no disk)
  if (!opts.noGraft && root.entries) {
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
        const ontosDir = path.join(defsRoot, 'ontos');
        if (fs.existsSync(ontosDir)) shared.push({ key: 'ontos', edge: 'contain', value: yield* dirNode(ontosDir, ctx) });
        node = { kind: 'mapping', entries: shared, array: false };
      } else {
        // No project taxonomy on disk: graft the BUNDLED taxonomy (full $defs + tags), falling back
        // to the minimal in-source builtin if the bundle is unavailable.
        const built = graftTaxonomy() ?? builtinYamloverGraft();
        node = built.node;
        builtinDefs = built.defs;
      }
      // the self-import is plumbing, not content: HIDDEN from the TOC/explorer/projection like the
      // `.yo` overlay, yet fully reachable — `:yamlover` navigates, `*::yamlover:…` resolves
      node.meta = { ...node.meta, hidden: true };
      if (yEntry) { yEntry.value = node; yEntry.edge = 'contain'; } // materialize over the import pointer
      else root.entries.push({ key: 'yamlover', edge: 'contain', value: node });
    }
  }
  // Whatever path the graft took (or a user's own `yamlover` override left in place), attached
  // schemas must ALWAYS resolve — no root reaches applySchemas without a defs source. Disk `$defs`
  // wins; else the bundled taxonomy backs `loadDef` in memory.
  if (!opts.noGraft && !builtinDefs && !fs.existsSync(defsDir)) {
    builtinDefs = (graftTaxonomy() ?? builtinYamloverGraft()).defs;
  }
  applySchemas(root, defsRoot, builtinDefs); // propagate attached !!<…> schemas down the instance
  return {
    doc: { root, source: { concrete: 'dir', uri: absDir } },
    files: [...ctx.files.values()],
  };
}

/** Build the index DB for a directory tree: walk → IR → SQLite at <root>/.yo/index.db.
 *  Creates the .yo/ dir if absent. The DB is a derived cache (ENGINE.md) — re-runnable. */
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
export async function reindexAsync(store: Store, absDir: string, opts: ReindexAsyncOptions = {}): Promise<IndexDiff> {
  return (await reindexAsyncDoc(store, absDir, opts)).diff;
}

/** {@link reindexAsync} that also returns the assembled {@link Document} and file manifest — the
 *  server retains the doc so a later single-file edit can be patched against it in memory
 *  ({@link reindexPathAsync}) instead of re-walking and rebuilding the whole tree. */
export async function reindexAsyncDoc(
  store: Store,
  absDir: string,
  opts: ReindexAsyncOptions = {},
): Promise<{ diff: IndexDiff; doc: Document; files: FileRecord[] }> {
  const prev = store.stale ? new Map<string, FileRecord>() : store.manifest();
  const onProgress = opts.onProgress;
  // the enumeration pre-pass reports too — on a slow drive it can take minutes, and silence
  // there is indistinguishable from a hang
  let lastEnum = 0;
  const total = onProgress
    ? await countChildren(path.resolve(absDir), opts, (n) => {
        const now = Date.now();
        if (now - lastEnum < 250) return;
        lastEnum = now;
        onProgress({ done: 0, message: `enumerating… ${n} entries` });
      })
    : undefined;

  // PARTIAL COMMITS (opt-in): between walk steps, commit a provisional snapshot of the tree so
  // far — nodes/edges only, never the manifest — and report the newly visible file paths. The
  // walk generator is suspended while the (synchronous) commit runs, so the snapshot cannot race.
  const partialMs = opts.partialCommitMs;
  const snapshot: PartialSnapshot = opts.snapshot ?? {};
  let lastPartial = Date.now();
  let minInterval = partialMs ?? 0;
  let reported = 0; // filePaths already handed to onPartial
  const maybeCommitPartial = (): void => {
    if (!partialMs) return;
    const now = Date.now();
    if (now - lastPartial < minInterval) return;
    const snap = snapshot.current?.();
    if (!snap) return;
    lastPartial = now;
    const t0 = Date.now();
    try {
      snap.root.meta = { ...snap.root.meta, documentRoot: true };
      store.indexDocument({ root: snap.root, source: { concrete: 'dir', uri: absDir } });
      minInterval = Math.max(partialMs, 5 * (Date.now() - t0));
      const added = snap.filePaths.slice(reported);
      reported = snap.filePaths.length;
      if (added.length > 0) opts.onPartial?.(added);
    } catch {
      // best-effort: a failed partial commit only delays visibility; the final commit is authoritative
    }
  };

  const { doc, files } = await walkTreeAsync(absDir, {
    ...opts,
    cache: opts.cache ?? manifestCache(prev),
    snapshot: partialMs ? snapshot : opts.snapshot,
    onProgress: onProgress || partialMs
      ? (p): void => {
          onProgress?.({ ...p, total });
          maybeCommitPartial();
        }
      : undefined,
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
  // The splice unit is the directory that OWNS the change: for a `.yo/` overlay the directory
  // the overlay belongs to; for any other file, its containing directory.
  const parts = changedRel.split('/');
  const yi = parts.indexOf(YAMLOVER_DIR);
  const dirSegs = yi >= 0 ? parts.slice(0, yi) : parts.slice(0, -1);
  if (dirSegs.length === 0) return null; // a root-level file → re-walking the root is a full reindex
  if (dirSegs[0] === '$defs' || dirSegs[0] === 'ontos') return null; // feeds applySchemas/the graft

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
  const P = pathOfSegs(dirSegs); // canonical store-path tokens (a spacey dir name rides quoted)
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
 *  the determinate `total` for progress. readdir-only; trivially cheap next to the walk on a
 *  local disk, but minutes on a slow network drive — `onCount` reports the running count every
 *  ~200 entries so the pre-pass is visibly alive. */
async function countChildren(absRoot: string, opts: WalkOptions, onCount?: (n: number) => void): Promise<number> {
  let n = 0;
  const tick = (): void => {
    if (onCount && n % 200 === 0) onCount(n);
  };
  // count a `.yo/` overlay dir's indexable sidecars (same skip-list as yamloverDirNode);
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
      tick();
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
    // the `index.yo` the walk CONSUMES as this directory's overlay is not a child (dirNode)
    const consumesIndex = entries.some((e) => e.name === INDEX_FILE) && path.basename(overlayFile(dir) ?? '') === INDEX_FILE;
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== YAMLOVER_DIR) continue;
      if (consumesIndex && e.name === INDEX_FILE) continue;
      const abs = path.join(dir, e.name);
      if (opts.ignore?.(abs)) continue;
      if (e.name === YAMLOVER_DIR) {
        if ((await visitYamlover(abs)) > 0) n++; // +1 for the hidden `.yo` node itself
        continue;
      }
      n++;
      tick();
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

/** A file's root-relative POSIX path — the currency diffs, watcher batches, progress ticks
 *  and error reports all speak. */
function rel(ctx: Ctx, abs: string): string {
  return path.relative(ctx.root, abs).split(path.sep).join('/');
}

/** Record a file the walk saw into the manifest (`hash` is null for a large blob the walk did
 *  not read). Files outside the walked root (e.g. a `$defs` host found above it) are not
 *  manifested — the watcher cannot see them. */
function record(ctx: Ctx, abs: string, hash: string | null, size: number, mtimeMs: number): void {
  const relPath = rel(ctx, abs);
  if (relPath.startsWith('..')) return;
  ctx.files.set(relPath, { path: relPath, hash, size, mtimeMs });
}

/** Report an unparsable file and carry on. Returns the `parseError` stamp the degraded node
 *  carries ({@link NodeMeta.parseError}) — the same root-relative POSIX path the report speaks,
 *  plus the parser's reason. */
function noteFileError(ctx: Ctx, abs: string, err: unknown): { file: string; message: string } {
  const file = rel(ctx, abs);
  ctx.opts.onFileError?.(file, err);
  return { file, message: String((err as Error)?.message ?? err) };
}

/** Read a file's bytes, recording its content identity in the manifest. */
function readTracked(ctx: Ctx, abs: string): Buffer {
  const stat = fs.statSync(abs);
  const bytes = fs.readFileSync(abs);
  record(ctx, abs, hashBytes(bytes), stat.size, stat.mtimeMs);
  return bytes;
}

/** Per-child metadata from `.yo/meta.yo` `members:` (legacy spelling `properties:` — read
 *  forever). `concrete` is the decode axis (a language / codec / charset —
 *  docs/language/concretes); `type` the abstract kind; `format` a named constraint on the
 *  value, never a decode selector (docs/meta). A clause with `pattern: true` matches member
 *  NAMES by its key read as a regexp — JSON Schema patternProperties semantics, so the
 *  regexp SEARCHES the name (authors anchor with `^…$` themselves). A clause's own nested
 *  `members:` describes a directory child's members in turn (docs/meta/members). */
type MetaEntry = {
  concrete?: string; type?: string; format?: string; uniqueItems?: boolean;
  pattern?: boolean; members?: unknown; properties?: unknown;
};
type Meta = {
  exact: Record<string, MetaEntry>;
  patterns: Array<{ re: RegExp; entry: MetaEntry }>;
};

/** Split a meta-shaped object into clauses: literal names vs `pattern: true` selectors.
 *  `members` wins per key over the legacy `properties`; keyless member clauses have no
 *  meaning for directory children (every file has a name) and fall away in toPlain. */
function parseClauses(plain: unknown): { meta: Meta; badPattern?: string } {
  const meta: Meta = { exact: {}, patterns: [] };
  let badPattern: string | undefined;
  const clause = (v: unknown): Record<string, MetaEntry> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, MetaEntry>) : {};
  const p = plain as Record<string, unknown> | null | undefined;
  for (const src of [clause(p?.properties), clause(p?.members)]) {
    for (const [key, entry] of Object.entries(src)) {
      if (entry && typeof entry === 'object' && entry.pattern) {
        try {
          meta.patterns.push({ re: new RegExp(key), entry });
        } catch {
          badPattern ??= key; // an unparsable regexp: the clause is dropped, the author told
        }
      } else {
        meta.exact[key] = entry;
      }
    }
  }
  return { meta, badPattern };
}

/** The clause for a member name: an exact clause always wins; otherwise pattern clauses try
 *  in author order and the FIRST match supplies the whole entry (sub-metas do not merge). */
function metaFor(meta: Meta | undefined, name: string): MetaEntry | undefined {
  if (!meta) return undefined;
  if (Object.prototype.hasOwnProperty.call(meta.exact, name)) return meta.exact[name];
  return meta.patterns.find((p) => p.re.test(name))?.entry;
}

function loadMeta(dir: string, ctx: Ctx): { props: Meta; error?: { file: string; message: string } } {
  const file = path.join(dir, YAMLOVER_DIR, 'meta.yo');
  if (!fs.existsSync(file)) return { props: { exact: {}, patterns: [] } };
  try {
    const plain = toPlain(parseYamlover(readTracked(ctx, file).toString('utf8'), file).root) as Record<string, unknown>;
    const { meta, badPattern } = parseClauses(plain);
    if (badPattern !== undefined)
      return { props: meta, error: noteFileError(ctx, file, new Error(`pattern clause is not a valid regexp: ${badPattern}`)) };
    return { props: meta };
  } catch (e) {
    // there is no node yet to stamp — the error rides out to dirNode, which puts it on the
    // directory (the node whose children just lost their per-child metadata)
    return { props: { exact: {}, patterns: [] }, error: noteFileError(ctx, file, e) };
  }
}

/** A directory → a Mapping node: one entry per file/subdir, then the instance overlay.
 *  `inherited` is the nested `members:` clause an ANCESTOR meta declared for this directory —
 *  the directory's own `.yo/meta.yo` is closer to the data and wins per member (any own
 *  clause, exact or pattern, beats any inherited one).
 *  A generator: yields one progress tick per child processed (subtree ticks ride through). */
function* dirNode(dir: string, ctx: Ctx, inherited?: Meta): Generator<WalkProgress, Node, void> {
  const { props: meta, error: metaError } = loadMeta(dir, ctx);
  const overlay = overlayFile(dir);
  const consumesIndex = overlay !== null && path.basename(overlay) === INDEX_FILE;
  const names = fs
    .readdirSync(dir)
    .filter((n) => n === YAMLOVER_DIR || !n.startsWith('.')) // keep `.yo` (hidden subtree); drop other dotfiles
    .filter((n) => !(consumesIndex && n === INDEX_FILE)) // the overlay is read, never an entry
    .filter((n) => !ctx.opts.ignore?.(path.join(dir, n))) // skip git-ignored (e.g. node_modules)
    .sort(); // filesystem order = sorted names (stable; the overlay can re-impose order)

  const entries: Entry[] = [];
  ctx.open?.push({ name: path.basename(dir), entries });
  for (const name of names) {
    const abs = path.join(dir, name);
    if (name === YAMLOVER_DIR) {
      // index the overlay dir's derived sidecars as a HIDDEN child (omitted when it holds only
      // engine files — overlays / index db — so plain directories keep today's shape).
      const hidden = yield* yamloverDirNode(abs, ctx);
      if (hidden) {
        entries.push({ key: name, edge: 'contain', value: hidden });
        yield { done: ++ctx.count, path: rel(ctx, abs) };
      }
      continue;
    }
    const child = yield* childNode(abs, metaFor(meta, name) ?? metaFor(inherited, name), ctx);
    entries.push({ key: name, edge: 'contain', value: child });
    yield { done: ++ctx.count, path: rel(ctx, abs) };
  }
  ctx.open?.pop();

  const node: Mapping = { kind: 'mapping', entries, array: false };
  const merged = applyMeta(applyBody(overlay, node, ctx), meta, inherited); // attach meta `format` to entries (incl. body-overlay ones)
  // a broken meta.yo surfaces on the directory too, but the BODY's error wins the single
  // slot — the body is what a mediated write would re-serialize
  return metaError && !merged.meta?.parseError ? { ...merged, meta: { ...merged.meta, parseError: metaError } } : merged;
}

/** A `.yo/` overlay dir → a HIDDEN content subtree (its derived `thumbnails/`/`fragments/`
 *  sidecars, addressable as `*:.yo:…`), or null when nothing indexable remains (overlay /
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
  // hidden in the frame too, so a partial snapshot never shows a transient visible `.yo`
  ctx.open?.push({ name: path.basename(absYamlover), entries, meta: { hidden: true } });
  for (const name of names) {
    const abs = path.join(absYamlover, name);
    const child = yield* childNode(abs, undefined, ctx);
    entries.push({ key: name, edge: 'contain', value: child });
    yield { done: ++ctx.count, path: rel(ctx, abs) };
  }
  ctx.open?.pop();
  if (entries.length === 0) return null;
  return { kind: 'mapping', entries, array: false, meta: { hidden: true } };
}

/** A single filesystem child (file or subdir) → a Node, honoring meta concrete/type/format
 *  overrides. An explicit `concrete:` decodes FIRST — it always wins
 *  (docs/language/concretes/01-choosing); the legacy chain (format doubling as the decode
 *  selector) stays below it, read forever. */
function* childNode(abs: string, m: MetaEntry | undefined, ctx: Ctx): Generator<WalkProgress, Node, void> {
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    // the clause's own nested `members:` describes THIS subdirectory's members — hand it
    // down (a bad nested pattern just drops its clause; only a meta.yo's own top level
    // gets the error slot)
    const nested = m && (m.members ?? m.properties) != null ? parseClauses(m).meta : undefined;
    return yield* dirNode(abs, ctx, nested);
  }

  const ext = path.extname(abs).toLowerCase();
  // format resolution order: meta `format:` → a recognized extension → (none → sniff/parse).
  const fmt = m?.format ?? EXT_FORMAT[ext] ?? null;
  if (m?.concrete) {
    const decoded = decodeConcrete(abs, m.concrete, m.format ?? null, stat, ctx);
    if (decoded) return decoded; // an unrecognized id (e.g. a STORAGE concrete) stays inert
  }
  if (m?.type === 'binary') return blob(abs, fmt ?? 'application/octet-stream', ctx);
  if (fmt && (DOC_FORMATS[fmt] || TEXT_FORMATS.has(fmt))) {
    // a format-matched doc/text file is slurped to parse — unless it is too big to slurp
    if (stat.size > MAX_DOC_BYTES) return blob(abs, fmt, ctx);
    if (DOC_FORMATS[fmt]) return parsedDoc(abs, DOC_FORMATS[fmt], ctx); // a sub-document encoding → parse (docs/meta)
    // A TEXT format holds the WHOLE FILE as one string scalar, so its ceiling is not the
    // doc-parse ceiling: MAX_DOC_BYTES (64 MiB) would put multi-MB of source code into the node
    // value, and from there into every stub that mentions the file (a 2.5 MB `.jsonl` put its
    // entire body in a directory listing's `side:` block). Above MAX_TEXT_BYTES it stays a blob —
    // the format is still NAMED (so the plaintext view still claims it) and `/api/blob` still
    // serves the bytes; only the inline copy is refused. Same 1 MiB the binary sniff uses, so the
    // two text ceilings agree.
    if (stat.size > MAX_TEXT_BYTES) return blob(abs, fmt, ctx);
    return textScalar(abs, fmt, ctx); // markdown/adoc/plantuml/csv/foreign source → string + format
  }
  if (fmt) return blob(abs, fmt, ctx); // a known but non-text format = opaque bytes
  if (looksBinary(abs)) return blob(abs, 'application/octet-stream', ctx);
  // Text with no format: PARSE only what the parser claims by name (docs/language), else keep the
  // bytes as plain text. An unknown extension is a file of somebody else's language, not a
  // yamlover file to fail on — so it degrades nothing and reports nothing.
  // (as RAW BYTES, like `.txt`: an unknown extension is also an unknown ENCODING, so the
  // client's encoding selector gets the choice rather than a server-side utf8 guess.)
  if (!PARSED_EXTS.has(ext) || path.basename(abs).startsWith('.')) return blob(abs, 'text/plain', ctx);
  return parsedScalar(abs, ext, ctx); // text, claimed extension → parse (json5p for .json*, else yamlover)
}

/** Decode a file per its DECLARED `concrete:` — the language/codec/charset axis. Returns null
 *  for an id this dispatcher does not know (storage concretes like `file/binary` land here by
 *  design — they state where bytes live, not how they translate), letting the legacy chain
 *  decide. Every decoded node carries a `meta.concrete` stamp: the provenance a future
 *  mediated write needs to encode back (or refuse — decoded members are READ-ONLY this round). */
function decodeConcrete(abs: string, concrete: string, format: string | null, stat: fs.Stats, ctx: Ctx): Node | null {
  const stamp = (n: Node): Node => ({ ...n, meta: { ...n.meta, concrete } });
  const lang = DOC_CONCRETES[concrete];
  if (lang) {
    if (stat.size > MAX_DOC_BYTES) return stamp(blob(abs, format ?? 'application/octet-stream', ctx));
    return stamp(parsedDoc(abs, lang, ctx));
  }
  if (concrete === 'base64') {
    // text→bytes codec: the node is the DECODED value (type binary), but blob identity —
    // hash/size — stays the FILE's bytes (decode-on-serve is the recorded follow-up), so
    // the goldens and the background hasher see the same file they always did
    return stamp(blob(abs, format ?? 'application/octet-stream', ctx));
  }
  const codec = /^binary\/int(8|16|32|64)\/(le|be)$/.exec(concrete);
  if (codec) {
    const bytes = readTracked(ctx, abs);
    const width = Number(codec[1]) / 8;
    const le = codec[2] === 'le';
    const refuse = (why: string): Node =>
      stamp({ ...blob(abs, format ?? 'application/octet-stream', ctx),
        meta: { parseError: noteFileError(ctx, abs, new Error(`${concrete}: ${why}`)) } });
    if (bytes.length !== width) return refuse(`expected ${width} bytes, found ${bytes.length}`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const value = width === 1 ? dv.getInt8(0)
      : width === 2 ? dv.getInt16(0, le)
      : width === 4 ? dv.getInt32(0, le)
      : Number(dv.getBigInt64(0, le));
    if (!Number.isSafeInteger(value)) return refuse('value exceeds the safe integer range');
    return stamp({ kind: 'scalar', value, raw: String(value),
      ...(format ? { meta: { derivedFormat: format } } : {}) });
  }
  if (concrete.startsWith('text/')) {
    // a charset text: decode bytes → string. An unknown charset returns null — the file
    // stays bytes exactly as bare `text/plain` does today (the client picks the encoding).
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(concrete.slice('text/'.length), { fatal: false });
    } catch {
      return null;
    }
    if (stat.size > MAX_DOC_BYTES) return stamp(blob(abs, format ?? 'text/plain', ctx));
    const text = decoder.decode(readTracked(ctx, abs));
    // no span unless the decode is byte-transparent: for non-utf8 charsets value offsets are
    // NOT file offsets, and mv.ts's surgical link rewriting must not be tempted to use them
    const span = decoder.encoding === 'utf-8' ? { span: { uri: abs, start: 0, end: text.length } } : {};
    return stamp({ kind: 'scalar', value: text, raw: text,
      meta: { ...(format ? { derivedFormat: format } : {}), ...span } });
  }
  return null;
}

/** Apply `meta.yo` `members.<key>.format` (legacy `properties.…`) to the matching entries, so a
 *  body-overlay text entry (e.g. 59's `markdown:`) gets its (type, format) just like a file child does. A
 *  Blob already carries its format; a node with a format already wins; binary stays a Blob.
 *  `uniqueItems: true` marks the child a SET (≡ the `!!set` tag — docs/meta): NodeMeta.set. */
function applyMeta(node: Node, meta: Meta, inherited?: Meta): Node {
  for (const e of node.entries ?? []) {
    if (e.key == null || isPointer(e.value)) continue;
    const m = metaFor(meta, e.key) ?? metaFor(inherited, e.key);
    if (!m) continue;
    if (m.uniqueItems) e.value = { ...e.value, meta: { ...e.value.meta, set: true } };
    if (e.value.kind === 'blob') continue;
    if (m.format && !e.value.meta?.schema) e.value = { ...e.value, meta: { ...e.value.meta, derivedFormat: m.format } };
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
  const relPath = rel(ctx, abs);
  const cached = ctx.opts.cache?.(relPath, stat.size, stat.mtimeMs) ?? null;
  if (cached) {
    record(ctx, abs, cached, stat.size, stat.mtimeMs);
    return { kind: 'blob', format, contentHash: cached, size: stat.size };
  }
  const inlineMax = ctx.opts.hashInlineMax ?? HASH_INLINE_MAX;
  const contentHash = stat.size <= inlineMax ? hashBytes(fs.readFileSync(abs)) : null;
  record(ctx, abs, contentHash, stat.size, stat.mtimeMs);
  return { kind: 'blob', format, contentHash, size: stat.size };
}

/** A textual file kept as a raw string scalar (markdown/asciidoc/plantuml/csv …). The span
 *  covers the WHOLE file (value === raw === the bytes, utf8, unnormalized) — so a prose-link
 *  scan attributes the node to its own file and value offsets ARE file offsets (mv.ts's
 *  surgical link rewriting relies on both). */
function textScalar(abs: string, format: string, ctx: Ctx): Node {
  const text = readTracked(ctx, abs).toString('utf8');
  return { kind: 'scalar', value: text, raw: text, meta: { derivedFormat: format, span: { uri: abs, start: 0, end: text.length } } };
}

/** A structured/text file with no binary format: parse it into a node. The parser is chosen by
 *  extension — `.json`/`.json5`/`.json5p` → json5p (handles JSON/JSON5 incl. multi-line + comments,
 *  which the YAML parser does not), everything else (`.yaml`/`.yo`/no extension) → yamlover,
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
  } catch (e) {
    // the degraded node stays a DOCUMENT root: the file still owns its bytes, so /api/source
    // can serve the true text for rescue and an edit addressed at it resolves to this file —
    // where the parseError stamp refuses the write — instead of routing into the parent overlay
    return { kind: 'scalar', value: text, raw: text, meta: { documentRoot: true, parseError: noteFileError(ctx, abs, e) } };
  }
}

// --------------------------------------------------------------------------- //
// Schema application (the metadata layer): resolve a node's attached `!!<…>` schema and
// propagate (type, format) DOWN the instance via the schema's member clauses — the ruled
// `members:`/`others:` spelling, with the legacy `properties`/`items`/`additionalProperties`
// read forever (docs/meta/members). So a chapter tagged only at its root makes its
// `children[*]` chapters and its `chunks[*]` text/marklower — even though the subnodes carry
// no tag of their own. (METADATA-only; no validation. Schema resolution was deferred — this
// is the first, targeted slice of it.)
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
    if (inst.kind === 'blob' || inst.meta?.derivedFormat) return true;
    const s = inst.meta?.schema;
    return !!s && !isPointer(s) && s.kind === 'mapping' && !!field(s, 'format');
  };

  // resolve a `*…/$defs/<name>` pointer (or a plain schema Node) to {name, node}
  const resolveSchema = (v: Value): { name: string | null; node: Node | null } => {
    if (isPointer(v)) {
      const last = v.steps[v.steps.length - 1];
      const nm = last?.sel === 'key' ? last.name : null;
      return { name: nm, node: nm ? loadDef(nm) : null };
    }
    return { name: null, node: v };
  };
  // A schema branch is a CONTAINER (chapter/task-like) if it exercises the keyed or ordinal
  // facet (or extends one via `allOf`); else it is a LEAF (chunk-like scalar/binary). Used to
  // pick an `anyOf` element branch structurally — a mapping element ⇒ container, else ⇒ leaf.
  const isContainerSchema = (n: Node): boolean =>
    !!field(n, 'members') || !!field(n, 'others') ||
    !!field(n, 'properties') || !!field(n, 'items') || !!field(n, 'allOf') ||
    ['object', 'variant', 'omni', 'mixed', 'kseq', 'array'].includes(str(n, 'type') ?? '');
  // A mapping is a container; so is an omni scalar that carries BODY entries (a titled
  // subchapter: its self-value is the title, its entries the body) — and so is a DIRECTORY-
  // backed document whatever its body momentarily holds: storage is shape, and a directory
  // is a container (a titled CHILDLESS subchapter's body is a bare title, indistinguishable
  // from a chunk by value shape alone — its directory says what it is). An inline bare
  // scalar and a FILE-backed scalar stay leaves — chunks, which ARE title-only content
  // (docs/documents/chapter). The overlay keys an annotated chunk gains (docs/annotations) are not body —
  // a scalar with only those stays a chunk.
  const OVERLAY_KEYS = new Set(['yo']);
  const elemIsContainer = (el: Node): boolean =>
    el.kind === 'mapping' ||
    (el.meta as { dirBacked?: boolean } | undefined)?.dirBacked === true ||
    (el.entries ?? []).some((e) => e.key == null || !OVERLAY_KEYS.has(e.key));

  // the ORDINAL members a sweep/clause can describe: keyless elements plus ANCHORED members —
  // position-granted by the body's pointer array (`meta.anchored`) — which are the chapter's
  // BODY exactly like inline keyless elements ("they count as ORDINAL, not keyed").
  // An element that declares its OWN inline `!!<*…/$defs/X>` schema wins over anything
  // inherited — its tag decides, not shape routing (a tagged table in a chapter body stays a
  // table; docs/documents/chapter/schema). `walk()` applies the element's pointer separately.
  // A `!!yo` element is PLAIN YAMLOVER — exempt from the enclosing schema by definition
  // (the data-island semantics): never routed to a branch, never stamped with a format,
  // so a chapter body's island does not become an x-yamlover-chapter in the TOC.
  const ordinalElems = (inst: Node): Entry[] => {
    const anchoredKeys = new Set(((inst.meta as { anchored?: string[] } | undefined)?.anchored) ?? []);
    return (inst.entries ?? []).filter((e) =>
      (e.key == null || anchoredKeys.has(e.key)) && !isPointer(e.value) &&
      e.value.meta?.yo !== true &&
      !(e.value.meta?.schema && isPointer(e.value.meta.schema)));
  };

  // propagate a SWEEP schema (`others:`, legacy `items`) to the ordinal members of `inst`,
  // skipping the first `skip` (those claimed by keyless member clauses). The sweep may be
  // a single schema (pointer or literal) — applied to every element — or an `anyOf` union,
  // where each element is routed to the branch whose shape matches it (container ↔ mapping).
  const applyItems = (inst: Node, items: Value, depth: number, skip = 0): void => {
    const { node: itemsNode } = resolveSchema(items);
    const anyOf = itemsNode ? field(itemsNode, 'anyOf') : null;
    const elems = ordinalElems(inst).slice(skip);
    if (anyOf && !isPointer(anyOf) && anyOf.entries) {
      const branches = anyOf.entries
        .map((e) => e.value)
        .map((b) => ({ ptr: b as Value, ...resolveSchema(b) }));
      for (const e of elems) {
        const want = elemIsContainer(e.value as Node);
        const pick = branches.find((b) => b.node && isContainerSchema(b.node) === want) ?? branches[0];
        if (pick) apply(e.value as Node, pick.ptr, depth + 1);
      }
    } else {
      for (const e of elems) apply(e.value as Node, items, depth + 1);
    }
  };

  const apply = (inst: Node, schema: Value, depth: number): void => {
    if (depth > 64 || isPointer(inst)) return;
    // resolve a pointer schema (`*…/$defs/<name>`) to the hosted schema node
    const { name, node: s } = resolveSchema(schema);
    if (!s || isPointer(s)) return;
    // attach this node's derived (type, format): an explicit schema `format`, else an object /
    // variant / mixed schema hosted as `$defs/<name>` → `x-yamlover-<name>` (chapter, task, tag, …).
    const stype = str(s, 'type');
    const named = name && (stype === 'object' || stype === 'variant' || stype === 'omni' ||
      stype === 'mixed' || stype === 'kseq' || !!field(s, 'allOf'));
    const fmt = str(s, 'format') ?? (named ? `x-yamlover-${name}` : null);
    // record the derived format WITHOUT touching `schema` — the authored `!!<…>` tag (a pointer)
    // must survive for views/serialization; the derived typing rides its own meta slot
    if (fmt && !hasFormat(inst)) inst.meta = { ...inst.meta, derivedFormat: fmt };
    // recurse structurally — `omni`/`kseq` (long aliases `variant`/`mixed`) carry keyed fields
    // exactly like `object` (docs/meta/facets), so member clauses propagate through
    // them too (e.g. a tag taxonomy whose tags hold their description as a BODY still tags
    // every sub-tag). A `variant`/`mixed` node ALSO carries a positional body on the ordinal
    // facet, so the sweep propagates alongside them.
    //
    // THE MEMBER CLAUSES (docs/meta/members), whichever spelling: the ruled `members:` — one
    // omni clause; a KEYED clause describes the same-named member (legacy `properties`), the
    // k-th KEYLESS clause the k-th ordinal member (JSON Schema's `prefixItems`, which the
    // legacy reader never consumed) — with the sibling `others:` sweeping every member no
    // clause matched (legacy `additionalProperties` for keyed + `items` for ordinal). Inside
    // `members:` every entry is a clause — a member literally named "others" is stated there;
    // the top-level `others:` is always the keyword.
    const members = field(s, 'members');
    const membersNode = members && !isPointer(members) ? members : null;
    const others = field(s, 'others');
    const keylessClauses = (membersNode?.entries ?? []).filter((e) => e.key == null).map((e) => e.value);
    if (stype === 'object' || stype === 'variant' || stype === 'omni' ||
        stype === 'mixed' || stype === 'kseq' || stype === 'array' ||
        membersNode || others || field(s, 'items')) {
      const props = field(s, 'properties');
      const addl = field(s, 'additionalProperties'); // legacy sweep for keys not in `properties`
      for (const e of inst.entries ?? []) {
        if (e.key == null || isPointer(e.value)) continue;
        // A child that declares its OWN inline `!!<*…/$defs/X>` schema wins over an inherited
        // clause — `walk()` applies the child's pointer separately.
        // (Without this, the sweep would clobber, e.g., a `$defs/workflow` node sitting
        // in a tag taxonomy back down to `x-yamlover-onto`. `hasFormat` can't guard it — a pointer
        // schema carries no `format` field yet.)
        if (e.value.meta?.schema && isPointer(e.value.meta.schema)) continue;
        // a `!!yo` child is plain yamlover — exempt from the enclosing schema (the data island)
        if (e.value.meta?.yo === true) continue;
        const declared = (membersNode ? field(membersNode, e.key) : null)
          ?? (props && !isPointer(props) ? field(props, e.key) : null);
        // a declared clause wins; else `others:` sweeps (never the annotation-overlay keys —
        // a NEW keyword gets clean semantics); else the legacy additionalProperties, untouched
        const sub = declared ?? (others && !OVERLAY_KEYS.has(e.key) ? others : null) ?? addl;
        if (sub) apply(e.value, sub, depth + 1);
      }
      // the ordinal facet: the k-th keyless clause claims the k-th ordinal member; the sweep
      // (`others:`, legacy `items`) covers the rest. Run the node's OWN clauses before any
      // inherited (`allOf`) ones so a narrowing subtype (e.g. task's `task|chunk` body) wins
      // over the inherited (`chapter|chunk`) body.
      if (keylessClauses.length) {
        const elems = ordinalElems(inst);
        keylessClauses.forEach((cl, i) => {
          const e = elems[i];
          if (e) apply(e.value as Node, cl, depth + 1);
        });
      }
      const sweep = others ?? field(s, 'items');
      if (sweep) applyItems(inst, sweep, depth, keylessClauses.length);
    }
    // `allOf` extension (task IS-A chapter): apply each supertype branch too, so inherited
    // `properties`/`items` propagate. Own facets already ran, and format/format-bearing children
    // are guarded (`hasFormat`), so the supertype fills only what the subtype left open.
    const allOf = field(s, 'allOf');
    if (allOf && !isPointer(allOf) && allOf.entries) {
      for (const b of allOf.entries) apply(inst, b.value, depth + 1);
    }
  };

  const walk = (node: Node): void => {
    if (node.meta?.schema) apply(node, node.meta.schema, 0);
    for (const e of node.entries ?? []) if (!isPointer(e.value)) walk(e.value);
  };
  walk(root);
}

/** A directory's INSTANCE OVERLAY file, or null when it has none (docs/language/concretes):
 *  `.yo/body.yo` for the `dir/.yo` flavor, else an `index.yo` inside the directory itself for
 *  the `dir/index.yo` one. Carrying BOTH is a layout violation the doctor reports
 *  (`layout/duplicate-overlay`); `.yo/body.yo` wins here so such a tree still reads. */
function overlayFile(dir: string): string | null {
  const body = path.join(dir, YAMLOVER_DIR, BODY_FILE);
  if (fs.existsSync(body)) return body;
  const index = path.join(dir, INDEX_FILE);
  return fs.existsSync(index) ? index : null;
}

/** The NODE a root-relative file path belongs to: a directory's consumed instance overlay
 *  (`X/.yo/body.yo`, or an `X/index.yo` that {@link overlayFile} confirms is the overlay and
 *  not a shadowed plain member) collapses to the directory `X` itself; any other path is its
 *  own node. PRECONDITION: the path must exist under `absRoot` — the `index.yo` case checks
 *  the filesystem to disambiguate — so on a moved pair only the `to` side is safe to ask. */
export function ownerNodePath(absRoot: string, relPath: string): string {
  const parts = relPath.split('/');
  const base = parts[parts.length - 1];
  if (base === BODY_FILE && parts[parts.length - 2] === YAMLOVER_DIR && parts.length > 2) return parts.slice(0, -2).join('/');
  if (base === INDEX_FILE && parts.length > 1) {
    const dirRel = parts.slice(0, -1).join('/');
    if (overlayFile(path.join(absRoot, dirRel)) === path.join(absRoot, dirRel, INDEX_FILE)) return dirRel;
  }
  return relPath;
}

/** Merge a directory's instance overlay over its mapping (docs/language/concretes):
 *  - a mapping body OVERRIDES same-key children and ADDS overlay-only keys (scalars/pointers);
 *  - a pointer-array body (`- *file …`) imposes ORDER over the existing children;
 *  - a SCALAR body root with fields (the omni shape, e.g. `!!var A taxonomy` over a tag
 *    directory) gives the directory that scalar as its own BODY, fields merged as above.
 *  The body root's `meta` (e.g. a `!!<*yamlover/$defs/chapter>` tag attaching a schema to the
 *  whole directory) is carried onto the merged node, so a directory CHAPTER is recognized. */
function applyBody(file: string | null, node: Mapping, ctx: Ctx): Node {
  if (file === null) return node;
  // A SYNTAX ERROR IN AN OVERLAY IS A ONE-FILE FAILURE, not a whole-tree one: the directory keeps
  // its plain filesystem mapping (children still index, the rest of the walk still runs) and loses
  // only what the overlay contributed — its title, fields and ordering. Same degradation contract
  // as {@link parsedDoc} for an unparsable data file. The stamp rides the directory node —
  // deliberately WITHOUT documentRoot/dirBacked: children keep routing as plain-dir member ops
  // (their own files are intact), only a write that would re-serialize the overlay is refused.
  let bodyDoc: Document;
  try {
    bodyDoc = parseYamlover(readTracked(ctx, file).toString('utf8'), file);
  } catch (e) {
    return { ...node, meta: { ...node.meta, parseError: noteFileError(ctx, file, e) } };
  }
  const body = bodyDoc.root;
  if (body.kind !== 'mapping' && body.kind !== 'scalar') return node;
  // A scalar body has no `entries` (a bare `30`); an omni scalar body / mapping body does. Treat a
  // field-less scalar as an empty overlay so the directory still takes the scalar as its own value.
  const bodyEntries = body.entries ?? [];
  // a directory with a body.yo overlay is a self-contained instance = a DOCUMENT root
  // (so `*: file` inside it resolves to this directory, at any nesting depth). The body's
  // head-of-file banner rides onto the node so it survives past the parse.
  // `dirBacked` records the STORAGE shape: this document is a directory, which is container
  // shape wherever a schema routes by shape — a bare-title body does not demote it to a chunk
  const meta0 = { ...node.meta, ...body.meta, documentRoot: true, dirBacked: true, ...(bodyDoc.head?.length ? { head: bodyDoc.head } : {}) };

  // THE POSITIONAL FACET of a directory body is its KEYLESS entries — the same thing whatever else
  // the body carries: a pure pointer/inline sequence, a SCALAR self-value with a body under it (the
  // omni chapter shape, `World` then `- *: item01`), or a mapping mixing keyed fields with them.
  // They are the POSITIONAL PREFIX, in body order, and a `*name` element is CONSUMED — replaced by
  // the child it names, which keeps its key as the storage provenance a projection shows as a
  // derived `&name` anchor. So a member the body orders appears ONCE, at the position the body gave
  // it — never a second time as a bare directory child beside its own pointer. Children the body
  // does NOT name are never granted positions: they trail as KEYED-ONLY entries after the prefix.
  // The directory's own children, by key — a slot is EMPTIED when a body pointer consumes it, so
  // what survives is exactly the remainder the body never named.
  const children: (Entry | null)[] = node.entries.slice();
  const childAt = new Map<string, number>();
  children.forEach((e, i) => { if (e!.key != null) childAt.set(e!.key, i); });
  const bodyOrder: Entry[] = []; // the body's entries in SOURCE order — the addressing space
  const anchored: string[] = []; // members the body ORDERED by pointer, and so consumed
  const bodyAt = new Map<string, number>(); // key → its index in bodyOrder
  for (const e of bodyEntries) {
    if (e.key == null) {
      const targetKey = isPointer(e.value) ? pointerLeafKey(e.value) : null;
      const ci = targetKey != null ? childAt.get(targetKey) : undefined;
      const hit = ci !== undefined ? children[ci] : null;
      if (!hit) { bodyOrder.push(e); continue; } // an inline element, or a dangling/duplicate pointer
      children[ci!] = null; // consumed — it lives at its BODY position from here on
      anchored.push(targetKey!);
      bodyAt.set(targetKey!, bodyOrder.length);
      bodyOrder.push(hit);
      continue;
    }
    // a keyed body entry AUGMENTS the member it names (docs/language/concretes: a file blob + body
    // title/tags ⇒ an omni-blob) — wherever that member already sits. Augmenting is not ORDERING:
    // only a `*` pointer grants a position, so a merely-augmented child keeps its filesystem place.
    const bi = bodyAt.get(e.key);
    if (bi !== undefined) { bodyOrder[bi] = augmentEntry(bodyOrder[bi], e); continue; }
    const ci = childAt.get(e.key);
    if (ci !== undefined && children[ci]) { children[ci] = augmentEntry(children[ci]!, e); continue; }
    bodyAt.set(e.key, bodyOrder.length);
    bodyOrder.push(e); // an overlay-ONLY key: it exists nowhere on disk, so the body places it
  }
  const unlisted = children.filter((e): e is Entry => e !== null);
  const remainder = unlisted.length > 0;
  // `meta.anchored` names the members whose position came from the body — their keys are storage
  // provenance a projection shows as a derived `&name` anchor, and they count as ORDINAL, not
  // keyed. It is per-key, not a prefix count: a body that mixes keyed fields with its positional
  // flow (a chapter) scatters them through source order.
  const meta = anchored.length > 0 ? { ...meta0, anchored } : meta0;

  // THE BODY IMPOSES ORDER: its own entries first, in source order (which is therefore the
  // absolute-index addressing space an edit splices into), then the children it never named, in
  // filesystem order. A child a keyed body entry merely AUGMENTS is not ordered by the body — it
  // stays in the remainder, at its filesystem position.
  const entries: Entry[] = [...bodyOrder, ...unlisted];
  if (body.kind === 'mapping' && (body.array || (bodyEntries.length > 0 && bodyEntries.every((e) => e.key === null)))) {
    // a body that names EVERYTHING keeps the array projection (`array: true` — the hidden built-in
    // graft must not flip it, see THE UNIFORM GRAFT); a remainder makes the node an honest mix
    return { kind: 'mapping', entries, array: !remainder, meta };
  }
  // a scalar body root → the directory node carries that scalar as its own value (omni). But an
  // EMPTY body (null value, no authored `~`/`null` token) is only a self-value when the directory
  // is OTHERWISE empty — a truly empty document (value: null → the editor's root hole). When the
  // directory HAS members (e.g. one whose siblings were all promoted out, leaving the body blank,
  // or a body that is only a `!!<…>` tag banner), the empty body is an empty OVERLAY, not a null
  // self-value: keep the directory a plain mapping so it never reads as a spurious `null`-valued
  // omni. An explicitly authored null (`~`/`null`) is always a value.
  if (body.kind === 'scalar') {
    const emptySelf = body.value === null && (body.raw == null || body.raw.trim() === '');
    if (!(emptySelf && entries.length > 0)) {
      return { kind: 'scalar', value: body.value, raw: body.raw, entries, array: false, meta };
    }
  }
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
  // A stored mail message. Opaque bytes, never inline text: its own headers name its charset
  // (koi8-r and windows-1251 are the norm in an old archive) and its parts carry their own
  // transfer encodings, so decoding belongs to the renderer, not to the walk.
  '.eml': 'message/rfc822',
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
  // FOREIGN SOURCE CODE — text this project does not speak, NAMED so it stops looking like
  // a broken yamlover file. Held inline as UTF-8 (they are, in practice) and shown verbatim;
  // without these a saved web page's minified `.js` reached the yamlover parser and either
  // degraded loudly or parsed into garbage (a 4 KiB key), both indistinguishable from a `.yo`
  // its author must fix.
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript',
  '.css': 'text/css', '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.sql': 'text/x-sql', '.xml': 'text/xml', '.jsonl': 'application/x-ndjson',
};

const TEXT_FORMATS = new Set([
  'text/markdown', 'text/asciidoc', 'text/x-plantuml', 'text/csv', 'text/tab-separated-values',
  // foreign source code: a string scalar carrying its own bytes, never parsed
  'text/javascript', 'text/typescript', 'text/css', 'text/x-python', 'text/x-shellscript',
  'text/x-sql', 'text/xml', 'application/x-ndjson',
]);

// The extensions the yamlover PARSER claims. Everything else textual is foreign text held as a
// string — the parser is opt-in by name, not the fallback for anything unrecognized. An
// extensionless file (`README`, `notes`) is authored content and stays claimed; a DOTFILE is
// not (`path.extname('.gitignore') === ''`, so it would otherwise pass as extensionless).
// (`.yamlover` is the legacy spelling of `.yo` — read forever, YOMIGRATION.md §1. The set
// mirrors concrete.ts's EXT_FILE_CONCRETE, plus the extensionless case it has no entry for.)
const PARSED_EXTS = new Set(['', '.yo', '.yamlover', '.yaml', '.yml', '.json', '.json5', '.json5p']);

// A `format` naming a SUB-DOCUMENT ENCODING — the LEGACY spelling of the decode axis, from
// before the concrete/format split (docs/meta): read forever, but the authored corpus states
// `concrete:` instead. These must never fall into the opaque-Blob branch.
const DOC_FORMATS: Record<string, 'yamlover' | 'json5p' | 'yaml'> = {
  'yamlover': 'yamlover', 'yaml': 'yaml', 'yamlover/meta': 'yamlover', 'yaml/meta': 'yaml',
  'json': 'json5p', 'json5': 'json5p', 'json5p': 'json5p',
  'json/meta': 'json5p', 'json5p/meta': 'json5p', 'json/schema': 'json5p',
};

// The LANGUAGE decode concretes (docs/language/concretes): a declared `concrete:` naming a
// surface language parses the file as a sub-document in it. `…/stream` is a whole file's
// content, `…/code` a single document — one parser today (multi-document streams are
// reserved); `…/meta` parses the same surface read as a schema document. This axis COMPOSES
// with the pinned STORAGE concretes (`file/yamlover`, `dir/.yo`, …) — it renames nothing.
const DOC_CONCRETES: Record<string, 'yamlover' | 'json5p' | 'yaml'> = {
  'yamlover/stream': 'yamlover', 'yamlover/code': 'yamlover', 'yamlover/meta': 'yamlover',
  'yaml/stream': 'yaml', 'yaml/code': 'yaml', 'yaml/meta': 'yaml',
  'json/code': 'json5p', 'json5/code': 'json5p', 'json5p/code': 'json5p',
  'json/meta': 'json5p', 'json5/meta': 'json5p', 'json5p/meta': 'json5p',
};
