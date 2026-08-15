/**
 * engine-api.ts — the JSON API, backed by the new yamlover ENGINE.
 *
 * This replaces the legacy `loadEntity` materializer (./yamlover.ts) with the engine:
 * `walkDir` (directory concrete → IR) + `Store` (SQLite property-graph index). It emits the
 * SAME response shapes the React client already consumes (TreeNode, the `$yamloverLink` /
 * `$yamloverRef` / `$yamloverBinary` markers, the schema view), so the UI works "as it was".
 *
 * Endpoints (path is JSON-space: `/key[0]/sub`):
 *   GET /api/info                         breadcrumb head (root label)
 *   GET /api/tree?path&depth              the TOC subtree
 *   GET /api/content/{slash-path}?depth   THE ONE WIRE — the node as a yamlover envelope
 *   GET /api/schema?path&depth            the instance schema
 *   GET /api/blob?path                    a file-backed node's raw bytes
 *   GET /api/thumb?path&w&h                a lazily-generated thumbnail of a file-backed blob
 *   GET /api/tagged?path                  the materials filed under a tag (annotations → targets)
 *   GET /api/events                       SSE: {type:"diff",…} reindex diffs + {type:"task",…} progress
 *   GET /api/tasks                        long-running tasks in flight (snapshot for a fresh page)
 *   GET /api/query?q&path                 the 3g query evaluator (colon match templates)
 *   GET /api/dangling                     pointers that did not resolve at index time
 *   POST /api/reindex                     manual reconcile (the watcher's fallback)
 *   GET  /api/source?path=P               the node's yamlover SOURCE (the yed editor's load)
 *   POST /api/preview                     render a STANDALONE yamlover text as a content envelope (stateless)
 *   POST /api/edit-text                   the /api/edit ops over a standalone text → new text (stateless)
 *
 * The on-disk index lives at <root>/.yo/index.db. It is a derived cache with a persistent
 * FILE MANIFEST (path + hash + size + mtime): startup re-indexes against it (the offline
 * reconcile — unchanged blobs are never re-read, so it is cheap), and an FS watcher re-indexes
 * on external edits (the watched-live tier), broadcasting what changed over /api/events.
 *
 * LONG-RUNNING WORK runs as background tasks (./tasks.ts): the initial index starts the moment
 * createHandlers returns (the HTTP server can listen immediately and serve the PREVIOUS index —
 * or an empty one on a cold start), and the background hasher then fills in content hashes for
 * the large blobs the walk no longer reads. Store-mutating jobs (index, mv, paste, annotate)
 * serialize through one writer queue; reads never wait.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store, reindex, reindexAsyncDoc, reindexPathAsync, hashFileAsync, watchTree, walkTree, loadSettings, ensureSettingsFile, mv, relinkMoved, relinkRenamed, evalQuery, isBoundaryRow } from "../../../engine/ts/src/index.ts";
import { deadLinkDiagnostics, deadLinkTargets, logDeadLinks } from "./link-check.js";
import type { NodeRow, EdgeRow, Settings, SidecarLocation, IndexDiff } from "../../../engine/ts/src/index.ts";
import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { parseJson5p } from "../../../parser/ts/src/json5p.ts";
import { pointerToken, schemaTagToken, serializeYamlover } from "../../../parser/ts/src/serialize-yamlover.ts";
import { renderPointer, parsePointer } from "../../../parser/ts/src/pointer.ts";
import { scanMarklower, type FragToken as FragTokenT } from "../../../parser/ts/src/marklower-links.ts";
import { pathOfSegs, segsOfPath, segToken } from "../../../parser/ts/src/pathseg.ts";
import { anchorBody, seqMarkLen, stripSeqMark } from "../../../parser/ts/src/serialize-common.ts";
import { upsertFragment, upsertThumbnail, removeMapEntry, keyToken, upsertMapEntryAt, removeMapEntryAt, pruneEmptyAnnotations, reachBodyAt, pruneEmptyKeyAt, pruneEmptyYo, appendBookmark, appendBookmarkAt, removeBookmark, removeBookmarkAt, bookmarksRemain, bookmarksRemainAt, type Region as EmbedRegion } from "./embed.js";
import { BODY_FILE, INDEX_FILE, OVERLAY_DIR, dataFileConcrete, dirConcreteFor, interiorOf, isDirConcrete, isOverlayDirConcrete, overlaySegs, pointerSafeName, type DirConcrete } from "../concrete.js";
import { classifyScalar, isDefaultRepr, type BlockQualifiers, type Repr, type ScalarStyle } from "../repr.js";
import { renderThumbnail } from "./extract/thumbnails.js";
import { isThumbnailable } from "./extract/registry.js";
import { colonSegment } from "../../../parser/ts/src/pointer.ts";
import { isPointer } from "../../../parser/ts/src/ir.ts";
import type { Node as IrNode, Document, Comment as IrComment, Entry as IrEntry, Step as IrStep, Pointer as IrPointer } from "../../../parser/ts/src/ir.ts";
import { buildGitIgnore } from "./gitignore.js";
import { buildEnvelope, type EnvelopeDeps } from "../content-envelope.js";
import { collectComments, irNodeAt } from "../projection-comments.js";
import { deriveMemberEncoding, deriveDirEditRoute, nextMemberName, subchapterMaterializes } from "../concrete-rules.js";
import {
  validatePath,
  validateWrite,
  validateTree,
  enforce,
  defaultMode,
  type ConcreteNode,
  type Diagnostic,
  type EnforcementMode,
  type PlannedWrite,
  type TreeSnapshot,
  type WriteSnapshot,
} from "../validate.js";
import { displayKind, ownedEntries, anchoredOf, typeName, facetsOf } from "./node-kind.js";
import { TaskRegistry } from "./tasks.js";
import type { TaskHandle, TaskInfo } from "./tasks.js";
import { allowedInReadOnly, READ_ONLY_ERROR } from "./read-only-policy.js";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;
interface Options {
  gitignore?: boolean; // honor .gitignore for stray files (default: true)
  watch?: boolean; // watch the tree and re-index on external edits (default: false; bin turns it on)
  log?: (line: string) => void; // server-side progress lines (the bin wires console.log; tests stay silent)
  // Materialize a defaults `settings.yo` when absent, so the gear button's settings node
  // always exists (default: false; the bin turns it on). OFF for programmatic/test use, so the
  // pure indexer never writes into the served tree.
  ensureSettings?: boolean;
  // CONTENT READ-ONLY: every user-data-mutating route answers 403, thumbnail generation and
  // move relinking are suppressed; housekeeping (index, settings) still runs. See
  // read-only-policy.ts for the route rule.
  readOnly?: boolean;
}

// Marker keys + types the client recognizes (must match src/client expectations).
// ($yamloverBinary / $yamloverMixed retired with the JSON wire — the client mints them
//  in derive-node.ts now; the server still speaks $yamloverLink / $yamloverRef stubs.)
const LINK_KEY = "$yamloverLink";
// A reference shown AS a reference: its yamlover pointer `text` (the scope-correct colon spelling),
// hyperlinked to where it resolves (`path`). The client renders the pointer text — a LOCAL target
// (inside the rendered subtree) becomes an in-page `#` fragment link, else it navigates. Distinct
// from LINK_KEY, which is now reserved for a depth-TRUNCATED container ("click to descend").
const REF_KEY = "$yamloverRef";
// A non-finite number (±Infinity / NaN): JSON cannot carry it over the wire (JSON.stringify → null),
// so it rides as a marker the client decodes to the literal (`.inf`/`.nan` in yamlover, `Infinity`/
// `NaN` in json5p). Payload is the canonical name "Infinity" | "-Infinity" | "NaN".
const NUM_KEY = "$yamloverNum";
const wireScalar = (v: unknown): unknown =>
  typeof v === "number" && !Number.isFinite(v) ? { [NUM_KEY]: String(v) } : v;
type Seg = string | number | null; // string key | integer position | the NULL key (pathseg.ts)
// Node-KIND classification (object|array|scalar|binary|omni|mix → the client `type:`) lives in
// ./node-kind.ts so it can be unit-tested against a Store without the HTTP layer.

export function createHandlers(dataRoot: string, opts: Options = {}): Handler & { close: () => void; ready: Promise<IndexDiff> } {
  const rootName = path.basename(path.resolve(dataRoot)) || "/";
  const dbPath = path.join(dataRoot, ".yo", "index.db");
  // Project configuration (<root>/.yo/settings.yo) — defaults for WRITE paths
  // (e.g. where new annotations are created). Read at startup; reloaded when POST /api/config
  // rewrites the file (so write-path defaults track edits without a server restart).
  const settingsFile = path.join(dataRoot, ".yo", "settings.yo");
  // The settings file's ROOT-RELATIVE path, in the `/`-joined form an IndexDiff speaks — so a reindex
  // that touched it (via ANY path: the FS watcher on a direct edit, `/api/edit`, `/api/config`) can
  // reload the in-memory Settings. See `broadcast` below.
  const settingsRel = path.relative(dataRoot, settingsFile).split(path.sep).join("/");
  // Materialize a defaults file when absent (serve boundary only — `opts.ensureSettings`), so the
  // config node always exists: the gear button opens `:.yo:settings.yo`, and a missing
  // file would 404 that fetch. A no-op when the file is already there. Tolerant of a read-only tree:
  // serving must not crash on a write failure.
  if (opts.ensureSettings) {
    try {
      ensureSettingsFile(dataRoot);
    } catch (e) {
      (opts.log ?? (() => {}))(`could not create settings.yo: ${(e as Error).message}`);
    }
  }
  let settings: Settings = loadSettings(dataRoot);
  // Skip git-ignored strays (node_modules, build output, …) so serving the project root works.
  const ignore = opts.gitignore === false ? undefined : buildGitIgnore(dataRoot);

  // ONE Store, open for the server's lifetime; every request is answered from it (indexed
  // lookups — sub-millisecond). Freshness is the reconcile loop, not a per-request re-walk:
  // `reindex` re-walks against the persisted file manifest (an unchanged blob is never
  // re-read — the cost that once made refresh block on a click), swaps the tables in one
  // transaction, and reports what changed. It runs at startup (the OFFLINE reconcile: external
  // edits made while the server was down show up immediately) and on every FS-watcher batch
  // (the WATCHED-LIVE tier), with POST /api/reindex as the manual fallback. Changes are pushed
  // to clients over GET /api/events (SSE). Move inference / relinking waits on the serializers.
  mkdirInside(dataRoot, path.dirname(dbPath), { recursive: true });
  const store0 = new Store(dbPath);
  const store = (): Store => store0;
  // The assembled IR document, retained across reindexes: a single-file edit re-walks only its
  // directory, splices the fresh subtree in, re-resolves IN MEMORY (so cross-file links stay
  // correct), and patches just that subtree's rows — instead of re-walking + rebuilding the whole
  // index. Null until the first full reindex; invalidated when a path-rewriting reconcile runs.
  let cachedDoc: Document | null = null;
  const log = opts.log ?? ((): void => {});
  setValidationLog(log); // non-fatal format diagnostics surface on the server's own log
  // Walk options every indexing path shares. `onFileError` is the reporting half of the walk's
  // degradation contract: an unparsable file loses its structure (a data file becomes raw text,
  // a directory overlay drops to the plain filesystem mapping) but never fails the whole index —
  // so ONE broken `.yo` costs its own page, not the tree.
  const walkOpts = {
    ignore,
    onFileError: (rel: string, e: unknown): void =>
      log(`parse ${rel}: ${String((e as Error)?.message ?? e)} — degraded, rest of the tree indexed`),
  };
  const readOnly = opts.readOnly === true;
  setReadOnlyWrites(readOnly); // the byte chokepoint refuses too — belt for any future GET-that-writes
  let closed = false;

  // SSE subscribers. Frames are typed: `{type:"diff", added,changed,removed,moved}` (a reindex
  // that found changes, as client JSON paths) and `{type:"task", task}` (long-running task
  // lifecycle — see ./tasks.ts).
  const sseClients = new Set<ServerResponse>();
  const sseWrite = (frame: unknown): void => {
    const payload = JSON.stringify(frame);
    for (const res of sseClients) res.write(`data: ${payload}\n\n`);
  };
  const broadcast = (diff: IndexDiff): void => {
    if (diff.added.length + diff.changed.length + diff.removed.length + diff.moved.length === 0) return;
    // Reload the in-memory Settings whenever the config file was (re)indexed — from a direct disk
    // edit (the watcher), the generic value editor (`/api/edit`), or `/api/config`. The config is now
    // edited through the ordinary yamlover data view, so this is the single place settings stay live.
    if (diff.changed.includes(settingsRel) || diff.added.includes(settingsRel)) settings = loadSettings(dataRoot);
    const toClient = (rel: string): string => segsToStr(rel.split("/"));
    sseWrite({
      type: "diff",
      added: diff.added.map(toClient), changed: diff.changed.map(toClient), removed: diff.removed.map(toClient),
      moved: diff.moved.map((m) => ({ from: toClient(m.from), to: toClient(m.to) })),
    });
  };
  // ONE change currency for every write path: a mediated endpoint announces the file-level
  // change it just made in the same IndexDiff shape the reconcile broadcasts, so every client
  // surface (TOC, node pane, marks, tag pages) refreshes through the SAME SSE flow — never a
  // per-endpoint push path. Incremental writes (annotate, tag) call this with the one file
  // they touched; full-reindex writes (paste, mv) broadcast their reconcile diff directly.
  const announce = (d: Partial<IndexDiff>): void => broadcast({ added: [], changed: [], removed: [], moved: [], ...d });
  // a client JSON path (keys percent-encoded) as the root-relative FILE path diffs speak
  const relFileOf = (clientPath: string): string => strToSegs(clientPath).map(String).join("/");
  // EVERY task's lifecycle also lands in the caller terminal (start / throttled progress /
  // done-with-duration / failure), so all phases — indexing, hashing, thumbnails, reconciling —
  // are diagnosable from the log, not just the ones that hand-roll their own lines.
  const taskLogLast = new Map<string, number>();
  const logTask = (t: TaskInfo): void => {
    if (!taskLogLast.has(t.id)) {
      taskLogLast.set(t.id, 0);
      log(`[${t.label}] started`);
    }
    if (t.state === "done") {
      log(`[${t.label}] done in ${(((t.finishedAt ?? t.startedAt) - t.startedAt) / 1000).toFixed(1)}s`);
      taskLogLast.delete(t.id);
      return;
    }
    if (t.state === "error") {
      log(`[${t.label}] FAILED: ${t.error ?? "unknown error"}`);
      taskLogLast.delete(t.id);
      return;
    }
    const now = Date.now();
    if (now - (taskLogLast.get(t.id) ?? 0) < 1000) return; // terminal progress throttle
    taskLogLast.set(t.id, now);
    const p = t.progress;
    if (p.done === 0 && p.total === undefined && p.message === undefined) return; // nothing to say yet
    log(`[${t.label}] ${p.done}${p.total !== undefined ? `/${p.total}` : ""}${p.message ? ` — ${p.message}` : ""}`);
  };
  const tasks = new TaskRegistry((t) => {
    sseWrite({ type: "task", task: t });
    logTask(t);
  });

  // Thumbnail generation surfaces as ONE coalesced task in the strip (like the index/hasher),
  // not a flood of per-image ones: opening a directory fires many /api/thumb misses, so a single
  // "building thumbnails" task's `total` grows as requests arrive and its `done` catches up as
  // each finishes; it clears when the burst drains. (A cache hit / 415 never reaches here.)
  let thumbTask: TaskHandle | null = null;
  let thumbDone = 0;
  let thumbTotal = 0;
  const loggedNoThumb = new Set<string>(); // formats already reported as server-undecodable (log once each)
  const thumbBegin = (): void => {
    thumbTotal++;
    if (!thumbTask && !closed) thumbTask = tasks.start("building thumbnails");
    thumbTask?.progress(thumbDone, thumbTotal);
  };
  const thumbEnd = (): void => {
    thumbDone++;
    if (!thumbTask) return;
    if (thumbDone >= thumbTotal) {
      thumbTask.progress(thumbTotal, thumbTotal); // so the completion frame reads 100%, not N-1/N
      thumbTask.done();
      thumbTask = null;
      thumbDone = thumbTotal = 0;
    } else {
      thumbTask.progress(thumbDone, thumbTotal);
    }
  };

  // ONE WRITER at a time: every job that mutates the Store or needs a consistent manifest
  // (indexing, mv, paste, annotations) chains here, so e.g. an annotation cannot be swallowed
  // by a concurrently-committing full walk whose disk snapshot predates it. Read endpoints
  // never queue — they answer from the current index (stale-but-instant during a reindex).
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T,>(fn: () => T | Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => {}); // a failed job must not poison the queue
    return p;
  };

  // The background HASHER: fills in content hashes the walk skipped (blobs over the inline
  // limit), smallest-first, as a visible task. A singleton loop OUTSIDE the write queue — it
  // only reads bytes; each tiny manifest update enqueues on its own, so a multi-GB file never
  // holds the queue. It re-queries the store every step, so files added by later reconciles
  // are picked up; a file that changed or vanished mid-hash fails the (size, mtime) guard and
  // is skipped (the next reconcile re-queues it with fresh identity).
  const gib = (b: number): string => (b / 2 ** 30).toFixed(1);
  const BIG_FILE_BYTES = 256 * 2 ** 20; // show within-file byte progress above this
  let hashing = false;
  const scheduleHasher = (): void => {
    if (hashing || closed) return;
    if (store0.unhashedFiles(1).length === 0) return;
    hashing = true;
    void (async () => {
      const skip = new Set<string>();
      let done = 0;
      const t0 = Date.now();
      let h: TaskHandle | null = null;
      try {
        for (;;) {
          if (closed) break;
          const pending = store0.unhashedFiles().filter((f) => !skip.has(f.path));
          if (pending.length === 0) break;
          h ??= tasks.start("hashing large files");
          const next = pending[0];
          const total = done + pending.length;
          h.progress(done, total, next.path);
          const abs = path.join(dataRoot, ...next.path.split("/"));
          // big files get their own start/finish lines (with throughput) — a multi-GB hash on a
          // slow drive is exactly the stall the log must make visible
          const big = next.size >= BIG_FILE_BYTES;
          if (big) log(`hashing ${next.path} (${gib(next.size)} GiB)…`);
          const tFile = Date.now();
          let hash: string | null = null;
          try {
            hash = await hashFileAsync(abs, (bytes) => {
              if (big) h?.progress(done, total, `${next.path} — ${gib(bytes)}/${gib(next.size)} GiB`);
            });
          } catch (e) {
            // unreadable or vanished — skip; a later reconcile re-queues it if it still exists
            log(`hashing ${next.path} failed: ${String((e as Error)?.message ?? e)} — skipped`);
          }
          if (big && hash !== null) {
            const secs = (Date.now() - tFile) / 1000;
            log(`hashing ${next.path} done in ${secs.toFixed(1)}s (${(next.size / 2 ** 20 / Math.max(secs, 0.001)).toFixed(0)} MiB/s)`);
          }
          const st = hash !== null ? fs.statSync(abs, { throwIfNoEntry: false }) : undefined;
          const fresh = st !== undefined && st.size === next.size && st.mtimeMs === next.mtimeMs;
          const ok = hash !== null && fresh && !closed
            ? await enqueue(() => store0.setFileHash(next.path, hash, next.size, next.mtimeMs))
            : false;
          if (!ok) {
            skip.add(next.path);
            continue;
          }
          done++;
        }
        h?.done();
        if (h) log(`hashed ${done} file(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s${skip.size ? `, ${skip.size} skipped` : ""}`);
      } catch (e) {
        h?.fail(e);
      } finally {
        hashing = false;
      }
    })();
  };

  // A reindex usable inside an already-queued job (NOT queued itself — callers queue). Retains the
  // assembled doc so a subsequent single-file edit can patch against it in memory.
  const doReindex = async (): Promise<IndexDiff> => {
    const { diff, doc } = await reindexAsyncDoc(store0, dataRoot, walkOpts);
    cachedDoc = doc;
    return diff;
  };
  // A reindex for ONE edited file (the tagging hot path): patch the cached tree's subtree in place,
  // falling back to a full reindex when the change is not locally patchable (root-level file, the
  // grafted taxonomy, or the patch guard rejecting an external-reference change).
  const doReindexFile = async (absFile: string): Promise<IndexDiff> => {
    if (cachedDoc) {
      const rel = path.relative(dataRoot, absFile).split(path.sep).join("/");
      try {
        const res = await reindexPathAsync(store0, dataRoot, cachedDoc, rel, walkOpts);
        if (res) {
          cachedDoc = res.doc;
          return res.diff;
        }
      } catch {
        // any surprise in the incremental path → full reindex (correctness over speed)
      }
    }
    return doReindex();
  };

  // The INITIAL index, as a background task: the server listens (and serves the previous
  // on-disk index — or an empty one, cold) while the walk runs. Progress is determinate
  // (an enumeration pre-pass counts the tree) and lands in SSE + the log.
  const runIndexTask = (label: string): Promise<IndexDiff> =>
    enqueue(async () => {
      const h = tasks.start(label);
      try {
        // progress + start/done/failure lines land in the terminal via the task logger
        const { diff, doc } = await reindexAsyncDoc(store0, dataRoot, {
          ...walkOpts,
          onProgress: (p) => h.progress(p.done, p.total, p.message),
          // The TOC populates DURING the walk: every few seconds the partial tree commits and
          // the newly visible files broadcast as an ordinary `added` diff — the client's branch
          // merge splices them in without collapsing what the user already expanded.
          partialCommitMs: 3000,
          onPartial: (added) => {
            log(`partial index commit — ${added.length} more file(s) visible`);
            announce({ added }); // root-relative paths — broadcast maps them to client paths
          },
        });
        cachedDoc = doc;
        h.done();
        log(`${label}: +${diff.added.length} ~${diff.changed.length} −${diff.removed.length} →${diff.moved.length}`);
        // THE LINK INVARIANT, said out loud at startup: a tree with dead prose links is told
        // so before anyone clicks one (link-check.ts; /api/doctor lists the full set)
        logDeadLinks(deadLinkDiagnostics(doc, store0, dataRoot), log);
        broadcast(diff);
        scheduleHasher();
        return diff;
      } catch (e) {
        h.fail(e);
        throw e;
      }
    });

  // Files the server itself just wrote (thumbnail sidecars + the overlay embeds pointing at
  // them). The watcher must not answer those with a reconcile: the store is already patched by
  // the targeted reindex, and a full re-walk per generated thumbnail is exactly the feedback
  // loop that stalled big trees. Keyed by root-relative POSIX path (the currency of watcher
  // batches); entries expire after a TTL so a later GENUINE external edit still reconciles.
  const SELF_WRITE_TTL_MS = 5000;
  const selfWrites = new Map<string, number>();
  const noteSelfWrite = (absFile: string): void => {
    selfWrites.set(path.relative(dataRoot, absFile).split(path.sep).join("/"), Date.now());
    if (selfWrites.size > 1000) {
      const cutoff = Date.now() - SELF_WRITE_TTL_MS;
      for (const [k, t] of selfWrites) if (t < cutoff) selfWrites.delete(k);
    }
  };

  // An UNMEDIATED move (mv in a shell, a file manager) shows up as an inferred `moved` —
  // relink the inbound refs the way the mediated tier would (ENGINE.md tier 2: "inferred
  // as a move and relinked"), then reconcile once more so the rewritten files re-index.
  // COALESCED: a burst of watcher batches queues at most one pending reconcile — the full
  // re-walk sees everything on disk anyway, so N queued repeats were pure waste.
  let reconcilePending: Promise<IndexDiff> | null = null;
  const reconcile = (): Promise<IndexDiff> => {
    if (reconcilePending) return reconcilePending;
    const p = enqueue(async () => {
      reconcilePending = null; // changes landing while we run may schedule a fresh one
      const h = tasks.start("reconciling");
      try {
        const diff = await doReindex();
        // Relinking REWRITES source files (inbound pointers follow the moved node) — the one
        // side channel by which pure indexing mutates user data, so read-only skips it: an
        // externally moved file just shows up moved, its inbound pointers dangling.
        if (diff.moved.length > 0 && !readOnly) {
          const r = relinkMoved(dataRoot, diff.moved, { ignore });
          if (r.editedFiles.length > 0) {
            const follow = reindex(store0, dataRoot, walkOpts);
            diff.changed = [...new Set([...diff.changed, ...follow.changed])];
            cachedDoc = null; // sync `reindex` rebuilt the DB but not the cached doc — invalidate
          }
        }
        h.done();
        log(`reconcile: +${diff.added.length} ~${diff.changed.length} −${diff.removed.length} →${diff.moved.length}`);
        // the link invariant re-checks after every external change; a relink round nulls the
        // cached doc (the follow-up reindex is sync), so that pass reports on the NEXT walk
        if (cachedDoc) logDeadLinks(deadLinkDiagnostics(cachedDoc, store0, dataRoot), log);
        broadcast(diff);
        scheduleHasher();
        return diff;
      } catch (e) {
        h.fail(e);
        throw e;
      }
    });
    reconcilePending = p;
    return p;
  };

  // A watched event for a file whose on-disk (size, mtime) still matches the manifest is NOISE:
  // nothing a reindex could see has changed — the diff is stat-based, so a reconcile would walk
  // the whole tree just to report +0 ~0 −0 →0. Windows fires such events for mere READS (the
  // ReadDirectoryChangesW subscription includes last-access-time updates), so without this
  // filter the background hasher's own reads re-trigger a full re-walk per file it hashes.
  // A path unknown to the manifest (new file, directory), a vanished file, or a real stat
  // change all fall through as genuine.
  const spuriousEvent = (rel: string): boolean => {
    const rec = store0.file(rel);
    if (!rec) return false;
    const st = fs.statSync(path.join(dataRoot, ...rel.split("/")), { throwIfNoEntry: false });
    if (!st || !st.isFile()) return false;
    return st.size === rec.size && st.mtimeMs === rec.mtimeMs;
  };

  const ready = runIndexTask(`indexing ${rootName}`);
  const stopWatch = opts.watch
    ? watchTree(dataRoot, (batch) => {
        const now = Date.now();
        const external = batch
          .filter((rel) => now - (selfWrites.get(rel) ?? 0) >= SELF_WRITE_TTL_MS)
          .filter((rel) => !spuriousEvent(rel));
        if (external.length === 0) {
          log(`watch: ${batch.length} event(s), all self-writes or stat-unchanged — skipping reconcile`);
          return;
        }
        log(`watch: ${external.length} change(s) — ${external.slice(0, 5).join(", ")}${external.length > 5 ? ", …" : ""}`);
        // failure surfaces via the task logger ([reconciling] FAILED: …)
        reconcile().catch(() => {});
      }, { ignore })
    : null;

  const handler: Handler = (req, res, url) => {
    try {
      // THE read-only gate: one allowlist check before any route can look at the request.
      // Everything below it may assume a mutating request already proved it is allowed.
      if (readOnly && !allowedInReadOnly(req.method, url.pathname)) {
        return sendJson(res, 403, READ_ONLY_ERROR);
      }
      const s = store();

      // Server-pushed change notifications: an SSE stream of reindex diffs (client JSON
      // paths). The comment pings keep idle proxies from reaping the connection.
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write(": connected\n\n");
        sseClients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 30_000);
        req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }

      // Manual reconcile — the watcher's fallback; responds with what changed (inferred
      // moves are relinked, like the watcher path). Queued behind any in-flight index.
      if (req.method === "POST" && url.pathname === "/api/reindex") {
        reconcile()
          .then((diff) => sendJson(res, 200, diff))
          .catch((e) => sendJson(res, 500, { error: String((e as Error).message || e) }));
        return;
      }

      // THE DOCTOR SWEEP — validate.ts's layout rules over the WHOLE served tree, after the fact.
      // Deliberately a FILESYSTEM walk, not a Store walk: the index is built by a walker that
      // SKIPS what it does not understand, so an overlay buried inside another overlay is exactly
      // the corruption the index cannot see. The pre-flight guards stop this being written; the
      // doctor finds what earlier versions (or an external editor) already left behind.
      if (url.pathname === "/api/doctor") {
        try {
          const v = validateTree(scanTree(dataRoot, ignore));
          // THE LINK INVARIANT rides the same sweep: every in-tree prose link must name a
          // node (link-check.ts). Content warnings, merged after the layout diagnostics.
          const doc = cachedDoc ?? walkTree(dataRoot, walkOpts).doc;
          sendJson(res, 200, { allowed: v.allowed, diagnostics: [...v.diagnostics, ...deadLinkDiagnostics(doc, s, dataRoot)] });
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message || e) });
        }
        return;
      }

      // THE LINK INVARIANT's client half: the dead TARGET set, so NavLink can mark a link
      // whose target names no node (`.deadlink`) instead of rendering it live. Refreshed by
      // the client on every diff event.
      if (url.pathname === "/api/dead-links") {
        try {
          const doc = cachedDoc ?? walkTree(dataRoot, walkOpts).doc;
          sendJson(res, 200, { targets: deadLinkTargets(doc, s) });
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message || e) });
        }
        return;
      }

      // Long-running server tasks (indexing, hashing, …) currently in flight (or just
      // finished) — the snapshot a freshly loaded page needs; updates ride /api/events.
      if (url.pathname === "/api/tasks") {
        sendJson(res, 200, tasks.list());
        return;
      }

      // The QUERY evaluator (PLAN.md 3g / docs/language/pointers/queries): a colon-grammar match template,
      // evaluated at `path` (default: the root). Results are client JSON paths — or, with
      // `shape=tree`, TreeNode rows (metadata only, children lazy — the breadcrumb dropdown's
      // candidates), or, with `shape=filter`, ONE pruned tree of the matches plus ALL their
      // ancestors AND each match's own children one level deep (the filtered TOC), each match
      // flagged, capped at MATCH_CAP.
      if (url.pathname === "/api/query") {
        const q = url.searchParams.get("q") || "";
        const at = storePath(strToSegs(url.searchParams.get("path") || ":"));
        const shape = url.searchParams.get("shape");
        try {
          const paths = evalQuery(s, q, at);
          // Hidden filtering honors the SCOPE LADDER (docs/language/pointers): a PROJECT/world-scoped query
          // (`::` / `:::`) sees the grafted self-import's CONTENT — that is project furniture,
          // and searching `:: ...: colors` must find the built-in palette. Document/current
          // scoped queries keep the strict TOC hiding: `:` is the document, not the project.
          const projectScoped = /^\s*::/.test(q);
          const dropHidden = (p: string): boolean => (projectScoped ? queryHidden(s, p) : inHiddenSubtree(s, p));
          if (shape === "tree") {
            const results = paths
              .filter((p) => !dropHidden(p))
              .map((p) => {
                const segs = storePathToSegs(p);
                const label = segs.length === 0 ? rootName : labelFor(s, p, segs[segs.length - 1]);
                return buildTree(dataRoot, s, segs, label, 0);
              });
            sendJson(res, 200, { results });
          } else if (shape === "filter") {
            const all = paths.filter((p) => !dropHidden(p));
            const capped = all.slice(0, MATCH_CAP);
            const matchSet = new Set(capped);
            // keep set: every match plus every containment ancestor (the pruned tree's rows)
            const keep = new Set<string>();
            for (const m of capped) {
              for (let segs = storePathToSegs(m); ; segs = segs.slice(0, -1)) {
                keep.add(storePath(segs));
                if (!segs.length) break;
              }
            }
            const buildFilterTree = (segs: Seg[]): TreeNode & { match?: boolean } => {
              const p = storePath(segs);
              const label = segs.length === 0 ? rootName : labelFor(s, p, segs[segs.length - 1]);
              const node: TreeNode & { match?: boolean } = buildTree(dataRoot, s, segs, label, 0);
              if (matchSet.has(p)) node.match = true;
              const nullKeyed = nullKeyTargets(s, p);
              for (const c of chapterOrderedChildren(s, p, s.node(p)?.format ?? null)) {
                const seg = childSegOf(c, nullKeyed);
                // the KEEP chain always renders — a match INSIDE the (hidden) graft needs its
                // ancestor rows down to it; other hidden children stay off the pruned tree
                if (keep.has(c.to)) {
                  node.children.push(buildFilterTree([...segs, seg]));
                  continue;
                }
                if (isHidden(s, c.to)) continue;
                // a MATCH also ships its real children one level deep (shallow rows) — the
                // filtered TOC shows what lies below the matched path, like the dropdown does
                if (node.match) node.children.push(buildTree(dataRoot, s, [...segs, seg], labelFor(s, c.to, seg), 0));
              }
              return node;
            };
            sendJson(res, 200, {
              root: buildFilterTree([]),
              matches: capped.map((p) => segsToStr(storePathToSegs(p))),
              truncated: all.length > capped.length,
            });
          } else {
            sendJson(res, 200, { results: paths.map((p) => segsToStr(storePathToSegs(p))) });
          }
        } catch (e) {
          sendJson(res, 400, { error: String((e as Error).message || e) });
        }
        return;
      }

      // Pointers that did not resolve at index time (ENGINE.md: reported, never dropped).
      if (url.pathname === "/api/dangling") {
        sendJson(res, 200, s.dangling().map((d) => ({ from: segsToStr(storePathToSegs(d.from)), raw: d.raw, reason: d.reason })));
        return;
      }

      // Create an annotation — TAG a target (a WRITE path; docs/annotations). The tag application is
      // appended to the target's own `yamlover-annotations` array, embedded in the target's host
      // body (a `*.yo` document, or a directory's `.yo/body.yo` overlay keyed by
      // filename). The target may be a whole node OR a fragment (`…:yo:fragments:<slug>`).
      // Body: { target, tag, description?, params? } — target/tag are JSON paths; description/params
      // make it a PARAMETRIZED annotation (an object element), else it is a bare tag pointer.
      if (req.method === "POST" && url.pathname === "/api/annotate") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const a = data as AnnotateInput;
              const tagSegs = strToSegs(a.tag ?? "");
              const tagStore = storePath(tagSegs);
              // ANY node can be a tag — an annotation is just a `*` reference inside the
              // target's yamlover-annotations. The node only has to exist.
              if (!a?.tag || !s.node(tagStore)) {
                throw new Error("annotation needs a `tag` naming an existing node");
              }
              // …any node but the ROOT: it has no project-scope pointer spelling (`::` alone
              // is not a pointer), so the annotation could be written but never parsed back.
              // Refuse BEFORE the write — a failed reindex must not leave a corrupt body file.
              if (tagSegs.length === 0) throw new Error("the root cannot be a tag");
              const bodyFile = embedAnnotation(dataRoot, s, settings.sidecars, a);
              // A surgical body edit changes one file: patch just that file's subtree against the
              // cached tree (re-resolving in memory keeps cross-file links correct), instead of
              // re-walking + rebuilding the whole index on every tag toggle.
              broadcast(await doReindexFile(bodyFile));
              scheduleHasher();
              return { ok: true };
            }),
          )
          .then((body) => sendJson(res, 201, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Create a FRAGMENT — a user-marked region inside a target (a WRITE path; docs/annotations).
      // Stored under the target's `yo: fragments:` mapping keyed by a fresh slug; for an
      // image-like selection the optional `imageBase64` crop is written as a sidecar blob the
      // fragment references. Body: { target, selector, imageBase64? } → { slug, fragmentPath }.
      if (req.method === "POST" && url.pathname === "/api/fragment") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const f = data as FragmentInput;
              if (!f?.selector || typeof f.selector !== "object") throw new Error("a fragment needs a selector");
              const made = embedFragment(dataRoot, s, settings.sidecars, f);
              broadcast(await doReindex());
              scheduleHasher();
              return made;
            }),
          )
          .then((body) => sendJson(res, 201, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Unfile: remove the matching membership bookmark from the target (an inline-token
      // membership when `selector` rides the query). Query: { target, tag, selector? }.
      if (req.method === "DELETE" && url.pathname === "/api/annotate") {
        const target = url.searchParams.get("target") ?? "";
        const tag = url.searchParams.get("tag") || "";
        const selRaw = url.searchParams.get("selector");
        let sel: Record<string, unknown> | undefined;
        try { sel = selRaw ? (JSON.parse(selRaw) as Record<string, unknown>) : undefined; } catch { sel = undefined; }
        enqueue(async () => {
          if (!tag) throw new Error("delete needs a `tag`");
          const bodyFile = unembedAnnotation(dataRoot, s, target, tag, sel);
          broadcast(await doReindexFile(bodyFile));
        })
          .then(() => sendJson(res, 200, { ok: true }))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Create a NAMED TAG (a WRITE path — the picker's create-on-miss): add
      // `<name>: !!<*yamlover/$defs/onto>` to the taxonomy body at the project's default tags
      // location (settings.yo; `/ontos` by default → `<location>/.yo/body.yo`),
      // then reconcile so it joins the graph. The direct schema attach makes the node an
      // `x-yamlover-onto` wherever the taxonomy lives — like an annotation, a created tag may be
      // moved anywhere and keeps working. Idempotent: a tag already at that path is returned
      // as-is. Body: { name }.
      if (req.method === "POST" && url.pathname === "/api/tag") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const name = String((data as { name?: unknown })?.name ?? "").trim();
              if (!name) throw new Error("tag needs a non-empty name");
              const segs = [...strToSegs(settings.ontos), name];
              const tagPath = segsToStr(segs);
              const existing = s.node(storePath(segs));
              if (existing) {
                if (existing.format !== ONTO_FORMAT) throw new Error(`a node already exists at ${tagPath} and is not a tag`);
                const color = s.node(storePath(segs) + ":color")?.value;
                return { path: tagPath, name, color: typeof color === "string" ? color : null, created: false };
              }
              // Index INCREMENTALLY (the annotate pattern — not a full rebuild, which stats the
              // whole tree and blocks the picker for seconds on a big root); the watcher's
              // reconcile re-walks the edited body and trues the rows up moments later.
              const written = writeOnto(dataRoot, s, settings.ontos, name);
              s.addOnto(storePath(strToSegs(settings.ontos)), name, written.pos, written.node);
              if (s.node(storePath(segs))?.format !== ONTO_FORMAT) throw new Error(`the created tag did not index as a tag: ${tagPath}`);
              // the merged IR must see the new tag too — /api/content serves cachedDoc, and
              // "moments later" is after the client's immediate re-fetch of the created tag
              await doReindexFile(written.file); // writeOnto returns the ABSOLUTE body path
              announce(written.createdFile ? { added: [written.file] } : { changed: [written.file] });
              return { path: tagPath, name, color: null, created: true };
            }),
          )
          .then((body) => sendJson(res, 201, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Persist a BOARD's lane configuration (TICKETS.md §3 — the board is the explorer's per-tag
      // view). Rewrites the board directory's overlay `lanes:` block (a sequence of lanes, each a
      // flow-sequence of tag pointers — one tag = a plain lane, several = sublanes), then
      // reconciles. Body: { path, lanes: string[][] } where each inner string is a tag client-path.
      // The pointers are written project-scope (`*::…`), exactly like an annotation's tag (so they
      // resolve from the served root).
      if (req.method === "POST" && url.pathname === "/api/board") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const b = data as { path?: string; lanes?: unknown };
              const lanes: string[][] = Array.isArray(b?.lanes) ? b.lanes.map((lane) => (Array.isArray(lane) ? lane.map((p) => String(p)) : [])) : [];
              const { bodyFile } = hostFor(dataRoot, s, strToSegs(b?.path || ":"));
              mkdirInside(dataRoot, path.dirname(bodyFile), { recursive: true });
              const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
              writeBody(dataRoot, s, bodyFile, writeBoardLanes(src, lanes));
              broadcast(await doReindex());
              scheduleHasher();
              return { ok: true };
            }),
          )
          .then((body) => sendJson(res, 201, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Upload a pasted file, TEXT, or RICH content (a WRITE path). A file onto a DIRECTORY
      // page → it lands in that directory; onto a CHAPTER page → it lands in the chapter's
      // owning directory AND a `*…` pointer to it is appended as the chapter's last chunk.
      // TEXT onto a chapter → the text itself is appended as a new chunk (no file); anywhere
      // else → a new chapter .yo file in the nearest directory. RICH (an HTML selection:
      // text + image chunks + heading-nested subchapters) onto a chapter → chunks append to
      // `chunks:`, subchapters to `children:`; anywhere else → a new chapter (directory-backed
      // when it carries files). Body: { path, filename, contentBase64 } | { path, text } |
      // { path, rich }. A new file / edited chapter source needs the graph re-walked — a
      // manifest-cached reconcile, so only the new/edited files are read.
      if (req.method === "POST" && url.pathname === "/api/paste") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const result = handlePaste(dataRoot, s, data as PasteInput);
              broadcast(await doReindex());
              scheduleHasher();
              return result;
            }),
          )
          .then((result) => sendJson(res, 201, result))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // The yamlover EDITOR (a WRITE path). Surgical source-text edits to any `.yo` document:
      // it splices lines rather than reserializing, so comments, quoting, and block scalars survive.
      // Body: one edit `{ path, op, yamlover?, meta?, concrete?, name? }` or a batch `{ edits: […] }`.
      //
      // `path` is a plain yamlover path; each segment is a key or an ABSOLUTE entry index. A node has
      // four FACETS — scalar value, keyed entries, ordinal entries, and its `!!<…>` meta tag:
      //   emplace — replace only the facets `yamlover` carries; the rest of the node stands (so a
      //             prose edit keeps an annotated chunk's `yamlover-annotations`). `meta` preserved.
      //   replace — drop all four facets, assign `yamlover`. An omitted `meta` DROPS the tag.
      //   insert  — the new entry takes the position `path` names; an index past the end appends.
      //   remove  — delete the node at `path`.
      // `yamlover` is valid inline yamlover SOURCE (the caller escapes its own prose); it is parsed
      // to validate, then spliced verbatim. `concrete` is accepted only where content is born;
      // `concrete:"dir"` births a BARE folder (an empty OS directory, no body, no pointer).
      //
      // A batch groups by backing file (a document can span several) and reindexes each once —
      // respecting that different parts live in different files/concretes.
      if (req.method === "POST" && url.pathname === "/api/edit") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const d = data as EditInput & { edits?: EditInput[] };
              const edits = Array.isArray(d.edits) ? d.edits : [d];
              let applied;
              try {
                applied = applyEdits(dataRoot, s, edits);
              } catch (e) {
                // the DIAGNOSTIC the alert cannot carry: the failing batch, verbatim, beside the
                // error — enough to find and replay the problem without guessing
                console.error(`[/api/edit] FAILED: ${String((e as Error).message || e)}
  batch: ${JSON.stringify(edits)}`);
                throw e;
              }
              const { touched, created, appended, movedStorage } = applied;
              // a born document is a new FILE (and an archived one a moved dir): the whole graph
              // rewalks. Otherwise only the edited files.
              if (created.length || movedStorage) broadcast(await doReindex());
              else for (const f of touched) broadcast(await doReindexFile(f));
              scheduleHasher();
              // `path` is where a caller that CREATED something should navigate: the born document,
              // else the appended inline entry (a real node of its own).
              if (created.length) return { ok: true, path: created[created.length - 1] };
              if (appended.length) return { ok: true, path: lastBodyChildPath(s, appended[appended.length - 1]) };
              return { ok: true };
            }),
          )
          .then((body) => sendJson(res, 200, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // The node's yamlover SOURCE (a READ path — the yed editor's load): the raw body text at a
      // document root; a DEEPER node is the parsed subtree re-serialized (yed reparses and
      // normalizes spelling on save regardless). Returns { source }.
      if (url.pathname === "/api/source") {
        try {
          const segs = canonSegs(s, strToSegs(url.searchParams.get("path") ?? ""), true);
          const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
          const within = segs.slice(docSegs.length);
          const body = fs.readFileSync(bodyFile, "utf8");
          if (within.length === 0) {
            sendJson(res, 200, { source: body });
            return;
          }
          const doc = parseYamlover(body, bodyFile);
          let v: IrNode | IrPointer = doc.root;
          for (const g of within) {
            if (isPointer(v)) throw new Error("the path crosses a pointer");
            const ents: IrEntry[] = (v as IrNode).entries ?? [];
            const e: IrEntry | undefined = typeof g === "number" ? ents[g] : ents.find((x: IrEntry) => x.key === g);
            if (!e) throw new Error(`no entry ${String(g)} under the node`);
            v = e.value as IrNode | IrPointer;
          }
          if (isPointer(v)) throw new Error("a pointer has no editable source of its own");
          sendJson(res, 200, { source: serializeYamlover({ ...doc, root: v as IrNode }) });
        } catch (e) {
          sendJson(res, 404, { error: String((e as Error).message || e) });
        }
        return;
      }

      // THE CONTENT ENDPOINT (the one-wire migration): the node's projected subtree AS YAMLOVER,
      // depth-limited at DOCUMENT boundaries, in a yamlover envelope (source + sidecar +
      // relations + header). The path rides IN the URL, slash-spelled. See content-envelope.ts.
      if (url.pathname === "/api/content" || url.pathname.startsWith("/api/content/")) {
        (async () => {
          // the merged IR is the payload — a nulled cache (a just-landed relink) must REBUILD,
          // never degrade (unlike /api/json's comments, which just went empty)
          if (!cachedDoc) await reconcile();
          const doc = cachedDoc;
          if (!doc) throw new Error("the merged document is unavailable (index rebuild failed)");
          const rest = url.pathname === "/api/content" ? "" : url.pathname.slice("/api/content/".length);
          const segs = canonSegs(s, slashToSegs(rest), false);
          const p = storePath(segs);
          const row = s.node(p);
          const subtree = row ? irNodeAt(doc, segs) : undefined;
          if (!row || !subtree) return notFound(res, url);
          const kind = displayKind(s, p, row);
          const depthParam = parseDepth(url.searchParams.get("depth"));
          const docDepth = depthParam === undefined ? defaultDepth(s, dataRoot, segs, row, kind) : depthParam;
          const header = {
            path: segsToStr(segs),
            documentPath: documentPath(s, segs),
            type: tocType(s, p, row),
            ...facetsOf(s, p, row),
            format: row.format ?? null,
            concrete: concreteOf(s, dataRoot, segs, row),
            title: titleOf(s, p),
            description: descriptionOf(s, p),
            ...(row.type === "blob" ? { size: row.size } : {}),
            // a DEGRADED node (walk.ts: its source failed to parse) declares it, so the client
            // shows the failure instead of a merely-empty page and keeps its editor shut
            ...(row.meta?.parseError ? { parseError: row.meta.parseError } : {}),
          };
          const text = buildEnvelope(
            { segs, subtree, docDepth, header, relations: buildRelations(dataRoot, s, segs) as never },
            envelopeDeps(s, dataRoot, true),
          );
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/yamlover; charset=utf-8");
          res.end(text);
        })().catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Render a STANDALONE yamlover text (no file behind it — e.g. the client's browser-settings
      // document, stored in localStorage) as a CONTENT ENVELOPE, exactly as /api/content serves a
      // node: parse, index into a throwaway in-memory store, build the envelope. STATELESS —
      // touches neither the served tree nor the live index. Body: { source }.
      if (req.method === "POST" && url.pathname === "/api/preview") {
        readBody(req)
          .then((data) => {
            const text = previewEnvelope(String((data as { source?: unknown }).source ?? ""));
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/yamlover; charset=utf-8");
            res.end(text);
          })
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // The yamlover editor over a STANDALONE text (the /api/edit ops, minus files): applies the
      // surgical edits to `source` and returns the new text — the caller persists it (e.g. back
      // into localStorage). STATELESS. Body: { source, edits: [{ path, op, yamlover?, meta? }] }.
      if (req.method === "POST" && url.pathname === "/api/edit-text") {
        readBody(req)
          .then((data) => {
            const d = data as { source?: unknown; edits?: EditInput[] };
            sendJson(res, 200, { source: applyTextEdits(String(d.source ?? ""), Array.isArray(d.edits) ? d.edits : []) });
          })
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Move/rename a file or directory (a WRITE path — the engine-MEDIATED tier): the engine
      // relocates the FS object AND rewrites every inbound `*`/`~` pointer in the source files
      // (surgical span edits; ENGINE.md "a move rewrites references"). Body: { from, to } as
      // JSON paths addressing FS-level nodes (keyed segments only — no positions).
      if (req.method === "POST" && url.pathname === "/api/mv") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const { from, to } = data as { from?: string; to?: string };
              const rel = (p: string, what: string): string => {
                const segs = strToSegs(p);
                if (segs.length === 0) throw new Error(`mv: ${what} must name a file or directory`);
                if (segs.some((g) => typeof g === "number")) throw new Error(`mv: ${what} must be a file/directory path (no positions)`);
                return segs.join("/");
              };
              const report = mv(dataRoot, rel(from ?? "", "from"), rel(to ?? "", "to"), { ignore });
              const diff = await doReindex();
              broadcast(diff);
              return { ...report, diff };
            }),
          )
          .then((body) => sendJson(res, 200, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // RENAME A KEY (the editor's key cell). One verb, two backends chosen by the node's STORAGE —
      // THE CONCRETE IS NOT A STATE (docs/server/yamlover-editor): the editor asks to rename a key and
      // the server routes it. An fs-backed member (a real directory/file named by the key — the
      // promoted `world/`, a linked note) is renamed on disk via `mv`, which ALSO rewrites every
      // inbound `*`/`~` pointer; an INLINE keyed entry (a scalar/flow field in a body) has its key
      // token surgically rewritten in place, value and comments kept. Body: { path, key } as JSON
      // paths (keyed target; the last segment is the OLD key, `key` the new one).
      if (req.method === "POST" && url.pathname === "/api/rekey") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const { path: reqPath, key: newKey } = data as { path?: string; key?: string };
              const segs = canonSegs(s, strToSegs(reqPath ?? ""), false);
              if (segs.length === 0 || typeof segs[segs.length - 1] !== "string") throw new Error("rekey needs a keyed node path");
              if (typeof newKey !== "string" || newKey === "" || newKey !== newKey.trim()) throw new Error("a key must be a non-empty, un-padded string");
              const parentSegs = segs.slice(0, -1);
              const oldKey = String(segs[segs.length - 1]);
              if (newKey === oldKey) return { path: reqPath, unchanged: true };
              // the new key must be FREE in the parent (keys are unique per node)
              if (s.node(storePath([...parentSegs, newKey]))) throw new Error(`the key \`${newKey}\` already exists in the node`);
              const abs = segs.every((g) => typeof g === "string") ? path.resolve(dataRoot, ...segs.map(String)) : null;
              if (abs && fs.existsSync(abs)) {
                // an fs-backed member — rename the directory/file and rewrite inbound pointers
                const from = segs.map(String).join("/");
                const to = [...parentSegs.map(String), newKey].join("/");
                const report = mv(dataRoot, from, to, { ignore });
                const diff = await doReindex();
                broadcast(diff);
                return { path: segsToStr([...parentSegs, newKey]), ...report, diff };
              }
              // an INLINE keyed entry — surgically rewrite its key token in the enclosing body
              const backing = chapterSource(dataRoot, s, segs);
              const within = segs.slice(backing.docSegs.length);
              const src = editChapterSource(fs.readFileSync(backing.bodyFile, "utf8"), within, "rekey", "", undefined, newKey);
              writeBody(dataRoot, s, backing.bodyFile, src);
              // …and follow it with the inbound `*`/`~` pointers, exactly as the fs-backed branch
              // gets for free from `mv`. A key IS a path segment, so a rename that skipped this
              // left every reference to the old key DANGLING (`*: human1: pets: pet1` after
              // `pet1` became `pet3`). The relink runs AFTER the write, against a fresh walk, so
              // the spans are exact even when a pointer lives in the very body just rewritten.
              const report = relinkRenamed(dataRoot, [{
                from: storePath(segs),
                to: storePath([...parentSegs, newKey]),
              }], { ignore });
              const diff = await doReindex();
              broadcast(diff);
              return { path: segsToStr([...parentSegs, newKey]), ...report, diff };
            }),
          )
          .then((body) => sendJson(res, 200, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Install the bundled LLM-agent guidance docs (AGENTS.md + CLAUDE.md) into the served root,
      // so an AI agent co-editing this directory has the authoring/safety rules to hand. The
      // bundled guidance is a MARKER-FENCED block (mergeAgentDoc): a fresh file is created, an
      // existing file gets the block appended after the human's own rules, and a reinstall updates
      // the block in place — the human's text is never clobbered. Idempotent (an up-to-date file
      // reports "exists" and is not rewritten). Triggered by the leftmost breadcrumb button.
      if (req.method === "POST" && url.pathname === "/api/agent-docs") {
        enqueue(async () => {
          const files: { name: string; status: AgentDocStatus }[] = [];
          let wrote = false;
          for (const doc of loadAgentDocs()) {
            const target = path.resolve(dataRoot, doc.name);
            const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
            const { text, status } = mergeAgentDoc(existing, doc.content);
            if (status !== "exists") {
              writeInside(dataRoot, dataRoot, doc.name, Buffer.from(text, "utf8"));
              wrote = true;
            }
            files.push({ name: doc.name, status });
          }
          if (wrote) {
            broadcast(await doReindex());
            scheduleHasher();
          }
          return { files };
        })
          .then((body) => sendJson(res, 201, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // The project config (IMPORTS.md) — `<root>/.yo/settings.yo`, indexed as a HIDDEN
      // node (`:.yo:settings.yo`, format x-yamlover-config). GET → { source, settings }:
      // the RAW source (the node projection drops comments) plus the PARSED settings, read by the
      // annotate flow (tags location). The config is EDITED through the ordinary yamlover data view +
      // `/api/edit` now; `broadcast` reloads `settings` on any change to the file (incl. direct disk
      // edits), so there is no dedicated write endpoint.
      if (req.method !== "POST" && url.pathname === "/api/config") {
        const source = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "";
        sendJson(res, 200, { source, settings, path: ":.yo:settings.yo" });
        return;
      }

      // canonicalized: a positional segment may alias a KEYED member (docs/language/pointers — a keyed
      // entry's position is an alias to it; the dir-backed pointer-array members of
      // examples/56), and the store paths those by key
      const segs = canonSegs(s, strToSegs(url.searchParams.get("path") || ":"), false);
      const p = storePath(segs);
      const depth = parseDepth(url.searchParams.get("depth"));

      if (url.pathname === "/api/info") {
        // the breadcrumb head goes by the root's TITLE when it has one (a titled chapter names
        // itself), falling back to the served folder's name
        sendJson(res, 200, { root: titleOf(s, ":") || rootName, readOnly });
        return;
      }

      // The annotations whose `target` is this material (the engine's reverse link).
      if (url.pathname === "/api/annotations") {
        sendJson(res, 200, annotationsFor(dataRoot, s, segs));
        return;
      }

      // The materials filed under this tag (annotations resolved to their `target`; deduped) —
      // the explorer renderer's member list for a tag page. ANY existing node answers: a node
      // used as an annotation ref lists its annotators regardless of format.
      if (url.pathname === "/api/tagged") {
        const row = s.node(p);
        if (!row) return notFound(res, url);
        sendJson(res, 200, taggedMaterials(dataRoot, s, p));
        return;
      }

      if (url.pathname === "/api/tree") {
        const row = s.node(p);
        if (!row) return notFound(res, url);
        // the root goes by its TITLE when it has one — a titled chapter shows its title in the
        // TOC like every subchapter does — falling back to the served folder's name
        const label = segs.length === 0 ? titleOf(s, p) || rootName : labelFor(s, p, segs[segs.length - 1]);
        sendJson(res, 200, buildTree(dataRoot, s, segs, label, depth ?? 3));
        return;
      }

      if (url.pathname === "/api/blob") {
        const file = path.join(dataRoot, ...segs.map(String));
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return notFound(res, url);
        // STREAM the bytes — a readFileSync of a big PDF/video would block the event loop
        // (and with it every other request and the Vite HMR socket) for its whole read.
        res.statusCode = 200;
        res.setHeader("Content-Type", blobContentType(s.node(p)?.format ?? formatFromExt(file)));
        res.setHeader("Content-Length", String(fs.statSync(file).size));
        const stream = fs.createReadStream(file);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
        return;
      }

      // A lazily-generated thumbnail of a file-backed blob, fitted within ?w×?h. The first request
      // for a (source, box) decodes + encodes it, stores it the yamlover way (a content-addressed
      // sidecar under thumbnails/ + a `yamlover-thumbnails:[w,h]` overlay on the source), then
      // serves it; later requests hit the sidecar directly. Generation runs through the writer
      // queue so concurrent misses collapse onto one encode. A format with no decoder → 415, which
      // the explorer treats as "fall back to the type glyph".
      if (url.pathname === "/api/thumb") {
        const sourceRow = s.node(p);
        const sourceAbs = path.join(dataRoot, ...segs.map(String));
        if (!sourceRow || !fs.existsSync(sourceAbs) || fs.statSync(sourceAbs).isDirectory()) return notFound(res, url);
        const w = clampThumbDim(url.searchParams.get("w"), 256);
        const h = clampThumbDim(url.searchParams.get("h"), w);
        // A format with no server-side decoder answers 415 IMMEDIATELY — before any hashing or
        // reading. The old path discovered it only inside ensureThumbnail, AFTER stream-hashing
        // and slurping the whole file: for a multi-GB djvu/pdf that serialized minutes of dead
        // I/O through the writer queue while the UI sat on "building thumbnails".
        const fmt = sourceRow.format ?? formatFromExt(sourceAbs);
        if (!isThumbnailable(fmt)) {
          if (!loggedNoThumb.has(fmt ?? "unknown")) {
            loggedNoThumb.add(fmt ?? "unknown");
            log(`thumb: no server decoder for ${fmt ?? "unknown"} — client renders the glyph/preview`);
          }
          return sendJson(res, 415, { error: `no thumbnail for format: ${fmt ?? "unknown"}` });
        }
        const serve = (file: string): void => {
          res.statusCode = 200;
          res.setHeader("Content-Type", "image/jpeg");
          res.setHeader("Content-Length", String(fs.statSync(file).size));
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          const stream = fs.createReadStream(file);
          stream.on("error", () => res.destroy());
          stream.pipe(res);
        };
        const ready = existingThumb(dataRoot, s, settings.sidecars, segs, sourceRow, w, h); // no-write fast path
        if (ready) return serve(ready);
        // Generation writes a sidecar AND splices a `yamlover-thumbnails` overlay entry into the
        // source's host body — user data. Read-only serves only what already exists; a miss
        // answers 415, which the explorer already renders as the type glyph.
        if (readOnly) return sendJson(res, 415, { error: `thumbnail not pre-generated (read-only)` });
        thumbBegin(); // count this generation into the coalesced "building thumbnails" task
        const t0 = Date.now();
        // The content hash (it names the sidecar) is computed OUTSIDE the writer queue — it only
        // reads bytes, and an unhashed large image must not hold every queued write behind its I/O.
        Promise.resolve(sourceRow.content_hash ?? hashFileAsync(sourceAbs))
          .then((hash) =>
            enqueue(async () => {
              thumbTask?.progress(thumbDone, thumbTotal, String(segs[segs.length - 1] ?? "")); // the one now building
              const made = await ensureThumbnail(dataRoot, s, settings.sidecars, segs, sourceRow, w, h, hash, noteSelfWrite);
              // Patch only the owning directory into the index — the old FULL re-walk per
              // generated thumbnail made every icon burst O(tree) and starved the queue.
              if (made) broadcast(await doReindexFile(hostFor(dataRoot, s, segs).bodyFile));
              return made;
            }),
          )
          .then((made) => {
            log(`thumb ${segs.map(String).join("/")} ${w}x${h} — ${made ? "ok" : "unsupported"} in ${Date.now() - t0}ms (${Math.max(thumbTotal - thumbDone - 1, 0)} queued)`);
            return made ? serve(made) : sendJson(res, 415, { error: `no thumbnail for format: ${fmt ?? "unknown"}` });
          })
          .catch((e) => {
            log(`thumb ${segs.map(String).join("/")} ${w}x${h} — FAILED in ${Date.now() - t0}ms: ${String((e as Error).message || e)}`);
            sendJson(res, 500, { error: String((e as Error).message || e) });
          })
          .finally(() => thumbEnd());
        return;
      }

      const row = s.node(p);
      if (!row) return notFound(res, url);
      const kind = displayKind(s, p, row);
      // an explicit `?depth=` (a finite level, or `.inf` → Infinity) wins; absent, default per
      // concrete (unlimited for a text document, one level for a directory / binary).
      const viewDepth = depth === undefined ? defaultDepth(s, dataRoot, segs, row, kind) : depth;

      if (url.pathname === "/api/schema") {
        sendJson(res, 200, projectSchema(dataRoot, s, segs, viewDepth, true));
      } else {
        notFound(res, url);
      }
    } catch (exc) {
      sendJson(res, 400, { error: (exc as Error).message || String(exc) });
    }
  };
  // Tear-down for embedders/tests: stop the watcher + hasher, drop SSE subscribers, close the
  // DB. Idempotent — an embedder's explicit close may precede a blanket teardown's. `ready`
  // resolves when the initial background index lands (tests await it; the bin
  // catches it so a failed index cannot crash as an unhandled rejection).
  return Object.assign(handler, {
    ready,
    close: (): void => {
      if (closed) return;
      closed = true;
      stopWatch?.();
      for (const r of sseClients) r.end();
      sseClients.clear();
      store0.close();
    },
  });
}

// --------------------------------------------------------------------------- //
// Projection (Store rows → the client's value / schema / tree / marker shapes)
// --------------------------------------------------------------------------- //

/** The (type) label shown in the TOC/header — the schema-style {@link typeName}. */
function tocType(s: Store, p: string, row: NodeRow): string {
  return typeName(s, p, row);
}

// --------------------------------------------------------------------------- //
// The directory OVERLAY resolver — one answer to "which file is this directory's body"
// --------------------------------------------------------------------------- //
//
// A directory keeps its INSTANCE OVERLAY either under the hidden control subdirectory
// (`.yo/body.yo` — `dir/.yo`) or as a plain file inside itself (`index.yo` — `dir/index.yo`).
// Every read and every write asks HERE which of the two a given directory uses, so the engine
// and the walk (walk.ts overlayFile) never disagree about where a document's source lives.

/** A directory's own child names, or an empty list when it cannot be read. */
function dirNames(absDir: string): string[] {
  try {
    return fs.readdirSync(absDir);
  } catch {
    return [];
  }
}

/** The directory concrete of `absDir` — `dir`, `dir/.yo` or `dir/index.yo` (concrete.ts). */
function dirConcreteOf(absDir: string): DirConcrete {
  return dirConcreteFor(dirNames(absDir), fs.existsSync(path.join(absDir, OVERLAY_DIR, BODY_FILE)));
}

/** The INSTANCE OVERLAY file of `absDir`: the one it already carries, else the `.yo/body.yo`
 *  a directory MATERIALIZES into when it first gains body content (ensureDirBody). The file
 *  need not exist — callers that care test it. */
function dirBodyFile(absDir: string): string {
  return path.join(absDir, ...overlaySegs(dirConcreteOf(absDir)));
}

/** The overlay flavor a NEW member of `absDir` is born in — the parent's own
 *  ({@link defaultChildConcrete}'s inheritance), so an `index.yo` branch stays `index.yo`. */
function memberFlavor(absDir: string): "dir/.yo" | "dir/index.yo" {
  return dirConcreteOf(absDir) === "dir/index.yo" ? "dir/index.yo" : "dir/.yo";
}

/** How the node at `segs` is stored — the full per-node concrete taxonomy (docs/language/concretes), derived
 *  from a stat plus the enclosing document's language (the engine tracks no per-node concrete yet).
 *  A filesystem-backed node reports its own storage (`dir` / `dir/.yo` / `file/<lang>` /
 *  `file/binary`); an interior (inlined) node reports the inlined language of the document it lives
 *  in — a directory document's values come from its instance overlay (`yamlover`), a parsed
 *  file's from that file (its extension's language). Positional segments never name an FS entry, so
 *  they fall through to the inlined case; never null (every node carries a concrete). */
function concreteOf(s: Store, dataRoot: string, segs: Seg[], row: NodeRow): string {
  // 1. A filesystem-backed node: stat its own path (only string segments can name an FS entry).
  if (segs.every((g) => typeof g === "string")) {
    const abs = path.resolve(dataRoot, ...segs.map(String));
    let st: fs.Stats | undefined;
    try { st = fs.statSync(abs); } catch { /* not FS-backed — fall through to the inlined case */ }
    if (st?.isDirectory()) return dirConcreteOf(abs);
    if (st?.isFile()) return dataFileConcrete(abs) ?? (row.type === "blob" ? "file/binary" : "file/yaml");
  }
  // 2. An interior (inlined) node: the inlined language of its enclosing document.
  const docAbs = path.resolve(dataRoot, ...documentRootSegs(s, segs).map(String));
  try { if (fs.statSync(docAbs).isFile()) return interiorOf(dataFileConcrete(docAbs) ?? "file/yaml"); } catch { /* a directory document / the served root → yamlover overlay */ }
  return "yamlover";
}

// --------------------------------------------------------------------------- //
// Relation direction. A relation has ONE natural direction (upstream → downstream), regardless of
// which side authored it: a forward `*` ref / containment runs from→to; a `~` back-edge is stored
// reversed (it is authored on the downstream side, pointing back up), so its nature is to→from.
// A node's DOWNSTREAM relations (it is the natural source) are its children/value, shown below the
// <hr>; its UPSTREAM relations (it is the natural target) are shown above it. Authoring a relation
// both ways (forward at the parent AND `~` at the child) yields two stored edges for ONE relation,
// so each direction is de-duplicated by (label, other end). This split is used everywhere — the
// value/schema projections and the relations panel — so nothing has to special-case `~`.
// --------------------------------------------------------------------------- //

const relKey = (label: string | null, other: string): string => `${label ?? ""}\u0000${other}`;

/** A node's DOWNSTREAM entries (it is the natural source), in source order: its containment
 *  children and forward `*` refs (authored here, positioned), then any `~` back-edges that target
 *  it from elsewhere (authored on the downstream node, so unpositioned → appended, ordered
 *  lexicographically by the member's path — docs/language/pointers/bookmarks).
 *
 *  Dedup is by identity, which only a LABEL provides: a same-label both-ways pair (`L: *x` +
 *  `~L: …`) is one relation authored twice → one entry. A KEYLESS membership (label null, the
 *  `~-` form) has no identity and is ADDITIVE — every declaration appends an element, even
 *  alongside a forward `- *member` (lists repeat) — unless the container is a `!!set` /
 *  `uniqueItems: true` (NodeMeta.set), where membership is by target and ALL duplicates
 *  (forward+forward, forward+reverse, reverse+reverse) collapse. */
/** Whether a node is flagged hidden (the `.yo` overlay subtree): resolvable by pointer, but
 *  omitted from the TOC, directory-member projection, and visible child counts. */
const isHidden = (s: Store, to: string): boolean => !!s.node(to)?.meta?.hidden;
/** Whether a node lives in the hidden `.yo` overlay subtree: it OR a containment ancestor is
 *  hidden. `meta.hidden` is set only on the `.yo` dir node (not propagated to its children),
 *  so an own-meta check misses descendants like `settings.yo` — walk up to catch them. */
const inHiddenSubtree = (s: Store, p: string): boolean => {
  for (let segs = storePathToSegs(p); segs.length; segs = segs.slice(0, -1))
    if (isHidden(s, storePath(segs))) return true;
  return false;
};
/** Has a child that ISN'T hidden — the `hasChildren` a directory should report (a dir whose only
 *  child is `.yo` reads as a leaf). */
const visibleHasChildren = (s: Store, p: string): boolean => s.children(p).some((c) => !isHidden(s, c.to));
/** Hidden for PROJECT-SCOPED query results (`::` / `:::` — see the /api/query handler) —
 *  looser than {@link inHiddenSubtree}: the `.yo` OVERLAY subtrees (dot-named hidden
 *  ancestors) and hidden nodes THEMSELVES stay off search results, but the grafted `yamlover`
 *  self-import's CONTENT answers — it is project furniture, hidden PLUMBING yet fully
 *  reachable, and `:: ...: colors` must find the built-in palette (`:yamlover:ontos:colors`).
 *  So `:: ?` still omits the graft root (a hidden node itself) while `:: yamlover: ?` and
 *  project-wide descent reach inside it. */
const queryHidden = (s: Store, p: string): boolean => {
  if (isHidden(s, p)) return true;
  for (let segs = storePathToSegs(p); segs.length; segs = segs.slice(0, -1)) {
    const sp = storePath(segs);
    if (isHidden(s, sp) && String(segs[segs.length - 1]).startsWith(".")) return true;
  }
  return false;
};

/** Has a SUBCHAPTER child (a nested chapter/task) — the `hasChildren` hint a CHAPTER should report in
 *  the TOC: only subchapters are navigable there (chunks and overlay fields like `yo`
 *  are content, not tree entries — `chapterTocView`). Mirrors the client's `isSubchapter(format)`, so
 *  a chunks-only chapter reads as a leaf (no chevron that expands to nothing). */
const hasSubchapterChild = (s: Store, p: string): boolean =>
  s.children(p).some((c) => {
    if (isHidden(s, c.to)) return false;
    const f = s.node(c.to)?.format;
    return f === "x-yamlover-chapter" || f === "x-yamlover-task";
  });

/** The entry targets under `p` whose edge carries the NULL KEY (label IS NULL but
 *  `label_null = 1` — a KEYED entry whose key is the null value, `:~`). The Store helpers do
 *  not surface the `label_null` column yet, so the projection reads it here (engine-api only). */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();
function nullKeyTargets(s: Store, p: string): ReadonlySet<string> {
  const rows = s.db
    .prepare("SELECT to_path FROM edge WHERE from_path = ? AND kind IN ('contain','ref') AND label IS NULL AND label_null = 1")
    .all(p) as { to_path: string }[];
  return rows.length ? new Set(rows.map((r) => r.to_path)) : EMPTY_SET;
}

/** The child SEGMENT an entry row answers to: its key, the NULL key (when `nullKeyed` says the
 *  label-less edge is the null-keyed one), or its position. */
function childSegOf(c: { to: string; label: string | null; pos: number | null }, nullKeyed: ReadonlySet<string>): Seg {
  return c.label ?? (nullKeyed.has(c.to) ? null : c.pos ?? 0);
}

function downstreamEntries(s: Store, p: string): { to: string; label: string | null; pos: number | null; kind: EdgeRow["kind"]; raw?: string }[] {
  const isSet = !!s.node(p)?.meta?.set;
  // contain + forward ref (including UNREALIZED refs — dangling/external pointers, `to` empty,
  // `raw` the authored text — via ownedEntries), ordered by pos — but a CONTAIN edge to a hidden
  // node (`.yo`) is omitted from the listing (forward `*` refs INTO the hidden subtree,
  // e.g. a thumbnail pointer, are kept — they're how the overlay surfaces the sidecar).
  let own = ownedEntries(s, p).filter((e) => !(e.kind === "contain" && isHidden(s, e.to)));
  const seen = new Set(own.map((e) => relKey(e.label, e.to || e.raw || "")));
  if (isSet) {
    const kept = new Set<string>(); // set semantics: an element appears at most once
    own = own.filter((e) => { const k = relKey(e.label, e.to || e.raw || ""); if (kept.has(k)) return false; kept.add(k); return true; });
  }
  const out: { to: string; label: string | null; pos: number | null; kind: EdgeRow["kind"]; raw?: string }[] = [...own];
  const backs = s.relationships(p).in
    .filter((e) => e.kind === "back" && e.from)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)); // lexicographic by member path
  for (const e of backs) {
    const k = relKey(e.label, e.from); // natural target of a back-edge is its `from`
    if (e.label != null || isSet) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push({ to: e.from, label: e.label, pos: null, kind: "ref" });
  }
  return out;
}

// projectValue — the JSON wire's projection — is RETIRED (the one-wire migration, Stage 4):
// the client derives its NodeJson from /api/content (derive-node.ts deriveNodeJson, pinned by
// the derivation goldens). What survives here is what other routes still speak: linkMarker,
// refMarker, refPointerText, downstreamEntries, wireScalar, childSegOf, projectSchema.

// irNodeAt / collectComments (and the CommentBucket vocabulary) moved to
// ../projection-comments.ts — PURE over the parser IR, shared with the client-side
// derivation (the one-wire migration, Stage 2).

/** The instance schema (every value `v` → `{const: v}`); containers past depth = link markers. */
function projectSchema(dataRoot: string, s: Store, segs: Seg[], depth: number, top: boolean): unknown {
  const p = storePath(segs);
  const row = s.node(p)!;
  const k = displayKind(s, p, row);
  if ((k === "object" || k === "array" || k === "mix" || k === "omni") && depth <= 0) return linkMarker(dataRoot, s, segs);
  if (k === "binary" && !top) return linkMarker(dataRoot, s, segs);
  const schema: Record<string, unknown> = { type: typeName(s, p, row) }; // map|seq|kseq|vmap|vseq|omni|binary|<scalar>
  if (row.format) schema.format = row.format;
  const kids = downstreamEntries(s, p);
  const nullKeyed = nullKeyTargets(s, p);
  const sub = (c: { to: string; label: string | null; pos: number | null; kind: string; raw?: string }) =>
    c.kind === "contain" ? projectSchema(dataRoot, s, [...segs, childSegOf(c, nullKeyed)], depth - 1, false)
    : c.to ? linkMarker(dataRoot, s, storePathToSegs(c.to))
    : refMarker(c.raw ?? "", null); // an unrealized ref: pointer text, no link
  if (k === "object" || k === "mix" || k === "omni") {
    // mixed/variant fields: keyless entries keep their bare-digit position key, keyed ones their
    // name, the null key `~`; a
    // variant (omni) also pins its self-value. (Order is the property insertion order.)
    const props: Record<string, unknown> = {};
    for (const c of kids) props[c.label ?? segToken(childSegOf(c, nullKeyed))] = sub(c);
    schema.properties = props;
    if (k === "omni") schema.value = row.value;
  } else if (k === "array") {
    schema.prefixItems = kids.map(sub);
    schema.items = false;
  } else if (k === "binary") {
    schema.const = { size: row.size, format: row.format };
  } else {
    schema.const = row.value;
  }
  const t = titleOf(s, p);
  if (t) schema.title = t;
  return schema;
}

/** A `$yamloverLink` marker for the node at `segs` (a navigable summary). */
function linkMarker(dataRoot: string, s: Store, segs: Seg[]): Record<string, unknown> {
  const p = storePath(segs);
  const row = s.node(p)!;
  const k = displayKind(s, p, row);
  const info: Record<string, unknown> = { kind: k, type: tocType(s, p, row), ...facetsOf(s, p, row), path: segsToStr(segs) };
  if (row.format) info.format = row.format;
  if (row.meta?.yo === true) info.yo = true; // `!!yo` — exempt from the enclosing schema (chapter routing)
  info.concrete = concreteOf(s, dataRoot, segs, row); // a folder child renders with a folder icon; every node carries one
  const title = titleOf(s, p);
  if (title) info.title = title;
  if (k === "binary") info.size = row.size;
  else if (k === "scalar") info.value = wireScalar(row.value);
  else if (k === "omni" || k === "mix") {
    info.count = ownedEntries(s, p).length; // owned items + fields (reverse members excluded)
    if (k === "omni") info.value = wireScalar(row.value); // the self-scalar, for the link label
  } else {
    // visible members only (omit `.yo`) — owned entries, so pointer members (including
    // unrealized ones) count the same as inline children (they all render as rows)
    info.count = ownedEntries(s, p).filter((e) => !(e.kind === "contain" && isHidden(s, e.to))).length;
  }
  if (row.format === ONTO_FORMAT) {
    // a pure color tag's explicit color rides the link, so badges color correctly everywhere
    const c = s.node(p + ":color")?.value;
    if (typeof c === "string") info.color = c;
  }
  if (row.format === FRAGMENT_FORMAT) {
    // a fragment is a region of an image with a materialized CROP blob (its `image` ref); ride
    // the crop's path on the link so a grid (e.g. the tag page's explorer) previews the fragment
    // by its crop, the way an image previews by its own bytes — a fragment is not file-backed.
    const imgEdge = s.relationships(p).out.find((o) => o.kind === "ref" && o.label === "image");
    if (imgEdge) info.preview = segsToStr(storePathToSegs(imgEdge.to));
  }
  return { [LINK_KEY]: info };
}

const segsEqual = (a: Seg[], b: Seg[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** An upstream node's path written in the scope it has FROM the current node's document frame:
 *  document-relative (`:eve`) when it lives in the same document, else a project-scope link
 *  (`::examples:…`) — mirroring the colon scope ladder (docs/language/pointers/paths: `:` = document root,
 *  `::` = project). */
function scopedPath(s: Store, src: Seg[], currentDoc: Seg[]): string {
  if (segsEqual(refFrameSegs(s, src), currentDoc)) return segsToStr(src.slice(currentDoc.length)); // `:…`
  return "::" + segsToStr(src).slice(1); // `::…` — a project-scope link
}

/** A reference's value rendered as a VALID yamlover deref token — `*` + the canonical
 *  spaced colon path (`*: pets: 0`, `*:: a: b` — a position is its own bare-digit portion, the
 *  null key `~`). Used for refs the projection surfaces from the
 *  store (realized anchor edges, incoming `~`): an authored pointer carries its own text via the
 *  comment/deco sidecar; this is the faithful fallback so a ref never renders as a bare `:path`. */
function refPointerText(s: Store, src: Seg[], currentDoc: Seg[]): string {
  const seg = (x: Seg): string => `: ${segToken(x)}`;
  if (segsEqual(refFrameSegs(s, src), currentDoc)) {
    const tail = src.slice(currentDoc.length);
    return "*" + (tail.length > 0 ? tail.map(seg).join("") : ":"); // document scope; `*:` = the doc root
  }
  return "*:" + src.map(seg).join(""); // project scope — the leading `*:` + `: seg` makes `*::…`
}

/** The relations panel: this node's UPSTREAM relations — those for which it is the natural target.
 *  Led by the containment parent as `..`, then each `*`/`~` upstream source: a forward ref authored
 *  AT the source (stored into this node) or a `~` back-edge authored here pointing at the source
 *  (stored out of it) — the same relation either way, so deduped by source + label. Each is keyed
 *  by the path it has from this node's document frame, with a link to its summary; a source that is
 *  a tag node is peeled into a header badge by splitTagRefs. (A tag is upstream of what it files —
 *  the membership `~tag` back-edge lands here naturally, no special-casing.) */
function buildRelations(dataRoot: string, s: Store, segs: Seg[]): Record<string, unknown> {
  const p = storePath(segs);
  const out: Record<string, unknown> = {};
  const put = (label: string, marker: unknown) => {
    let k = label;
    for (let i = 2; k in out; i++) k = `${label} (${i})`;
    out[k] = marker;
  };

  // The containment parent — the upstream containment relation, always the primary way up. Shown AS
  // a reference (`..` hyperlinked to the parent), never a `{ … }` marker (which means truncation).
  if (segs.length > 0) put("..", refMarker("..", segsToStr(segs.slice(0, -1))));

  // Upstream `*`/`~` sources (this node is the natural target), deduped across forward+reverse
  // authoring. A forward ref INTO p has its source at `from`; a `~` back-edge OUT of p (stored
  // reversed) has its source at `to`.
  const currentDoc = refFrameSegs(s, segs);
  const { out: outEdges, in: inEdges } = s.relationships(p);
  const upstream = new Map<string, string>(); // relKey → source store-path
  const addUp = (src: string | null, label: string | null) => {
    if (src) upstream.set(relKey(label, src), src);
  };
  for (const e of inEdges) if (e.kind === "ref") addUp(e.from, e.label); // forward ref INTO p
  for (const e of outEdges) if (e.kind === "back") addUp(e.to, e.label); // `~` back-edge OUT of p
  for (const src of upstream.values()) {
    const segs2 = storePathToSegs(src);
    const key = scopedPath(s, segs2, currentDoc);
    // a TAG source stays a link marker so splitTagRefs (client) can peel it into a header badge;
    // every other upstream source shows AS a reference (its pointer text), like the value view.
    put(key, s.node(src)?.format === ONTO_FORMAT ? linkMarker(dataRoot, s, segs2) : refMarker(key, segsToStr(segs2)));
  }
  return out;
}

interface TreeNode {
  path: string; label: string; type: string; format: string | null;
  valueType?: string | null; hasKeyed?: boolean; hasOrdinal?: boolean; // renderer dispatch facets (docs/language/logical-graph/matching)
  concrete: string | null; hasChildren: boolean; children: TreeNode[];
  value?: string; // the scalar self-value as a short one-line preview (see tocValue)
  match?: boolean; // shape=filter only: this row is one of the query's matches
}

/** A node's scalar self-value as a TOC tail (`[0] <this>`) — the `large-icons` grid's convention
 *  (explorer.tsx scalarText), so the two views read the same. First line only, capped: a long text
 *  would bloat every TOC row's DOM, and CSS ellipsis only hides overflow it has already paid for.
 *  BINARY has no readable value (blob bytes) and is omitted; so is a value that merely repeats the
 *  label, which a titled chapter's self-value always does. */
function tocValue(row: NodeRow, label: string): string | undefined {
  if (row.type === "blob" || row.value === null || row.value === undefined) return undefined;
  const line = String(row.value).split("\n", 1)[0].trim();
  if (!line || line === label) return undefined;
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

/** shape=filter's match cap — a huge result set prunes to its first rows (walk order) and
 *  the response says so (`truncated`), instead of shipping an unbounded tree. */
const MATCH_CAP = 500;

/** The TOC subtree rooted at `segs`, `depth` levels deep (every node listed). */
function buildTree(dataRoot: string, s: Store, segs: Seg[], label: string, depth: number): TreeNode {
  const p = storePath(segs);
  const row = s.node(p)!;
  const node: TreeNode = {
    path: segsToStr(segs),
    label,
    type: tocType(s, p, row),
    format: row.format ?? null,
    ...facetsOf(s, p, row),
    concrete: concreteOf(s, dataRoot, segs, row),
    // a CHAPTER's TOC entry expands to its SUBCHAPTERS only; count those, so a chunks-only chapter
    // is a leaf. Any other node reports the generic "has a visible child".
    hasChildren: row.format === "x-yamlover-chapter" || row.format === "x-yamlover-task" ? hasSubchapterChild(s, p) : visibleHasChildren(s, p),
    children: [],
  };
  const v = tocValue(row, label);
  if (v !== undefined) node.value = v;
  if (node.hasChildren && depth > 0) {
    // A BODY-ANCHORED member is ORDINAL (docs/meta/facets): its key is the storage name the body
    // consumed a pointer to, not an authored key, so the TOC names it by POSITION like any other
    // array element. The PATH stays keyed — that is the canonical, stable address.
    const anchored = anchoredOf(row);
    const nullKeyed = nullKeyTargets(s, p);
    for (const c of chapterOrderedChildren(s, p, row.format ?? null)) {
      if (isHidden(s, c.to)) continue; // omit the hidden `.yo` overlay subtree from the TOC
      const seg = childSegOf(c, nullKeyed);
      const shown = c.label !== null && anchored.has(c.label) ? (c.pos ?? 0) : seg;
      node.children.push(buildTree(dataRoot, s, [...segs, seg], labelFor(s, c.to, shown), depth - 1));
    }
  }
  return node;
}

/** A node's TOC children, normally in containment `pos` order. For a CHAPTER (directory-backed), a
 *  subchapter lives in its OWN subdirectory — a contain child sorted by directory scan — but is
 *  PLACED by a positional `*` body ref that carries the author's order. So order the children by
 *  their BODY position: a referenced child (subchapter / image chunk) takes its ref's `pos`, an
 *  inline chunk keeps its own contain `pos`, and a dir-backed child the body never references
 *  (`label` set, no ref) trails AFTER the ordered ones in dir-scan order — matching walk.ts
 *  applyBody's unlisted-trailing convention. An inline chapter has no such refs (its body is
 *  inline, contain `pos` already IS body order), so the map is empty and this is a no-op. */
function chapterOrderedChildren(s: Store, p: string, format: string | null): ReturnType<Store["children"]> {
  const kids = s.children(p);
  if (format !== "x-yamlover-chapter" && format !== "x-yamlover-task") return kids;
  const bodyPos = new Map<string, number>();
  for (const e of s.entries(p)) if (e.kind === "ref" && !bodyPos.has(e.to)) bodyPos.set(e.to, e.pos ?? 0);
  if (bodyPos.size === 0) return kids;
  const maxPos = Math.max(...bodyPos.values(), ...kids.map((c) => c.pos ?? 0));
  const key = (c: (typeof kids)[number]): number => {
    const bp = bodyPos.get(c.to);
    if (bp != null) return bp; // listed: body order
    if (c.label != null) return maxPos + 1 + (c.pos ?? 0); // unlisted dir child: trailing
    return c.pos ?? 0; // inline chunk: keeps its interleaved body position
  };
  return kids.map((c, i) => ({ c, i })).sort((a, b) => key(a.c) - key(b.c) || a.i - b.i).map((x) => x.c);
}

/** A node's tree label: its title (a chapter/task's scalar self-value — {@link titleOf}), else —
 *  for an UNTITLED chapter/task — the opening text of its first prose chunk (clipped), else the
 *  segment's canonical token (address-truth: a bare-digit position, `~` for the null key). */
function labelFor(s: Store, p: string, keyOrIdx: Seg): string {
  const t = titleOf(s, p);
  if (t) return t;
  const row = s.node(p);
  if (row?.format === "x-yamlover-chapter" || row?.format === "x-yamlover-task") {
    const first = firstChunkText(s, p);
    if (first) return first;
  }
  return segToken(keyOrIdx);
}

/** The opening line of a chapter's first prose chunk (its first keyless scalar child), clipped to
 *  label length — what an untitled chapter goes by in the TOC. */
function firstChunkText(s: Store, p: string): string | null {
  for (const e of s.entries(p)) {
    if (e.kind !== "contain" || e.label != null) continue;
    const c = s.node(e.to);
    if (c?.type === "scalar" && c.value != null && String(c.value).trim()) {
      const line = String(c.value).trim().split("\n")[0];
      return line.length > 40 ? line.slice(0, 39).trimEnd() + "…" : line;
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Tags, fragments & annotations — EMBEDDED in the target (docs/annotations). A user-marked region
// is a FRAGMENT under the target's `yo: fragments:` mapping (keyed by slug; selector + an
// optional binary crop). TAGGING a target — a whole node or a fragment — appends to its
// `yamlover-annotations` array: a bare tag pointer (`- *::tag`) or a `{tag, …params}` object. The
// applied tag drives the color. A material's annotations / a tag's materials are derived from
// these forward `*` edges. Writes edit the target's host body (a `*.yo` doc or a directory
// `.yo/body.yo` overlay) surgically — see ./embed.ts.
// --------------------------------------------------------------------------- //

const ONTO_FORMAT = "x-yamlover-onto";
const FRAGMENT_FORMAT = "x-yamlover-fragment";
// Fragments nest under the reserved `yo:` key (docs/annotations/fragments): `yo: fragments: <slug>`.
const YO_KEY = "yo";
const FRAGS_SUBKEY = "fragments";
const THUMB_KEY = "yamlover-thumbnails";
const CROP_SUBDIR = "fragments"; // crop sidecar blobs, under a hidden .yo/ overlay dir
const THUMB_SUBDIR = "thumbnails"; // derived thumbnail blobs, content-addressed, under .yo/

interface AnnotateInput {
  target: string; // the target's JSON path — a node, or a fragment (`…:yo:fragments:<slug>`)
  tag: string; // the applied tag's JSON path
  description?: string; // a parametrized annotation's comment
  selector?: Record<string, unknown>; // a TEXT selection on a prose chunk — the INLINE token spelling
  params?: Record<string, unknown>; // any other parameters (parametrized form)
}

interface FragmentInput {
  target: string; // the node the region lives in (its JSON path)
  selector: Record<string, unknown>; // { type:"text", exact, … } | { type:"pdf", page, x, y, w, h } | …
  imageBase64?: string; // an optional PNG crop (image-like selections)
}

/** A child store-path: `parent` + `:key` (root `:` has no leading owner). */
const childPath = (parent: string, key: string): string => (parent === ":" ? "" : parent) + ":" + key;

/** ANY node projected as an annotation ref { path, name, color } — annotating entities are
 *  identified by their scalar OMNI title (or a keyed `title`), else by their key inside the
 *  parent (the last path segment). `color` = the node's explicit `color` child, else null
 *  (the client derives a hue from the name). Null only when the node does not exist. */
function projectTag(s: Store, tagStore: string): { path: string; name: string; color: string | null } | null {
  if (!s.node(tagStore)) return null;
  const segs = storePathToSegs(tagStore);
  const color = s.node(tagStore + ":color")?.value;
  const name = displayNameOf(s, tagStore) ?? String(segs[segs.length - 1] ?? "");
  return { path: segsToStr(segs), name, color: typeof color === "string" ? color : null };
}

/** A node's DISPLAY identity, title-first: an OMNI node's scalar self-value (a tag/chapter
 *  spelled `mytag: "My Tag Title"`), else the keyed/chapter title (titleOf). Null = untitled
 *  (the caller falls back to the key inside the parent). A LEAF scalar's value is data, not
 *  a title — only a value-plus-fields (variant) node reads its self-value as one. */
function displayNameOf(s: Store, p: string): string | null {
  const n = s.node(p);
  if (n?.type === "scalar" && n.value != null && s.children(p).length > 0) return String(n.value);
  return titleOf(s, p);
}

/** The tag applications in a host node's `yamlover-annotations` array: a bare tag pointer (a `ref`
 *  entry straight to the tag) or a `{tag, …params}` object (a `contain` entry whose `tag` field
 *  refs the tag and whose scalar children are parameters). */
function readAnnotations(s: Store, hostStore: string): { tag: ReturnType<typeof projectTag>; description?: string; params?: Record<string, unknown> }[] {
  // MEMBERSHIP BY BOOKMARK (docs/annotations/applications): the node's ordinal `&…:-` bookmarks
  // are `back` edges FROM it INTO the onto — keyless (label null; a keyed bookmark is an alias,
  // never an application). Parameters ride the fragment as plain fields, read by the caller.
  const out: { tag: ReturnType<typeof projectTag>; description?: string; params?: Record<string, unknown> }[] = [];
  for (const e of s.relationships(hostStore).out) {
    if (e.kind !== "back" || e.label != null) continue;
    const tag = projectTag(s, e.to);
    if (tag) out.push({ tag });
  }
  return out;
}

/** A host node's fragments: each slug's selector fields (geometry / text quote) + its crop URL,
 *  read from the `yo: fragments:` mapping. A TEXT fragment's quoted text is the member's
 *  SELF-VALUE (docs/annotations/fragments) — materialized onto the wire as `selector.exact`, so
 *  every consumer keeps the W3C shape. `image` is a `*` pointer (a ref edge) to the crop. */
function readFragments(s: Store, hostStore: string): { slug: string; node: string; selector: Record<string, unknown>; description?: string; imageUrl?: string }[] {
  const frags = childPath(childPath(hostStore, YO_KEY), FRAGS_SUBKEY);
  if (!s.node(frags)) return [];
  const out: { slug: string; node: string; selector: Record<string, unknown>; description?: string; imageUrl?: string }[] = [];
  for (const fc of s.children(frags)) {
    if (!fc.label) continue;
    const selector: Record<string, unknown> = {};
    let description: string | undefined;
    const self = s.node(fc.to)?.value;
    if (self != null) selector.exact = String(self);
    for (const c of s.children(fc.to)) {
      if (!c.label || c.label === "created") continue;
      // open fragment data (docs/annotations/fragments): the selector locates; `description`
      // (and future extras) are commentary, surfaced beside it rather than inside it
      if (c.label === "description") { const v = s.node(c.to)?.value; description = v == null ? undefined : String(v); continue; }
      selector[c.label] = s.node(c.to)?.value;
    }
    const imgEdge = s.relationships(fc.to).out.find((o) => o.kind === "ref" && o.label === "image");
    const imageUrl = imgEdge ? `/api/blob?path=${encodeURIComponent(segsToStr(storePathToSegs(imgEdge.to)))}` : undefined;
    out.push({ slug: fc.label, node: fc.to, selector, description, imageUrl });
  }
  return out;
}

/** The annotations ON this material: its own whole-node tags, plus each fragment's tags carrying
 *  that fragment's selector + crop (so the client highlights the region and colors by tag). Each
 *  entry carries `node` — the CLIENT path of the node it lives on — so a multi-node page (a chapter
 *  whose CHUNKS each carry their own fragments, docs/annotations/storage) can target/highlight per node.
 *  A chapter also gathers its DIRECT children's fragments (the chunks), one level deep. */
function annotationsFor(dataRoot: string, s: Store, segs: Seg[]): unknown[] {
  void dataRoot;
  const p = storePath(segs);
  const out: unknown[] = [];
  const gather = (hostStore: string, nodeClient: string): void => {
    for (const a of readAnnotations(s, hostStore)) out.push({ ...a, node: nodeClient });
    // INLINE fragment tokens (docs/documents/marklower/grammar): a prose value's `[…](…)`
    // tokens with label bookmarks are memberships of the region the token wraps — surfaced
    // exactly like explicit fragments, the selector derived from the token's own position.
    const row = s.node(hostStore);
    if (row?.type === "scalar" && typeof row.value === "string" && row.value.includes("[")) {
      const text = row.value;
      for (const t of scanMarklower(text)) {
        if (t.kind !== "frag" || t.bookmarks.length === 0) continue;
        const selector = {
          type: "text", exact: t.value,
          prefix: text.slice(Math.max(0, t.start - 24), t.start).replace(/\n/g, " "),
          suffix: text.slice(t.end, t.end + 24).replace(/\n/g, " "),
        };
        for (const b of t.bookmarks) {
          const bsegs = bookmarkSegs(b);
          const tag = bsegs ? projectTag(s, storePath(bsegs)) : null;
          if (tag) out.push({ tag, node: nodeClient, selector, inline: true });
        }
      }
    }
    for (const f of readFragments(s, hostStore)) {
      for (const a of readAnnotations(s, f.node)) {
        out.push({
          ...a, node: nodeClient, selector: f.selector, fragmentSlug: f.slug,
          ...(f.description ? { description: f.description } : {}),
          ...(f.imageUrl ? { imageUrl: f.imageUrl } : {}),
        });
      }
    }
  };
  gather(p, segsToStr(segs));
  for (const c of s.children(p)) {
    if (isHidden(s, c.to)) continue; // skip the `.yo` overlay subtree
    gather(c.to, segsToStr(storePathToSegs(c.to)));
  }
  return out;
}

/** The MATERIALS filed under an onto — its MEMBERS (docs/annotations/derivation): every keyless
 *  `&…:-` bookmark INTO it (a `back` edge from the member) plus every forward-authored keyless
 *  `- *: member` row of its own. Keyed edges are aliases/links, never applications. Each member
 *  is deduped and ordered lexicographically by path. */
function taggedMaterials(dataRoot: string, s: Store, tagStorePath: string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  const rel = s.relationships(tagStorePath);
  const members = [
    ...rel.in.filter((e) => e.kind === "back" && e.label == null && e.from).map((e) => e.from),
    ...rel.out.filter((e) => e.kind === "ref" && e.label == null).map((e) => e.to),
  ].sort();
  for (const owner of members) {
    // skip the onto itself, dups, missing nodes, and any member in the hidden `.yo` overlay
    // subtree (e.g. settings.yo, whose `annotation-tag:` pointer back-references this onto)
    if (owner === tagStorePath || seen.has(owner) || !s.node(owner) || inHiddenSubtree(s, owner)) continue;
    seen.add(owner);
    out.push(linkMarker(dataRoot, s, storePathToSegs(owner)));
  }
  return out;
}

/** A client JSON path (`:key:0:x`, keys PERCENT-ENCODED) as project-scoped COLON pointer
 *  raw text (`::key:0:x`, keys RAW — quoted when spacey): pointer steps are matched against
 *  store keys verbatim — an encoded key would go dangling on the next re-walk. A position is
 *  its own bare-digit colon portion (the YAML-keys round), the null key `~`. */
function pointerRaw(clientPath: string): string {
  const segs = strToSegs(clientPath);
  // The ROOT has no project-scope spelling — `::` with no first portion is not a pointer, and
  // writing it would corrupt the host body (the parse throws only at the NEXT read). Every
  // writer (annotate, boards) funnels through here, so the invariant lives here.
  if (segs.length === 0) throw new Error("the root has no project-scope pointer spelling");
  let out = "";
  for (const seg of segs) {
    out += (out === "" ? "" : ":") + segToken(seg);
  }
  return "::" + out;
}

/** Rewrite a board overlay's top-level `lanes:` block (TICKETS.md §3). `lanes` is the lanes, each a
 *  list of tag client-paths; each lane is emitted as a flow-sequence of project-scope pointers. An
 *  existing `lanes:` block (its `- …` items) is replaced; otherwise the block is appended. A fresh
 *  file is seeded with the board schema tag so it indexes as a board. */
function writeBoardLanes(src: string, lanes: string[][]): string {
  const laneLine = (lane: string[]) => `- [${lane.map((p) => pointerToken(pointerRaw(p))).join(", ")}]`;
  const block = lanes.length === 0 ? ["lanes: []"] : ["lanes:", ...lanes.map(laneLine)];
  let lines = src.replace(/\n+$/, "").split("\n");
  if (src.trim() === "") lines = ["!!<*yamlover:$defs:board>"];
  const start = lines.findIndex((l) => /^lanes:/.test(l));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && (lines[end] === "" || /^[ \t-]/.test(lines[end]))) end++; // the block's items
    lines.splice(start, end - start, ...block);
  } else {
    lines.push(...block);
  }
  return lines.join("\n") + "\n";
}

// --- derived sidecars: where the bytes live + how the overlay points at them ------------------ //
// A sidecar (thumbnail / fragment crop) lives under a HIDDEN `.yo/` overlay dir. Two modes
// (settings.sidecars.location): 'per-directory' keeps it beside the source — the source's own
// directory `.yo/<subdir>/`, referenced by a DOCUMENT-scope pointer `*:.yo:<subdir>:name`
// that resolves against that directory (its documentRoot); 'project' centralizes under the served
// root's `.yo/`, referenced by a PROJECT-scope pointer `*::.yo:<subdir>:name`.

/** The DIRECTORY a body file overlays, or null when the file is a standalone document: `<dir>`
 *  from a `<dir>/.yo/body.yo`, and from a `<dir>/index.yo` (docs/language/concretes). */
function overlaidDir(bodyFile: string): string | null {
  if (bodyFile.endsWith(path.join(OVERLAY_DIR, BODY_FILE))) return path.dirname(path.dirname(bodyFile));
  return path.basename(bodyFile) === INDEX_FILE ? path.dirname(bodyFile) : null;
}

/** The directory a sidecar is written to + the pointer scope to emit, from the embed host's
 *  `bodyFile` (a directory overlay — `<dir>/.yo/body.yo` or `<dir>/index.yo` — lets
 *  per-directory work; a standalone-doc host has none, so per-directory falls back to project).
 *  The sidecars themselves always live under `.yo/`, whichever overlay flavor the host uses. */
function sidecarTarget(
  dataRoot: string,
  mode: SidecarLocation,
  subdir: string,
  bodyFile: string,
): { dir: string; scope: "document" | "project" } {
  const hostDir = overlaidDir(bodyFile);
  if (mode === "per-directory" && hostDir !== null) {
    return { dir: path.join(hostDir, OVERLAY_DIR, subdir), scope: "document" };
  }
  return { dir: path.join(dataRoot, OVERLAY_DIR, subdir), scope: "project" };
}

/** Pointer raw text for a sidecar `name` in `subdir` under `.yo/`, at the given scope:
 *  document → `:.yo:<subdir>:name` (single colon, resolves against the nearest documentRoot);
 *  project → `::.yo:<subdir>:name` (served-root relative). Wrap with {@link pointerToken}. */
function sidecarPointerRaw(subdir: string, name: string, scope: "document" | "project"): string {
  const body = [".yo", subdir, name].map(colonSegment).join(":");
  return (scope === "document" ? ":" : "::") + body;
}

/** Serialize a value as a yamlover scalar (double-quoted strings round-trip through the parser). */
function yScalar(v: unknown): string {
  return typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v ?? ""));
}

/** The yamlover host body holding the node at `segs`, and the mapping-key path WITHIN it to that
 *  node (docs/annotations/storage). A standalone `*.yo` document → the file itself (within = the
 *  path inside it); a directory → its instance overlay; an on-disk blob (a PDF) →
 *  the ENCLOSING directory's overlay, keyed by the filename. */
function hostFor(dataRoot: string, s: Store, segs: Seg[]): { bodyFile: string; within: string[] } {
  for (let i = segs.length; i >= 0; i--) {
    const sub = segs.slice(0, i);
    const abs = path.resolve(dataRoot, ...sub.map(String));
    let st: fs.Stats | undefined;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) return { bodyFile: dirBodyFile(abs), within: segs.slice(i).map(String) };
    if (st.isFile()) {
      const node = s.node(storePath(sub));
      // Edit a MAPPING document in place (a new top-level key is valid). A leaf file — scalar,
      // blob, or array — would become an UNTAGGED omni/mix if a key were appended to its source
      // (a parse error under the current parser), so route it through the enclosing directory's
      // overlay keyed by the filename: the engine merges the fields onto the file at IR level
      // (augmentEntry — omni-blob), never reparsing a mixed source. docs/annotations/storage.
      if (node?.meta?.documentRoot && node.type === "mapping" && !node.is_array) {
        return { bodyFile: abs, within: segs.slice(i).map(String) };
      }
      const dir = path.resolve(dataRoot, ...sub.slice(0, -1).map(String));
      return { bodyFile: dirBodyFile(dir), within: segs.slice(i - 1).map(String) };
    }
  }
  return { bodyFile: dirBodyFile(dataRoot), within: segs.map(String) };
}


/** A fragment's source lines at the fragments-map `indent` (`<slug>:` + selector + crop + created),
 *  tagged so it indexes as an x-yamlover-fragment node. A TEXT selector's `exact` is spelled as
 *  the member's SELF-VALUE on the slug line (docs/annotations/fragments) — the member is an omni:
 *  the quoted text itself, with the remaining selector fields beside it. */
function fragmentBlockLines(slug: string, selector: Record<string, unknown>, imagePtr: string | null, indent: number): string[] {
  const pad = " ".repeat(indent);
  const { exact, ...fields } = selector as { exact?: unknown } & Record<string, unknown>;
  const self = exact != null ? ` ${yScalar(exact)}` : "";
  const lines = [`${pad}${keyToken(slug)}: !!<*::yamlover:$defs:fragment>${self}`];
  for (const [k, v] of Object.entries(fields)) lines.push(`${pad}  ${keyToken(k)}: ${yScalar(v)}`);
  if (imagePtr) lines.push(`${pad}  image: ${imagePtr}`);
  lines.push(`${pad}  created: ${new Date().toISOString()}`);
  return lines;
}

/** Whether a seg path names a fragment member (`…:yo:fragments:<slug>`). */
const isFragmentSegs = (segs: Seg[]): boolean =>
  segs.length >= 3 && segs[segs.length - 3] === YO_KEY && segs[segs.length - 2] === FRAGS_SUBKEY;

// ─────────────── THE INLINE FRAGMENT TOKEN (docs/documents/marklower/grammar) ───────────────
// In marklower prose the NORMALIZED spelling of a text fragment is the `[…](…)` token in the
// chunk's own text: creation wraps the selected words, a membership rides the label as a
// leading `&…:-` bookmark, and removing the last membership unwraps the token — the prose
// returns byte-exact. Everything an inline op cannot spell (a selection across a soft break or
// inside another token) falls back to the explicit `yo: fragments:` member, silently.

/** The `[]` spelling of a value: bare when it survives the label scan; quoted otherwise. */
const labelToken = (v: string): string =>
  /[:\[\]()&'"\n]|^\s|\s$/.test(v) ? "'" + v.replace(/'/g, "''") + "'" : v;

/** Locate `exact` in the chunk's SOURCE text (soft breaks read as spaces — the offsets are 1:1),
 *  prefix/suffix disambiguated; null when absent, crossing a line, or inside another token. */
function locateExact(text: string, sel: Record<string, unknown>): { a: number; b: number } | null {
  const needle = String(sel.exact ?? "");
  if (!needle) return null;
  const norm = text.replace(/\n/g, " ");
  const pre = String(sel.prefix ?? "").replace(/\n/g, " ");
  const suf = String(sel.suffix ?? "").replace(/\n/g, " ");
  let at = -1;
  for (let f = norm.indexOf(needle); f >= 0; f = norm.indexOf(needle, f + 1)) {
    if (pre && !norm.slice(0, f).endsWith(pre)) continue;
    if (suf && !norm.slice(f + needle.length).startsWith(suf)) continue;
    at = f;
    break;
  }
  if (at < 0) at = norm.indexOf(needle);
  if (at < 0) return null;
  const b = at + needle.length;
  if (text.slice(at, b).includes("\n")) return null; // a token never spans lines
  for (const t of scanMarklower(text)) {
    if (at < t.end && b > t.start) return null; // overlaps an existing token — not spellable
  }
  return { a: at, b };
}

/** The block-literal payload for an emplace of `text` — the chomp preserves the value's own
 *  trailing-newline state, so an unwrap restores the chunk byte-exact. */
const blockPayload = (text: string): string => {
  const strip = !text.endsWith("\n");
  const body = (strip ? text : text.slice(0, -1)).split("\n").map((l) => "  " + l).join("\n");
  return (strip ? "|-\n" : "|\n") + body;
};

/** Rewrite a prose chunk's inline fragment token (or create one): `mutate` maps the existing
 *  token (null = none yet) to the replacement TOKEN TEXT (null = unwrap to the plain value).
 *  Returns false when the inline spelling cannot host the op — the caller falls back to the
 *  explicit member. Writes through applyEdits, so anchors/comments survive like any edit. */
function rewriteInlineFragment(
  dataRoot: string,
  s: Store,
  segs: Seg[],
  sel: Record<string, unknown>,
  mutate: (token: FragTokenT | null) => string | null | false,
): boolean {
  const row = s.node(storePath(segs));
  if (!row || row.type !== "scalar" || typeof row.value !== "string") return false;
  const text = row.value;
  const exact = String(sel.exact ?? "");
  let existing: FragTokenT | null = null;
  for (const t of scanMarklower(text)) {
    if (t.kind === "frag" && t.link === null && t.value === exact) { existing = t; break; }
  }
  let next: string;
  if (existing) {
    const replacement = mutate(existing);
    if (replacement === false) return false;
    next = text.slice(0, existing.start) + (replacement ?? existing.value) + text.slice(existing.end);
  } else {
    const where = locateExact(text, sel);
    if (!where) return false;
    const replacement = mutate(null);
    if (replacement === false || replacement === null) return false;
    next = text.slice(0, where.a) + replacement + text.slice(where.b);
  }
  applyEdits(dataRoot, s, [{ path: segsToStr(segs), op: "emplace", yamlover: blockPayload(next) }]);
  return true;
}

/** Compose a token from its parts (bookmarks lead the label, `: `-separated from the value). */
function fragTokenText(bookmarks: readonly string[], value: string, parens: string): string {
  const head = bookmarks.length ? bookmarks.join(": ") + ": " : "";
  return `[${head}${labelToken(value)}](${parens})`;
}

/** The bookmark body's segs (authority + step names), or null when unparsable. */
function bookmarkSegs(body: string): Seg[] | null {
  try {
    const p = parsePointer(body.replace(/^&/, "").replace(/:\s*-\s*$/, "")) as { base?: { authority?: string }; steps?: { name?: unknown }[] };
    const segs = [p.base?.authority, ...(p.steps ?? []).map((st) => st.name)].filter((x): x is string => typeof x === "string");
    return segs.length ? segs : null;
  } catch {
    return null;
  }
}

/** File the target under an onto: ONE membership bookmark on the target (`&<onto>:-`, own-line,
 *  top of the field block — docs/annotations/applications). An application carries no data of its
 *  own; a `description`/params ride the target FRAGMENT as plain fields. A TEXT selector on a
 *  prose-chunk target takes the INLINE spelling — the bookmark rides the `[…](…)` token's label,
 *  the token created around the selection when absent (docs/documents/marklower/grammar); what
 *  the inline form cannot spell falls back to the explicit member. */
function embedAnnotation(dataRoot: string, s: Store, mode: SidecarLocation, a: AnnotateInput): string {
  const segs = strToSegs(a.target || ":");
  const params: Record<string, unknown> = { ...(a.params ?? {}) };
  if (a.description != null && a.description !== "") params.description = a.description;
  const sel = a.selector;
  if (sel && typeof sel === "object" && (sel as Record<string, unknown>).type === "text"
      && Object.keys(params).length === 0 && isChunkTarget(s, segs)) {
    const btoken = `&${pointerRaw(a.tag)}:-`;
    const ok = rewriteInlineFragment(dataRoot, s, segs, sel as Record<string, unknown>, (t) =>
      t ? fragTokenText([...t.bookmarks, btoken], t.value, t.parens)
        : fragTokenText([btoken], String((sel as Record<string, unknown>).exact ?? ""), ""));
    if (ok) return chapterSource(dataRoot, s, segs).bodyFile;
    // the inline spelling can't host it — the explicit member is the fallback form
    const made = embedFragment(dataRoot, s, mode, { target: a.target, selector: sel as Record<string, unknown> });
    return embedAnnotation(dataRoot, s, mode, { target: made.fragmentPath, tag: a.tag });
  }
  if (Object.keys(params).length && !isFragmentSegs(segs)) {
    throw new Error("annotation parameters live on a fragment (docs/annotations/applications)");
  }
  const tokens = [`&${pointerRaw(a.tag)}:-`, ...Object.entries(params).map(([k, v]) => `${keyToken(k)}: ${yScalar(v)}`)];
  // A membership ON a chunk fragment (`:chapter[k]:yo:fragments:<slug>`) descends past a body
  // index: reach the chunk field-region, then the fragment's own body, and bookmark there.
  if (isChunkTarget(s, segs)) {
    const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
    const { indices, keys } = splitChunkWithin(segs.slice(docSegs.length));
    const lines = fs.readFileSync(bodyFile, "utf8").replace(/\n$/, "").split("\n");
    const region = reachBodyAt(lines, chunkFieldRegion(lines, indices, /*ensureOmni*/ true), keys);
    appendBookmarkAt(lines, region, tokens);
    writeBody(dataRoot, s, bodyFile, lines.join("\n") + "\n");
    return bodyFile;
  }
  const { bodyFile, within } = hostFor(dataRoot, s, segs);
  mkdirInside(dataRoot, path.dirname(bodyFile), { recursive: true });
  const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
  writeBody(dataRoot, s, bodyFile, appendBookmark(src, within, tokens));
  return bodyFile;
}

/** Embed a fragment under the target's `yo: fragments:` mapping; for an image-like selection,
 *  write the PNG crop as a sidecar blob the fragment references. Returns its slug + node path. */
function embedFragment(dataRoot: string, s: Store, mode: SidecarLocation, f: FragmentInput): { slug: string; fragmentPath: string } {
  const segs = strToSegs(f.target || ":");
  const slug = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // A chunk target (`:chapter[k]`, a positional prose item) can't be reached by the mapping-key
  // writer — turn the chunk into an omni node and hang `yo: fragments:` off it (docs/annotations/storage).
  if (isChunkTarget(s, segs)) {
    const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
    const { indices, keys } = splitChunkWithin(segs.slice(docSegs.length));
    if (keys.length) throw new Error("a fragment target must be the chunk itself"); // create hangs off the chunk
    const lines = fs.readFileSync(bodyFile, "utf8").replace(/\n$/, "").split("\n");
    assertProseChunk(lines, indices); // reject a `*…` / non-text chunk
    const region = chunkFieldRegion(lines, indices, /*ensureOmni*/ true); // convert the chunk to an omni node
    upsertMapEntryAt(lines, reachBodyAt(lines, region, [YO_KEY]), FRAGS_SUBKEY, slug, (indent) => fragmentBlockLines(slug, f.selector, null, indent));
    writeBody(dataRoot, s, bodyFile, lines.join("\n") + "\n");
    return { slug, fragmentPath: segsToStr([...segs, YO_KEY, FRAGS_SUBKEY, slug]) };
  }
  const { bodyFile, within } = hostFor(dataRoot, s, segs);
  let imagePtr: string | null = null;
  if (f.imageBase64) {
    const bytes = Buffer.from(String(f.imageBase64).replace(/^data:[^,]*,/, ""), "base64");
    if (bytes.length > 0) {
      const { dir, scope } = sidecarTarget(dataRoot, mode, CROP_SUBDIR, bodyFile);
      mkdirInside(dataRoot, dir, { recursive: true });
      const cropName = `${slug}.png`;
      writeInside(dataRoot, dir, cropName, bytes);
      imagePtr = pointerToken(sidecarPointerRaw(CROP_SUBDIR, cropName, scope));
    }
  }
  mkdirInside(dataRoot, path.dirname(bodyFile), { recursive: true });
  const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
  writeBody(dataRoot, s, bodyFile, upsertFragment(src, within, slug, (indent) => fragmentBlockLines(slug, f.selector, imagePtr, indent)));
  return { slug, fragmentPath: segsToStr([...segs, YO_KEY, FRAGS_SUBKEY, slug]) };
}

// --- thumbnails: a per-type EXTRACTOR product, stored the yamlover way ------------------------ //
// A thumbnail is an omni overlay on the source blob, under `yamlover-thumbnails:`, keyed by the
// `[w, h]` resolution tuple — parallel to `yo: fragments:`. The bytes can't live inline
// (the serializer has no blob text form yet), so each is a content-addressed sidecar blob under
// `thumbnails/` that the entry references by `*` pointer — exactly the fragment-crop pattern. The
// content hash in the name gives free dedupe + invalidation (a re-saved source → a new name).

/** The overlay key for a thumbnail resolution: the literal `[w, h]` tuple the parser reads back as
 *  a key string (cosmetic brackets — we never address it by client path; the bytes serve from the
 *  sidecar, the source from /api/thumb). */
const thumbResKey = (w: number, h: number): string => `[${w}, ${h}]`;

/** The content-addressed sidecar name for a `[w, h]` thumbnail of a blob whose content hash is
 *  `hash` (`xxh64:…`). */
const thumbName = (hash: string, w: number, h: number): string => `${hash.replace(/:/g, "-")}-${w}x${h}.jpg`;

/** The already-generated sidecar for this source + box, or null when its hash is unknown (a large
 *  blob the background hasher has not reached) or the file is absent — the cheap, no-write fast
 *  path the /api/thumb handler tries before queuing a generation. */
function existingThumb(dataRoot: string, s: Store, mode: SidecarLocation, segs: Seg[], row: NodeRow, w: number, h: number): string | null {
  if (!row.content_hash) return null;
  const { bodyFile } = hostFor(dataRoot, s, segs);
  const { dir } = sidecarTarget(dataRoot, mode, THUMB_SUBDIR, bodyFile);
  const abs = path.join(dir, thumbName(row.content_hash, w, h));
  return fs.existsSync(abs) ? abs : null;
}

/** Splice/replace the `yamlover-thumbnails: [w, h]:` overlay entry on the source blob, pointing at
 *  the sidecar `name` under the mode-appropriate `.yo/thumbnails/`. */
function embedThumbnail(dataRoot: string, s: Store, mode: SidecarLocation, segs: Seg[], w: number, h: number, name: string, onWrite?: (absFile: string) => void): void {
  const { bodyFile, within } = hostFor(dataRoot, s, segs);
  const { scope } = sidecarTarget(dataRoot, mode, THUMB_SUBDIR, bodyFile);
  mkdirInside(dataRoot, path.dirname(bodyFile), { recursive: true });
  const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
  const ptr = pointerToken(sidecarPointerRaw(THUMB_SUBDIR, name, scope));
  const key = thumbResKey(w, h);
  writeBody(dataRoot, s, bodyFile, upsertThumbnail(src, within, key, (indent) => [`${" ".repeat(indent)}${key}: ${ptr}`]));
  onWrite?.(bodyFile);
}

/** Ensure a `[w, h]` thumbnail of the source blob at `segs` exists: return the sidecar path,
 *  generating (decode → fit → encode → write sidecar → embed overlay) on a miss. Null when no
 *  extractor can decode the format (the caller serves the type glyph). `hash` is the source's
 *  content hash, computed by the CALLER outside the writer queue — hashing is pure reading and
 *  must not hold queued writes behind a large file's I/O. `onWrite` is told each file this
 *  writes (sidecar + overlay embed) so the caller can suppress the watcher's echo. Idempotent —
 *  safe to call concurrently behind the writer queue; a second caller finds the file written. */
async function ensureThumbnail(dataRoot: string, s: Store, mode: SidecarLocation, segs: Seg[], row: NodeRow, w: number, h: number, hash: string, onWrite?: (absFile: string) => void): Promise<string | null> {
  const sourceAbs = path.join(dataRoot, ...segs.map(String));
  const name = thumbName(hash, w, h);
  const { bodyFile } = hostFor(dataRoot, s, segs);
  const { dir } = sidecarTarget(dataRoot, mode, THUMB_SUBDIR, bodyFile);
  const abs = path.join(dir, name);
  if (fs.existsSync(abs)) return abs;
  const thumb = await renderThumbnail(fs.readFileSync(sourceAbs), row.format ?? formatFromExt(sourceAbs), w, h);
  if (!thumb) return null;
  mkdirInside(dataRoot, dir, { recursive: true });
  writeInside(dataRoot, dir, name, thumb.buf);
  onWrite?.(abs);
  embedThumbnail(dataRoot, s, mode, segs, w, h, name, onWrite);
  return abs;
}

/** Remove a tag application from the target's `yamlover-annotations` array — the first element
 *  referencing `tag` (bare pointer or object `tag:` field). When the target is a FRAGMENT and that
 *  was its last tag, the now-empty fragment node is deleted whole (its selector + crop ref) — a
 *  fragment exists only to carry tags, so a tagless one is dead weight (docs/annotations). Sibling
 *  fragments and the host node are untouched. */
function unembedAnnotation(dataRoot: string, s: Store, target: string, tag: string, sel?: Record<string, unknown>): string {
  const segs = strToSegs(target || ":");
  // Match on the onto's colon-PATH, tolerating the bookmark's spelling (compact or spaced,
  // project or graft scope). Strip whitespace on BOTH sides before the substring test — a
  // spacey-named onto is a QUOTED key, and only the stripped forms compare equal.
  const needle = (":" + pointerRaw(tag).replace(/^:+/, "")).replace(/\s+/g, "");
  const pred = (line: string): boolean => {
    const t = line.replace(/\s+/g, "");
    return t.startsWith("&") && t.includes(needle) && /:-$/.test(t);
  };
  // An INLINE-token membership: drop the bookmark from the token's label; the last one gone
  // (and no fields, no link) unwraps the token — the prose returns byte-exact.
  if (sel && sel.type === "text" && isChunkTarget(s, segs)) {
    const ok = rewriteInlineFragment(dataRoot, s, segs, sel, (t) => {
      if (!t) return false;
      const kept = t.bookmarks.filter((b) => !pred(b));
      if (kept.length === t.bookmarks.length) return false; // no such membership inline — fall back
      if (kept.length === 0 && t.fields.length === 0 && t.link === null) return null; // unwrap
      return fragTokenText(kept, t.value, t.parens);
    });
    if (ok) return chapterSource(dataRoot, s, segs).bodyFile;
  }
  // A membership ON a chunk fragment: reach the chunk field-region + the fragment's body, drop
  // the bookmark, and — when that was its last — drop the emptied slug and collapse the chunk.
  if (isChunkTarget(s, segs)) {
    const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
    if (!fs.existsSync(bodyFile)) return bodyFile;
    const { indices, keys } = splitChunkWithin(segs.slice(docSegs.length));
    const lines = fs.readFileSync(bodyFile, "utf8").replace(/\n$/, "").split("\n");
    const fragRegion = () => reachBodyAt(lines, chunkFieldRegion(lines, indices, /*ensureOmni*/ false), keys);
    removeBookmarkAt(lines, fragRegion, pred);
    if (isFragmentSegs(keys as Seg[]) && !bookmarksRemainAt(lines, fragRegion())) {
      removeMapEntryAt(lines, reachBodyAt(lines, chunkFieldRegion(lines, indices, false), keys.slice(0, -2)), FRAGS_SUBKEY, keys[keys.length - 1]);
      pruneEmptyKeyAt(lines, chunkFieldRegion(lines, indices, false), YO_KEY); // the emptied `yo:` husk
      collapseChunkOmni(lines, indices); // no fields left → back to a plain `- |` chunk
    } else if (keys.length === 0 && !bookmarksRemainAt(lines, fragRegion())) {
      // the CHUNK's last whole-node membership: when the omni carries nothing else, collapse
      collapseChunkOmni(lines, indices);
    }
    writeBody(dataRoot, s, bodyFile, lines.join("\n") + "\n");
    return bodyFile;
  }
  const { bodyFile, within } = hostFor(dataRoot, s, segs);
  if (!fs.existsSync(bodyFile)) return bodyFile;
  let src = removeBookmark(fs.readFileSync(bodyFile, "utf8"), within, pred);
  // Host-key pruning applies only to an OVERLAY body (`.yo/body.yo` or `index.yo`) — its keys (a
  // filename spine) exist solely to host overlay entries. An in-place document's keys are the
  // user's data: a pre-existing empty mapping must not vanish because a membership passed through.
  const overlay = overlaidDir(bodyFile) !== null;
  // within = [...host, "yo", "fragments", "<slug>"] for a fragment target; drop it when emptied.
  if (isFragmentSegs(within as Seg[]) && !bookmarksRemain(src, within)) {
    src = removeMapEntry(src, within.slice(0, -2), FRAGS_SUBKEY, within[within.length - 1]);
    src = pruneEmptyYo(src, within.slice(0, -3)); // the emptied `yo:` husk
    src = pruneEmptyAnnotations(src, within.slice(0, -3), overlay); // the host may hold nothing else now
  } else {
    // a whole-node unfiling may empty an overlay host key (a filename spine) — prune it
    src = pruneEmptyAnnotations(src, within, overlay);
  }
  writeBody(dataRoot, s, bodyFile, src);
  return bodyFile;
}

/** Persist a NEW named tag as a key of the tag-taxonomy body at the project's default tags
 *  location (`settings.yo`; `/ontos` unless configured): that directory's instance overlay
 *  gains a `<name>: !!<*yamlover/$defs/onto>` entry. The would-be body is PARSED before
 *  committing, so a name the yamlover syntax cannot hold as a plain key (one that vanishes into
 *  a comment, say) is refused instead of corrupting the taxonomy. */
function writeOnto(
  dataRoot: string,
  s: Store,
  location: string,
  name: string,
): { node: IrNode; pos: number; file: string; createdFile: boolean } {
  if (/[/\\\r\n:]/.test(name)) throw new Error("a tag name cannot contain '/', '\\', ':' or line breaks");
  const root = path.resolve(dataRoot);
  const file = dirBodyFile(path.resolve(dataRoot, ...strToSegs(location).map(String)));
  if (!file.startsWith(root + path.sep)) throw new Error("tags location escapes the data root");
  const dir = path.dirname(file);
  const createdFile = !fs.existsSync(file);
  const head = "# Named tags created from the annotation picker (settings.yo: tags.location).\n";
  const existing = createdFile ? head : fs.readFileSync(file, "utf8");
  const body = (existing === "" || existing.endsWith("\n") ? existing : existing + "\n") + `${name}: !!<*::yamlover:$defs:onto>\n`;
  const entries = parseYamlover(body, file).root.entries ?? [];
  const pos = entries.findIndex((e) => e.key === name);
  const entry = pos >= 0 ? entries[pos] : undefined;
  if (!entry || isPointer(entry.value) || entry.value.meta?.schema === undefined) {
    throw new Error(`cannot write a tag named ${JSON.stringify(name)}`);
  }
  mkdirInside(dataRoot, dir, { recursive: true });
  writeBody(dataRoot, s, file, body);
  return { node: entry.value, pos, file: relPosix(dataRoot, file), createdFile };
}

// --------------------------------------------------------------------------- //
// Paste / upload — drop a clipboard file OR plain text into the tree. A file: a directory target
// takes it as a new child; a chapter target takes it into its owning directory and gains a `*…`
// pointer chunk. Text: a chapter target gains it as an inline chunk (no file); any other target
// gets a new chapter .yo file in the nearest directory, the text as its one chunk.
// --------------------------------------------------------------------------- //

interface PasteInput {
  path: string; // the page's node path (a directory or a chapter)
  filename?: string; // file mode: the source filename (sanitized + de-duplicated server-side)
  contentBase64?: string; // file mode: the file bytes, base64
  text?: string; // text mode: the clipboard's plain text
  rich?: unknown; // rich mode: an HTML selection as a chapter tree (see parseRich) — text +
  // inline-file chunks, heading-nested children; the modes are mutually exclusive
  inline?: boolean; // file mode, onto a chapter: write the file and DO NOT append a chunk — the
  // caller is placing its own reference to it (an embed token inside a prose chunk it is editing)
}

/** Whether a paste at `segs` lands INSIDE a chapter: the node itself is chapter/task-formatted
 *  (a page root, or a dir-backed subchapter — those carry the format), or it is a CONTAINER
 *  nested in a chapter-formatted document (an INLINE subchapter, `:doc[2]` — untagged, so its
 *  own row has no format; the enclosing document root decides). A drop onto an inlined
 *  subchapter section targets that subchapter's path (NodeView), so both nested shapes must
 *  route into-chapter rather than to `nearestDirSegs`. */
function pasteTargetIsChapter(s: Store, segs: Seg[], row: NodeRow): boolean {
  const chapterFmt = (f: string | null | undefined) => f === "x-yamlover-chapter" || f === "x-yamlover-task";
  if (chapterFmt(row.format)) return true;
  if (row.type !== "mapping") return false; // a scalar/blob chunk is never a chapter body
  const docSegs = documentRootSegs(s, segs);
  if (docSegs.length === segs.length) return false; // the document root itself — its format decided
  return chapterFmt(s.node(storePath(docSegs))?.format);
}

/** Handle a paste/upload onto the node at `input.path`. Returns the new file's node path and,
 *  for a chapter, the chapter path + the chunk pointer appended to it. */
function handlePaste(dataRoot: string, s: Store, input: PasteInput): Record<string, unknown> {
  const segs = strToSegs(input.path || ":");
  const row = s.node(storePath(segs));
  if (!row) throw new Error(`no such node: ${input.path}`);
  const intoChapter = pasteTargetIsChapter(s, segs, row);

  if (input.rich != null) {
    const rich = parseRich(input.rich);
    if (intoChapter) return pasteRichIntoChapter(dataRoot, s, segs, rich);
    return pasteRichAsChapter(dataRoot, segs, rich);
  }

  if (typeof input.text === "string") {
    const text = input.text.replace(/\r\n?/g, "\n");
    if (text.trim().length === 0) throw new Error("empty paste (no text)");
    if (intoChapter) return pasteTextIntoChapter(dataRoot, s, segs, text);
    return pasteTextAsChapterFile(dataRoot, segs, text);
  }

  const bytes = Buffer.from(input.contentBase64 || "", "base64");
  if (bytes.length === 0) throw new Error("empty paste (no file bytes)");
  const name = sanitizeName(input.filename ?? "");

  // A chapter gains the file as a pointer chunk appended to its body — UNLESS the caller asked for
  // an `inline` paste, in which case the file merely lands beside the chapter and the caller writes
  // its own reference (a marklower link, mid-prose). Appending a chunk there would leave the
  // picture on the page twice: once in the sentence, once at the end.
  if (intoChapter && !input.inline) return pasteIntoChapter(dataRoot, s, segs, name, bytes);

  // a directory page, or a MEMBER of one (any non-chapter node): the file lands in the nearest
  // enclosing directory. `open` marks the member case — the page is not the directory, so the
  // client opens the new file (on a directory page it just refreshes in place).
  const dirSegs = nearestDirSegs(dataRoot, segs);
  if (!dirSegs) throw new Error("no enclosing directory to paste into");
  const dir = path.resolve(dataRoot, ...dirSegs.map(String));
  const final = uniqueName(dir, name);
  writeInside(dataRoot, dir, final, bytes);
  // `open` never fires for an inline paste: the caller is mid-edit on this page and is about to
  // reference the new file in place — navigating to it would throw the edit away.
  return { path: segsToStr([...dirSegs, final]), dir: segsToStr(dirSegs), open: !input.inline && dirSegs.length !== segs.length };
}

/** The nearest enclosing filesystem directory at or above `segs` (the node itself when it is a
 *  directory, else its closest ancestor that is one), as segments; null if none under the root. */
function nearestDirSegs(dataRoot: string, segs: Seg[]): Seg[] | null {
  for (let i = segs.length; i >= 0; i--) {
    const sub = segs.slice(0, i);
    const abs = path.resolve(dataRoot, ...sub.map(String));
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return sub;
  }
  return null;
}

// The block-structured YAML family the surgical splice engine can edit: a standalone `.yo`
// (chapters, and the general editor's native format) or — for the general value editor — a plain
// `.yaml`/`.yml`, whose block grammar (keyed `k:` fields, `- ` items, indentation, `|` blocks) is
// exactly what the engine walks. JSON-family files (flow syntax) are edited on a separate path.
const YAMLOVER_ONLY = /\.(yo|yamlover)$/i; // `.yamlover` is the legacy spelling, read-only compat
const BLOCK_YAML = /\.(ya?ml|yo|yamlover)$/i;
const JSON_FILE = /\.(json|json5|json5p)$/i;

/** The file backing the document at `segs` — directory-backed (its instance overlay) or a
 *  standalone file — plus its document root. No extension gate: callers decide which editor (block
 *  YAML vs JSON surgery) the file's extension routes to. */
function resolveBacking(dataRoot: string, s: Store, segs: Seg[]): { docSegs: Seg[]; bodyFile: string; dirBacked: boolean } {
  const docSegs = documentRootSegs(s, segs);
  const docFs = path.resolve(dataRoot, ...docSegs.map(String));
  const dirBacked = fs.existsSync(docFs) && fs.statSync(docFs).isDirectory();
  const bodyFile = dirBacked ? dirBodyFile(docFs) : docFs;
  return { docSegs, bodyFile, dirBacked };
}

/** The block-YAML source holding the node at `segs`, validated by extension. `allow` restricts the
 *  STANDALONE file: `.yo` only for chapter/paste/annotate flows (the default), widened to
 *  `.yaml`/`.yml` by the general value editor. A directory-backed document is always a `.yo`
 *  overlay. Throws for a JSON-family or otherwise unsupported file. */
function chapterSource(dataRoot: string, s: Store, segs: Seg[], allow: RegExp = YAMLOVER_ONLY): { docSegs: Seg[]; bodyFile: string; dirBacked: boolean } {
  const r = resolveBacking(dataRoot, s, segs);
  const okExt = r.dirBacked ? r.bodyFile.endsWith(".yo") : allow.test(r.bodyFile);
  if (!okExt || !fs.existsSync(r.bodyFile)) {
    throw new Error("unsupported edit source (need a .yo / .yaml / .yml body)");
  }
  return r;
}

/** Colon-form pointer raws (docs/language/pointers/paths — the slash separator is DEAD; the server never
 *  authors it). A document member: `*: name` (spacey/metachar names portion-quoted). */
function memberPointer(name: string): string {
  return "*" + renderPointer({ kind: "pointer", base: { scope: "document" }, steps: [{ sel: "key", name }], raw: "" });
}

/** A project-rooted pointer `*:: dir: file` — the first segment is the `::` authority portion. */
function projectPointer(segs: Seg[]): string {
  const steps = segs.map((s): IrStep =>
    s === null ? { sel: "nullkey" } : typeof s === "number" ? { sel: "index", n: s } : { sel: "key", name: s },
  );
  const head = steps[0];
  if (head === undefined || head.sel !== "key") throw new Error("a project pointer needs a leading key");
  return "*" + renderPointer({ kind: "pointer", base: { scope: "link", authority: head.name }, steps: steps.slice(1), raw: "" });
}

/** The member NAME a positional body entry points at (`- *: name`), or null when the entry is
 *  not a single-key document-scope pointer — the inverse of {@link memberPointer}. */
function memberNameOfEntry(lines: string[], e: ChapterEntry): string | null {
  if (e.key !== null) return null;
  const head = entryHead(lines, e);
  if (!head.startsWith("*")) return null;
  try {
    const p = parsePointer(head.slice(1));
    if (p.base.scope === "document" && p.steps.length === 1 && p.steps[0].sel === "key") return p.steps[0].name;
  } catch {
    /* not a pointer token — not a member reference */
  }
  return null;
}

/** The body pointer-array NEIGHBOR member names around an insert at `index` within the region
 *  `within` addresses (undefined index = append): the nearest member pointer strictly BEFORE the
 *  position and the nearest AT/AFTER it — what {@link nextMemberName} slots a between-number
 *  from. Best-effort: a missing/unreadable body (or a body whose splice is still queued in the
 *  current batch) yields open ends, and the generated name simply appends past the on-disk max. */
function memberNeighbors(bodyFile: string, within: Seg[], index: number | undefined): { prevName?: string; nextName?: string } {
  let lines: string[];
  try {
    lines = fs.readFileSync(bodyFile, "utf8").split(/\r?\n/);
  } catch {
    return {};
  }
  let entries: ChapterEntry[];
  try {
    entries = chapterEntries(lines, reachChapter(lines, within));
  } catch {
    return {};
  }
  const at = index === undefined ? entries.length : index;
  const out: { prevName?: string; nextName?: string } = {};
  for (let i = Math.min(at, entries.length) - 1; i >= 0; i--) {
    const n = memberNameOfEntry(lines, entries[i]);
    if (n) { out.prevName = n; break; }
  }
  for (let i = at; i < entries.length; i++) {
    const n = memberNameOfEntry(lines, entries[i]);
    if (n) { out.nextName = n; break; }
  }
  return out;
}

/** A chapter paste: write the file into the chapter's owning directory, then append a pointer to
 *  it as the chapter's last chunk (editing the .yo source). */
function pasteIntoChapter(dataRoot: string, s: Store, segs: Seg[], name: string, bytes: Buffer): Record<string, unknown> {
  const { docSegs, bodyFile, dirBacked } = chapterSource(dataRoot, s, segs);
  // the file lands in the doc-root dir (directory-backed) or beside the standalone chapter file.
  const writeDirSegs = dirBacked ? docSegs : docSegs.slice(0, -1);
  const writeDir = path.resolve(dataRoot, ...writeDirSegs.map(String));
  const final = uniqueName(writeDir, name);
  writeInside(dataRoot, writeDir, final, bytes);

  // The chunk pointer: document-scoped (`*: file`) when the file sits inside the chapter's own
  // document (directory-backed); else a project-root link (`*:: dir: file`) reaching the sibling.
  const fileSegs = [...writeDirSegs, final];
  const pointer = dirBacked ? memberPointer(final) : projectPointer(fileSegs);
  // The chapter's location WITHIN its document — absolute body-item indices (empty = top-level).
  const within = segs.slice(docSegs.length);
  const src = fs.readFileSync(bodyFile, "utf8");
  writeBody(dataRoot, s, bodyFile, appendBody(src, within, (indent) => [`${" ".repeat(indent)}- ${pointer}`]));
  return { path: segsToStr(fileSegs), chapter: segsToStr(segs), pointer };
}

/** A text paste onto a chapter: the text itself becomes the chapter's last chunk — no file is
 *  written, only the .yo source gains an item. */
function pasteTextIntoChapter(dataRoot: string, s: Store, segs: Seg[], text: string): Record<string, unknown> {
  const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
  const within = segs.slice(docSegs.length);
  const src = fs.readFileSync(bodyFile, "utf8");
  writeBody(dataRoot, s, bodyFile, appendBody(src, within, (indent) => textChunkLines(text, indent)));
  return { path: segsToStr(segs), chapter: segsToStr(segs) };
}

/** A text paste onto anything that is NOT a chapter: a new chapter .yo file lands in the
 *  nearest enclosing directory — title from the text's first line, the text as its one chunk. */
function pasteTextAsChapterFile(dataRoot: string, segs: Seg[], text: string): Record<string, unknown> {
  const dirSegs = nearestDirSegs(dataRoot, segs);
  if (!dirSegs) throw new Error("no enclosing directory to paste into");
  const dir = path.resolve(dataRoot, ...dirSegs.map(String));
  const title = titleFromText(text);
  const final = uniqueName(dir, chapterFileName(title));
  const src = ["!!<*::yamlover:$defs:chapter>", JSON.stringify(title), ...textChunkLines(text, 0), ""].join("\n");
  writeInside(dataRoot, dir, final, Buffer.from(src, "utf8"));
  return { path: segsToStr([...dirSegs, final]), dir: segsToStr(dirSegs), open: dirSegs.length !== segs.length };
}

// --- rich paste: an HTML selection as a chapter tree (text + image chunks, subchapters) ----- //

type RichItem = { text: string } | { name: string; bytes: Buffer };
interface Rich {
  title: string | null;
  chunks: RichItem[];
  children: Array<Rich & { title: string }>;
}

/** Validate + normalize the wire `rich` payload: chunks are {text} or {file:{name,
 *  contentBase64}}, children recurse (each titled). Whitespace-only texts are dropped. */
function parseRich(raw: unknown, depth = 0): Rich {
  if (depth > 8) throw new Error("rich paste: nesting too deep");
  const r = (raw ?? {}) as { title?: unknown; chunks?: unknown; children?: unknown };
  const chunks: RichItem[] = [];
  for (const c of Array.isArray(r.chunks) ? (r.chunks as Array<Record<string, unknown>>) : []) {
    if (typeof c?.text === "string") {
      if (c.text.trim()) chunks.push({ text: c.text.replace(/\r\n?/g, "\n") });
      continue;
    }
    const f = c?.file as { name?: unknown; contentBase64?: unknown } | undefined;
    if (f && typeof f.name === "string") {
      const bytes = Buffer.from(String(f.contentBase64 ?? ""), "base64");
      if (bytes.length === 0) throw new Error("rich paste: empty file chunk");
      chunks.push({ name: sanitizeName(f.name), bytes });
      continue;
    }
    throw new Error("rich paste: a chunk must be {text} or {file}");
  }
  const children = (Array.isArray(r.children) ? r.children : []).map((k) => {
    const sub = parseRich(k, depth + 1);
    const title = typeof (k as { title?: unknown })?.title === "string" ? String((k as { title: string }).title).trim() : "";
    return { ...sub, title: title || "Untitled" };
  });
  if (depth === 0 && chunks.length === 0 && children.length === 0) throw new Error("empty rich paste");
  return { title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : null, chunks, children };
}

/** One chunk item's source lines: a text becomes a block scalar, a file is written through
 *  `pointerFor` (which yields its `*…` pointer). */
function richItemLines(item: RichItem, indent: number, pointerFor: (name: string, bytes: Buffer) => string): string[] {
  if ("text" in item) return textChunkLines(item.text, indent);
  return [`${" ".repeat(indent)}- ${pointerFor(item.name, item.bytes)}`];
}

/** A subchapter as a positional body item: `- "Title"` (the title is the omni node's scalar
 *  SELF-VALUE — no `title:` key) then its OWN body (chunks + recursive subchapters) as positional
 *  items 2 deeper — the fully-omni chapter shape (docs/documents/chapter). */
function richChildLines(node: Rich & { title: string }, indent: number, pointerFor: (name: string, bytes: Buffer) => string): string[] {
  const pad = " ".repeat(indent);
  const lines = [`${pad}- ${JSON.stringify(node.title)}`];
  for (const c of node.chunks) lines.push(...richItemLines(c, indent + 2, pointerFor));
  for (const k of node.children) lines.push(...richChildLines(k, indent + 2, pointerFor));
  return lines;
}

/** The positional body items of a rich node — its chunks (text + pointers) then its subchapters. */
function richBodyLines(rich: Rich, indent: number, pointerFor: (name: string, bytes: Buffer) => string): string[] {
  return [
    ...rich.chunks.flatMap((c) => richItemLines(c, indent, pointerFor)),
    ...rich.children.flatMap((k) => richChildLines(k, indent, pointerFor)),
  ];
}

/** A rich paste onto a chapter: files land in the chapter's owning directory, and the chunks
 *  (text + pointers, order kept) then the subchapters append to the chapter's positional body. */
function pasteRichIntoChapter(dataRoot: string, s: Store, segs: Seg[], rich: Rich): Record<string, unknown> {
  const { docSegs, bodyFile, dirBacked } = chapterSource(dataRoot, s, segs);
  const writeDirSegs = dirBacked ? docSegs : docSegs.slice(0, -1);
  const writeDir = path.resolve(dataRoot, ...writeDirSegs.map(String));
  const files: string[] = [];
  const pointerFor = (name: string, bytes: Buffer): string => {
    const final = uniqueName(writeDir, name);
    writeInside(dataRoot, writeDir, final, bytes);
    files.push(segsToStr([...writeDirSegs, final]));
    return dirBacked ? memberPointer(final) : projectPointer([...writeDirSegs, final]);
  };
  const within = segs.slice(docSegs.length);
  let src = fs.readFileSync(bodyFile, "utf8");
  if (rich.chunks.length || rich.children.length) src = appendBody(src, within, (ind) => richBodyLines(rich, ind, pointerFor));
  writeBody(dataRoot, s, bodyFile, src);
  return { path: segsToStr(segs), chapter: segsToStr(segs), files };
}

/** A rich paste onto anything that is NOT a chapter: a new chapter in the nearest enclosing
 *  directory — DIRECTORY-BACKED when it carries files (the images live inside it), else a
 *  standalone .yo file. A selection that STARTS with its own heading IS the chapter:
 *  the sole top child is promoted to the root (its title names the chapter). */
function pasteRichAsChapter(dataRoot: string, segs: Seg[], rich: Rich): Record<string, unknown> {
  const dirSegs = nearestDirSegs(dataRoot, segs);
  if (!dirSegs) throw new Error("no enclosing directory to paste into");
  const dir = path.resolve(dataRoot, ...dirSegs.map(String));
  if (!rich.title && rich.chunks.length === 0 && rich.children.length === 1) rich = rich.children[0];
  const firstText = rich.chunks.find((c): c is { text: string } => "text" in c);
  const title = rich.title ?? (firstText ? titleFromText(firstText.text) : rich.children[0]?.title ?? "Pasted content");

  if (!richHasFiles(rich)) {
    const final = uniqueName(dir, chapterFileName(title));
    const src = renderChapterSource(title, rich, () => {
      throw new Error("unreachable: no files");
    });
    writeInside(dataRoot, dir, final, Buffer.from(src, "utf8"));
    return { path: segsToStr([...dirSegs, final]), dir: segsToStr(dirSegs), open: dirSegs.length !== segs.length };
  }

  // directory-backed: the chapter's own overlay (in the enclosing directory's flavor) + the
  // image files inside <name>/
  const name = uniqueName(dir, chapterFileName(title).replace(/\.yo$/, ""));
  const chDir = path.join(dir, name);
  if (!path.resolve(chDir).startsWith(path.resolve(dataRoot) + path.sep)) throw new Error("target escapes the data root");
  const overlay = overlaySegs(memberFlavor(dir));
  const overlayDir = path.join(chDir, ...overlay.slice(0, -1));
  mkdirInside(dataRoot, overlayDir, { recursive: true });
  const pointerFor = (fname: string, bytes: Buffer): string => {
    const final = uniqueName(chDir, fname);
    writeInside(dataRoot, chDir, final, bytes);
    return memberPointer(final);
  };
  const src = renderChapterSource(title, rich, pointerFor);
  writeInside(dataRoot, overlayDir, overlay[overlay.length - 1], Buffer.from(src, "utf8"));
  return { path: segsToStr([...dirSegs, name]), dir: segsToStr(dirSegs), open: dirSegs.length !== segs.length };
}

/** The whole .yo source of a new rich chapter: the tag, the title as the root's scalar
 *  SELF-VALUE line (docs/documents/chapter — no `title:` key), and the positional body. */
function renderChapterSource(title: string, rich: Rich, pointerFor: (name: string, bytes: Buffer) => string): string {
  const lines = ["!!<*::yamlover:$defs:chapter>", JSON.stringify(title), ...richBodyLines(rich, 0, pointerFor)];
  return lines.join("\n") + "\n";
}

function richHasFiles(rich: Rich): boolean {
  return rich.chunks.some((c) => "bytes" in c) || rich.children.some(richHasFiles);
}

/** A title for a pasted-text chapter: the first content line, sans any markdown heading
 *  marker, clipped to 80 chars. */
function titleFromText(text: string): string {
  const first = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const t = first.replace(/^#{1,6}\s+/, "").trim();
  return (t.length > 80 ? t.slice(0, 79).trimEnd() + "…" : t) || "Pasted text";
}

/** The store path of a chapter's LAST positional (keyless) body element — the child just appended.
 *  Falls back to `[0]` when none is found yet (fresh index). */
function lastBodyChildPath(s: Store, parentSegs: Seg[]): string {
  const positional = s.entries(storePath(parentSegs)).filter((e) => e.kind === "contain" && e.label == null);
  const last = positional[positional.length - 1];
  return last ? segsToStr(storePathToSegs(last.to)) : segsToStr([...parentSegs, 0]);
}

/** The base name (no extension) for a new object file/dir, from its title. Unicode-tolerant: a
 *  directory MEMBER is reached by its own name, not by a `*` pointer, so it may keep its letters. */
function objectBaseName(title: string): string {
  const base = title.replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim().replace(/^\.+/, "");
  return base || "new";
}

/** Write a new object document into `dir` in the given concrete — a `<base>.yo` file, or a
 *  `<base>/` directory holding the overlay its flavor names (`.yo/body.yo` for a `dir/.yo`,
 *  `index.yo` for a `dir/index.yo`). `base` is the name WITHOUT extension (caller decides
 *  unicode-vs-pointer-safe). Returns the file/dir NAME actually created (unique). */
function writeObject(dataRoot: string, dir: string, base: string, concrete: string, src: string): string {
  if (isOverlayDirConcrete(concrete)) {
    const final = uniqueName(dir, base);
    const segs = overlaySegs(concrete);
    const overlayDir = path.join(dir, final, ...segs.slice(0, -1));
    mkdirInside(dataRoot, overlayDir, { recursive: true });
    writeInside(dataRoot, overlayDir, segs[segs.length - 1], Buffer.from(src, "utf8"));
    return final;
  }
  const final = uniqueName(dir, base + ".yo");
  writeInside(dataRoot, dir, final, Buffer.from(src, "utf8"));
  return final;
}

/** Materialize a directory's instance overlay (empty) when absent — the moment a directory gains
 *  BODY-encoded content (concrete-rules.ts). A directory that carries none is born a `dir/.yo`,
 *  the default flavor; one already carrying an `index.yo` keeps it. Returns the body file path. */
function ensureDirBody(dataRoot: string, absDir: string): string {
  const body = dirBodyFile(absDir);
  if (!fs.existsSync(body)) {
    const overlayDir = path.dirname(body);
    mkdirInside(dataRoot, overlayDir, { recursive: true });
    writeInside(dataRoot, overlayDir, path.basename(body), Buffer.from("", "utf8"));
  }
  return body;
}

/** The key and column-0 VALUE source of a keyed payload group (`key: inline` + continuation lines
 *  one step deeper), or null when the head does not parse as a keyed line. */
function keyedGroupParts(group: string[]): { key: string; src: string } | null {
  const head = group[0];
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:\s*(.*)$/.exec(head) ?? /^([^:]+?)\s*:\s*(.*)$/.exec(head);
  if (!m) return null;
  let key: string;
  try {
    key = m[1].startsWith('"') ? (JSON.parse(m[1]) as string) : m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1];
  } catch {
    return null;
  }
  const cont = group.slice(1).map((l) => (l.startsWith("  ") ? l.slice(2) : l));
  const src = [...(m[2] ? [m[2]] : []), ...cont].join("\n").replace(/\n+$/, "");
  return { key, src };
}

/** Write a keyed CONTAINER member of a directory as a NESTED real directory (concrete-rules.ts).
 *  The key IS the directory name (must be filename-safe; an existing child is a conflict — no
 *  uniqueName renaming, the key names the node). The member's scalar self-value, ordinal entries
 *  and keyed SCALAR children land in its own instance overlay, born in the PARENT's flavor
 *  (concrete-rules' inheritance); each keyed CONTAINER child recurses into a deeper directory.
 *  A member with no body-bound content stays a bare directory — a pure nested-object shell. */
function writeDirMemberTree(
  dataRoot: string,
  absDir: string,
  key: string,
  valueSrc: string,
  meta?: string | null,
  // the whole subtree is born in ONE flavor — a deeper member is created before its parent's
  // overlay lands, so re-deriving it from disk at each level would read an empty directory
  flavor: "dir/.yo" | "dir/index.yo" = memberFlavor(absDir),
): void {
  const name = String(key);
  if (!name || name === INDEX_FILE || name !== name.trim() || name.startsWith(".") || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw new Error(`\`${name}\` cannot name a directory member`);
  }
  const dir = path.join(absDir, name);
  if (fs.existsSync(dir)) throw new Error(`member \`${name}\` already exists in the directory`);
  mkdirInside(dataRoot, dir);
  const f = payloadFacets(valueSrc);
  const groups = orderedGroups(f);
  const kinds: ("k" | "o")[] =
    f.order && groups.length === f.order.length ? f.order : [...f.keyed.map(() => "k" as const), ...f.ordinal.map(() => "o" as const)];
  const bodyLines: string[] = [];
  const tag = metaTag(meta, undefined, false);
  if (tag) bodyLines.push(tag);
  const selfAt = f.scalar !== undefined ? Math.min(f.selfAt ?? 0, groups.length) : -1;
  let emittedSelf = false;
  const emitSelf = (): void => {
    if (f.scalar !== undefined) bodyLines.push(...f.scalar.split("\n"));
    emittedSelf = true;
  };
  groups.forEach((g, i) => {
    if (i === selfAt) emitSelf();
    const parts = kinds[i] === "k" ? keyedGroupParts(g) : null;
    if (parts) {
      const cf = payloadFacets(parts.src);
      if (deriveMemberEncoding({ keyed: true, container: cf.keyed.length > 0 || cf.ordinal.length > 0 }) === "dir") {
        writeDirMemberTree(dataRoot, dir, parts.key, parts.src, undefined, flavor);
        return;
      }
    }
    bodyLines.push(...g);
  });
  if (selfAt >= 0 && !emittedSelf) emitSelf();
  if (bodyLines.length) {
    const segs = overlaySegs(flavor);
    const overlayDir = path.join(dir, ...segs.slice(0, -1));
    mkdirInside(dataRoot, overlayDir, { recursive: true });
    writeInside(dataRoot, overlayDir, segs[segs.length - 1], Buffer.from(bodyLines.join("\n").replace(/\n*$/, "") + "\n", "utf8"));
  }
}

/** A filename for a new chapter file, from its title: unicode letters/digits/space/dot/dash kept
 *  (non-ASCII names are first-class — see uniqueName for collisions), never hidden. */
function chapterFileName(title: string): string {
  const base = title.replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim().replace(/^\.+/, "");
  return `${base || "pasted"}.yo`;
}

/** A safe filename: basename only, restricted charset, never hidden; defaults when empty. */
function sanitizeName(raw: string): string {
  const base = path.basename(String(raw || "")).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return base || "pasted";
}

/** `name`, or `name-1`/`name-2`/… if it already exists in `dir` (extension kept). */
function uniqueName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, cand))) return cand;
  }
}

/** A root-relative POSIX path — the spelling validate.ts and the index both speak. */
function relPosix(dataRoot: string, abs: string): string {
  return path.relative(dataRoot, abs).split(path.sep).join("/");
}

/** The served tree as validate.ts sees it: one {@link ConcreteNode} per filesystem object, with
 *  the same concrete derivation {@link concreteOf} uses for its FS branch. Git-ignored strays are
 *  skipped (the walk skips them too, so they are not this format's business), but NOTHING else is
 *  — including the hidden overlays, which is the point. */
function scanTree(dataRoot: string, ignore?: (absPath: string) => boolean): TreeSnapshot {
  const nodes: ConcreteNode[] = [];
  const visit = (abs: string, segs: string[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable: not a format violation
    }
    const names = entries.map((d) => d.name);
    nodes.push({
      path: segsToStr(segs),
      concrete: dirConcreteFor(names, fs.existsSync(path.join(abs, OVERLAY_DIR, BODY_FILE))),
      fsPath: segs.join("/"),
      names,
    });
    for (const d of entries) {
      const childAbs = path.join(abs, d.name);
      if (ignore?.(childAbs)) continue;
      // `.yo` is the ONE hidden name this format owns — and the one that must be descended
      // into, since a nested overlay is what we are hunting. Every other dot-name (`.git`, an
      // editor's droppings) is outside the data tree: the walk skips it, so the doctor does too.
      if (d.name.startsWith(".") && d.name !== ".yo") continue;
      const childSegs = [...segs, d.name];
      if (d.isDirectory()) visit(childAbs, childSegs);
      // a file's concrete comes from its extension alone; `null` (a material, a blob, an
      // extensionless file) is honest — the sweep does not guess where the index would know.
      else if (d.isFile()) nodes.push({ path: segsToStr(childSegs), concrete: dataFileConcrete(childAbs), fsPath: childSegs.join("/") });
    }
  };
  visit(path.resolve(dataRoot), []);
  return { nodes };
}

/** Where NON-fatal validation diagnostics (warnings, and everything in `report` mode) go. The
 *  write chokepoints are module-level and hold no Options, so `createHandlers` wires its `log`
 *  here — the same module-level-setter shape as yamlover.ts's `setIgnoreFilter`. */
let validationLog: (line: string) => void = () => {};
export function setValidationLog(fn: (line: string) => void): void {
  validationLog = fn;
}

/** Report the diagnostics a verdict did not abort on. */
function logDiagnostics(found: Diagnostic[]): void {
  for (const x of found) validationLog(`validate ${x.severity}: ${x.code} at ${x.path ?? x.fsPath ?? "?"} — ${x.message}`);
}

/** Read-only's second line of defense: {@link writeInside} refuses outright when set. The HTTP
 *  allowlist is the first line; this catches the gap it cannot see — a future GET route that
 *  writes (the way `/api/thumb` does). Same module-level-setter shape (and same last-created-
 *  handler-wins caveat) as {@link setValidationLog}. `mkdirInside` stays ungated: the index's
 *  own `.yo/` directory is permitted housekeeping. */
let readOnlyWrites = false;
export function setReadOnlyWrites(v: boolean): void {
  readOnlyWrites = v;
}

/** How a validation verdict is acted on here: dev/test THROWS (so corruption turns the suite red
 *  before it can reach a user's tree), production REFUSES the write and reports. `YAMLOVER_VALIDATE`
 *  overrides. A per-project `validate:` in settings.yo is the natural next override, but the
 *  byte/mkdir chokepoints below are module-level and hold no Settings — it would have to be threaded. */
function validationMode(): EnforcementMode {
  return defaultMode({ dev: process.env.NODE_ENV !== "production" || !!process.env.VITEST, setting: process.env.YAMLOVER_VALIDATE });
}

/** THE PATH GATE — every byte and every directory this server creates passes through here.
 *  It re-asks validate.ts for the format's path invariants (no overlay inside an overlay, no
 *  stray name in a `.yo/`, no root escape, no hidden/padded/metachar member name), so a
 *  write that would corrupt the tree is refused before it can reach the disk. */
function guardPath(dataRoot: string, abs: string): void {
  logDiagnostics(enforce(validatePath(relPosix(dataRoot, abs)), validationMode()));
}

/** Write `bytes` to `dir/name`, refusing any path that escapes the served root or violates the
 *  format's layout invariants. */
function writeInside(dataRoot: string, dir: string, name: string, bytes: Buffer): void {
  if (readOnlyWrites) throw new Error("refused: server is read-only");
  const root = path.resolve(dataRoot);
  const target = path.resolve(dir, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("target escapes the data root");
  guardPath(dataRoot, target);
  fs.writeFileSync(target, bytes);
}

/** The store rows that could OWN `rel` as their serialized SOURCE: the file's own node (a
 *  standalone document), and — when `rel` is an overlay or a consumed `index.yo` — the
 *  directory it speaks for. */
function sourceOwnerSegs(rel: string): Seg[][] {
  const segs: Seg[] = rel.split("/");
  const n = segs.length;
  const out: Seg[][] = [segs];
  if (n >= 2 && segs[n - 2] === OVERLAY_DIR && (segs[n - 1] === BODY_FILE || segs[n - 1] === "meta.yo")) out.push(segs.slice(0, -2));
  if (segs[n - 1] === INDEX_FILE) out.push(segs.slice(0, -1));
  return out;
}

/** THE DEGRADATION GATE — every mediated rewrite of an EXISTING document source (a body splice,
 *  an overlay append, a JSON scalar edit) leaves through here. A source the walk could not parse
 *  is served DEGRADED (walk.ts: a raw-text scalar / the plain filesystem mapping, marked
 *  `meta.parseError`); re-serializing it would overwrite the user's original text with the
 *  degraded projection, so the write is refused until the file is fixed on disk. Keyed by the
 *  FILE the stamp names, so a degraded directory's intact children (their own files) still edit
 *  freely. `/api/mv` and the fs-rekey branch stay outside: they rename storage and rewrite
 *  INDEXED inbound pointers, and a degraded file contributed none — its bytes are never
 *  rewritten. Funnels into {@link writeInside}, closing the read-only and path-invariant gaps
 *  these rewrites used to slip past via a raw writeFileSync. */
function writeBody(dataRoot: string, s: Store, bodyFile: string, src: string): void {
  const rel = relPosix(dataRoot, bodyFile);
  for (const owner of sourceOwnerSegs(rel)) {
    const pe = s.node(storePath(owner))?.meta?.parseError as { file?: string; message?: string } | undefined;
    if (pe && pe.file === rel) {
      throw new Error(`cannot edit ${segsToStr(owner)}: its source failed to parse and is shown degraded (${rel}: ${pe.message ?? "syntax error"}) — fix the file on disk first`);
    }
  }
  writeInside(dataRoot, path.dirname(bodyFile), path.basename(bodyFile), Buffer.from(src, "utf8"));
}

/** {@link fs.mkdirSync} behind the same gate as {@link writeInside}. Directory creation is the
 *  OTHER way an object is born — the one that used to bypass every check, which is how a
 *  `.yo` came to sit inside a `.yo`. Every mkdir in this module goes through here. */
function mkdirInside(dataRoot: string, abs: string, opts?: { recursive?: boolean }): void {
  guardPath(dataRoot, abs);
  fs.mkdirSync(abs, opts);
}

// The bundled LLM-agent guidance docs (AGENTS.md + CLAUDE.md), shipped beside this module as real
// .md files — `src/server/agent-docs` when the dev server loads this source via Vite, and
// `dist/agent-docs` in the prod bundle (scripts/build.mjs copies them there; same dual-path trick
// as the codec wasm in extract/wasm.ts, since import.meta.url points at the live module either way).
const AGENT_DOCS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-docs");

/** Read the bundled agent docs, alphabetically (AGENTS.md before CLAUDE.md). Throws a clear error
 *  if the resources are missing (a broken build). POST /api/agent-docs writes these into the root. */
function loadAgentDocs(): { name: string; content: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(AGENT_DOCS_DIR).filter((f) => f.endsWith(".md")).sort();
  } catch {
    throw new Error(`agent-docs resources not found at ${AGENT_DOCS_DIR}`);
  }
  if (names.length === 0) throw new Error(`no agent-docs resources at ${AGENT_DOCS_DIR}`);
  return names.map((name) => ({ name, content: fs.readFileSync(path.join(AGENT_DOCS_DIR, name), "utf8") }));
}

// Stable fence around the bundled guidance inside a project's AGENTS.md / CLAUDE.md. A human may
// keep their own project rules in the same file; we own only the block between these markers, so a
// reinstall can UPDATE it in place (or append it once) without ever clobbering the human's text.
const DOC_BEGIN = "<!-- BEGIN yamlover agent guide (auto-managed by `npx yamlover` — regenerated on reinstall) -->";
const DOC_END = "<!-- END yamlover agent guide -->";

export type AgentDocStatus = "created" | "appended" | "updated" | "exists";

/** Merge one bundled agent doc into a file's current text (`null` when the file is absent),
 *  fenced by {@link DOC_BEGIN}/{@link DOC_END}:
 *   - missing file        → the fenced block alone            (`created`)
 *   - no fence yet         → block appended after the human's content (`appended`)
 *   - fence present, stale → block replaced in place          (`updated`)
 *   - fence present, same  → text untouched                   (`exists`)
 *  Idempotent: reinstalling an up-to-date file is a no-op. */
export function mergeAgentDoc(existing: string | null, content: string): { text: string; status: AgentDocStatus } {
  const block = `${DOC_BEGIN}\n${content.trimEnd()}\n${DOC_END}\n`;
  if (existing === null) return { text: block, status: "created" };
  const b = existing.indexOf(DOC_BEGIN);
  if (b === -1) {
    const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { text: existing + sep + block, status: "appended" };
  }
  const e = existing.indexOf(DOC_END, b);
  const end = e === -1 ? existing.length : e + DOC_END.length;
  const text = existing.slice(0, b) + block.trimEnd() + existing.slice(end);
  return { text, status: text === existing ? "exists" : "updated" };
}

// --- chapter list insertion (indentation-aware; the parser does not track spans) ------------- //
// A directory body / standalone chapter is YAML-shaped: a mapping's keys at one indent, a
// sequence's `- ` items at the SAME indent as their key, an item's mapping body at key-indent+2.
// To reach a subchapter we descend `children:` sequences by index; then we append to a list key
// (`chunks:` for content, `children:` for pasted subchapters), creating it when absent.

const indentOf = (line: string): number => { let i = 0; while (line[i] === " ") i++; return i; };
const isContentLine = (line: string): boolean => { const t = line.trim(); return t.length > 0 && !t.startsWith("#"); };

/** A prose string as a standalone yamlover VALUE source: a literal block scalar when the text
 *  round-trips, else one double-quoted line (JSON escapes: exactly the subset quotedScalar reads
 *  back). A block's body is indented under its header — the source must parse on its own, which is
 *  what `/api/edit` validates. The one place raw text becomes yamlover: edit callers escape their
 *  own content, the paste endpoints escape theirs through here. */
function escapeScalarSrc(text: string): string {
  const first = text.split("\n").find((l) => l.trim().length > 0);
  if (!first || /^\s/.test(first)) return JSON.stringify(text);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const head = text.endsWith("\n") ? "|" : "|-"; // the chomping matches the text's own ending
  return [head, ...body.split("\n").map((l) => (l.trim().length ? "  " + l : ""))].join("\n");
}

/** Render ONE entry at `indent` from a yamlover value source (whose own lines already carry their
 *  relative indentation). `marker` is `"- "` for a positional entry or `` `${key}: ` `` for a keyed
 *  one; `tag` is an inline `!!<…>` schema tag.
 *
 *  `deeper` pushes the value's continuation lines two columns further in — for a node that ALSO
 *  carries keyed fields (which sit at indent+2), a block scalar must be deeper than them so its
 *  dedent to the field column ends the block (docs/language/vs-yaml/differences/mixtures). Blank lines are emitted truly empty:
 *  a `pad`-only line at a shallower column would truncate the block. */
function renderEntry(valueSrc: string, indent: number, marker: string, tag?: string, deeper = false): string[] {
  const pad = " ".repeat(indent + (deeper ? 2 : 0));
  const [first, ...rest] = valueSrc.split("\n");
  return [`${" ".repeat(indent)}${marker}${tag ? tag + " " : ""}${first}`, ...rest.map((l) => (l.trim().length ? pad + l : ""))];
}

/** Render a pasted PROSE text as the lines of one `- ` chunk item at `indent`. */
function textChunkLines(text: string, indent: number): string[] {
  return renderEntry(escapeScalarSrc(text), indent, "- ");
}

// --- yamlover source surgery (the /api/edit ops) --------------------------------------------- //
// A node's entries — keyed fields (`key: …`) and positional items (`- …`) — live on one mapping.
// There is ONE address space: a path segment is a key, or the ABSOLUTE index of an entry in source
// order (keyed entries consume indices too). It is the same index `/api/json`, the resolver, and
// pointers use, so an edit path is a plain yamlover path and nothing else.

/** A chapter mapping's line region [lo,hi) at key `indent`. `marker` is the `- ` item line when the
 *  region is a DESCENDED subchapter body (its first key may sit inline on that marker line, e.g.
 *  `- title: X`), else -1 for the top-level mapping. */
interface Region { lo: number; hi: number; indent: number; marker: number }

interface ChapterEntry { absIndex: number; key: string | null; start: number; end: number; inline: boolean }

/** The OWN entries of the chapter mapping at `region`, in source order — each a keyed field
 *  (`key: …`) or a positional item (`- …`), with its absolute index and [start,end) line span. A
 *  descended subchapter's first key inline on the `- ` marker line is surfaced as the first entry. */
/** The DECODED key an entry line opens with, or null when it opens no KEYED entry (a `- ` item).
 *
 *  A quoted key is UNQUOTED, and a key may contain spaces: paths, the index and the model all speak
 *  the decoded key, so `"australia and oceania":` has to answer `australia and oceania`. The old
 *  `/^([^:\s]+):/` could not match a key with a space at all and silently answered null — recording
 *  the entry as ORDINAL, so a later op addressing it by key got "no entry at …". */
function entryKeyOf(text: string): string | null {
  const t = text.trim();
  if (seqMarkLen(t) !== null) return null;
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s|$)/.exec(t) ?? /^([^:#]+?)\s*:(?:\s|$)/.exec(t);
  if (!m) return null;
  const tok = m[1];
  try {
    if (tok.startsWith('"')) return JSON.parse(tok) as string;
    if (tok.startsWith("'")) return tok.slice(1, -1).replace(/''/g, "'");
  } catch {
    return null; // an unparseable quoted token is not a key we can address
  }
  return tok;
}

function chapterEntries(lines: string[], r: Region): ChapterEntry[] {
  const starts: { key: string | null; start: number; inline: boolean }[] = [];
  if (r.marker >= 0) {
    // Only a `- ` DASH item carries an inline first child (`- title: X`, `- name: Rex`). A KEYED
    // marker line (`pets:`, `rating: !!var 5`) is the parent's key / self-value — its entries sit on
    // the lines BELOW, never inline — so surfacing its text would inject a phantom entry (its own
    // key) and shift every index. Chapters only ever descend `- ` items, so this only bit the general
    // value editor descending a `key:` → sequence/mapping.
    const raw = lines[r.marker].replace(/^\s*/, "");
    if (seqMarkLen(raw) !== null) {
      // the item's inline `!!<…>` schema tag is META, not an entry — surfacing it would inject a
      // phantom first entry and shift every index (a `- !!<…table>` body item's rows, e.g.)
      const inline = (stripSeqMark(raw) ?? raw).replace(/^!!<[^>]*>\s*/, "");
      // Only an inline ENTRY OPENER is the first child: a nested `- ` item (compact `- - x`
      // nesting) or a `key: …` field (`- title: X`). A plain/quoted/pointer scalar head is the
      // node's own SELF-VALUE (an omni titled subchapter, `- Sub` + body — docs/documents/chapter) — not an
      // entry; surfacing it would inject a phantom [0] and shift every body index off the store.
      if (inline.trim()) {
        if (seqMarkLen(inline) !== null) starts.push({ key: null, start: r.marker, inline: true });
        else if (/^[^\s"'*|>#-][^:]*:(\s|$)/.test(inline.replace(/\s+#.*$/, ""))) {
          starts.push({ key: entryKeyOf(inline), start: r.marker, inline: true });
        }
      }
    }
  }
  for (let i = r.lo; i < r.hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < r.indent) break; // left the mapping
    if (ind !== r.indent) continue; // deeper → the current entry's body
    const t = lines[i].trim();
    if (t.startsWith("!!<")) continue; // the node's OWN schema tag line — not an entry
    // A line that opens no entry (and is no quoted key either) is the node's scalar SELF-VALUE —
    // a fully-omni chapter's title line (docs/documents/chapter). It consumes NO index; a block-header
    // self-value's content sits deeper and is skipped by the indent check above.
    if (!opensEntry(t) && !opensQuotedKey(t)) continue;
    starts.push({ key: entryKeyOf(t), start: i, inline: false });
    // a K&R value spans the lines below: step over its interior so an inner `x: 1,` can never be
    // read as an entry of THIS node (and the closer never as a self-value line)
    const span = flowSpanEnd(lines, i);
    if (span > i) i = span;
  }
  // THE SPAN LAW: an entry ends after its own LAST CONTENT line. The blank/`#` block that
  // separates it from the next entry is NOT its tail — those lines are the next entry's
  // leading comments (the parser's attachment rule), and a splice or removal of THIS entry
  // must leave them standing. `trimBack` walks the end over exactly that block.
  return starts.map((s, k) => ({
    absIndex: k,
    key: s.key,
    start: s.start,
    end: trimBack(lines, s.start, k + 1 < starts.length ? starts[k + 1].start : r.hi),
    inline: s.inline,
  }));
}

/** The entry `seg` names within `r`: a keyed field by name, or any entry by ABSOLUTE index.
 *  The NULL key addresses the `~:` line — in this TEXT layer the null key's canonical spelling
 *  `~` IS the key token `entryKeyOf` records.
 *  TODO(yaml-keys): a quoted `'~':` (the literal-tilde STRING key) collides with the null key
 *  here — the line scanner records both as the key "~"; disambiguating needs the splicer to
 *  keep the quoting of the key token. */
function findEntry(lines: string[], r: Region, seg: Seg): ChapterEntry | undefined {
  const entries = chapterEntries(lines, r);
  if (typeof seg === "number") return entries[seg];
  const keyed = entries.find((e) => e.key === (seg === null ? "~" : seg));
  if (keyed) return keyed;
  // a MEMBER'S NAME also addresses the keyless pointer entry granting its position
  // (`- *: name`) — the same key the wire's anchorKey carries, so a member-rooted op
  // re-routed to the parent (the root-remove detach) lands on its line
  if (typeof seg === "string") {
    return entries.find((e) => e.key === null && memberPointerNameOf(entryHead(lines, e)) === seg);
  }
  return undefined;
}

/** The member NAME a keyless entry's head grants a position to (`- *: name` — a document-scope
 *  single-key pointer), or null for anything else. */
function memberPointerNameOf(head: string): string | null {
  if (!head.startsWith("*")) return null;
  try {
    const p = parsePointer(head.slice(1).trim()) as { base: { scope: string }; steps: { sel: string; name?: string }[] };
    if (p.base.scope === "document" && p.steps.length === 1 && p.steps[0].sel === "key") return p.steps[0].name ?? null;
  } catch { /* not a member pointer */ }
  return null;
}

/** An entry's own VALUE source on its opening line — past the `- ` marker, its inline `!!<…>` tag,
 *  and (for a keyed entry) its own `key:`. A block header (`|-`), a quoted/plain scalar, a `*…`
 *  pointer, or — for a positional entry holding a mapping — an inline `key: value`. */
function entryHead(lines: string[], e: ChapterEntry): string {
  const bare = lines[e.start].trim();
  let t = (stripSeqMark(bare) ?? bare).replace(/^!!<[^>]*>\s*/, "");
  if (e.key) t = t.slice(t.indexOf(":") + 1).trim(); // a keyed entry's head is what follows `key:`
  return t;
}

/** True when the entry HOLDS entries of its own (a mapping/sequence), rather than being a scalar
 *  leaf. A block scalar's content sits at the child column, so it only counts as a container when
 *  it also carries keyed fields there (an omni node — see {@link itemHasFields}). */
function isContainerEntry(lines: string[], e: ChapterEntry, childIndent: number): boolean {
  // a K&R value is ONE value spanning lines — its interior is not children (see flowSpanEnd)
  if (flowSpanEnd(lines, e.start) > e.start) return false;
  const head = entryHead(lines, e);
  // compact `- - x` nesting: the head itself opens a nested item — it IS the first child, even
  // when the entry is a single line (a scalar head can never start `- `; it would be quoted)
  if (seqMarkLen(head) !== null) return true;
  if (isBlockHeader(head)) return itemHasFields(lines, e, childIndent); // omni block, or plain
  // The inline `key:` test must not read past a trailing comment: a scalar's comment may itself
  // contain a colon (`theme: dark   # ui palette: dark | light`), which is prose, not a mapping.
  // A plain scalar cannot contain ` #` (yamlover comments need the leading whitespace), and a
  // quoted head never enters the regex (its first char is excluded), so the strip is safe.
  const bare = head.replace(/\s+#.*$/, "");
  // A whole FLOW token is a one-line VALUE, never an entry with an inline first child: `a: {x: 1}`
  // otherwise satisfies the test below (`{x` + `: `) and the splicer keeps the old token as a
  // phantom child — an emplace over it left `a: <new>\n  {x: 1}` orphaned in the file.
  if (isFlowToken(bare)) return false;
  if (/^[^\s"'*|>#-][^:]*:(\s|$)/.test(bare)) return true; // an inline `- title: Sub`
  for (let i = e.start + 1; i < e.end; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < childIndent) break;
    if (ind === childIndent) return true; // a child entry line
  }
  return false;
}

/** The line region of the node addressed by `within` (a path relative to the document root; empty =
 *  the document's own top-level mapping). Each segment is a key or an absolute entry index.
 *  Descending a SCALAR is an error: splicing underneath one silently corrupts the document. */
function reachChapter(lines: string[], within: Seg[]): Region {
  let r: Region = { lo: 0, hi: lines.length, indent: firstContentIndent(lines), marker: -1 };
  for (const seg of within) {
    const entry = findEntry(lines, r, seg);
    if (!entry) throw new Error(`no entry at ${segToken(seg)}`);
    if (!isContainerEntry(lines, entry, r.indent + 2)) {
      const at = segToken(seg);
      // A FLOW value is one source token with no interior line to splice — a K&R one included. Say
      // so, rather than reporting it as a scalar: the caller's move is to emplace the whole token.
      if (isFlowToken(entryHead(lines, entry)) || flowSpanEnd(lines, entry.start) > entry.start) {
        throw new Error(`${at} is written in flow form — edit it as a whole token (emplace on ${at} itself)`);
      }
      throw new Error(`cannot descend into a scalar element at ${at}`);
    }
    r = { lo: entry.start + 1, hi: entry.end, indent: r.indent + 2, marker: entry.start };
  }
  return r;
}

/** The line index to append a new positional body item at the END of a chapter region — right
 *  after the last positional item (keeping the body contiguous), else after its last entry. */
function bodyAppendPoint(lines: string[], r: Region): number {
  const entries = chapterEntries(lines, r);
  const items = entries.filter((e) => e.key === null);
  if (items.length) return items[items.length - 1].end;
  if (entries.length) return entries[entries.length - 1].end;
  return r.marker >= 0 ? r.marker + 1 : trimBack(lines, r.lo - 1, r.hi);
}

/** Append items (rendered by `renderItems` at the body's indent) to the positional body of the
 *  chapter at `chapterPath` within a .yo source. */
function appendBody(text: string, chapterPath: Seg[], renderItems: (indent: number) => string[]): string {
  const lines = text.split("\n");
  const r = reachChapter(lines, chapterPath);
  lines.splice(bodyAppendPoint(lines, r), 0, ...renderItems(r.indent));
  return lines.join("\n");
}

// --- facets: the /api/edit surgical ops ------------------------------------------------------ //
// A node has four FACETS (docs/meta/facets): its scalar value, its keyed entries, its ordinal (positional)
// entries, and its `!!<…>` meta tag. `emplace` replaces only the facets its payload carries and
// leaves the rest standing — which is what lets a prose edit keep an annotated chunk's
// `yamlover-annotations` overlay. `replace` drops all four and assigns the payload.

/** A node's facets as column-0 yamlover source: the scalar's own source, and each keyed / ordinal
 *  entry as its own group of lines (kept verbatim, so re-emitting one never reformats it).
 *  `selfAt` is the scalar's authored POSITION — the number of entries that precede its line
 *  (0/undefined = it leads); `order` is the source order of the keyed/ordinal groups, carried so a
 *  re-render can keep the authored interleaving when the groups come from one source. */
interface Facets {
  scalar?: string;
  keyed: string[][];
  ordinal: string[][];
  selfAt?: number;
  order?: ("k" | "o")[];
}

/** True for a line that opens an entry — a `- ` item or a `key:` field. A block scalar's content is
 *  NOT an entry, which is why prose that looks like `note: hi` must reach us escaped. A `&`-led
 *  line is an ANCHOR (its colon form `&: tags: x` runs to EOL) — never an entry, never an index
 *  (an authored key starting with `&` is spelled escaped, `\&key:`). */
const opensEntry = (t: string): boolean => seqMarkLen(t) !== null || /^[^\s"'*|>#&-][^:]*:(\s|$)/.test(t);

/** A `|` / `>` block header, a trailing ` # comment` tolerated (YAML allows one on the header
 *  line; a bare header can never itself contain ` #`). */
const isBlockHeader = (head: string): boolean => /^[|>][+-]?\d*(\s+#.*)?$/.test(head.trim());

/** True for a line opening a QUOTED-key entry (`"pic.png": …`) — `opensEntry`'s regex excludes
 *  quote-led lines so a quoted scalar reads as a value, but a quoted key IS an entry opener. */
const opensQuotedKey = (t: string): boolean => /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(\s|$)/.test(t);

/** Group column-`at` source lines into entries, keyed and ordinal, each group verbatim, plus their
 *  source `order`. A line at the entry column that opens NO entry (a bare scalar or a block header
 *  with its deeper content) is the node's SELF-VALUE line — returned as `self` with its authored
 *  position (entries before it), never misfiled as a keyed group. Anchor / tag / pointer lines
 *  (`&…`, `!!<…`, `*…`) keep their old keyed-group classification. */
function groupEntries(lines: string[], at: number): { keyed: string[][]; ordinal: string[][]; order: ("k" | "o")[]; self?: { src: string; at: number } } {
  const starts = lines.map((l, i) => i).filter((i) => isContentLine(lines[i]) && indentOf(lines[i]) === at);
  const keyed: string[][] = [];
  const ordinal: string[][] = [];
  const order: ("k" | "o")[] = [];
  let self: { src: string; at: number } | undefined;
  starts.forEach((s, k) => {
    const group = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length).map((l) => l.slice(at));
    const head = lines[s].trim();
    if (seqMarkLen(head) !== null) {
      ordinal.push(group);
      order.push("o");
    } else if (!self && !opensEntry(head) && !opensQuotedKey(head) && !/^[&*!]/.test(head)) {
      self = { src: group.join("\n").replace(/\n+$/, ""), at: order.length };
    } else {
      keyed.push(group);
      order.push("k");
    }
  });
  return { keyed, ordinal, order, self };
}

/** The `!!yo` plain-yamlover mark on a source snippet's ROOT: a data ISLAND. The
 *  member-encoding derivation treats it exactly like an explicit `!!<…>` tag — content, not
 *  structure, so it stays inline in the body and never materializes as an `itemNN` member
 *  (a promotion would rip the island out of the document it annotates). */
function rootIsYo(src: string | null | undefined): boolean {
  if (!src || isPointerValue(src)) return false;
  try {
    return parseYamlover(src, "<edit>").root.meta?.yo === true;
  } catch {
    return false;
  }
}

/** The facets a column-0 `yamlover` payload carries. A payload whose first content line opens no
 *  entry is (or starts with) a SCALAR — a block header, a quoted/plain scalar, or a `*…` pointer.
 *  A one-line scalar head followed by column-0 entry lines is an OMNI payload (a self-value plus
 *  entries — e.g. a titled chapter, docs/documents/chapter); a block-header payload keeps the whole source as
 *  the scalar (its content lines live below the header, never entries). */
function payloadFacets(src: string): Facets {
  const lines = src.split("\n");
  const fi = lines.findIndex(isContentLine);
  if (fi < 0) return { keyed: [], ordinal: [] };
  const first = lines[fi].trim();
  // A whole FLOW token is a VALUE, whatever it contains — it must never be grouped as entry lines.
  // The scalar is the WHOLE token: a K&R one spans lines (`{`, its cells, its closer), and taking
  // only the first line wrote a bare `{` to the file.
  if (isFlowToken(src)) {
    // the payload arrives at COLUMN 0 (the wire contract above), so its continuation lines already
    // carry the token's own relative indentation and `renderEntry` pads them to the target column
    const text = src.replace(/\s+$/, "");
    return { scalar: text.includes("\n") ? text : first, keyed: [], ordinal: [] };
  }
  // `opensEntry`'s regex excludes a quote-led line (so a quoted SCALAR reads as a value), so a
  // payload whose first line is a QUOTED-KEY entry needs the same test `groupEntries` already
  // applies. Without it such a payload was classified as a scalar and written INLINE after the
  // key — `world: "a b":` — after which the next op could not descend into what had become a
  // scalar ("cannot descend into a scalar element at world").
  if (!opensEntry(first) && !opensQuotedKey(first) && !first.startsWith("&")) {
    // the scalar head: one line, or a block header with its DEEPER content lines. A payload
    // LEADING with a `&` anchor line is decoration + entries, not a scalar — grouped below,
    // where groupEntries re-emits the anchor lines verbatim at the canonical column.
    let bend = fi + 1;
    if (isBlockHeader(first)) while (bend < lines.length && (!isContentLine(lines[bend]) || indentOf(lines[bend]) > 0)) bend++;
    const after = lines.slice(bend);
    if (!after.some(isContentLine)) return { scalar: src, keyed: [], ordinal: [] };
    const g = groupEntries(after, 0);
    return { scalar: lines.slice(fi, bend).join("\n").replace(/\n+$/, ""), selfAt: 0, keyed: g.keyed, ordinal: g.ordinal, order: g.order };
  }
  const g = groupEntries(lines, 0);
  // entries first — a non-entry line further down is the self-value at its authored position
  return { scalar: g.self?.src, selfAt: g.self?.at, keyed: g.keyed, ordinal: g.ordinal, order: g.order };
}

/** The facets an EXISTING entry carries, as column-0 source (its own indentation stripped), plus
 *  the inline `!!<…>` it wears. A block scalar's content lives at the child column when the node is
 *  plain, and one step deeper when it is an omni carrying keyed fields (docs/language/vs-yaml/differences/mixtures). */
function entryFacets(lines: string[], e: ChapterEntry, indent: number): Facets & { tag?: string } {
  const bare = lines[e.start].trim();
  const marked = stripSeqMark(bare) ?? bare;
  const tag = marked.match(/^(!!<[^>]*>)/)?.[1];
  const head = entryHead(lines, e);
  const childIndent = indent + 2;
  // a value's continuation lines are re-emitted with their own relative indent (2 under the header)
  const value = (from: number, to: number, at: number): string =>
    [head, ...lines.slice(from, to).map((l) => (l.trim().length ? "  " + l.slice(at) : ""))].join("\n").replace(/\n+$/, "");

  // A K&R VALUE is one token spanning lines: its continuation lines keep their OWN relative
  // indentation (de-indented by the entry's own column, not the child column, and with nothing
  // added), so renderEntry can re-emit the token verbatim at any indent.
  const span = flowSpanEnd(lines, e.start);
  if (span > e.start) {
    const rest = lines.slice(e.start + 1, span + 1).map((l) => (l.trim().length ? l.slice(indent) : ""));
    return { tag, scalar: [head, ...rest].join("\n"), keyed: [], ordinal: [] };
  }

  if (!isContainerEntry(lines, e, childIndent)) {
    return { tag, scalar: value(e.start + 1, e.end, childIndent), keyed: [], ordinal: [] };
  }

  // a container. Its scalar (an omni's block value) sits one step deeper than its children, which
  // start at the first line at the child column — or inline on the marker (`- title: Sub`).
  const blockValue = isBlockHeader(head);
  let firstChild = e.end;
  for (let i = e.start + 1; i < e.end; i++) {
    if (isContentLine(lines[i]) && indentOf(lines[i]) === childIndent) { firstChild = i; break; }
  }
  // An inline head is the first KEYED entry (`- title: X`), the first ORDINAL entry (`- - x`,
  // the compact nesting of an untitled subchapter), or — when it opens no entry — the node's own
  // SELF-VALUE (`- Sub` + body: an omni titled subchapter, docs/documents/chapter). Misfiling the compact
  // `- ` head as the scalar would make a title emplace SWALLOW the first child.
  const inlineKeyed = !blockValue && !!head && /^[^\s"'*|>#-][^:]*:(\s|$)/.test(head.replace(/\s+#.*$/, ""));
  const inlineDash = !blockValue && !!head && /^-(\s|$)/.test(head);
  let scalar = blockValue ? value(e.start + 1, firstChild, childIndent + 2) : head && !inlineKeyed && !inlineDash ? head : undefined;
  const g = groupEntries(lines.slice(firstChild, e.end), childIndent);
  let selfAt = scalar !== undefined ? 0 : undefined;
  if (scalar === undefined && g.self) {
    // a MID-position self-value line among the children — kept at its authored position
    scalar = g.self.src;
    selfAt = g.self.at;
  }
  if (inlineKeyed || inlineDash) {
    // the entry inlined on the `- ` marker — with any continuation lines that sit DEEPER than the
    // child column (e.g. the block content of a compact `- - |` head), kept verbatim
    const headGroup = [head, ...lines.slice(e.start + 1, firstChild).map((l) => (l.trim().length ? l.slice(childIndent) : ""))];
    (inlineKeyed ? g.keyed : g.ordinal).unshift(headGroup);
    g.order.unshift(inlineKeyed ? "k" : "o");
    if (selfAt !== undefined) selfAt += 1; // an inline head is an entry BEFORE the mid-position self
  }
  return { tag, scalar, selfAt, keyed: g.keyed, ordinal: g.ordinal, order: g.order };
}

/** A ONE-LINE double-quoted scalar as its bare plain spelling, when the bare line re-reads as the
 *  SAME string — a title like `"Added title"` authors better as `Added title`. Anything the bare
 *  spelling would change keeps its quotes: an entry opener (`a: b`), a sigil (`*x`, `- x`, `|`),
 *  a number/bool/null (`30`, `true`), a ` #` comment, leading/trailing space, a multi-line value. */
function preferPlainScalar(src: string): string {
  const line = src.trim();
  if (src.includes("\n") || !/^".*"$/.test(line)) return src;
  try {
    const q = parseYamlover(line, "<scalar>").root as { kind?: string; value?: unknown };
    if (q.kind !== "scalar" || typeof q.value !== "string") return src;
    const text = q.value;
    if (!text || text !== text.trim() || text.includes("\n")) return src;
    if (opensEntry(text) || opensQuotedKey(text)) return src;
    const bare = parseYamlover(text, "<scalar>").root as { kind?: string; value?: unknown; entries?: unknown[] };
    if (bare.kind === "scalar" && bare.value === text && !bare.entries?.length) return text;
  } catch {
    /* anything unparseable bare keeps its quotes */
  }
  return src;
}

/** Render a node from its facets at `indent`. `marker` is `"- "` (positional) or `` `${key}: ` ``.
 *  A positional container inlines its first keyed entry on the marker line (`- title: X`), the shape
 *  a chapter's subchapters already have. A node with children keeps its block scalar one step
 *  deeper than them, so the dedent ends the block. */
function renderNode(f: Facets, indent: number, marker: string, tag?: string, flat?: boolean): string[] {
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);
  const groups = orderedGroups(f);
  const child = (g: string[]): string[] => g.map((l) => (l.trim().length ? childPad + l : ""));

  // THE FLAT SPLICE (docs/language/flattening): the caller says the payload's first row is a
  // flat CONTINUATION of the key — join them as ONE row (`key1: key2: value`), the keyed twin
  // of the positional inline below (`- title: Sub`). Only when the shape can spell it: exactly
  // one keyed group, no self value, no tag (a tag cannot ride a flat row); anything else falls
  // through to the nested splice — parse-correct, the fold merely unspelled.
  if (flat === true && !marker.startsWith("-") && f.scalar === undefined && !tag
      && f.keyed.length === 1 && (f.ordinal ?? []).length === 0) {
    const [g0] = groups;
    return [`${pad}${marker}${g0[0]}`, ...child(g0.slice(1))];
  }

  const selfAt = f.scalar !== undefined ? Math.min(f.selfAt ?? 0, groups.length) : 0;
  if (f.scalar !== undefined && selfAt > 0) {
    // THE REPRESENTATION RULE: the self-value line keeps its authored position among the entries —
    // entries before it, the scalar's lines (a child-column bare line or block), entries after
    const selfLines = child(preferPlainScalar(f.scalar).split("\n"));
    const before = groups.slice(0, selfAt);
    const after = groups.slice(selfAt);
    const rest = (gs: string[][]): string[] => gs.flatMap(child);
    if (marker.startsWith("-") && !tag) {
      const [g0, ...restB] = before;
      return [`${pad}${marker}${g0[0]}`, ...child(g0.slice(1)), ...rest(restB), ...selfLines, ...rest(after)];
    }
    return [`${pad}${marker.trimEnd()}${tag ? " " + tag : ""}`, ...rest(before), ...selfLines, ...rest(after)];
  }
  if (f.scalar !== undefined) {
    // a container's scalar is its SELF-VALUE (a chapter's title) — author it plain when safe
    const scalar = groups.length ? preferPlainScalar(f.scalar) : f.scalar;
    return [...renderEntry(scalar, indent, marker, tag, groups.length > 0), ...groups.flatMap(child)];
  }
  if (!groups.length) return [`${pad}${marker.trimEnd()}${tag ? " " + tag : ""}`];
  if (marker.startsWith("-") && !tag) {
    // `- title: Sub` — a positional container inlines its first key, the shape a subchapter has.
    // A TAG cannot share that line (`- !!<…> title: X` binds the tag to the key, not to the item),
    // so a tagged container wears its tag alone on the `- ` line and drops its keys below.
    const [g0, ...rest] = groups;
    return [`${pad}${marker}${g0[0]}`, ...child(g0.slice(1)), ...rest.flatMap(child)];
  }
  return [`${pad}${marker.trimEnd()}${tag ? " " + tag : ""}`, ...groups.flatMap(child)];
}

/** The keyed/ordinal groups in their SOURCE order when `order` is consistent with them (groups
 *  from one source), else keyed-then-ordinal (the mixed-source fallback). */
function orderedGroups(f: Facets): string[][] {
  const { keyed, ordinal, order } = f;
  if (order && order.filter((x) => x === "k").length === keyed.length && order.filter((x) => x === "o").length === ordinal.length) {
    let ki = 0;
    let oi = 0;
    return order.map((x) => (x === "k" ? keyed[ki++] : ordinal[oi++]));
  }
  return [...keyed, ...ordinal];
}

/** The `!!<…>` a payload asks for: the given `meta`, the entry's existing tag when `meta` is omitted
 *  and the op preserves (emplace), or none. */
function metaTag(meta: string | null | undefined, existing: string | undefined, preserve: boolean): string | undefined {
  if (meta === null) return undefined;
  if (meta !== undefined) return `!!<${meta}>`;
  return preserve ? existing : undefined;
}

/** `emplace` / `replace` / `remove` on the entry `seg` names within `r`; `insert` before it (or
 *  appended when `seg` is undefined — the path named the node itself). An insert with `key` makes
 *  a KEYED entry at that position (`key: value`) instead of an ordinal one — a fresh keyed emplace
 *  always splices at the top of the block, so this is how a caller keeps AUTHORED entry order. */
/** The index of the colon that SEPARATES a key from its value in `s` (which begins at the key
 *  token), quote-aware: a colon inside a `"…"`/`'…'` quoted key does not count. -1 if none. */
function keySepColon(s: string): number {
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    let i = 1;
    for (; i < s.length; i++) {
      if (q === '"' && s[i] === "\\") i++; // escaped char inside a double-quoted key
      else if (s[i] === q) { i++; break; } // past the closing quote
    }
    while (i < s.length && s[i] !== ":") i++;
    return i < s.length ? i : -1;
  }
  return s.indexOf(":"); // a plain key holds no colon — the first one separates
}

/** The ` # …` comment trailing an entry's opening line, WITH its authored separator —
 *  quote-aware (a `#` inside a quoted token is content). Null: no trailing comment. */
function trailingCommentOf(line: string): string | null {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === "#" && !inS && !inD && i > 0 && (line[i - 1] === " " || line[i - 1] === "\t")) {
      const ws = /[ \t]+$/.exec(line.slice(0, i));
      return (ws ? ws[0] : " ") + line.slice(i);
    }
  }
  return null;
}

function assignAt(lines: string[], r: Region, seg: Seg | undefined, op: string, valueSrc: string, meta: string | null | undefined, key?: string, at?: number, flat?: boolean): void {
  // the entry-opening marker a fresh emplace writes: `key: ` for a keyed target, `~: ` for the
  // NULL key (its canonical emission), `- ` for a positional one. The key goes through keyToken —
  // spelling is ONE law (embed.ts): a bare `-:` is the keyless marker and a bare `12:` a position,
  // so a key that needs quotes must get them here too, not only on the `insert` path below.
  const marker = (s: Seg | undefined): string => (typeof s === "string" ? `${keyToken(s)}: ` : s === null ? "~: " : "- ");

  if (op === "insert") {
    if (typeof seg !== "number" && seg !== undefined) throw new Error("`insert` needs a positional target (a path ending in a bare index, or the node itself)");
    const entries = chapterEntries(lines, r);
    const entry = seg === undefined ? undefined : entries[seg];
    // An index PAST THE END means the end of the ENTRY list. `bodyAppendPoint` instead keeps the
    // positional items grouped — right when the caller says "append an item to this body" (seg
    // undefined), wrong for a RANKED insert into a MIX, where it tucks the new entry in front of
    // the trailing keyed fields and loses the very order the rank was carrying.
    const at = entry ? entry.start
      : seg !== undefined && entries.length ? entries[entries.length - 1].end
      : bodyAppendPoint(lines, r);
    lines.splice(at, 0, ...renderNode(payloadFacets(valueSrc), r.indent, key !== undefined ? `${keyToken(key)}: ` : "- ", metaTag(meta, undefined, false), key !== undefined && flat === true));
    return;
  }

  if (seg === undefined) throw new Error(`\`${op}\` needs a key or index target`);
  const entry = findEntry(lines, r, seg);

  if (op === "rekey") {
    if (!entry) throw new Error(`no entry at ${segToken(seg)}`);
    if (entry.key === null) throw new Error("a positional entry has no key to rename");
    if (key === undefined || key === "") throw new Error("rekey needs a new key");
    // rewrite ONLY the key token on the entry's opening line, keeping its value + all descendant
    // rows: the span before the key is the indent and (for an inline `- key: v` member) the dash
    // marker and any inline `!!<…>` tag; the key token itself is plain or quoted, so find the
    // SEPARATING colon quote-aware and splice the new key in front of it.
    const line = lines[entry.start];
    const pre = /^(\s*(?:-\s+(?:!!<[^>]*>\s+)?)?)/.exec(line)![1];
    const rest = line.slice(pre.length);
    const colon = keySepColon(rest);
    if (colon < 0) throw new Error("could not locate the key token to rename");
    // `key` arrives RAW (the endpoint passes the user's text) — spell it through the ONE key
    // tokenizer (embed.ts). The local regex this replaced admitted a bare `-`, which the line
    // scanner then read as the KEYLESS marker, so the entry vanished and the next op answered
    // "no entry at '-'"; it admitted a bare `12` the same way (a position claim).
    lines[entry.start] = pre + keyToken(key) + rest.slice(colon);
    return;
  }

  if (op === "remove") {
    if (!entry) throw new Error(`no entry at ${segToken(seg)}`);
    if (entry.inline) {
      // the entry lives on its parent's `- ` marker line — drop only the inline part, keeping
      // the marker (splicing the whole line would take the parent and orphan its other children)
      lines[entry.start] = `${" ".repeat(indentOf(lines[entry.start]))}-`;
      return;
    }
    lines.splice(entry.start, entry.end - entry.start);
    return;
  }
  if (op !== "emplace" && op !== "replace") throw new Error(`unknown edit op: ${op}`);

  if (!entry) {
    // emplace at a FRESH path: a new keyed field, or an appended positional item
    if (op === "replace") throw new Error(`no entry at ${segToken(seg)}`);
    const rendered = renderNode(payloadFacets(valueSrc), r.indent, marker(seg), metaTag(meta, undefined, false));
    // a KEYED target (a string key or the null key) splices at the top of the block; a positional
    // one appends to the body
    const at = typeof seg !== "number" ? (r.marker >= 0 ? r.marker + 1 : trimBack(lines, r.lo - 1, r.hi)) : bodyAppendPoint(lines, r);
    lines.splice(at, 0, ...rendered);
    return;
  }

  const had = entryFacets(lines, entry, r.indent);
  const payload = payloadFacets(valueSrc);
  const inlineKey = entry.inline ? entry.key : null; // a key living on its parent's `- ` marker line
  const keyed = payload.keyed.length ? payload.keyed : had.keyed;
  const ordinal = payload.ordinal.length ? payload.ordinal : had.ordinal;
  const next: Facets =
    op === "replace"
      ? { ...payload, selfAt: at ?? payload.selfAt }
      : {
          scalar: payload.scalar ?? had.scalar,
          keyed,
          ordinal,
          // the self line's position: the op's explicit `at`, else where the winning scalar sat
          selfAt: at ?? (payload.scalar !== undefined ? payload.selfAt : had.selfAt),
          // source order survives only when both group facets come from the same source
          order: keyed === payload.keyed && ordinal === payload.ordinal ? payload.order
               : keyed === had.keyed && ordinal === had.ordinal ? had.order : undefined,
        };
  // An EMPTY scalar emplaced onto a container DROPS the self-value: an untitled chapter's title
  // is no value at all, not an empty string (docs/documents/chapter) — `emplace '""'` on a subchapter un-titles it.
  if (op === "emplace" && payload.scalar !== undefined && next.scalar !== undefined && (next.keyed.length || next.ordinal.length)) {
    const p = parseYamlover(next.scalar, "<scalar>").root as { kind?: string; value?: unknown };
    if (p.kind === "scalar" && (p.value == null || p.value === "")) next.scalar = undefined;
  }
  // A FLOW token is the entry's whole value, not a self-value beside fields — BOTH WAYS ROUND.
  // Emplacing block content over `a: {x: 1}` replaces the token (a demoted flow); emplacing a flow
  // token over `a:` + children replaces the children. Either merge would make an omni node whose
  // self-value is a mapping, which renders as the token with the other facet orphaned beneath it.
  if (op === "emplace" && payload.scalar !== undefined && isFlowToken(payload.scalar)) {
    next.keyed = [];
    next.ordinal = [];
    next.order = undefined;
  }
  if (op === "emplace" && payload.scalar === undefined && next.scalar !== undefined
      && (next.keyed.length || next.ordinal.length) && isFlowToken(next.scalar)) {
    next.scalar = undefined;
  }
  const tag = metaTag(meta, had.tag, op === "emplace");

  // THE TRAILING-COMMENT LAW: a remark riding the entry's opening line (`a: 1 # note`) is the
  // user's labour, not the value's — an emplace that re-renders the line carries it over
  // (renderNode emits no comments of its own; a payload spelling a `#` never collides because
  // the capture is quote-aware on the ORIGINAL line).
  const headTrail = trailingCommentOf(lines[entry.start]);
  if (entry.inline) {
    // an entry living on its parent's `- ` marker line (`- title: X`, or a compact `- - x`
    // nested item) — rewrite the marker line in place, keeping the outer `- `
    const pad = " ".repeat(indentOf(lines[entry.start]));
    lines[entry.start] = (inlineKey
      ? `${pad}- ${tag ? tag + " " : ""}${inlineKey}: ${next.scalar ?? '""'}`
      : `${pad}- - ${tag ? tag + " " : ""}${next.scalar ?? '""'}`) + (headTrail ?? "");
    return;
  }
  // THE MEMBERSHIP LAW (docs/annotations/applications): `&` bookmark lines are edges, never a
  // facet a payload could carry — an emplace re-render carries them over unchanged; `replace`
  // (the clean-slate verb) drops them with everything else.
  const anchorLines = op === "emplace"
    ? lines.slice(entry.start + 1, entry.end).filter((l) => isContentLine(l) && indentOf(l) === r.indent + 2 && l.trim().startsWith("&"))
    : [];
  const rendered = renderNode(next, r.indent, marker(seg), tag);
  if (headTrail !== null && rendered.length > 0 && trailingCommentOf(rendered[0]) === null) rendered[0] += headTrail;
  // …but a payload that spells anchors of its own (the yed anchor-row edit round-trips the whole
  // node source) is EDITING them — it wins, and nothing is carried over.
  const payloadHasAnchors = rendered.some((l) => isContentLine(l) && l.trim().startsWith("&"));
  const carried = payloadHasAnchors ? [] : anchorLines;
  if (carried.length && rendered.length > 1 && /[|>][+-]?\s*$/.test(rendered[0].replace(/\s+#.*$/, ""))) {
    // a BLOCK-scalar entry keeps its anchors only in the OMNI layout — content one step deeper
    // than the anchor column (the same shape convertChunkToOmni writes), else the `&` line would
    // be absorbed as scalar content
    for (let i = 1; i < rendered.length; i++) if (rendered[i].trim()) rendered[i] = "  " + rendered[i];
  }
  lines.splice(entry.start, entry.end - entry.start, ...rendered, ...carried);
}

// --- chunk fragments (docs/annotations/storage): a text fragment lives ON the chunk it was drawn in ----- //
// A chunk that carries a fragment becomes an OMNI node — its prose is a block-scalar self-value and
// `yo:`/`yamlover-annotations:` are keyed fields. These fields sit at the item's
// child indent (item-indent + 2); the block-scalar content is pushed one step DEEPER (item-indent +
// 4) so its dedent to the field level ends the block (docs/language/vs-yaml/differences/mixtures). Reached by ABSOLUTE index
// (node-path space — what the fragment target uses), NOT the /api/edit rank space.

/** The absolute-index body item at `indices` (the last descends INTO the item; earlier ones descend
 *  subchapters), with the parent region that holds it. */
function reachChapterItem(lines: string[], indices: number[]): { parent: Region; item: ChapterEntry; itemIndent: number } {
  const parent = reachChapter(lines, indices.slice(0, -1));
  const idx = indices[indices.length - 1];
  const item = chapterEntries(lines, parent)[idx];
  if (!item || item.key !== null) throw new Error(`no chapter body item at ${idx}`);
  return { parent, item, itemIndent: parent.indent };
}

/** True once the item at `[item.start,item.end)` already has keyed fields at `fieldIndent` (an omni
 *  node) — a `key:` line at exactly that column (its block-scalar content sits deeper). */
function itemHasFields(lines: string[], item: ChapterEntry, fieldIndent: number): boolean {
  // A BLOCK-headed item pins its content indent to the FIRST content line after the header (the
  // YAML rule). Content AT the field column is the PLAIN form: the whole tail is scalar content,
  // and a "key: ..." line inside the folded prose is text, not a field (misreading it spliced a
  // fresh block over the first line only and orphaned the rest -- the reported chunk mangle).
  // Content one step deeper is the OMNI form: block lines (>= content indent) skip; a "key:"
  // line at exactly the field column is a real field.
  const blockHeaded = isBlockHeader(entryHead(lines, item));
  let contentIndent: number | null = null;
  for (let i = item.start + 1; i < item.end; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (blockHeaded) {
      if (contentIndent === null) {
        if (ind <= fieldIndent) return false; // the plain form: everything is block content
        contentIndent = ind;
        continue;
      }
      if (ind >= contentIndent) continue; // still block content
    }
    if (ind < fieldIndent) break;
    if (ind === fieldIndent && /^[^\s-][^:]*:(\s|$)/.test(lines[i].trim())) return true;
  }
  return false;
}

/** Rewrite a PLAIN chunk item into an omni node so it can carry fields: push its block-scalar
 *  content one step deeper (to item-indent + 4), or convert an inline scalar item into a `- |`
 *  block at that indent. Preserves a leading inline `!!<…>` schema tag. */
function convertChunkToOmni(lines: string[], item: ChapterEntry, itemIndent: number): void {
  const sliced = lines[item.start].slice(itemIndent);
  const head = stripSeqMark(sliced) ?? sliced;
  const tagMatch = head.match(/^(!!<[^>]*>)\s*/);
  const tag = tagMatch ? tagMatch[1] + " " : "";
  const rest = tagMatch ? head.slice(tagMatch[0].length) : head;
  if (/^[|>][+-]?\d*$/.test(rest.trim())) {
    for (let i = item.start + 1; i < item.end; i++) if (lines[i].trim().length) lines[i] = "  " + lines[i]; // +2 → content at itemIndent+4
    return;
  }
  const value = rest.startsWith('"') ? String(JSON.parse(rest)) : rest; // inline scalar → its text
  const pad = " ".repeat(itemIndent);
  const chomp = value.endsWith("\n") ? "|" : "|-";
  const clean = value.endsWith("\n") ? value.slice(0, -1) : value;
  lines.splice(item.start, item.end - item.start, `${pad}- ${tag}${chomp}`, ...clean.split("\n").map((l) => (l.trim() ? `${pad}    ${l}` : "")));
}

/** The field-level Region of the chapter body item at absolute `indices` (where `yo:`
 *  / `yamlover-annotations:` live). With `ensureOmni`, a plain chunk is first converted so it can
 *  hold fields. Re-scans after conversion, so the returned span is current. */
function chunkFieldRegion(lines: string[], indices: number[], ensureOmni: boolean): EmbedRegion {
  const { item, itemIndent } = reachChapterItem(lines, indices);
  const fieldIndent = itemIndent + 2;
  if (ensureOmni && !itemHasFields(lines, item, fieldIndent)) convertChunkToOmni(lines, item, itemIndent);
  const { item: cur } = reachChapterItem(lines, indices); // re-scan: the span may have grown
  return { lo: cur.start + 1, hi: cur.end, indent: fieldIndent };
}

/** Once a chunk has no fields left (its last fragment/annotation removed), collapse the omni node
 *  back to a plain block chunk: re-indent its block-scalar content up by 2 (item-indent+4 → +2). */
function collapseChunkOmni(lines: string[], indices: number[]): void {
  const { item, itemIndent } = reachChapterItem(lines, indices);
  if (itemHasFields(lines, item, itemIndent + 2)) return; // still an omni node — leave it
  for (let i = item.start + 1; i < item.end; i++) {
    if (lines[i].trim().length && indentOf(lines[i]) >= itemIndent + 2) lines[i] = lines[i].slice(2);
  }
}

/** Refuse to tag the TEXT of a non-prose chunk (a `*…` file/pointer or a non-text schema tag —
 *  image, diagram): addressed by absolute index. (`/api/edit` needs no such guard: its caller sends
 *  yamlover source, so editing a pointer or a LaTeX chunk is simply legal.) */
function assertProseChunk(lines: string[], indices: number[]): void {
  const { item } = reachChapterItem(lines, indices);
  const sliced = lines[item.start].slice(indentOf(lines[item.start]));
  const head = stripSeqMark(sliced) ?? sliced;
  if (head.startsWith("*")) throw new Error("cannot tag a file/pointer chunk's text");
  const tag = head.match(/^!!<([^>]*)>/)?.[1];
  if (tag && !/text\/(markdown|marklower|x-latex)/.test(tag)) throw new Error("cannot tag a non-text chunk's text");
}

/** Whether a fragment/annotation `target` addresses a CHAPTER CHUNK — i.e. its path descends into a
 *  positional body item (a numeric segment past the document root). Such a target can't be reached
 *  by the mapping-key writer (`hostFor`/`reachBody`); it routes through the chapter editor instead. */
function isChunkTarget(s: Store, segs: Seg[]): boolean {
  const within = segs.slice(documentRootSegs(s, segs).length);
  return within.length > 0 && typeof within[0] === "number";
}

/** Split a chapter-local `within` into its leading numeric body indices and the trailing mapping
 *  keys (e.g. `[3, "yo", "fragments", "slug"]` → `{ indices:[3], keys:["yo","fragments","slug"] }`). */
function splitChunkWithin(within: Seg[]): { indices: number[]; keys: string[] } {
  let i = 0;
  while (i < within.length && typeof within[i] === "number") i++;
  const keys = within.slice(i).map((k) => {
    if (typeof k !== "string") throw new Error("the null key cannot host fragments/annotations yet");
    return k;
  });
  return { indices: within.slice(0, i).map(Number), keys };
}

/** Set, replace, or (an empty payload) DROP a document root's scalar SELF-VALUE line — a fully-omni
 *  chapter's title (docs/documents/chapter). The self-value is the content line at the root indent that is
 *  neither the leading `!!<…>` tag line nor an entry opener; a block-header self-value owns its
 *  deeper-indented content lines too. Replacement happens in place (the authored position among the
 *  entries is the author's — docs/language/vs-yaml/differences/mixtures); a fresh self-value lands right after the tag line. */
/** Replace a document's whole body with one FLOW token. Unlike a self-value line, a flow token is
 *  the entire value — nothing else may stand beside it — so every content line goes and the token
 *  takes their place. The `!!<…>` banner and the head-of-file comments are not content and stay. */
/** Replace the document's WHOLE BODY with a block payload — the yed editor's whole-document
 *  flush (a root emplace whose yamlover carries ENTRY facets). The `!!<…>` banner and the
 *  leading comments stand, exactly as the flow-token branch keeps them. */
function setRootBody(lines: string[], valueSrc: string): void {
  const indent = firstContentIndent(lines);
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isContentLine(lines[i]) || lines[i].trim().startsWith("!!<")) continue;
    if (at < 0) at = i;
    lines.splice(i, 1);
    at = i;
  }
  const rendered = valueSrc === "" ? [] : valueSrc.split("\n").map((l) => (l.length ? " ".repeat(indent) + l : l));
  if (at < 0) {
    // a body of nothing but a banner/comments: the content follows the last of them
    let end = lines.length;
    while (end > 0 && !isContentLine(lines[end - 1])) end--;
    lines.splice(end, 0, ...rendered);
    return;
  }
  lines.splice(at, 0, ...rendered);
}

function setRootFlowValue(lines: string[], token: string): void {
  const indent = firstContentIndent(lines);
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isContentLine(lines[i]) || lines[i].trim().startsWith("!!<")) continue;
    if (at < 0) at = i;
    lines.splice(i, 1);
    at = i;
  }
  const rendered = " ".repeat(indent) + token;
  if (at < 0) {
    // a body of nothing but a banner/comments: the token follows the last of them
    let end = lines.length;
    while (end > 0 && !isContentLine(lines[end - 1])) end--;
    lines.splice(end, 0, rendered);
    return;
  }
  lines.splice(at, 0, rendered);
}

function setRootSelfValue(lines: string[], scalarSrc: string, selfAt?: number): void {
  const indent = firstContentIndent(lines);
  const parsed = parseYamlover(scalarSrc, "<self-value>").root as { kind?: string; value?: unknown };
  if (parsed.kind !== "scalar") throw new Error("a document-root emplace takes a scalar self-value (the title)");
  const empty = parsed.value == null || parsed.value === "";
  // locate the existing self-value line and its span (a block scalar's content sits deeper)
  let at = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isContentLine(lines[i]) || indentOf(lines[i]) !== indent) continue;
    const t = lines[i].trim();
    // decorations are never the self-value line: the `!!<…>` tag, the lone `!!yo`/`!!set`
    // marks, and the node's own-line `&` anchors all stand
    if (t.startsWith("!!") || t.startsWith("&") || opensEntry(t) || opensQuotedKey(t)) continue;
    at = i;
    end = i + 1;
    if (isBlockHeader(t)) while (end < lines.length && (!isContentLine(lines[end]) || indentOf(lines[end]) > indent)) end++;
    end = trimBack(lines, at, end);
    break;
  }
  const rendered = empty
    ? []
    : preferPlainScalar(scalarSrc).split("\n").map((l) => (l.trim().length ? " ".repeat(indent) + l : ""));
  if (at >= 0) {
    lines.splice(at, end - at, ...rendered); // an existing line is replaced IN PLACE — position kept
    return;
  }
  if (empty) return; // no self-value to drop
  // a FRESH self-value line lands at its authored position: after the `selfAt` entries that
  // precede it (THE REPRESENTATION RULE — the line is saved where it was typed, never hoisted)
  if (selfAt !== undefined && selfAt > 0) {
    const starts: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!isContentLine(lines[i]) || indentOf(lines[i]) !== indent) continue;
      const t = lines[i].trim();
      if (opensEntry(t) || opensQuotedKey(t)) starts.push(i);
    }
    if (starts.length) {
      const pos = selfAt < starts.length ? starts[selfAt] : trimBack(lines, starts[starts.length - 1], lines.length);
      lines.splice(pos, 0, ...rendered);
      return;
    }
  }
  const first = lines.findIndex(isContentLine);
  const tagLine = first >= 0 && lines[first].trim().startsWith("!!<") ? first : -1;
  lines.splice(tagLine >= 0 ? tagLine + 1 : Math.max(first, 0), 0, ...rendered);
}

/** Set, replace, or drop (`meta === null`) a DOCUMENT's own leading `!!<…>` tag — the one place a
 *  tag is a line of its own rather than an inline prefix. */
function setRootTag(lines: string[], meta: string | null): void {
  const at = lines.findIndex(isContentLine);
  const existing = at >= 0 && lines[at].trim().startsWith("!!<") ? at : -1;
  if (meta === null) {
    if (existing >= 0) lines.splice(existing, 1);
    return;
  }
  if (existing >= 0) lines[existing] = `!!<${meta}>`;
  else lines.splice(Math.max(at, 0), 0, `!!<${meta}>`);
}

// --- flow-row cell surgery (docs/documents/marklower) --------------------------------------------------------- //
// A table's flow row (`- [a, 'b c', *[.-1]]`) is ONE source line; the block engine above cannot
// descend into it. A cell edit — `<table>[r][c]` with a scalar payload — is spliced token-wise:
// the row's `[…]` body splits on top-level commas (quotes and nested brackets respected), the
// target token is re-rendered, and every other cell survives verbatim (pointer spellings and the
// trailing comment included). Multi-line text cannot live in a flow cell (no representation) —
// that edit is rejected; a block-form row accepts it through the ordinary engine.

/** The offset of the flow-sequence `[` opening the entry's value on its own line, or -1. */
function flowValueStart(raw: string, e: ChapterEntry): number {
  let i = indentOf(raw);
  if (raw.startsWith("- ", i)) i += 2;
  while (raw[i] === " ") i++;
  if (raw.startsWith("!!<", i)) {
    const gt = raw.indexOf(">", i);
    if (gt < 0) return -1;
    i = gt + 1;
    while (raw[i] === " ") i++;
  }
  if (e.key !== null) {
    const c = raw.indexOf(":", i);
    if (c < 0) return -1;
    i = c + 1;
    while (raw[i] === " ") i++;
  }
  return raw[i] === "[" ? i : -1;
}

/** Scan a FLOW token from its opener: the matching closer and each top-level cell's [start,end)
 *  span — nesting (a nested flow container, a `*…[.-1]` pointer) and quoted cells respected. Both
 *  bracket kinds nest, so `{a: [1, 2]}` and `[{a: 1}, 2]` scan correctly either way in. */
function scanFlow(s: string, open: number): { close: number; cells: { start: number; end: number }[] } | null {
  const closerOf = s[open] === "[" ? "]" : "}";
  let depth = 0;
  let q: string | null = null;
  const cells: { start: number; end: number }[] = [];
  let cellStart = open + 1;
  for (let j = open; j < s.length; j++) {
    const ch = s[j];
    if (q) {
      if (ch === q) {
        if (q === "'" && s[j + 1] === "'") j++; // a doubled '' is a literal quote
        else q = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (ch !== closerOf) return null; // `[1}` — mismatched, not a token
        if (j > open + 1 || s.slice(open + 1, j).trim().length) cells.push({ start: cellStart, end: j });
        return { close: j, cells };
      }
    } else if (ch === "," && depth === 1) {
      cells.push({ start: cellStart, end: j });
      cellStart = j + 1;
    }
  }
  return null;
}

/** A flow SEQUENCE specifically (the MARKLOWER row surgery's entry point — a `{…}` is not a row). */
function scanFlowSeq(s: string, open: number): { close: number; cells: { start: number; end: number }[] } | null {
  return s[open] === "[" ? scanFlow(s, open) : null;
}

/** True when `src` is ONE complete flow token: a single line whose trimmed text opens with `[`/`{`
 *  and whose MATCHING closer is its last character. Such a payload is a VALUE, not entry lines —
 *  without this `{a: 1}` satisfies {@link opensEntry} (its leading `{` passes the first-character
 *  class and `a: ` reads as a key), so the token the author typed is torn apart into a block
 *  mapping. `[12, 13, 14]` slips through today only because it carries no colon. */
function isFlowToken(src: string): boolean {
  const t = src.trim();
  if (t[0] !== "[" && t[0] !== "{") return false;
  const scan = scanFlow(t, 0); // newline-agnostic: it counts quotes and brackets, so K&R scans too
  return scan !== null && scan.close === t.length - 1;
}

/** The column of a flow opener on `line` that does NOT close there — the head of a **K&R value**, a
 *  flow token spanning the lines below it (an inline concrete switch to json5p, docs/language/concretes/00-storage/00-inlined). -1 when the line opens no such token. Quote-aware, and blind to a comment. */
function flowOpenAt(line: string): number {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === q) {
        if (q === "'" && line[i + 1] === "'") i++;
        else q = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) return -1; // a comment
    if (ch === "[" || ch === "{") return scanFlow(line, i) === null ? i : -1;
  }
  return -1;
}

/** The index of the line that CLOSES a K&R value opened on line `i`, or -1 when line `i` opens no
 *  span (or nothing closes it — a malformed file keeps the old line-at-a-time behaviour).
 *
 *  THE WHOLE POINT: a K&R value is ONE value written across several lines, so every line-level
 *  reader here — the entry scanner, the container test, the facet reader — must step OVER its
 *  interior. Without this the splicer read `a: {` + two indented lines as an entry with children
 *  and rewrote them as block mapping lines, dropping the flow commas and corrupting the file. */
function flowSpanEnd(lines: string[], i: number): number {
  const open = flowOpenAt(lines[i]);
  if (open < 0) return -1;
  let joined = lines[i];
  for (let n = i + 1; n < lines.length; n++) {
    joined += "\n" + lines[n];
    if (scanFlow(joined, open) !== null) return n;
  }
  return -1;
}

/** A cell value as a flow-sequence token: plain when the flow lexer takes it whole — non-empty,
 *  no whitespace/`, [ ] : # ' "`, not opening with a sigil (`* & - | > !`) — else single-quoted
 *  with `''` doubling (the one escape the parser reads; double-quote backslashes do NOT parse). */
function flowCellToken(s: string): string {
  const plain = s.length > 0 && s === s.trim() && !/[\s,[\]:#'"{}]/.test(s) && !/^[*&\-|>!]/.test(s);
  return plain ? s : `'${s.replace(/'/g, "''")}'`;
}

/** Emplace a scalar into cell `cellIdx` of the flow row at `row`. Returns false when the row's
 *  value is not a flow sequence (the caller falls through to the block engine's diagnostics). */
function editFlowRowCell(lines: string[], row: ChapterEntry, cellIdx: number, op: string, valueSrc: string): boolean {
  const raw = lines[row.start];
  const open = flowValueStart(raw, row);
  if (open < 0) return false;
  const scan = scanFlowSeq(raw, open);
  if (!scan) return false;
  if (op !== "emplace" && op !== "replace") throw new Error(`a flow-row cell supports emplace/replace only (got \`${op}\`)`);
  const payload = payloadFacets(valueSrc);
  if (payload.scalar === undefined) throw new Error("a flow-row cell takes a scalar value");
  const parsed = parseYamlover(payload.scalar, "cell").root as { kind?: string; value?: unknown };
  if (parsed.kind !== "scalar") throw new Error("a flow-row cell takes a scalar value");
  const text = String(parsed.value ?? "");
  if (text.includes("\n")) throw new Error("a flow-row cell cannot hold multi-line text — rewrite the row in block form (docs/documents/marklower)");
  const cell = scan.cells[cellIdx];
  if (!cell) throw new Error(`no cell ${cellIdx} in the flow row (${scan.cells.length} cells)`);
  const lead = cellIdx === 0 ? "" : " "; // the row's own style: none after `[`, one after `,`
  lines[row.start] = raw.slice(0, cell.start) + lead + flowCellToken(text) + raw.slice(cell.end);
  return true;
}

/** Apply one surgical edit to a `.yo` source, addressed by `within` — the edit path relative
 *  to its document root. Every segment is a key or an ABSOLUTE entry index; the last one names the
 *  node being edited. Returns the new source text.
 *
 *   - `emplace` — replace only the facets `valueSrc` carries; the rest of the node stands.
 *   - `replace` — drop the node's facets and assign `valueSrc`.
 *   - `remove`  — delete the node.
 *   - `insert`  — the new entry takes the position the path names; an index past the end APPENDS,
 *                 which is how a caller who doesn't know the entry count appends to a container.
 *
 *  With an empty `within` the path named the document root: `insert` appends to it, and `emplace`
 *  may set its `!!<…>` tag. */
function editChapterSource(src: string, within: Seg[], op: string, valueSrc: string, meta: string | null | undefined, key?: string, at?: number, flat?: boolean): string {
  const lines = src.split("\n");
  if (within.length === 0) {
    if (op === "insert") {
      assignAt(lines, reachChapter(lines, []), undefined, op, valueSrc, meta, key, undefined, flat);
      return lines.join("\n");
    }
    if (op === "emplace") {
      if (meta !== undefined && !valueSrc) {
        setRootTag(lines, meta);
        return lines.join("\n");
      }
      // A whole FLOW token IS the document's value — `[12, 13, 14]` and `{a: 1}` are complete
      // yamlover documents (JSON is valid YAML). It is not an omni self-value LINE beside entries,
      // so it replaces the body outright; only the `!!<…>` banner and the leading comments stand.
      if (isFlowToken(valueSrc)) {
        if (meta !== undefined && meta !== null) setRootTag(lines, meta);
        setRootFlowValue(lines, valueSrc.trim());
        return lines.join("\n");
      }
      // an EXPLICITLY EMPTY emplace at the root CLEARS the body — the editor's "document
      // emptied" flush, and the only clear a FLOW-rooted document can express (root
      // remove/replace stay refused, and a flow body has no entry addresses). The `!!<…>`
      // banner and the leading comments stand. This branch must run before the scalar-only
      // one: payloadFacets("") reads as an empty SELF-VALUE and used to no-op silently.
      if (op === "emplace" && !valueSrc && meta === undefined) {
        setRootBody(lines, "");
        return lines.join("\n");
      }
      // a scalar-only payload sets the document's SELF-VALUE — a chapter's title (an empty
      // string drops it); the keyed/ordinal entries and the tag line all stand
      const p = payloadFacets(valueSrc);
      if (valueSrc && p.scalar !== undefined && !p.keyed.length && !p.ordinal.length) {
        if (meta !== undefined && meta !== null) setRootTag(lines, meta);
        setRootSelfValue(lines, p.scalar, at);
        return lines.join("\n");
      }
      // a payload carrying ENTRY facets replaces the BODY wholesale — the yed editor's
      // whole-document flush. The facet semantics hold: the payload carries every content
      // facet, so every content facet is replaced; the `!!<…>` banner (the META facet) and
      // the leading comments stand. (An EMPTY emplace still carries no facets — a no-op by
      // the same contract — so an emptied editor does not clear a document; a deliberate
      // clear needs targeted `remove` ops.)
      if (valueSrc) {
        parseYamlover(valueSrc, "<edit>"); // validate before touching the file
        if (meta !== undefined && meta !== null) setRootTag(lines, meta);
        setRootBody(lines, valueSrc);
        return lines.join("\n");
      }
      // …and an EMPTY payload IS that no-op, here as everywhere else: `assignAt` keeps every `had`
      // facet when the payload carries none, so the root must not be the one address where a
      // facetless emplace is an ERROR. The yed mount emits exactly this op when the last token in
      // a document is erased (in an empty tree: type `[`, which auto-closes to `[]` and flushes,
      // then Backspace, which flushes the now-empty root) — a keyless path with nothing to say.
      return lines.join("\n");
    }
    if (op === "replace") {
      // a KIND CONVERSION reaching the DOCUMENT ROOT — the yed diff's leaf↔container replace
      // (T titling a member's only chunk turns the member document into its scalar self):
      // `replace` drops every CONTENT facet wholesale, so the payload IS the new body. The
      // `!!<…>` banner is the DOCUMENT'S IDENTITY, not a content facet: an op that omits
      // `meta` PRESERVES it (the same law emplace follows — dropping it untyped a chapter
      // member into a bare data row); `meta: string` restamps, `meta: null` drops.
      if (valueSrc) parseYamlover(valueSrc, "<edit>"); // validate before touching the file
      if (meta !== undefined) setRootTag(lines, meta);
      setRootBody(lines, valueSrc || "");
      return lines.join("\n");
    }
    throw new Error(`\`${op}\` at a document root needs a key or index target`);
  }
  // a numeric segment into a FLOW row (a table's `- [a, b, c]` / `header: […]`): the block
  // engine cannot descend into the one-line row — splice the cell token instead (docs/documents/marklower)
  const last = within[within.length - 1];
  if (within.length >= 2 && typeof last === "number") {
    const parentR = reachChapter(lines, within.slice(0, -2));
    const rowEntry = findEntry(lines, parentR, within[within.length - 2]);
    if (rowEntry && !isContainerEntry(lines, rowEntry, parentR.indent + 2) && editFlowRowCell(lines, rowEntry, last, op, valueSrc)) {
      return lines.join("\n");
    }
  }
  assignAt(lines, reachChapter(lines, within.slice(0, -1)), within[within.length - 1], op, valueSrc, meta, key, at, flat);
  return lines.join("\n");
}

// --- JSON-family value surgery (flow syntax — the block engine above does not apply) ------------ //
// A `.json`/`.json5`/`.json5p` file is flow-structured (`{ "k": v, … }`, `[ v, … ]`), so a scalar
// value is edited by locating its exact source SPAN and replacing just that token — comments and
// formatting survive (the same span-surgery idea as engine `rewrite.ts`/`mv.ts`). Only a scalar
// leaf value is editable this way; structure/omni edits are not offered for JSON yet.

/** The [start,end) char span of the VALUE token inside an entry span [es,ee). The json5p parser sets
 *  an entry span from the key/`~` marker through the END of its value, so `ee` sits just past the
 *  value; we walk back from there over the one trailing token (a quoted string — matched to its
 *  unescaped opening quote — or a bare number/keyword up to the first delimiter). */
function jsonValueSpan(src: string, es: number, ee: number): [number, number] {
  const last = src[ee - 1];
  if (last === '"' || last === "'") {
    for (let j = ee - 2; j >= es; j--) {
      if (src[j] !== last) continue;
      let bs = 0;
      for (let k = j - 1; k >= es && src[k] === "\\"; k--) bs++;
      if (bs % 2 === 0) return [j, ee]; // an unescaped opening quote of the same kind
    }
    throw new Error("could not locate the string value in the source");
  }
  let j = ee;
  while (j > es && !/[\s,:{}[\]]/.test(src[j - 1])) j--;
  return [j, ee];
}

/** The edited value arrives as YAMLOVER source (the yamlover renderer is the universal edit surface),
 *  so for a JSON-family target we parse it and re-serialize the scalar as a JSON token: `~`→`null`,
 *  `0x1F`→`31`, a bare/quoted string→a JSON double-quoted string, etc. A number keeps its source
 *  spelling when that is already valid JSON (so `1.0`/`1e3` survive). Throws for a non-scalar payload
 *  or a parse error (→ 400, file untouched). */
function yamloverScalarToJsonToken(valueSrc: string): string {
  const root = parseYamlover(valueSrc, "<edit>").root;
  if (root.kind !== "scalar") throw new Error("only a scalar value is editable in a JSON file");
  const v = root.value;
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(root.raw) ? root.raw : String(v);
  return JSON.stringify(v);
}

/** Replace the scalar value at `within` (a path relative to the document root — a key or an absolute
 *  positional index per segment) in a JSON-family source, returning the new text. `token` is already
 *  a JSON scalar token. Only a scalar target is supported; descending anything but a mapping, or
 *  targeting a non-scalar, throws. */
function editJsonScalar(src: string, within: Seg[], token: string): string {
  if (within.length === 0) throw new Error("cannot edit the JSON document root as a scalar value");
  let node: IrNode = parseJson5p(src, "<edit>").root;
  for (let k = 0; k < within.length; k++) {
    const seg = within[k];
    const entries = node.entries ?? [];
    const entry: IrEntry | undefined =
      typeof seg === "number"
        ? entries.filter((e) => e.edge === "contain" && e.key === null && e.nullKey !== true)[seg] // positional element
        : seg === null
          ? entries.find((e) => e.edge === "contain" && e.nullKey === true) // the NULL-keyed field
          : entries.find((e) => e.edge === "contain" && e.key === seg); // keyed field
    if (!entry) throw new Error(`no entry at ${segToken(seg)}`);
    const value = entry.value;
    if (k === within.length - 1) {
      if (isPointer(value) || value.kind !== "scalar") throw new Error("only a scalar value is editable in a JSON file");
      const span = entry.meta?.span;
      if (!span) throw new Error("no source span for the target value");
      const [vs, ve] = jsonValueSpan(src, span.start, span.end);
      return src.slice(0, vs) + token + src.slice(ve);
    }
    if (isPointer(value) || value.kind !== "mapping") throw new Error(`cannot descend into a non-container at ${segToken(seg)}`);
    node = value;
  }
  throw new Error("empty JSON edit path"); // unreachable (within.length checked)
}

/** A one-line `*…` pointer — a legal entry VALUE, but not a legal document on its own, so it never
 *  goes through the document parser. */
const isPointerValue = (src: string): boolean => /^\*\S*$/.test(src.trim()) && !src.includes("\n");

/** The deepest prefix of `segs` that is an ON-DISK dir-backed document (its instance overlay
 *  exists) — the filesystem's view of the document root, independent of the index. Null when
 *  no prefix (the served root included) has a body on disk. */
function fsDocRootSegs(dataRoot: string, segs: Seg[]): { docSegs: Seg[]; bodyFile: string } | null {
  for (let i = segs.length; i >= 0; i--) {
    const sub = segs.slice(0, i);
    if (!sub.every((g) => typeof g === "string")) continue;
    const body = dirBodyFile(path.resolve(dataRoot, ...sub.map(String)));
    if (fs.existsSync(body)) return { docSegs: sub, bodyFile: body };
  }
  return null;
}

/** A filesystem directory that backs NO yamlover document — it has no instance overlay to
 *  splice, so what you add to it is a member file/directory, not an entry in some source. */
function isPlainDir(dataRoot: string, s: Store, segs: Seg[]): boolean {
  if (!segs.every((g) => typeof g === "string")) return false;
  const abs = path.resolve(dataRoot, ...segs.map(String));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return false;
  try {
    chapterSource(dataRoot, s, segs);
    return false; // a dir-backed document: it has a body to edit
  } catch {
    return true;
  }
}

/** Store-CANONICALIZE a client path: a NUMERIC segment is a position (`[n]`), and a position may
 *  alias a KEYED member (docs/language/pointers — "a keyed entry's position is a `*`-alias to it"; the members
 *  of a dir-backed pointer-array body, examples/56). The store paths keyed children BY KEY, so a
 *  positional segment with no keyless node behind it rewrites to the key of the contain entry at
 *  that position. `keepLast` leaves the FINAL segment untouched — an edit's terminal position
 *  must stay positional so a file-level splice (remove/emplace of a pointer-array ELEMENT) hits
 *  the body line, never the member document behind it. */
function canonSegs(s: Store, segs: Seg[], keepLast: boolean): Seg[] {
  const out: Seg[] = [];
  const end = keepLast ? segs.length - 1 : segs.length;
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    if (i < end && typeof g === "number" && !s.node(storePath([...out, g]))) {
      // A HIDDEN member (the `.yo` overlay) occupies a position in the index but NOT in the
      // body's positional space — the projections that define that space omit it. Aliasing to one
      // would point a positional edit at the overlay: in a fresh project whose body is still empty,
      // `:[0]` would resolve to `:.yo` and the edit would write `.yo/.yo/`.
      const hit = s.entries(storePath(out)).find((c) => c.kind === "contain" && c.pos === g && c.label != null && !isHidden(s, c.to));
      if (hit) { out.push(hit.label!); continue; }
    }
    out.push(g);
  }
  return out;
}

/** One edit, resolved to the file it lands in. */
interface ResolvedEdit {
  within: Seg[];
  op: string;
  valueSrc: string;
  meta: string | null | undefined;
  concrete?: string;
  name?: string;
  key?: string; // insert only: make a KEYED entry at the position (order-preserving)
  at?: number; // scalar emplace: the self-value line's position — entries preceding it
  flat?: boolean; // insert only: join the key and the payload's first row as ONE flat row
  docSegs: Seg[];
  dirBacked: boolean;
}

/** `concrete: file/yamlover | dir/.yo | dir/index.yo` — the content is born as its OWN document beside the
 *  parent, and what lands in the parent's source is a `*` pointer to it. Returns the pointer source
 *  and the new document's node path (what a create navigates to). */
function bornAsDocument(dataRoot: string, e: ResolvedEdit, tag: string | undefined, neighbors: { prevName?: string; nextName?: string } = {}): { pointer: string; path: string } {
  const writeDirSegs = e.dirBacked ? e.docSegs : e.docSegs.slice(0, -1);
  const writeDir = path.resolve(dataRoot, ...writeDirSegs.map(String));
  const src = [...(tag ? [tag] : []), e.valueSrc, ""].join("\n");
  // a linked document is reached by a `*` pointer → name it pointer-safe: no whitespace or
  // metachars, but unicode letters KEPT (pointerSafeName — a Cyrillic title must not collapse
  // into underscores). A DIRECTORY member additionally carries an order-number prefix
  // (`01-Введение`; a between-insert slots `01-1-…` from its body neighbors — cosmetic listing
  // order, existing members never renamed). The client births compute the same name
  // (nextMemberName/pointerSafeName are shared) for keyed follow-up addressing.
  const title = String(e.name || "object");
  const base = isOverlayDirConcrete(e.concrete)
    ? nextMemberName(fs.existsSync(writeDir) ? fs.readdirSync(writeDir) : [], "title", { ...neighbors, title })
    : pointerSafeName(title);
  const final = writeObject(dataRoot, writeDir, base, e.concrete!, src);
  const targetSegs = [...writeDirSegs, final];
  return { pointer: e.dirBacked ? memberPointer(final) : projectPointer(targetSegs), path: segsToStr(targetSegs) };
}

/** Apply a BATCH of edits, grouped by their backing file (a document can span several — each part
 *  routes to its own via {@link chapterSource}). Ops for one file fold in order, each re-scanning
 *  the buffer the previous one left, so absolute indices stay consistent; each touched file is
 *  written once. Returns the touched files (to reindex) and any document born along the way. */
function applyEdits(dataRoot: string, s: Store, edits: EditInput[]): { touched: string[]; created: string[]; appended: Seg[][]; movedStorage: boolean } {
  let movedStorage = false;
  // detached members' storage, archived to `.yo/.trash/` only AFTER the whole batch commits
  const pendingArchives: { abs: string; name: string }[] = [];
  const byFile = new Map<string, ResolvedEdit[]>();
  const jsonByFile = new Map<string, { within: Seg[]; valueSrc: string }[]>(); // JSON-family scalar edits
  const appended: Seg[][] = []; // parents an INLINE entry was appended to — their new last child is the created node
  const created: string[] = [];
  // Members BORN EARLIER IN THIS BATCH at a known body position: a later edit in the same batch
  // may still address them positionally (`:d[1][1]` — fast typing, Tab-wrap follow-ups) while the
  // index is stale and canonSegs can't see them. Recorded at birth, prefix-rewritten here.
  const remap: { parent: Seg[]; index: number; name: string }[] = [];
  const applyRemap = (segs: Seg[]): Seg[] => {
    let out = segs;
    for (let changed = true; changed; ) {
      changed = false;
      for (const r of remap) {
        if (out.length > r.parent.length && out[r.parent.length] === r.index && r.parent.every((g, i) => out[i] === g)) {
          out = [...r.parent, r.name, ...out.slice(r.parent.length + 1)];
          changed = true;
        }
      }
    }
    return out;
  };
  /** A body's source INCLUDING the ops queued earlier in this batch but not yet written — the state
   *  a later edit in the same batch is addressed against. Nothing is written, so a batch that fails
   *  half-way still leaves the document untouched. */
  const pendingSrc = (bodyFile: string): string => {
    let src: string;
    try {
      src = fs.readFileSync(bodyFile, "utf8");
    } catch {
      return "";
    }
    try {
      for (const o of byFile.get(bodyFile) ?? []) src = editChapterSource(src, o.within, o.op, o.valueSrc, o.meta, o.key, o.at, o.flat);
    } catch {
      return src; // a queued op that cannot fold will fail loudly at the end of the batch
    }
    return src;
  };
  for (const e of edits) {
    const editSegs = applyRemap(canonSegs(s, strToSegs(e.path ?? ""), true));
    const op = String(e.op ?? "");

    // A directory that backs no document has no source to splice: inserting into it creates a
    // MEMBER — a document of its own, named for itself rather than pointed at from a parent's body.
    // (A dir-BACKED document is a directory too, but `chapterSource` finds its body, so it lands in
    // the ordinary path below and gains a child.)
    if (op === "insert" && (e.concrete === "file/yamlover" || isOverlayDirConcrete(e.concrete)) && isPlainDir(dataRoot, s, editSegs)) {
      const dir = path.resolve(dataRoot, ...editSegs.map(String));
      const src = [...(metaTag(e.meta, undefined, false) ? [metaTag(e.meta, undefined, false)!] : []), String(e.yamlover ?? ""), ""].join("\n");
      if (e.yamlover) parseYamlover(String(e.yamlover), "<edit>");
      const final = writeObject(dataRoot, dir, objectBaseName(String(e.name || "new")), String(e.concrete), src);
      created.push(segsToStr([...editSegs, final]));
      continue;
    }

    // A BARE folder (`concrete:"dir"`): just an OS directory — no body, no pointer, no .yo
    // marker. Legal inside any filesystem directory (a plain dir OR a dir-backed document); the
    // walk discovers it as a keyed member. `meta`/`yamlover` are ignored — it carries neither.
    // Must divert BEFORE the body-splicing path: `"dir"` has no `/`, so falling through would
    // misread it as an inline append into the parent's source.
    if (op === "insert" && e.concrete === "dir") {
      if (!editSegs.every((g) => typeof g === "string")) throw new Error("a folder needs a directory parent");
      const abs = path.resolve(dataRoot, ...editSegs.map(String));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error("a folder can only be created inside a directory");
      const final = uniqueName(abs, objectBaseName(String(e.name || "New Folder")));
      mkdirInside(dataRoot, path.join(abs, final));
      created.push(segsToStr([...editSegs, final]));
      continue;
    }

    // A DIRECTORY TARGET (concrete-rules.ts): a directory is editable like any yamlover node —
    // WHERE a new child is encoded is the derivation policy's call. A keyed CONTAINER child
    // becomes a nested REAL directory (recursively); scalar/ordinal children and the directory's
    // own scalar self-value live in its `.yo/body.yo` overlay, created on demand.
    // A dir WITH a body keeps today's body-splicing for everything but keyed-container inserts
    // (positional chapter edits depend on the body's index space); explicit `concrete:` branches
    // above keep precedence.
    {
      const stripped = op === "insert" && typeof editSegs[editSegs.length - 1] === "number" ? editSegs.slice(0, -1) : editSegs;
      const absDir = stripped.every((g) => typeof g === "string") ? path.resolve(dataRoot, ...stripped.map(String)) : null;
      const isDirTarget = absDir !== null && fs.existsSync(absDir) && fs.statSync(absDir).isDirectory();
      if (isDirTarget) {
        const bodyFile = dirBodyFile(absDir);
        // the routing DECISION is concrete-rules.ts's (deriveDirEditRoute) — only the observed
        // state is gathered here; see the policy's doc for why disk and index must agree
        const target = {
          hasBody: fs.existsSync(bodyFile),
          indexedAsDocument: !!s.node(storePath(stripped))?.meta?.documentRoot,
        };
        const valueSrc = String(e.yamlover ?? "");
        const meta = e.meta === undefined ? undefined : e.meta === null ? null : String(e.meta);
        const at = typeof e.at === "number" && Number.isFinite(e.at) && e.at >= 0 ? Math.floor(e.at) : undefined;
        const pushBodyOp = (key?: string): void => {
          ensureDirBody(dataRoot, absDir!);
          const list = byFile.get(bodyFile) ?? [];
          list.push({ within: [], op, valueSrc, meta, key, at, docSegs: stripped, dirBacked: true });
          byFile.set(bodyFile, list);
        };
        if (op === "insert" && (!e.concrete || e.concrete === "yamlover")) {
          if (valueSrc && !isPointerValue(valueSrc)) parseYamlover(valueSrc, "<edit>");
          const p = payloadFacets(valueSrc);
          const container = p.keyed.length > 0 || p.ordinal.length > 0;
          const key = e.key === undefined ? undefined : String(e.key);
          let route = deriveDirEditRoute(target, { keyed: key !== undefined, container, tagged: typeof meta === "string" || rootIsYo(valueSrc) });
          // an explicit `concrete: "yamlover"` pins the INLINE encoding — derivation to a
          // sequential item directory applies only to UNDERIVED (concrete-less) inserts
          if (route === "dir-seq" && e.concrete) route = deriveDirEditRoute(target);
          // THE FORMAT GUARD (validate.ts). The routing decision is made and the writes it implies
          // are known, but nothing has touched the disk yet — the one point where "this container
          // is about to be spliced inline instead of promoted to a directory" is decidable. Names
          // and neighbors are resolved here so the guard sees the member name the branch will use.
          const dirNames = route === "dir" || route === "dir-seq" ? fs.readdirSync(absDir) : undefined;
          const lastSeg = editSegs[editSegs.length - 1];
          const seqName =
            route === "dir-seq"
              ? nextMemberName(dirNames!, "item", memberNeighbors(bodyFile, [], typeof lastSeg === "number" ? lastSeg : undefined))
              : undefined;
          const memberName = route === "dir" ? key : seqName;
          const bodySplice: PlannedWrite = { kind: "splice", fsPath: relPosix(dataRoot, bodyFile) };
          const memberConcrete = memberFlavor(absDir);
          const snap: WriteSnapshot = {
            target: {
              path: segsToStr(stripped),
              concrete: dirConcreteOf(absDir),
              fsPath: relPosix(dataRoot, absDir),
              names: dirNames,
            },
            child: { keyed: key !== undefined, container, tagged: typeof meta === "string" || rootIsYo(valueSrc) },
            route,
            explicitConcrete: e.concrete ?? null,
            memberName,
            writes: memberName
              ? [{ kind: "dir", fsPath: relPosix(dataRoot, path.join(absDir, memberName)), concrete: memberConcrete }, ...(route === "dir-seq" ? [bodySplice] : [])]
              : [bodySplice],
          };
          logDiagnostics(enforce(validateWrite(snap), validationMode()));
          if (route === "dir") {
            writeDirMemberTree(dataRoot, absDir, key!, valueSrc, meta);
            created.push(segsToStr([...stripped, key!]));
            continue;
          }
          if (route === "dir-seq") {
            // an UNTAGGED ordinal container: an order-numbered item directory (item01, item02, …;
            // a between-insert slots item01-1, never renumbering) plus a body pointer-array
            // element granting its POSITION — the examples/56 shape (concrete-rules.ts). The
            // pointer splices at the insert's own index; the member's name is recorded so
            // same-batch follow-ups addressing `[i][j]` land inside it.
            const last = lastSeg;
            const name = seqName!;
            writeObject(dataRoot, absDir, name, memberConcrete, [valueSrc, ""].join("\n"));
            created.push(segsToStr([...stripped, name]));
            if (typeof last === "number") remap.push({ parent: stripped, index: last, name });
            ensureDirBody(dataRoot, absDir);
            const list = byFile.get(bodyFile) ?? [];
            list.push({ within: typeof last === "number" ? [last] : [], op: "insert", valueSrc: memberPointer(name), meta: undefined, docSegs: stripped, dirBacked: true });
            byFile.set(bodyFile, list);
            continue;
          }
          if (route === "body") { pushBodyOp(key); continue; }
          // "document": an established document root — fall through, its body's own positional
          // index space (chapter subchapter inserts and the like) applies
        } else if (op === "emplace" && editSegs === stripped && deriveDirEditRoute(target) === "body") {
          // self-value of a dir with no established body: materialize the overlay, splice the self line
          pushBodyOp();
          continue;
        }
      }
    }

    // THE SCALAR→CONTAINER PROMOTION (concrete-rules.ts {@link subchapterMaterializes}): the moment
    // an inline node living in a DIRECTORY-backed document gains CONTAINER content, its inherited
    // storage family is "directory" (a dir keeps its members directory-concrete), so it lifts OUT of
    // the enclosing body into its own real member. Birth order stops mattering: `world: World` grown
    // a child lands in the SAME shape as a `world` born already populated. The child re-derives
    // INSIDE the new body (a scalar leaf stays inline, a container recurses — writeDirMemberTree).
    // Two edit shapes reach the transition: the omni first-child commit EMPLACES the whole node
    // (self + child in the payload — commitSpine), and a direct INSERT adds a child under a
    // still-scalar member (the self-value is read from the body and the child appended). A pure
    // scalar emplace (a title edit, no entries) is NOT a transition and stays inline.
    //
    // WHICH member shape it takes is {@link deriveMemberEncoding}'s call, exactly as it is at birth
    // — a KEYED node becomes a directory named by its key, an untagged ORDINAL element a
    // sequentially-named one whose position is granted by a `- *: itemNN` pointer left in its place.
    // A tagged ordinal container (a table, a typographic list) is CONTENT and stays inline.
    if ((op === "insert" || op === "emplace" || op === "replace") && (!e.concrete || e.concrete === "yamlover")) {
      const tail = editSegs[editSegs.length - 1];
      // the node that WILL hold container content: for an insert-child it is the PARENT (the edit's
      // trailing index is the child position); for emplace/replace it is the target itself.
      const nodeSegs = op === "insert" && typeof tail === "number" ? editSegs.slice(0, -1) : editSegs;
      const nodeKey = nodeSegs[nodeSegs.length - 1];
      // Resolve the enclosing document FS-FIRST, exactly as the generic path below does: a body born
      // earlier in THIS batch is invisible to the stale index, which would otherwise route the node
      // to the enclosing document instead of the one that now owns it.
      const idxBack = resolveBacking(dataRoot, s, nodeSegs);
      const fsBack = fsDocRootSegs(dataRoot, nodeSegs);
      const nBack = fsBack && fsBack.docSegs.length > idxBack.docSegs.length ? { ...fsBack, dirBacked: true } : idxBack;
      const nodeRow = s.node(storePath(nodeSegs));
      const inlineHere = nBack.docSegs.length < nodeSegs.length; // the node lives INSIDE the enclosing document's body
      const inlineKeyed = typeof nodeKey === "string" && nodeSegs.every((g) => typeof g === "string") && inlineHere;
      // an ORDINAL element promotes the same way. Its pointer is DOCUMENT-scoped, so the member
      // always lands beside the document root whatever depth the element itself sits at — only the
      // document's own segments need to name real directories.
      const inlineOrdinal = typeof nodeKey === "number" && inlineHere && nBack.docSegs.every((g) => typeof g === "string");
      const docRow = inlineKeyed || inlineOrdinal ? s.node(storePath(nBack.docSegs)) : null;
      // The enclosing document's concrete: from the index when it knows the node, else from the
      // FILESYSTEM — a document born earlier in this batch is not indexed yet, and `dirBacked`
      // already answers the only question the rule asks (is a directory backing it?).
      const encConcrete = docRow
        ? concreteOf(s, dataRoot, nBack.docSegs, docRow)
        : nBack.dirBacked
          ? dirConcreteOf(path.resolve(dataRoot, ...nBack.docSegs.map(String)))
          : "yamlover";
      if ((inlineKeyed || inlineOrdinal) && subchapterMaterializes(encConcrete)) {
        // the node's full VALUE source AFTER this edit, when the edit gives it container content
        let memberSrc: string | null = null;
        let memberMeta: string | null | undefined;
        if (op === "emplace" || op === "replace") {
          const f = payloadFacets(String(e.yamlover ?? ""));
          if (f.keyed.length > 0 || f.ordinal.length > 0) { // the new value IS a container
            memberSrc = String(e.yamlover ?? "");
            memberMeta = e.meta;
          }
        } else if (!nodeRow || nodeRow.type === "scalar") {
          // A scalar gains its FIRST child: old self-value (from the body) + the new child appended.
          // The body is read WITH this batch's pending ops folded in, so a node inserted a moment
          // ago in the same batch (fast typing: `- World` then a child under it) is visible even
          // though neither the index nor the disk knows it yet — which is also why the scalar test
          // is made against the ENTRY rather than the index row.
          const pending = pendingSrc(nBack.bodyFile);
          const lines: string[] | null = pending ? pending.split(/\r?\n/) : null;
          const within = nodeSegs.slice(nBack.docSegs.length);
          let region: ReturnType<typeof reachChapter> | null = null;
          try {
            region = lines ? reachChapter(lines, within.slice(0, -1)) : null;
          } catch {
            region = null; // an ancestor is itself a scalar — not a transition this edit can make
          }
          const entry = lines && region ? findEntry(lines, region, within[within.length - 1]) : undefined;
          // an inline `!!<…>` tag on the scalar is NOT carried by this path — leave it inline
          if (lines && region && entry && !isContainerEntry(lines, entry, region.indent + 2) && !/!!<[^>]*>/.test(lines[entry.start])) {
            const head = entryHead(lines, entry);
            const rest: string[] = [];
            let ci = -1;
            for (let i = entry.start + 1; i < entry.end; i++) {
              if (!isContentLine(lines[i])) { rest.push(""); continue; }
              if (ci < 0) ci = indentOf(lines[i]);
              rest.push(indentOf(lines[i]) >= ci ? lines[i].slice(ci) : lines[i].trimStart());
            }
            const selfSrc = [head, ...rest].join("\n").replace(/\s+$/, "");
            const childVal = String(e.yamlover ?? "");
            if (childVal && !isPointerValue(childVal)) parseYamlover(childVal, "<edit>");
            const marker = e.key !== undefined ? `${keyToken(String(e.key))}: ` : "- ";
            const childLines = renderEntry(childVal, 0, marker, metaTag(e.meta, undefined, false));
            memberSrc = [selfSrc, ...childLines].filter((l, i) => !(i === 0 && l === "")).join("\n");
          }
        }
        // A TAGGED ordinal container is content, not structure — deriveMemberEncoding says "body",
        // and this node stays where it is. Content is content ALL THE WAY DOWN: a node INSIDE an
        // inline tagged container (a table's row, a list's sublist) never promotes out of it —
        // a `- *: itemNN` pointer in the middle of a content unit breaks the positional
        // addressing every following edit uses (the reported "cannot descend into a scalar
        // element" sync failure, reproduced by a table growing across two flushes).
        const insideContent = ((): boolean => {
          const pending = pendingSrc(nBack.bodyFile);
          if (!pending) return false;
          const lines = pending.split(/\r?\n/);
          const within = nodeSegs.slice(nBack.docSegs.length);
          try {
            for (let i = 0; i < within.length - 1; i++) {
              const region = reachChapter(lines, within.slice(0, i));
              const entry = findEntry(lines, region, within[i]);
              if (!entry) return false;
              if (/!!<[^>]*>/.test(lines[entry.start])) return true; // the RAW line — entryHead strips the tag
            }
          } catch { return false; }
          return false;
        })();
        const enc = memberSrc === null ? "body" : deriveMemberEncoding({ keyed: inlineKeyed, container: true, tagged: typeof memberMeta === "string" || rootIsYo(memberSrc), insideContent });
        if (enc !== "body") {
          if (memberSrc && !isPointerValue(memberSrc!)) parseYamlover(memberSrc!, "<edit>");
          const docAbs = path.resolve(dataRoot, ...nBack.docSegs.map(String));
          const within = nodeSegs.slice(nBack.docSegs.length);
          const idx = within[within.length - 1];
          const names = fs.readdirSync(docAbs);
          const memberConcrete = memberFlavor(docAbs);
          const memberName =
            enc === "dir"
              ? String(nodeKey)
              : nextMemberName(names, "item", memberNeighbors(nBack.bodyFile, within.slice(0, -1), typeof idx === "number" ? idx : undefined));
          // THE FORMAT GUARD (validate.ts), on the OTHER surface a member is born — same rules, same
          // snapshot shape, still before the first mkdir.
          logDiagnostics(
            enforce(
              validateWrite({
                target: { path: segsToStr(nBack.docSegs), concrete: encConcrete, fsPath: relPosix(dataRoot, docAbs), names },
                child: { keyed: inlineKeyed, container: true, tagged: typeof memberMeta === "string" || rootIsYo(memberSrc) },
                route: enc,
                memberName,
                writes: [
                  { kind: "dir", fsPath: relPosix(dataRoot, path.join(docAbs, memberName)), concrete: memberConcrete },
                  { kind: "splice", fsPath: relPosix(dataRoot, nBack.bodyFile) },
                ],
              }),
              validationMode(),
            ),
          );
          const list = byFile.get(nBack.bodyFile) ?? [];
          if (enc === "dir") {
            writeDirMemberTree(dataRoot, docAbs, nodeKey as string, memberSrc!, memberMeta);
            created.push(segsToStr(nodeSegs));
            // the key still names the node, so the orphaned inline line simply goes
            list.push({ within, op: "remove", valueSrc: "", meta: undefined, docSegs: nBack.docSegs, dirBacked: nBack.dirBacked });
          } else {
            // dir-seq: the member is born beside the document root under a generated order-numbered
            // name, and the element KEEPS its position — its value becomes the pointer granting it.
            writeObject(dataRoot, docAbs, memberName, memberConcrete, memberSrc!.replace(/\n*$/, "") + "\n");
            created.push(segsToStr([...nBack.docSegs, memberName]));
            list.push({ within, op: "emplace", valueSrc: memberPointer(memberName), meta: undefined, docSegs: nBack.docSegs, dirBacked: nBack.dirBacked });
            // Same-batch positional follow-ups (`:[0][0]` typed fast) — recorded only for an element
            // at the body's TOP level, the one depth at which the member's path IS parent+name. A
            // document-scoped pointer further down resolves beside the document root instead, which
            // this remap shape cannot express; after the batch, canonSegs resolves it either way.
            if (within.length === 1 && typeof idx === "number") remap.push({ parent: nBack.docSegs, index: idx, name: memberName });
          }
          byFile.set(nBack.bodyFile, list);
          continue;
        }
      }
    }

    // A JSON-family file (flow syntax) can't use the block engine — route its scalar `emplace` edits
    // to the span-surgical JSON editor. Only value edits for now (no insert/remove/structure).
    const backing = resolveBacking(dataRoot, s, editSegs);
    if (!backing.dirBacked && JSON_FILE.test(backing.bodyFile)) {
      if (op !== "emplace") throw new Error("only scalar value edits (emplace) are supported for JSON files");
      const jlist = jsonByFile.get(backing.bodyFile) ?? [];
      jlist.push({ within: editSegs.slice(backing.docSegs.length), valueSrc: String(e.yamlover ?? "") });
      jsonByFile.set(backing.bodyFile, jlist);
      continue;
    }

    // A document body BORN EARLIER IN THIS BATCH (ensureDirBody / writeDirMemberTree) is
    // invisible to the stale index: documentRootSegs would route a deep path to the ENCLOSING
    // document. The filesystem already knows — the deepest on-disk dir-backed document wins
    // when it sits STRICTLY deeper than the index's answer.
    const fsDoc = fsDocRootSegs(dataRoot, editSegs);
    const { docSegs, bodyFile, dirBacked } =
      fsDoc && fsDoc.docSegs.length > documentRootSegs(s, editSegs).length
        ? { ...fsDoc, dirBacked: true }
        : chapterSource(dataRoot, s, editSegs, BLOCK_YAML);
    if (op === "remove" && editSegs.length > 0 && docSegs.length === editSegs.length) {
      // REMOVING A MEMBER DOCUMENT: a root remove routed into the member has no meaning (a
      // document cannot remove itself) — the op DETACHES it from the PARENT instead: the
      // pointer entry granting its position goes, and the member's storage ARCHIVES into the
      // parent's `.yo/.trash/` (TRASH ON DELETE — deletion is never a wall and never
      // destroys; the data survives on disk, recoverable). The archive is queued and runs
      // POST-COMMIT: a mid-batch throw must leave storage untouched. Addressed BY NAME,
      // resolved at splice time (findEntry's member-pointer match), so pending parent ops
      // keep working.
      const memberName = String(editSegs[editSegs.length - 1]);
      const parentSegs = editSegs.slice(0, -1);
      let detach: ResolvedEdit | null = null;
      let detachFile: string | null = null;
      try {
        const pDoc = chapterSource(dataRoot, s, parentSegs, BLOCK_YAML);
        const parentLines = fs.readFileSync(pDoc.bodyFile, "utf8").split("\n");
        const r = reachChapter(parentLines, parentSegs.slice(pDoc.docSegs.length));
        if (findEntry(parentLines, r, memberName) !== undefined) {
          detachFile = pDoc.bodyFile;
          detach = {
            within: [...parentSegs.slice(pDoc.docSegs.length), memberName],
            op: "remove", valueSrc: "", meta: undefined,
            docSegs: pDoc.docSegs, dirBacked: pDoc.dirBacked,
          };
        }
      } catch { /* no parent document at all — the member is unreferenced */ }
      if (detach === null) {
        // an ALREADY-ORPHANED member (no granting line — it surfaced keyed-only): there is
        // nothing to detach, but the row must still be deletable (never a wall). Its storage
        // ARCHIVES into the parent's `.yo/.trash/` — a dot-name the walk skips entirely, so
        // the member leaves the projection while the data survives on disk, recoverable.
        const memberAbs = path.resolve(dataRoot, ...editSegs.map(String));
        const trashDir = path.join(path.dirname(memberAbs), ".yo", ".trash");
        fs.mkdirSync(trashDir, { recursive: true });
        let dest = path.join(trashDir, memberName);
        for (let n = 2; fs.existsSync(dest); n++) dest = path.join(trashDir, `${memberName}-${n}`);
        console.warn(`[/api/edit] remove of ORPHANED member ${segsToStr(editSegs)}: archived ${memberAbs} -> ${dest}`);
        fs.renameSync(memberAbs, dest);
        movedStorage = true; // the graph changed shape — the caller rewalks fully
        continue;
      }
      const list = byFile.get(detachFile!) ?? [];
      list.push(detach);
      byFile.set(detachFile!, list);
      // the detached member's storage (a directory OR a file member) archives after the
      // batch commits — same trash, same collision suffixing as the orphan branch above
      const memberAbs = path.resolve(dataRoot, ...editSegs.map(String));
      if (fs.existsSync(memberAbs)) pendingArchives.push({ abs: memberAbs, name: memberName });
      continue;
    }
    if (op === "insert" && !e.concrete?.includes("/")) {
      // an APPEND (no trailing index, or one past the end) creates the parent's new last child
      const last = editSegs[editSegs.length - 1];
      if (typeof last !== "number") appended.push(editSegs);
      else if (!s.node(storePath(editSegs))) appended.push(editSegs.slice(0, -1));
    }
    const concrete = e.concrete ? String(e.concrete) : undefined;
    if (concrete && concrete !== "yamlover" && op !== "insert" && !(op === "emplace" && !s.node(storePath(editSegs)))) {
      throw new Error("`concrete` is only for content being created — converting an existing node is a move, not an edit");
    }
    const resolved: ResolvedEdit = {
      within: editSegs.slice(docSegs.length),
      op,
      valueSrc: String(e.yamlover ?? ""),
      meta: e.meta === undefined ? undefined : e.meta === null ? null : String(e.meta),
      concrete,
      name: e.name ? String(e.name) : undefined,
      key: e.key === undefined ? undefined : String(e.key),
      at: typeof e.at === "number" && Number.isFinite(e.at) && e.at >= 0 ? Math.floor(e.at) : undefined,
      flat: e.flat === true ? true : undefined,
      docSegs,
      dirBacked,
    };
    if (resolved.concrete === "file/yamlover" || isOverlayDirConcrete(resolved.concrete)) {
      // birth at RESOLUTION time, not in the splice loop: a later edit in this batch may address
      // the newborn member positionally (a Tab-wrap's follow-up chunks) — the remap needs the
      // name NOW. The value becomes its own document; the parent splices a `*` pointer (no tag).
      if (resolved.valueSrc && !isPointerValue(resolved.valueSrc)) parseYamlover(resolved.valueSrc, "<edit>");
      const lastWithin = resolved.within[resolved.within.length - 1];
      const nb = isOverlayDirConcrete(resolved.concrete)
        ? memberNeighbors(bodyFile, resolved.within.slice(0, -1), typeof lastWithin === "number" ? lastWithin : undefined)
        : {};
      const born = bornAsDocument(dataRoot, resolved, metaTag(resolved.meta, undefined, false), nb);
      created.push(born.path);
      const last = editSegs[editSegs.length - 1];
      if (resolved.dirBacked && typeof last === "number") {
        remap.push({ parent: editSegs.slice(0, -1), index: last, name: born.path.slice(born.path.lastIndexOf(":") + 1) });
      }
      resolved.valueSrc = born.pointer;
      resolved.meta = undefined;
      resolved.concrete = undefined;
    }
    const list = byFile.get(bodyFile) ?? [];
    list.push(resolved);
    byFile.set(bodyFile, list);
  }
  // TWO PHASES — splice every file IN MEMORY first, write only when the WHOLE batch spliced
  // clean. A mid-batch throw must leave every file untouched: the reported runaway wrote the
  // first file, threw on the second, and the client's retry loop (committed never advancing)
  // appended a duplicate on every attempt.
  const touched: string[] = [];
  const pendingWrites: [string, string][] = [];
  for (const [bodyFile, ops] of byFile) {
    let src = fs.readFileSync(bodyFile, "utf8");
    for (const o of ops) {
      const { valueSrc, meta } = o;
      // The CALLER's payload must be valid yamlover on its own — parse it before anything is
      // spliced, so a malformed fragment 400s with the document untouched. Two things are legal as
      // an entry's value but not as a whole document, and so are not parsed as one: the `!!<…>` tag
      // (`!!<…> |-`), and a bare `*` pointer (which is what a resolution-time document birth left
      // in `valueSrc` — a `concrete: file/yamlover | dir/.yo` op was born back there, its
      // pointer swapped in and its concrete cleared).
      if (valueSrc && !isPointerValue(valueSrc)) parseYamlover(valueSrc, "<edit>");
      src = editChapterSource(src, o.within, o.op, valueSrc, meta, o.key, o.at, o.flat);
    }
    // the SPLICED document must itself parse: a surgical bug must 400 with the file untouched,
    // never persist a corrupt body (the reported orphaned block lines)
    parseYamlover(src, bodyFile);
    pendingWrites.push([bodyFile, src]);
  }
  for (const [file, jedits] of jsonByFile) {
    let src = fs.readFileSync(file, "utf8");
    for (const j of jedits) {
      src = editJsonScalar(src, j.within, yamloverScalarToJsonToken(j.valueSrc)); // yamlover payload → JSON token
    }
    pendingWrites.push([file, src]);
  }
  for (const [file, src] of pendingWrites) {
    writeBody(dataRoot, s, file, src);
    touched.push(file);
  }
  // TRASH ON DELETE, post-commit: every detached member's storage archives into its parent's
  // `.yo/.trash/` (dirs and file members alike, collision-suffixed) — the batch's writes are
  // durable by now, so a throw above never moved anything.
  for (const a of pendingArchives) {
    if (!fs.existsSync(a.abs)) continue; // an earlier archive took an enclosing directory
    const trashDir = path.join(path.dirname(a.abs), ".yo", ".trash");
    fs.mkdirSync(trashDir, { recursive: true });
    let dest = path.join(trashDir, a.name);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(trashDir, `${a.name}-${n}`);
    console.warn(`[/api/edit] remove of member: archived ${a.abs} -> ${dest}`);
    fs.renameSync(a.abs, dest);
    movedStorage = true; // the graph changed shape — the caller rewalks fully
  }
  return { touched, created, appended, movedStorage };
}

interface EditInput {
  path?: string; // the yamlover path of the node being edited (a key or an absolute index per segment)
  op?: string; // emplace | replace | insert | remove
  yamlover?: string; // the node's value as VALID inline yamlover source — the caller escapes its own prose
  meta?: string | null; // the `!!<…>` schema pointer: set it, `null` to drop it, omit to leave it alone
  concrete?: string; // yamlover | file/yamlover | dir/.yo | dir (a bare folder) — only where content is BORN
  name?: string; // the file/dir name when `concrete` births a document (or a bare folder)
  key?: string; // insert only: create a KEYED entry (`key: value`) at the position — unlike a fresh
                // keyed emplace (which splices at the top of the block), this keeps authored order
  at?: number; // scalar emplace only: the self-value LINE's authored position — the number of
               // entries that precede it. A fresh self line splices there instead of the top;
               // replacing an existing line keeps its position regardless.
  flat?: boolean; // insert only: the payload's first row is a FLAT continuation of the key
                  // (docs/language/flattening) — splice `key: <first row>` as ONE line when the
                  // payload's shape allows (one keyed group, no self value, no tag), else nested.
}

// A dataRoot that never exists: `concreteOf`'s stats throw and every node falls through to plain
// "yamlover" — nothing a standalone-document projection does can reach the real filesystem.
const PREVIEW_ROOT = path.join(os.tmpdir(), ".yo-preview-nonexistent");

/** The envelope-builder capabilities over a Store — shared by the live tree route (members
 *  exist on disk) and the standalone preview (a throwaway in-memory index; nothing on disk). */
function envelopeDeps(s: Store, dataRoot: string, membersOnDisk: boolean): EnvelopeDeps {
  return {
    memberExists: (sg) =>
      membersOnDisk && sg.every((x) => typeof x === "string") && fs.existsSync(path.resolve(dataRoot, ...sg.map(String))),
    formatAt: (sg) => s.node(storePath(sg))?.format ?? null,
    stub: (sg) => (s.node(storePath(sg)) ? linkMarker(dataRoot, s, sg) : null),
    refTargetAt: (holder, pos) => {
      const hit = ownedEntries(s, storePath(holder)).find((e) => e.kind === "ref" && e.pos === pos && e.to);
      if (!hit?.to) return null;
      const tsegs = storePathToSegs(hit.to);
      return {
        path: segsToStr(tsegs),
        text: refPointerText(s, tsegs, refFrameSegs(s, holder as Seg[])),
        stub: s.node(hit.to) ? linkMarker(dataRoot, s, tsegs) : null,
      };
    },
    backEdgesAt: (sg) => {
      const currentDoc = refFrameSegs(s, sg as Seg[]);
      return downstreamEntries(s, storePath(sg))
        .filter((e) => e.pos === null && e.kind === "ref" && e.to)
        .map((e) => {
          const fsegs = storePathToSegs(e.to);
          return {
            label: e.label,
            path: segsToStr(fsegs),
            text: refPointerText(s, fsegs, currentDoc),
            stub: s.node(e.to) ? linkMarker(dataRoot, s, fsegs) : null,
          };
        });
    },
  };
}

/** A STANDALONE yamlover text's content envelope — /api/preview: the same wire the live tree
 *  serves, over a throwaway in-memory index (schema/format resolution included), touching
 *  neither the served tree nor the live index. The client derives NodeJson exactly as it
 *  does for /api/content. */
export function previewEnvelope(source: string): string {
  const doc = parseYamlover(source, "<preview>");
  // stamp what the walk stamps on a parsed file: the root IS a document root, and the head-of-file
  // banner rides its meta (collectComments reads both from the node, not the Document)
  doc.root.meta = { ...doc.root.meta, documentRoot: true, ...(doc.head?.length ? { head: doc.head } : {}) };
  const s = new Store(":memory:");
  try {
    s.indexDocument(doc);
    const row = s.node(":")!;
    const header = {
      path: ":",
      type: tocType(s, ":", row),
      ...facetsOf(s, ":", row),
      format: row.format ?? null,
      concrete: "yamlover", // by construction — the document IS yamlover text
      documentPath: ":",
      title: titleOf(s, ":"),
      description: descriptionOf(s, ":"),
    };
    return buildEnvelope(
      { segs: [], subtree: doc.root, docDepth: Infinity, header, relations: {} },
      envelopeDeps(s, PREVIEW_ROOT, false),
    );
  } finally {
    s.close();
  }
}

/** Apply surgical edits to a STANDALONE yamlover text: the same op semantics as /api/edit
 *  (emplace/replace/insert/remove via {@link editChapterSource}), minus everything that needs a
 *  filesystem — `concrete`/`name` (borning documents) are refused. Each payload is parsed before
 *  any splice (a malformed edit throws with the source untouched), and the final text is re-parsed
 *  before it is returned: the caller persists it verbatim (e.g. into localStorage) with no reindex
 *  behind it to catch a bad splice, so a broken result must never leave this function. */
export function applyTextEdits(src: string, edits: EditInput[]): string {
  let out = src;
  for (const e of edits) {
    if (e.concrete || e.name) throw new Error("`concrete`/`name` are only for file-backed edits");
    const valueSrc = String(e.yamlover ?? "");
    const meta = e.meta === undefined ? undefined : e.meta === null ? null : String(e.meta);
    if (valueSrc && !isPointerValue(valueSrc)) parseYamlover(valueSrc, "<edit>");
    out = editChapterSource(out, strToSegs(String(e.path ?? "")), String(e.op ?? ""), valueSrc, meta,
      e.key === undefined ? undefined : String(e.key),
      typeof e.at === "number" && Number.isFinite(e.at) && e.at >= 0 ? Math.floor(e.at) : undefined);
  }
  parseYamlover(out, "<edit-result>");
  return out;
}

/** The indent of the first content line — the chapter mapping's key column. */
function firstContentIndent(lines: string[]): number {
  for (const l of lines) if (isContentLine(l)) return indentOf(l);
  return 0;
}

/** Walk an end index back over trailing blank lines, so we insert right after the last item. */
function trimBack(lines: string[], lastItemLine: number, end: number): number {
  let e = end;
  while (e > lastItemLine + 1 && !isContentLine(lines[e - 1])) e--;
  return e;
}

/** Read a request body and parse it as JSON. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/** The nearest enclosing DOCUMENT root for `segs` — the closest ancestor (or self) whose node
 *  is flagged `documentRoot` (a parsed file / `.yo` dir / served root), as segments. This is the
 *  STORAGE document: where the bytes live, so it also answers "which file does an edit go to". */
function documentRootSegs(s: Store, segs: Seg[]): Seg[] {
  for (let i = segs.length; i >= 0; i--) {
    const anc = segs.slice(0, i);
    if (s.node(storePath(anc))?.meta?.documentRoot) return anc;
  }
  return [];
}

/** The frame a `:`-scoped REFERENCE resolves in (engine boundary.ts): the storage document, or a
 *  nearer node whose tag opens one — a `!!yo` island, a tagged graph. Storage and reference frames
 *  part ways here, so a pointer is SPELLED the way it will be READ while an edit still routes to
 *  the file that holds the bytes. */
function refFrameSegs(s: Store, segs: Seg[]): Seg[] {
  for (let i = segs.length; i >= 0; i--) {
    const anc = segs.slice(0, i);
    if (isBoundaryRow(s.node(storePath(anc)) ?? undefined)) return anc;
  }
  return [];
}

/** The nearest enclosing document root as a client JSON path (`/…`). */
function documentPath(s: Store, segs: Seg[]): string {
  return segsToStr(documentRootSegs(s, segs));
}

/** A node's title, if any — used as a friendly label. A chapter/task is FULLY OMNI: its title
 *  is the node's own scalar SELF-VALUE (docs/documents/chapter), so read that first; the keyed `title`
 *  child remains as the legacy read for unmigrated files (and for any other schema that still
 *  keys a title). */
function titleOf(s: Store, p: string): string | null {
  const n = s.node(p);
  if ((n?.format === "x-yamlover-chapter" || n?.format === "x-yamlover-task") && n.type === "scalar" && n.value != null)
    return String(n.value);
  return scalarKeyOf(s, p, "title");
}

function descriptionOf(s: Store, p: string): string | null {
  return scalarKeyOf(s, p, "description");
}

/** A node's scalar keyed child `key` (a leaf scalar), or null — the chapter title/description.
 *
 *  CHILDLESSNESS is not part of being a scalar. Annotating a title lays the tag applications over it
 *  as keyed entries (docs/annotations): the row stays a `scalar` carrying its own value, and gains a
 *  child. That is precisely an omni/`variant` node — `type: string` and `type: variant` both match
 *  it (query.ts) — and tagging must never change how a node reads (docs/language/logical-graph/matching). Demanding no
 *  children here made a chapter lose its title, its tree label, and its browser-tab name the moment
 *  anyone annotated it. The `scalar` check stays: a mapping's own value is not a title. */
function scalarKeyOf(s: Store, p: string, key: string): string | null {
  const kp = (p === ":" ? "" : p) + ":" + key;
  const t = s.node(kp);
  if (t && t.type === "scalar" && t.value != null) return String(t.value);
  return null;
}

// --------------------------------------------------------------------------- //
// Path handling (JSON space; matches the client + the Store path scheme)
// --------------------------------------------------------------------------- //

const PATH_TOKEN = /\[\d+\]|[^:\[\]]+/g;

/** Render segments as a client-facing JSON path (`:pets:1:name`, colon-form — the YAML-keys
 *  round: a position is a bare integer segment, a numeric STRING key rides quoted, the null
 *  key is `~`). Each segment's canonical token is percent-encoded whole. */
function segsToStr(segs: Seg[]): string {
  return segs.map((seg) => ":" + encodeURIComponent(segToken(seg))).join("") || ":";
}

/** Classify ONE decoded path token by the bare-token typing rule (shared by the colon and
 *  slash spellings): `~` = the null key, digits = a position, `'…'` = a quoted (string) key,
 *  anything else a bare key with `\x` → `x` unescaping (pathseg.ts's read rule). */
function classifyToken(t: string): Seg {
  if (t === "~") return null;
  if (/^\d+$/.test(t)) return Number(t);
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  return t.replace(/\\(.)/g, "$1");
}

/** Parse a client JSON path into segments — the decoded token classifies by the bare-token
 *  typing rule; the retired `[n]` spelling reads forever as an alias. */
function strToSegs(str: string): Seg[] {
  const out: Seg[] = [];
  for (const tok of str.match(PATH_TOKEN) || []) {
    if (/^\[\d+\]$/.test(tok)) { out.push(Number(tok.slice(1, -1))); continue; }
    out.push(classifyToken(safeDecode(tok)));
  }
  return out;
}

/** Parse the SLASH spelling (`/api/content/<a>/<b>/<0>`): one percent-encoded token per
 *  segment, the same classifier as the colon form; empty = the root. */
function slashToSegs(rest: string): Seg[] {
  return rest.split("/").filter((t) => t !== "").map((t) => classifyToken(safeDecode(t)));
}

/** Build the raw Store path the index uses (pathseg.ts — the ONE spelling). */
function storePath(segs: Seg[]): string {
  return pathOfSegs(segs);
}

/** Parse a raw Store path back into segments (quote-aware; `[n]` reads as the alias). */
function storePathToSegs(p: string): Seg[] {
  return segsOfPath(p);
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// extension → Content-Type for the blob endpoint (mirrors the engine walker's table subset).
const EXT_CT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".tiff": "image/tiff", ".tif": "image/tiff", ".html": "text/html",
  ".md": "text/markdown", ".csv": "text/csv", ".epub": "application/epub+zip",
};
function formatFromExt(file: string): string | null {
  return EXT_CT[path.extname(file).toLowerCase()] ?? null;
}

// Formats the project itself reads and writes as UTF-8 (the walker's TEXT_FORMATS, plus the two
// markup ones served as bytes). They must SAY so: a consumer that decodes the response by the
// header rather than by hand — the HTML iframe, a direct URL, a download — otherwise falls back
// to the browser's locale encoding and mangles every non-ASCII byte. `text/plain` is deliberately
// absent: its encoding is unknown by design and the reader picks it (plaintext.tsx `?enc=`).
const UTF8_CT = new Set([
  "text/html", "image/svg+xml", "text/markdown", "text/asciidoc",
  "text/x-plantuml", "text/csv", "text/tab-separated-values",
]);
function blobContentType(format: string | null): string {
  if (format == null) return "application/octet-stream";
  return UTF8_CT.has(format) ? `${format}; charset=utf-8` : format;
}

// `undefined` = absent (the caller picks a per-concrete default), `Infinity` = `.inf`/`inf`
// (unlimited), a finite integer = that level. A malformed value is treated as absent.
function parseDepth(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  if (raw === ".inf" || raw === "inf") return Infinity;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The render depth when the request pins none: ONE level for a binary leaf or a directory (a plain
 *  folder or a `.yo`-backed directory — the explorer shows one level), else UNLIMITED
 *  (Infinity) so a text document (json/json5/yaml/yamlover, and the value nodes inside it) inlines
 *  whole. A reference is never followed at unlimited depth — it shows as a reference — so the whole
 *  walk stays finite even on a cyclic graph. */
function defaultDepth(s: Store, dataRoot: string, segs: Seg[], row: NodeRow, kind: string): number {
  if (kind === "binary") return 1;
  return isDirConcrete(concreteOf(s, dataRoot, segs, row)) ? 1 : Infinity;
}

/** A `$yamloverRef` marker: a reference shown by its pointer `text`, hyperlinked to `path` —
 *  or plain text when `path` is null (an unrealized ref: dangling or external). */
function refMarker(text: string, path: string | null): Record<string, unknown> {
  return { [REF_KEY]: { text, path } };
}

/** A thumbnail box dimension from the query, clamped to a sane range so a request can't ask the
 *  encoder for a 100000px image; falls back to `def` when absent or unparseable. */
function clampThumbDim(raw: string | null, def: number): number {
  const n = raw == null ? NaN : Math.round(Number(raw));
  return Number.isFinite(n) && n >= 16 ? Math.min(n, 2048) : def;
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}
function notFound(res: ServerResponse, url: URL): void {
  sendJson(res, 404, { error: `no such node/endpoint: ${url.pathname}?${url.searchParams}` });
}
