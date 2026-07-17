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
 *   GET /api/json?path&depth&binary       the node value (depth-limited; nested = link markers)
 *   GET /api/schema?path&depth            the instance schema
 *   GET /api/blob?path                    a file-backed node's raw bytes
 *   GET /api/thumb?path&w&h                a lazily-generated thumbnail of a file-backed blob
 *   GET /api/tagged?path                  the materials filed under a tag (annotations → targets)
 *   GET /api/events                       SSE: {type:"diff",…} reindex diffs + {type:"task",…} progress
 *   GET /api/tasks                        long-running tasks in flight (snapshot for a fresh page)
 *   GET /api/query?q&path                 the 3g query evaluator (colon match templates)
 *   GET /api/dangling                     pointers that did not resolve at index time
 *   POST /api/reindex                     manual reconcile (the watcher's fallback)
 *   POST /api/preview                     render a STANDALONE yamlover text as /api/json would (stateless)
 *   POST /api/edit-text                   the /api/edit ops over a standalone text → new text (stateless)
 *
 * The on-disk index lives at <root>/.yamlover/index.db. It is a derived cache with a persistent
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
import { Store, reindex, reindexAsyncDoc, reindexPathAsync, hashFileAsync, watchTree, loadSettings, ensureSettingsFile, mv, relinkMoved, evalQuery } from "../../../engine/ts/src/index.ts";
import type { NodeRow, EdgeRow, Settings, SidecarLocation, IndexDiff } from "../../../engine/ts/src/index.ts";
import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { parseJson5p } from "../../../parser/ts/src/json5p.ts";
import { pointerToken, schemaTagToken } from "../../../parser/ts/src/serialize-yamlover.ts";
import { renderPointer } from "../../../parser/ts/src/pointer.ts";
import { anchorBody } from "../../../parser/ts/src/serialize-common.ts";
import { appendAnnotation, upsertFragment, upsertThumbnail, removeAnnotation as removeAnnotationItem, annotationsRemain, removeMapEntry, keyToken, appendAnnotationAt, upsertMapEntryAt, removeAnnotationAt, removeMapEntryAt, annotationsRemainAt, reachBodyAt, type Region as EmbedRegion } from "./embed.js";
import { dataFileConcrete, interiorOf, isDirConcrete } from "../concrete.js";
import { renderThumbnail } from "./extract/thumbnails.js";
import { colonSegment } from "../../../parser/ts/src/pointer.ts";
import { isPointer } from "../../../parser/ts/src/ir.ts";
import type { Node as IrNode, Document, Comment as IrComment, Entry as IrEntry } from "../../../parser/ts/src/ir.ts";
import { buildGitIgnore } from "./gitignore.js";
import { displayKind, ownedEntries, typeName, facetsOf } from "./node-kind.js";
import { TaskRegistry } from "./tasks.js";
import type { TaskHandle } from "./tasks.js";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;
interface Options {
  gitignore?: boolean; // honor .gitignore for stray files (default: true)
  watch?: boolean; // watch the tree and re-index on external edits (default: false; bin turns it on)
  log?: (line: string) => void; // server-side progress lines (the bin wires console.log; tests stay silent)
  // Materialize a defaults `settings.yamlover` when absent, so the gear button's settings node
  // always exists (default: false; the bin turns it on). OFF for programmatic/test use, so the
  // pure indexer never writes into the served tree.
  ensureSettings?: boolean;
}

// Marker keys + types the client recognizes (must match src/client expectations).
const LINK_KEY = "$yamloverLink";
const BINARY_KEY = "$yamloverBinary";
const MIXED_KEY = "$yamloverMixed"; // an omni/mix node: a self-value and/or interleaved items+fields
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
type Seg = string | number;
// Node-KIND classification (object|array|scalar|binary|omni|mix → the client `type:`) lives in
// ./node-kind.ts so it can be unit-tested against a Store without the HTTP layer.

export function createHandlers(dataRoot: string, opts: Options = {}): Handler & { close: () => void; ready: Promise<IndexDiff> } {
  const rootName = path.basename(path.resolve(dataRoot)) || "/";
  const dbPath = path.join(dataRoot, ".yamlover", "index.db");
  // Project configuration (<root>/.yamlover/settings.yamlover) — defaults for WRITE paths
  // (e.g. where new annotations are created). Read at startup; reloaded when POST /api/config
  // rewrites the file (so write-path defaults track edits without a server restart).
  const settingsFile = path.join(dataRoot, ".yamlover", "settings.yamlover");
  // The settings file's ROOT-RELATIVE path, in the `/`-joined form an IndexDiff speaks — so a reindex
  // that touched it (via ANY path: the FS watcher on a direct edit, `/api/edit`, `/api/config`) can
  // reload the in-memory Settings. See `broadcast` below.
  const settingsRel = path.relative(dataRoot, settingsFile).split(path.sep).join("/");
  // Materialize a defaults file when absent (serve boundary only — `opts.ensureSettings`), so the
  // config node always exists: the gear button opens `:.yamlover:settings.yamlover`, and a missing
  // file would 404 that fetch. A no-op when the file is already there. Tolerant of a read-only tree:
  // serving must not crash on a write failure.
  if (opts.ensureSettings) {
    try {
      ensureSettingsFile(dataRoot);
    } catch (e) {
      (opts.log ?? (() => {}))(`could not create settings.yamlover: ${(e as Error).message}`);
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
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store0 = new Store(dbPath);
  const store = (): Store => store0;
  // The assembled IR document, retained across reindexes: a single-file edit re-walks only its
  // directory, splices the fresh subtree in, re-resolves IN MEMORY (so cross-file links stay
  // correct), and patches just that subtree's rows — instead of re-walking + rebuilding the whole
  // index. Null until the first full reindex; invalidated when a path-rewriting reconcile runs.
  let cachedDoc: Document | null = null;
  const log = opts.log ?? ((): void => {});
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
  const tasks = new TaskRegistry((t) => sseWrite({ type: "task", task: t }));

  // Thumbnail generation surfaces as ONE coalesced task in the strip (like the index/hasher),
  // not a flood of per-image ones: opening a directory fires many /api/thumb misses, so a single
  // "building thumbnails" task's `total` grows as requests arrive and its `done` catches up as
  // each finishes; it clears when the burst drains. (A cache hit / 415 never reaches here.)
  let thumbTask: TaskHandle | null = null;
  let thumbDone = 0;
  let thumbTotal = 0;
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
      let lastLog = 0;
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
          let hash: string | null = null;
          try {
            hash = await hashFileAsync(abs, (bytes) => {
              if (next.size >= BIG_FILE_BYTES) h?.progress(done, total, `${next.path} — ${gib(bytes)}/${gib(next.size)} GiB`);
            });
          } catch {
            // unreadable or vanished — skip; a later reconcile re-queues it if it still exists
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
          const now = Date.now();
          if (now - lastLog >= 500) {
            lastLog = now;
            log(`hashing ${done}/${total} — ${next.path}`);
          }
        }
        h?.done();
        if (h) log(`hashing done — ${done} file(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        h?.fail(e);
        log(`hashing FAILED — ${String((e as Error)?.message ?? e)}`);
      } finally {
        hashing = false;
      }
    })();
  };

  // A reindex usable inside an already-queued job (NOT queued itself — callers queue). Retains the
  // assembled doc so a subsequent single-file edit can patch against it in memory.
  const doReindex = async (): Promise<IndexDiff> => {
    const { diff, doc } = await reindexAsyncDoc(store0, dataRoot, { ignore });
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
        const res = await reindexPathAsync(store0, dataRoot, cachedDoc, rel, { ignore });
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
      const t0 = Date.now();
      let lastLog = 0;
      log(`${label}…`);
      try {
        const { diff, doc } = await reindexAsyncDoc(store0, dataRoot, {
          ignore,
          onProgress: (p) => {
            h.progress(p.done, p.total, p.message);
            const now = Date.now();
            if (now - lastLog >= 500) {
              lastLog = now;
              log(`${label} ${p.done}/${p.total ?? "?"}${p.message ? ` — ${p.message}` : ""}`);
            }
          },
        });
        cachedDoc = doc;
        h.done();
        log(
          `${label} done in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
            ` (+${diff.added.length} ~${diff.changed.length} −${diff.removed.length} →${diff.moved.length})`,
        );
        broadcast(diff);
        scheduleHasher();
        return diff;
      } catch (e) {
        h.fail(e);
        log(`${label} FAILED — ${String((e as Error)?.message ?? e)}`);
        throw e;
      }
    });

  // An UNMEDIATED move (mv in a shell, a file manager) shows up as an inferred `moved` —
  // relink the inbound refs the way the mediated tier would (ENGINE.md tier 2: "inferred
  // as a move and relinked"), then reconcile once more so the rewritten files re-index.
  const reconcile = (): Promise<IndexDiff> =>
    enqueue(async () => {
      const h = tasks.start("reconciling");
      try {
        const diff = await doReindex();
        if (diff.moved.length > 0) {
          const r = relinkMoved(dataRoot, diff.moved, { ignore });
          if (r.editedFiles.length > 0) {
            const follow = reindex(store0, dataRoot, { ignore });
            diff.changed = [...new Set([...diff.changed, ...follow.changed])];
            cachedDoc = null; // sync `reindex` rebuilt the DB but not the cached doc — invalidate
          }
        }
        h.done();
        broadcast(diff);
        scheduleHasher();
        return diff;
      } catch (e) {
        h.fail(e);
        throw e;
      }
    });

  const ready = runIndexTask(`indexing ${rootName}`);
  const stopWatch = opts.watch
    ? watchTree(dataRoot, () => {
        reconcile().catch((e) => log(`reconcile FAILED — ${String((e as Error)?.message ?? e)}`));
      }, { ignore })
    : null;

  const handler: Handler = (req, res, url) => {
    try {
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

      // Long-running server tasks (indexing, hashing, …) currently in flight (or just
      // finished) — the snapshot a freshly loaded page needs; updates ride /api/events.
      if (url.pathname === "/api/tasks") {
        sendJson(res, 200, tasks.list());
        return;
      }

      // The QUERY evaluator (PLAN.md 3g / QUERY.md): a colon-grammar match template,
      // evaluated at `path` (default: the root). Results are client JSON paths.
      if (url.pathname === "/api/query") {
        const q = url.searchParams.get("q") || "";
        const at = storePath(strToSegs(url.searchParams.get("path") || ":"));
        try {
          const results = evalQuery(s, q, at).map((p) => segsToStr(storePathToSegs(p)));
          sendJson(res, 200, { results });
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

      // Create an annotation — TAG a target (a WRITE path; ANNOTATIONS.md). The tag application is
      // appended to the target's own `yamlover-annotations` array, embedded in the target's host
      // body (a `*.yamlover` document, or a directory's `.yamlover/body.yamlover` overlay keyed by
      // filename). The target may be a whole node OR a fragment (`…:yamlover-fragments:<slug>`).
      // Body: { target, tag, description?, params? } — target/tag are JSON paths; description/params
      // make it a PARAMETRIZED annotation (an object element), else it is a bare tag pointer.
      if (req.method === "POST" && url.pathname === "/api/annotate") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const a = data as AnnotateInput;
              const tagStore = storePath(strToSegs(a.tag ?? ""));
              if (!a?.tag || s.node(tagStore)?.format !== TAG_FORMAT) {
                throw new Error("annotation needs a `tag` that is an x-yamlover-tag node");
              }
              const bodyFile = embedAnnotation(dataRoot, s, a);
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

      // Create a FRAGMENT — a user-marked region inside a target (a WRITE path; ANNOTATIONS.md).
      // Stored under the target's `yamlover-fragments` mapping keyed by a fresh slug; for an
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

      // Delete an annotation (recolor = delete + create, client-side): remove the matching element
      // from the target's `yamlover-annotations`. Body/query: { target, tag } (JSON paths).
      if (req.method === "DELETE" && url.pathname === "/api/annotate") {
        const target = url.searchParams.get("target") ?? "";
        const tag = url.searchParams.get("tag") || "";
        enqueue(async () => {
          if (!tag) throw new Error("delete needs a `tag`");
          const bodyFile = unembedAnnotation(dataRoot, s, target, tag);
          broadcast(await doReindexFile(bodyFile));
        })
          .then(() => sendJson(res, 200, { ok: true }))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Create a NAMED TAG (a WRITE path — the picker's create-on-miss): add
      // `<name>: !!<*yamlover/$defs/tag>` to the taxonomy body at the project's default tags
      // location (settings.yamlover; `/tags` by default → `<location>/.yamlover/body.yamlover`),
      // then reconcile so it joins the graph. The direct schema attach makes the node an
      // `x-yamlover-tag` wherever the taxonomy lives — like an annotation, a created tag may be
      // moved anywhere and keeps working. Idempotent: a tag already at that path is returned
      // as-is. Body: { name }.
      if (req.method === "POST" && url.pathname === "/api/tag") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const name = String((data as { name?: unknown })?.name ?? "").trim();
              if (!name) throw new Error("tag needs a non-empty name");
              const segs = [...strToSegs(settings.tags), name];
              const tagPath = segsToStr(segs);
              const existing = s.node(storePath(segs));
              if (existing) {
                if (existing.format !== TAG_FORMAT) throw new Error(`a node already exists at ${tagPath} and is not a tag`);
                const color = s.node(storePath(segs) + ":color")?.value;
                return { path: tagPath, name, color: typeof color === "string" ? color : null, created: false };
              }
              // Index INCREMENTALLY (the annotate pattern — not a full rebuild, which stats the
              // whole tree and blocks the picker for seconds on a big root); the watcher's
              // reconcile re-walks the edited body and trues the rows up moments later.
              const written = writeTag(dataRoot, settings.tags, name);
              s.addTag(storePath(strToSegs(settings.tags)), name, written.pos, written.node);
              if (s.node(storePath(segs))?.format !== TAG_FORMAT) throw new Error(`the created tag did not index as a tag: ${tagPath}`);
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
              fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
              const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
              fs.writeFileSync(bodyFile, writeBoardLanes(src, lanes));
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
      // else → a new chapter .yamlover file in the nearest directory. RICH (an HTML selection:
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

      // The yamlover EDITOR (a WRITE path). Surgical source-text edits to any `.yamlover` document:
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
      // to validate, then spliced verbatim. `concrete` is accepted only where content is born.
      //
      // A batch groups by backing file (a document can span several) and reindexes each once —
      // respecting that different parts live in different files/concretes.
      if (req.method === "POST" && url.pathname === "/api/edit") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const d = data as EditInput & { edits?: EditInput[] };
              const edits = Array.isArray(d.edits) ? d.edits : [d];
              const { touched, created, appended } = applyEdits(dataRoot, s, edits);
              // a born document is a new FILE: the whole graph rewalks. Otherwise only the edited files.
              if (created.length) broadcast(await doReindex());
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

      // Render a STANDALONE yamlover text (no file behind it — e.g. the client's browser-settings
      // document, stored in localStorage) exactly as /api/json would render a node: parse, index
      // into a throwaway in-memory store, project. STATELESS — touches neither the served tree nor
      // the live index. Body: { source }.
      if (req.method === "POST" && url.pathname === "/api/preview") {
        readBody(req)
          .then((data) => sendJson(res, 200, previewPayload(String((data as { source?: unknown }).source ?? ""))))
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

      // The project config (IMPORTS.md) — `<root>/.yamlover/settings.yamlover`, indexed as a HIDDEN
      // node (`:.yamlover:settings.yamlover`, format x-yamlover-config). GET → { source, settings }:
      // the RAW source (the node projection drops comments) plus the PARSED settings, read by the
      // annotate flow (tags location). The config is EDITED through the ordinary yamlover data view +
      // `/api/edit` now; `broadcast` reloads `settings` on any change to the file (incl. direct disk
      // edits), so there is no dedicated write endpoint.
      if (req.method !== "POST" && url.pathname === "/api/config") {
        const source = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "";
        sendJson(res, 200, { source, settings, path: ":.yamlover:settings.yamlover" });
        return;
      }

      const segs = strToSegs(url.searchParams.get("path") || ":");
      const p = storePath(segs);
      const depth = parseDepth(url.searchParams.get("depth"));

      if (url.pathname === "/api/info") {
        sendJson(res, 200, { root: rootName });
        return;
      }

      // The annotations whose `target` is this material (the engine's reverse link).
      if (url.pathname === "/api/annotations") {
        sendJson(res, 200, annotationsFor(dataRoot, s, segs));
        return;
      }

      // The materials filed under this tag (annotations resolved to their `target`; deduped) —
      // the explorer renderer's member list for a tag page.
      if (url.pathname === "/api/tagged") {
        const row = s.node(p);
        if (!row || row.format !== TAG_FORMAT) return notFound(res, url);
        sendJson(res, 200, taggedMaterials(dataRoot, s, p));
        return;
      }

      if (url.pathname === "/api/tree") {
        const row = s.node(p);
        if (!row) return notFound(res, url);
        const label = segs.length === 0 ? rootName : labelFor(s, p, segs[segs.length - 1]);
        sendJson(res, 200, buildTree(dataRoot, s, segs, label, depth ?? 3));
        return;
      }

      if (url.pathname === "/api/blob") {
        const file = path.join(dataRoot, ...segs.map(String));
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return notFound(res, url);
        // STREAM the bytes — a readFileSync of a big PDF/video would block the event loop
        // (and with it every other request and the Vite HMR socket) for its whole read.
        res.statusCode = 200;
        res.setHeader("Content-Type", s.node(p)?.format ?? formatFromExt(file) ?? "application/octet-stream");
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
        thumbBegin(); // count this generation into the coalesced "building thumbnails" task
        enqueue(async () => {
          thumbTask?.progress(thumbDone, thumbTotal, String(segs[segs.length - 1] ?? "")); // the one now building
          const made = await ensureThumbnail(dataRoot, s, settings.sidecars, segs, sourceRow, w, h);
          if (made) broadcast(await doReindex());
          return made;
        })
          .then((made) => (made ? serve(made) : sendJson(res, 415, { error: `no thumbnail for format: ${sourceRow.format ?? "unknown"}` })))
          .catch((e) => sendJson(res, 500, { error: String((e as Error).message || e) }))
          .finally(() => thumbEnd());
        return;
      }

      const row = s.node(p);
      if (!row) return notFound(res, url);
      const kind = displayKind(s, p, row);
      // an explicit `?depth=` (a finite level, or `.inf` → Infinity) wins; absent, default per
      // concrete (unlimited for a text document, one level for a directory / binary).
      const viewDepth = depth === undefined ? defaultDepth(s, dataRoot, segs, row, kind) : depth;

      if (url.pathname === "/api/json") {
        // Gate the byte fetch on the binary VALUE FACET (a blob), not the display `kind`: an image
        // that also owns overlay entries (thumbnails/fragments/annotations) reads as `variant`/omni,
        // but its bytes are still fetchable via ?binary=1. For such an omni the projection is KEPT —
        // the bytes fill the mixed marker's self-value slot (otherwise null: bytes never sit in the
        // store's value column) — so the entries and the base64 arrive together.
        const wantBytes = row.type === "blob" && url.searchParams.get("binary") === "1";
        let value: unknown;
        if (!wantBytes) value = projectValue(dataRoot, s, segs, viewDepth, true);
        else if (kind !== "omni") value = binaryContent(dataRoot, segs, row);
        else {
          const projected = projectValue(dataRoot, s, segs, viewDepth, true) as Record<string, { value?: unknown }>;
          const marker = projected[MIXED_KEY];
          if (marker) marker.value = binaryContent(dataRoot, segs, row);
          value = projected;
        }
        sendJson(res, 200, {
          path: segsToStr(segs),
          type: tocType(s, p, row),
          format: row.format ?? null,
          ...facetsOf(s, p, row), // valueType / hasKeyed / hasOrdinal — the renderer dispatch facets (TYPES.md §9)
          concrete: concreteOf(s, dataRoot, segs, row), // the full per-node concrete taxonomy (stat + document language)
          documentPath: documentPath(s, segs), // nearest enclosing document root (for `/…` links)
          title: titleOf(s, p),
          description: descriptionOf(s, p),
          value,
          comments: cachedDoc && !wantBytes ? collectComments(cachedDoc, segs, viewDepth) : {},
          relations: buildRelations(dataRoot, s, segs),
        });
      } else if (url.pathname === "/api/schema") {
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

/** How the node at `segs` is stored — the full per-node concrete taxonomy (CONCRETES.md), derived
 *  from a stat plus the enclosing document's language (the engine tracks no per-node concrete yet).
 *  A filesystem-backed node reports its own storage (`dir` / `dir/yamlover` / `file/<lang>` /
 *  `file/binary`); an interior (inlined) node reports the inlined language of the document it lives
 *  in — a directory document's values come from its `.yamlover/` overlay (`yamlover`), a parsed
 *  file's from that file (its extension's language). Positional segments never name an FS entry, so
 *  they fall through to the inlined case; never null (every node carries a concrete). */
function concreteOf(s: Store, dataRoot: string, segs: Seg[], row: NodeRow): string {
  // 1. A filesystem-backed node: stat its own path (only string segments can name an FS entry).
  if (segs.every((g) => typeof g === "string")) {
    const abs = path.resolve(dataRoot, ...segs.map(String));
    let st: fs.Stats | undefined;
    try { st = fs.statSync(abs); } catch { /* not FS-backed — fall through to the inlined case */ }
    if (st?.isDirectory()) return fs.existsSync(path.join(abs, ".yamlover")) ? "dir/yamlover" : "dir";
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

const relKey = (label: string | null, other: string): string => `${label ?? ""} ${other}`;

/** A node's DOWNSTREAM entries (it is the natural source), in source order: its containment
 *  children and forward `*` refs (authored here, positioned), then any `~` back-edges that target
 *  it from elsewhere (authored on the downstream node, so unpositioned → appended, ordered
 *  lexicographically by the member's path — URIs.md §`~-`).
 *
 *  Dedup is by identity, which only a LABEL provides: a same-label both-ways pair (`L: *x` +
 *  `~L: …`) is one relation authored twice → one entry. A KEYLESS membership (label null, the
 *  `~-` form) has no identity and is ADDITIVE — every declaration appends an element, even
 *  alongside a forward `- *member` (lists repeat) — unless the container is a `!!set` /
 *  `uniqueItems: true` (NodeMeta.set), where membership is by target and ALL duplicates
 *  (forward+forward, forward+reverse, reverse+reverse) collapse. */
/** Whether a node is flagged hidden (the `.yamlover` overlay subtree): resolvable by pointer, but
 *  omitted from the TOC, directory-member projection, and visible child counts. */
const isHidden = (s: Store, to: string): boolean => !!s.node(to)?.meta?.hidden;
/** Whether a node lives in the hidden `.yamlover` overlay subtree: it OR a containment ancestor is
 *  hidden. `meta.hidden` is set only on the `.yamlover` dir node (not propagated to its children),
 *  so an own-meta check misses descendants like `settings.yamlover` — walk up to catch them. */
const inHiddenSubtree = (s: Store, p: string): boolean => {
  for (let segs = storePathToSegs(p); segs.length; segs = segs.slice(0, -1))
    if (isHidden(s, storePath(segs))) return true;
  return false;
};
/** Has a child that ISN'T hidden — the `hasChildren` a directory should report (a dir whose only
 *  child is `.yamlover` reads as a leaf). */
const visibleHasChildren = (s: Store, p: string): boolean => s.children(p).some((c) => !isHidden(s, c.to));

/** Has a SUBCHAPTER child (a nested chapter/task) — the `hasChildren` hint a CHAPTER should report in
 *  the TOC: only subchapters are navigable there (chunks and overlay fields like `yamlover-fragments`
 *  are content, not tree entries — `chapterTocView`). Mirrors the client's `isSubchapter(format)`, so
 *  a chunks-only chapter reads as a leaf (no chevron that expands to nothing). */
const hasSubchapterChild = (s: Store, p: string): boolean =>
  s.children(p).some((c) => {
    if (isHidden(s, c.to)) return false;
    const f = s.node(c.to)?.format;
    return f === "x-yamlover-chapter" || f === "x-yamlover-task";
  });

function downstreamEntries(s: Store, p: string): { to: string; label: string | null; pos: number | null; kind: EdgeRow["kind"]; raw?: string }[] {
  const isSet = !!s.node(p)?.meta?.set;
  // contain + forward ref (including UNREALIZED refs — dangling/external pointers, `to` empty,
  // `raw` the authored text — via ownedEntries), ordered by pos — but a CONTAIN edge to a hidden
  // node (`.yamlover`) is omitted from the listing (forward `*` refs INTO the hidden subtree,
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

/** A node value as plain JSON-able data. `depth` limits nesting; a container past the budget,
 *  or any non-top binary, becomes a `$yamloverLink` marker the client navigates on click. */
function projectValue(dataRoot: string, s: Store, segs: Seg[], depth: number, top: boolean): unknown {
  const p = storePath(segs);
  const row = s.node(p)!;
  const k = displayKind(s, p, row);
  if (!top && depth <= 0) return linkMarker(dataRoot, s, segs);
  if (k === "binary" && !top) return linkMarker(dataRoot, s, segs);
  if (k === "binary") return { size: row.size, format: row.format }; // top binary header
  // DOWNSTREAM entries in order — containment recursed, a forward `*` ref or an incoming `~`
  // back-edge shown as a link marker to the downstream node (so a `chunks` array mixing inline
  // blocks and `*sample.png` pointers is whole, and a child reached only by `~` still appears).
  const kids = downstreamEntries(s, p);
  const currentDoc = documentRootSegs(s, segs); // frame for a reference's scope-correct pointer text
  const project = (c: { to: string; label: string | null; pos: number | null; kind: string; raw?: string }) => {
    if (c.kind === "contain") return projectValue(dataRoot, s, [...segs, c.label ?? c.pos ?? 0], depth - 1, false);
    // an UNREALIZED ref (dangling / external — no local target): the authored pointer text,
    // not hyperlinked (`path: null`), at any depth — there is nothing to link or summarize.
    if (!c.to) return refMarker(c.raw ?? "", null);
    // a reference (a forward `*` ref or an incoming `~` back-edge). At UNLIMITED depth show it AS a
    // reference — its yamlover pointer text, hyperlinked — so the link syntax stays visible (and the
    // possibly-cyclic graph is never inlined). At a FINITE depth it is RESOLVED to a navigable link
    // marker (a `{ … }` summary of the target); since that only happens under an explicit finite
    // `?depth=`, the `{ … }` marker means "truncated by the depth setting" everywhere it appears.
    const targetSegs = storePathToSegs(c.to);
    return depth === Infinity
      ? refMarker(refPointerText(s, targetSegs, currentDoc), segsToStr(targetSegs))
      : linkMarker(dataRoot, s, targetSegs);
  };
  // a FORMAT-STAMPED array (a tagged/derived x-yamlover-* container, e.g. an all-keyless
  // nested table or list) keeps its format via the marker path below; a plain data array
  // projects bare — the client cannot otherwise tell a tagged keyless table from data.
  if (k === "array" && !row.format) return kids.map(project);
  if (k === "omni" || k === "mix" || k === "array") {
    // A `$yamloverMixed` marker preserving source order: each entry is positional (`key: null` →
    // a `- item`) or keyed (`key: "scale"` → `scale: …`); an omni also carries its self-value.
    const entries = kids.map((c) => ({ key: c.label, value: project(c) }));
    const marker: Record<string, unknown> = { kind: k, entries };
    // the node's stamped/derived format — an inlined container otherwise carries none, and the
    // table renderer needs it to tell a CHAPTER cell from a nested table (MARKLOWER.md §Cells)
    if (row.format) marker.format = row.format;
    if (k === "omni") {
      // the node's own scalar self-value (the `!!var 5`); a FILE-backed omni (an image carrying
      // `yamlover-thumbnails`/annotations) shows its bytes as a navigable `< binary >`, not `null`
      marker.value = row.type === "blob" ? binaryValueMarker(segs, row) : wireScalar(row.value);
      // its authored display position among the entries (order-preserving; 0/absent → first)
      if (typeof row.meta?.selfAt === "number") marker.selfAt = row.meta.selfAt;
    }
    return { [MIXED_KEY]: marker };
  }
  if (k === "object") {
    const out: Record<string, unknown> = {};
    for (const c of kids) out[c.label ?? String(c.pos)] = project(c);
    return out;
  }
  return wireScalar(row.value); // scalar
}

/** The IR node at client `segs` within the assembled document, or undefined when the path
 *  leaves the contained spine (a pointer / missing key). Keyless segments index the FULL
 *  `entries` array — the same basis the store path uses (graph.ts / resolve.ts: `[i]`). */
function irNodeAt(doc: Document, segs: Seg[]): IrNode | undefined {
  let node: IrNode = doc.root;
  for (const seg of segs) {
    const entries = node.entries ?? [];
    let val;
    if (typeof seg === "number") {
      const e = entries[seg];
      if (!e || e.key !== null || e.edge !== "contain") return undefined;
      val = e.value;
    } else {
      val = entries.find((en) => en.key === seg && en.edge === "contain")?.value;
    }
    if (!val || isPointer(val)) return undefined;
    node = val;
  }
  return node;
}

/** The comments to show with the value at `segs`, keyed by each node's fragment continuation
 *  FROM THE VIEWED NODE — exactly what the client looks up as `frag.slice(base.length)`. So a
 *  child's leading/trailing comments live under `/key` or `[i]` (i = its index among the node's
 *  RENDERED own entries, matching render.tsx). `$head` is the file banner (only at the served
 *  root); `$tail` is the viewed node's own leftover comments (after its last entry). Comments
 *  are typography: this never changes the value projection, only annotates it. */
type CommentBucket = {
  leading?: string[];
  trailing?: string[];
  pointer?: string;      // a ref entry's authored pointer text, canonical colon form (no `*`)
  anchors?: string[];    // the value node's `&` path-anchor bodies (no `&`), source order
  tag?: string;          // the value node's yamlover tags: `!!<…>` schema and/or `!!set` (shape tags are default)
  blankBefore?: boolean;  // a blank source line precedes this entry (or its leading comments)
  valueTrailing?: string[]; // a comment trailing the node's own SELF-VALUE line (an omni `5 # …`)
  raw?: string;           // a scalar's authored SOURCE token, carried only when it differs from the
                          // plain decoded form — so `"~"` reads as a string not null, `0xff`/`True`
                          // keep their spelling (CONCRETES.md §Scalar representation). Single-line only.
};

/** A scalar's authored source token to render faithfully — but only when it differs from the plain
 *  decoded form (a quoted string, a `~`/word null, a hex/octal int, a `True` casing, `.inf`, …), so
 *  the sidecar stays sparse and a plain `Rex`/`42` carries nothing. Block (multi-line) scalars render
 *  as `|`/`>` blocks already, so they are skipped. */
function scalarRawToken(node: IrNode): string | undefined {
  if (isPointer(node) || node.kind !== "scalar") return undefined;
  const raw = node.raw;
  if (raw == null || raw.includes("\n")) return undefined;
  const v = node.value;
  if (typeof v === "string" && v.includes("\n")) return undefined;
  const plain = v === null ? "null" : String(v); // mirrors the client's default bare rendering
  return raw === plain ? undefined : raw;
}

/** The yamlover type tags a node carries in canonical serialization, or undefined. Mirrors
 *  serialize-yamlover's `decorations`: the `!!<…>` schema tag (a tag APPLICATION — it must not
 *  vanish from the view just because the store routes it as `format`), then `!!set` (set
 *  semantics). The shape tags `!!mix` (a mixed keyed+keyless container) and `!!var` (a scalar-
 *  plus-fields) are the DEFAULT — omni-by-default (YAMLOVER.md §4) — so they are never shown;
 *  an untagged mixture reads back the same. */
function tagOf(n: IrNode): string | undefined {
  const parts: string[] = [];
  if (n.meta?.schema !== undefined) {
    try {
      parts.push(schemaTagToken(n.meta.schema));
    } catch {
      // an inline schema with no one-line form: parsed input always has one, so only a
      // programmatic IR can get here — better an untagged view than a failed page
    }
  }
  if (n.meta?.set) parts.push("!!set");
  return parts.length ? parts.join(" ") : undefined;
}

/** Syntax decorations of a value node (anchors, type tag, a self-value trailing comment),
 *  attached to its fragment. */
function nodeDeco(bucket: CommentBucket, node: IrNode): void {
  const anchors = (node.meta?.anchors ?? []).map(anchorBody);
  if (anchors.length > 0) bucket.anchors = anchors;
  const tag = tagOf(node);
  if (tag) bucket.tag = tag;
  // a comment trailing the node's own SELF-VALUE line (an omni `5 # …`) — placement `trailing`
  // on the node itself (attachComments routes self-value trailers here, not to an entry)
  const vt = (node.meta?.comments ?? []).filter((c) => c.placement === "trailing").map((c) => c.text);
  if (vt.length > 0) bucket.valueTrailing = vt;
}

function collectComments(doc: Document, segs: Seg[], depth: number): Record<string, CommentBucket | string[]> {
  const out: Record<string, CommentBucket | string[]> = {};
  const root = irNodeAt(doc, segs);
  if (!root) return out;
  { // the viewed node's own anchors / tag / self-value trailing comment / raw token, keyed at ""
    const self: CommentBucket = {};
    nodeDeco(self, root);
    const raw = scalarRawToken(root);
    if (raw) self.raw = raw;
    if (self.anchors || self.tag || self.valueTrailing || self.raw) out[""] = self;
  }
  // $head is the head-of-file banner — shown when the VIEWED node is a document root (the walk
  // carries each document's head onto its root node, so sub-documents surface theirs too).
  const head = (root.meta?.head ?? []).map((c) => c.text);
  if (head.length > 0) out.$head = head;
  // leftover comments after the node's last entry render at the bottom ($tail); a `trailing`
  // one rides the self-value line instead (valueTrailing, via nodeDeco above).
  const tail = (root.meta?.comments ?? []).filter((c) => c.placement === "leading").map((c) => c.text);
  if (tail.length > 0) out.$tail = tail;
  const placed = (cs: IrComment[] | undefined, p: "leading" | "trailing"): string[] =>
    (cs ?? []).filter((c) => c.placement === p).map((c) => c.text);
  const walk = (node: IrNode, rel: string, d: number, top: boolean): void => {
    if (!top && d <= 0) return; // a non-top node past the depth budget renders as a link marker
    let i = 0; // index over RENDERED own entries (own back-edges and hidden children are filtered)
    for (const e of node.entries ?? []) {
      if (e.edge === "back") continue;
      if (e.edge === "contain" && !isPointer(e.value) && e.value.meta?.hidden) continue;
      const cont = e.key != null ? `/${e.key}` : `[${i}]`;
      i++;
      const bucket: CommentBucket = {};
      const lead = placed(e.meta?.comments, "leading");
      const trail = placed(e.meta?.comments, "trailing");
      if (lead.length > 0) bucket.leading = lead;
      if (trail.length > 0) bucket.trailing = trail;
      // a blank line before the entry, or before its leading-comment block, is worth keeping
      const leadComment = e.meta?.comments?.find((c) => c.placement === "leading");
      if (e.meta?.blankBefore || leadComment?.blankBefore) bucket.blankBefore = true;
      if (isPointer(e.value)) bucket.pointer = renderPointer(e.value); // the authored `*…` token
      else {
        nodeDeco(bucket, e.value); // the value node's anchors + type tag
        const raw = scalarRawToken(e.value); // a scalar's faithful source token (when it differs)
        if (raw) bucket.raw = raw;
      }
      if (Object.keys(bucket).length > 0) out[rel + cont] = bucket;
      if (e.edge === "contain" && !isPointer(e.value)) walk(e.value, rel + cont, d - 1, false);
    }
  };
  walk(root, "", depth, true);
  return out;
}

/** The instance schema (every value `v` → `{const: v}`); containers past depth = link markers. */
function projectSchema(dataRoot: string, s: Store, segs: Seg[], depth: number, top: boolean): unknown {
  const p = storePath(segs);
  const row = s.node(p)!;
  const k = displayKind(s, p, row);
  if ((k === "object" || k === "array" || k === "mix" || k === "omni") && depth <= 0) return linkMarker(dataRoot, s, segs);
  if (k === "binary" && !top) return linkMarker(dataRoot, s, segs);
  const schema: Record<string, unknown> = { type: typeName(s, p, row) }; // object|array|binary|mixed|variant|<scalar>
  if (row.format) schema.format = row.format;
  const kids = downstreamEntries(s, p);
  const sub = (c: { to: string; label: string | null; pos: number | null; kind: string; raw?: string }) =>
    c.kind === "contain" ? projectSchema(dataRoot, s, [...segs, c.label ?? c.pos ?? 0], depth - 1, false)
    : c.to ? linkMarker(dataRoot, s, storePathToSegs(c.to))
    : refMarker(c.raw ?? "", null); // an unrealized ref: pointer text, no link
  if (k === "object" || k === "mix" || k === "omni") {
    // mixed/variant fields: keyless entries keep their `[pos]` key, keyed ones their name; a
    // variant (omni) also pins its self-value. (Order is the property insertion order.)
    const props: Record<string, unknown> = {};
    for (const c of kids) props[c.label ?? `[${c.pos}]`] = sub(c);
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
  info.concrete = concreteOf(s, dataRoot, segs, row); // a folder child renders with a folder icon; every node carries one
  const title = titleOf(s, p);
  if (title) info.title = title;
  if (k === "binary") info.size = row.size;
  else if (k === "scalar") info.value = wireScalar(row.value);
  else if (k === "omni" || k === "mix") {
    info.count = ownedEntries(s, p).length; // owned items + fields (reverse members excluded)
    if (k === "omni") info.value = wireScalar(row.value); // the self-scalar, for the link label
  } else {
    // visible members only (omit `.yamlover`) — owned entries, so pointer members (including
    // unrealized ones) count the same as inline children (they all render as rows)
    info.count = ownedEntries(s, p).filter((e) => !(e.kind === "contain" && isHidden(s, e.to))).length;
  }
  if (row.format === TAG_FORMAT) {
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
 *  (`::examples:…`) — mirroring the colon scope ladder (SEPARATOR.md: `:` = document root,
 *  `::` = project). */
function scopedPath(s: Store, src: Seg[], currentDoc: Seg[]): string {
  if (segsEqual(documentRootSegs(s, src), currentDoc)) return segsToStr(src.slice(currentDoc.length)); // `:…`
  return "::" + segsToStr(src).slice(1); // `::…` — a project-scope link
}

/** A reference's value rendered as a VALID yamlover deref token — `*` + the canonical
 *  spaced colon path (`*: pets[0]`, `*:: a: b`). Used for refs the projection surfaces from the
 *  store (realized anchor edges, incoming `~`): an authored pointer carries its own text via the
 *  comment/deco sidecar; this is the faithful fallback so a ref never renders as a bare `:path`. */
function refPointerText(s: Store, src: Seg[], currentDoc: Seg[]): string {
  const seg = (x: Seg): string => (typeof x === "number" ? `[${x}]` : `: ${x}`);
  if (segsEqual(documentRootSegs(s, src), currentDoc)) {
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
  const currentDoc = documentRootSegs(s, segs);
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
    put(key, s.node(src)?.format === TAG_FORMAT ? linkMarker(dataRoot, s, segs2) : refMarker(key, segsToStr(segs2)));
  }
  return out;
}

/** A binary leaf's bytes as a base64 payload (only when the leaf itself is selected). */
function binaryContent(dataRoot: string, segs: Seg[], row: NodeRow): Record<string, unknown> {
  const file = path.join(dataRoot, ...segs.map(String));
  const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  return { [BINARY_KEY]: { format: row.format ?? null, size: row.size ?? bytes.length, base64: bytes.toString("base64") } };
}

interface TreeNode {
  path: string; label: string; type: string; format: string | null;
  valueType?: string | null; hasKeyed?: boolean; hasOrdinal?: boolean; // renderer dispatch facets (TYPES.md §9)
  concrete: string | null; hasChildren: boolean; children: TreeNode[];
}

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
  if (node.hasChildren && depth > 0) {
    for (const c of chapterOrderedChildren(s, p, row.format ?? null)) {
      if (isHidden(s, c.to)) continue; // omit the hidden `.yamlover` overlay subtree from the TOC
      const seg = c.label ?? c.pos ?? 0;
      node.children.push(buildTree(dataRoot, s, [...segs, seg], labelFor(s, c.to, seg), depth - 1));
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

/** A node's tree label: an instance `title` child, else the key / `[index]`. */
function labelFor(s: Store, p: string, keyOrIdx: Seg): string {
  const t = titleOf(s, p);
  if (t) return t;
  return typeof keyOrIdx === "number" ? `[${keyOrIdx}]` : keyOrIdx;
}

// --------------------------------------------------------------------------- //
// Tags, fragments & annotations — EMBEDDED in the target (ANNOTATIONS.md). A user-marked region
// is a FRAGMENT under the target's `yamlover-fragments` mapping (keyed by slug; selector + an
// optional binary crop). TAGGING a target — a whole node or a fragment — appends to its
// `yamlover-annotations` array: a bare tag pointer (`- *::tag`) or a `{tag, …params}` object. The
// applied tag drives the color. A material's annotations / a tag's materials are derived from
// these forward `*` edges. Writes edit the target's host body (a `*.yamlover` doc or a directory
// `.yamlover/body.yamlover` overlay) surgically — see ./embed.ts.
// --------------------------------------------------------------------------- //

const TAG_FORMAT = "x-yamlover-tag";
const FRAGMENT_FORMAT = "x-yamlover-fragment";
const ANN_KEY = "yamlover-annotations";
const FRAG_KEY = "yamlover-fragments";
const THUMB_KEY = "yamlover-thumbnails";
const CROP_SUBDIR = "fragments"; // crop sidecar blobs, under a hidden .yamlover/ overlay dir
const THUMB_SUBDIR = "thumbnails"; // derived thumbnail blobs, content-addressed, under .yamlover/

interface AnnotateInput {
  target: string; // the target's JSON path — a node, or a fragment (`…:yamlover-fragments:<slug>`)
  tag: string; // the applied tag's JSON path
  description?: string; // a parametrized annotation's comment
  params?: Record<string, unknown>; // any other parameters (parametrized form)
}

interface FragmentInput {
  target: string; // the node the region lives in (its JSON path)
  selector: Record<string, unknown>; // { type:"text", exact, … } | { type:"pdf", page, x, y, w, h } | …
  imageBase64?: string; // an optional PNG crop (image-like selections)
}

/** A child store-path: `parent` + `:key` (root `:` has no leading owner). */
const childPath = (parent: string, key: string): string => (parent === ":" ? "" : parent) + ":" + key;

/** A tag store-path projected as { path, name, color } — color = its explicit `color`, else null
 *  (the client derives a hue from the name). Null when `tagStore` is not an x-yamlover-tag node. */
function projectTag(s: Store, tagStore: string): { path: string; name: string; color: string | null } | null {
  if (s.node(tagStore)?.format !== TAG_FORMAT) return null;
  const segs = storePathToSegs(tagStore);
  const color = s.node(tagStore + ":color")?.value;
  return { path: segsToStr(segs), name: String(segs[segs.length - 1] ?? ""), color: typeof color === "string" ? color : null };
}

/** The tag applications in a host node's `yamlover-annotations` array: a bare tag pointer (a `ref`
 *  entry straight to the tag) or a `{tag, …params}` object (a `contain` entry whose `tag` field
 *  refs the tag and whose scalar children are parameters). */
function readAnnotations(s: Store, hostStore: string): { tag: ReturnType<typeof projectTag>; description?: string; params?: Record<string, unknown> }[] {
  const arr = childPath(hostStore, ANN_KEY);
  if (!s.node(arr)) return [];
  const out: { tag: ReturnType<typeof projectTag>; description?: string; params?: Record<string, unknown> }[] = [];
  for (const e of s.entries(arr)) {
    if (e.kind === "ref") {
      const tag = projectTag(s, e.to);
      if (tag) out.push({ tag });
    } else if (e.kind === "contain") {
      const tagEdge = s.relationships(e.to).out.find((o) => o.kind === "ref" && o.label === "tag");
      const tag = tagEdge ? projectTag(s, tagEdge.to) : null;
      if (!tag) continue;
      const params: Record<string, unknown> = {};
      let description: string | undefined;
      for (const c of s.children(e.to)) {
        const v = s.node(c.to)?.value;
        if (c.label === "description") description = v == null ? undefined : String(v);
        else if (c.label) params[c.label] = v;
      }
      out.push({ tag, description, params: Object.keys(params).length ? params : undefined });
    }
  }
  return out;
}

/** A host node's fragments: each slug's selector fields (geometry / text quote) + its crop URL,
 *  read from the `yamlover-fragments` mapping. `image` is a `*` pointer (a ref edge) to the crop. */
function readFragments(s: Store, hostStore: string): { slug: string; node: string; selector: Record<string, unknown>; imageUrl?: string }[] {
  const frags = childPath(hostStore, FRAG_KEY);
  if (!s.node(frags)) return [];
  const out: { slug: string; node: string; selector: Record<string, unknown>; imageUrl?: string }[] = [];
  for (const fc of s.children(frags)) {
    if (!fc.label) continue;
    const selector: Record<string, unknown> = {};
    for (const c of s.children(fc.to)) {
      if (c.label && c.label !== ANN_KEY && c.label !== "created") selector[c.label] = s.node(c.to)?.value;
    }
    const imgEdge = s.relationships(fc.to).out.find((o) => o.kind === "ref" && o.label === "image");
    const imageUrl = imgEdge ? `/api/blob?path=${encodeURIComponent(segsToStr(storePathToSegs(imgEdge.to)))}` : undefined;
    out.push({ slug: fc.label, node: fc.to, selector, imageUrl });
  }
  return out;
}

/** The annotations ON this material: its own whole-node tags, plus each fragment's tags carrying
 *  that fragment's selector + crop (so the client highlights the region and colors by tag). Each
 *  entry carries `node` — the CLIENT path of the node it lives on — so a multi-node page (a chapter
 *  whose CHUNKS each carry their own fragments, ANNOTATIONS.md §3) can target/highlight per node.
 *  A chapter also gathers its DIRECT children's fragments (the chunks), one level deep. */
function annotationsFor(dataRoot: string, s: Store, segs: Seg[]): unknown[] {
  void dataRoot;
  const p = storePath(segs);
  const out: unknown[] = [];
  const gather = (hostStore: string, nodeClient: string): void => {
    for (const a of readAnnotations(s, hostStore)) out.push({ ...a, node: nodeClient });
    for (const f of readFragments(s, hostStore)) {
      for (const a of readAnnotations(s, f.node)) {
        out.push({ ...a, node: nodeClient, selector: f.selector, fragmentSlug: f.slug, ...(f.imageUrl ? { imageUrl: f.imageUrl } : {}) });
      }
    }
  };
  gather(p, segsToStr(segs));
  for (const c of s.children(p)) {
    if (isHidden(s, c.to)) continue; // skip the `.yamlover` overlay subtree
    gather(c.to, segsToStr(storePathToSegs(c.to)));
  }
  return out;
}

/** The MATERIALS filed under a tag — the reverse of the forward `*::tag` pointers authored in
 *  `yamlover-annotations` arrays (a bare element's edge from the array, an object element's `tag`
 *  field, or a legacy direct `~`/`&` membership). Each is climbed to its owning material or
 *  fragment and deduped, ordered lexicographically by path. */
function taggedMaterials(dataRoot: string, s: Store, tagStorePath: string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  const ins = s.relationships(tagStorePath).in
    .filter((e) => (e.kind === "ref" || e.kind === "back") && e.from)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  for (const e of ins) {
    const arrOwner = e.from.replace(/\[\d+\]$/, "").match(/^(.*):yamlover-annotations$/);
    const owner = arrOwner ? arrOwner[1] || ":" : e.from; // an annotation array → its host; else a direct member
    // skip the tag itself, dups, missing nodes, and any owner in the hidden `.yamlover` overlay
    // subtree (e.g. settings.yamlover, whose `annotation-tag:` pointer back-references this tag)
    if (owner === tagStorePath || seen.has(owner) || !s.node(owner) || inHiddenSubtree(s, owner)) continue;
    seen.add(owner);
    out.push(linkMarker(dataRoot, s, storePathToSegs(owner)));
  }
  return out;
}

/** A client JSON path (`:key[0]:x`, keys PERCENT-ENCODED) as project-scoped COLON pointer
 *  raw text (`::key[0]:x`, keys RAW — quoted when spacey): pointer steps are matched against
 *  store keys verbatim — an encoded key would go dangling on the next re-walk. */
function pointerRaw(clientPath: string): string {
  let out = "";
  for (const seg of strToSegs(clientPath)) {
    out += typeof seg === "number" ? `[${seg}]` : (out === "" ? "" : ":") + colonSegment(seg);
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
// A sidecar (thumbnail / fragment crop) lives under a HIDDEN `.yamlover/` overlay dir. Two modes
// (settings.sidecars.location): 'per-directory' keeps it beside the source — the source's own
// directory `.yamlover/<subdir>/`, referenced by a DOCUMENT-scope pointer `*:.yamlover:<subdir>:name`
// that resolves against that directory (its documentRoot); 'project' centralizes under the served
// root's `.yamlover/`, referenced by a PROJECT-scope pointer `*::.yamlover:<subdir>:name`.

/** The directory a sidecar is written to + the pointer scope to emit, from the embed host's
 *  `bodyFile` (a directory overlay `<dir>/.yamlover/body.yamlover` lets per-directory work;
 *  a standalone-doc host has no `.yamlover` child, so per-directory falls back to project). */
function sidecarTarget(
  dataRoot: string,
  mode: SidecarLocation,
  subdir: string,
  bodyFile: string,
): { dir: string; scope: "document" | "project" } {
  const dirOverlay = bodyFile.endsWith(path.join(".yamlover", "body.yamlover"));
  if (mode === "per-directory" && dirOverlay) {
    const fileDir = path.dirname(path.dirname(bodyFile)); // <dir> from <dir>/.yamlover/body.yamlover
    return { dir: path.join(fileDir, ".yamlover", subdir), scope: "document" };
  }
  return { dir: path.join(dataRoot, ".yamlover", subdir), scope: "project" };
}

/** Pointer raw text for a sidecar `name` in `subdir` under `.yamlover/`, at the given scope:
 *  document → `:.yamlover:<subdir>:name` (single colon, resolves against the nearest documentRoot);
 *  project → `::.yamlover:<subdir>:name` (served-root relative). Wrap with {@link pointerToken}. */
function sidecarPointerRaw(subdir: string, name: string, scope: "document" | "project"): string {
  const body = [".yamlover", subdir, name].map(colonSegment).join(":");
  return (scope === "document" ? ":" : "::") + body;
}

/** Serialize a value as a yamlover scalar (double-quoted strings round-trip through the parser). */
function yScalar(v: unknown): string {
  return typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v ?? ""));
}

/** The yamlover host body holding the node at `segs`, and the mapping-key path WITHIN it to that
 *  node (ANNOTATIONS.md §3). A standalone `*.yamlover` document → the file itself (within = the
 *  path inside it); a directory → its `.yamlover/body.yamlover` overlay; an on-disk blob (a PDF) →
 *  the ENCLOSING directory's overlay, keyed by the filename. */
function hostFor(dataRoot: string, s: Store, segs: Seg[]): { bodyFile: string; within: string[] } {
  for (let i = segs.length; i >= 0; i--) {
    const sub = segs.slice(0, i);
    const abs = path.resolve(dataRoot, ...sub.map(String));
    let st: fs.Stats | undefined;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) return { bodyFile: path.join(abs, ".yamlover", "body.yamlover"), within: segs.slice(i).map(String) };
    if (st.isFile()) {
      const node = s.node(storePath(sub));
      // Edit a MAPPING document in place (a new top-level key is valid). A leaf file — scalar,
      // blob, or array — would become an UNTAGGED omni/mix if a key were appended to its source
      // (a parse error under the current parser), so route it through the enclosing directory's
      // overlay keyed by the filename: the engine merges the fields onto the file at IR level
      // (augmentEntry — omni-blob), never reparsing a mixed source. ANNOTATIONS.md §3.
      if (node?.meta?.documentRoot && node.type === "mapping" && !node.is_array) {
        return { bodyFile: abs, within: segs.slice(i).map(String) };
      }
      const dir = path.resolve(dataRoot, ...sub.slice(0, -1).map(String));
      return { bodyFile: path.join(dir, ".yamlover", "body.yamlover"), within: segs.slice(i - 1).map(String) };
    }
  }
  return { bodyFile: path.join(dataRoot, ".yamlover", "body.yamlover"), within: segs.map(String) };
}

/** One `yamlover-annotations` element's source lines at the list `indent`: a bare tag pointer when
 *  there are no parameters, else a `{tag, …}` object (block form). */
function annotationItemLines(a: AnnotateInput, indent: number): string[] {
  const pad = " ".repeat(indent);
  const ptr = pointerToken(pointerRaw(a.tag));
  const params: Record<string, unknown> = { ...(a.params ?? {}) };
  if (a.description != null && a.description !== "") params.description = a.description;
  const keys = Object.keys(params);
  if (keys.length === 0) return [`${pad}- ${ptr}`];
  return [`${pad}- tag: ${ptr}`, ...keys.map((k) => `${pad}  ${keyToken(k)}: ${yScalar(params[k])}`)];
}

/** A fragment's source lines at the fragments-map `indent` (`<slug>:` + selector + crop + created),
 *  tagged so it indexes as an x-yamlover-fragment node. */
function fragmentBlockLines(slug: string, selector: Record<string, unknown>, imagePtr: string | null, indent: number): string[] {
  const pad = " ".repeat(indent);
  const lines = [`${pad}${keyToken(slug)}: !!<*::yamlover:$defs:fragment>`];
  for (const [k, v] of Object.entries(selector)) lines.push(`${pad}  ${keyToken(k)}: ${yScalar(v)}`);
  if (imagePtr) lines.push(`${pad}  image: ${imagePtr}`);
  lines.push(`${pad}  created: ${new Date().toISOString()}`);
  return lines;
}

/** Embed a tag application into the target's `yamlover-annotations` array (editing the target's
 *  host body in place — ANNOTATIONS.md). */
function embedAnnotation(dataRoot: string, s: Store, a: AnnotateInput): string {
  const segs = strToSegs(a.target || ":");
  // A tag ON a chunk fragment (`:chapter[k]:yamlover-fragments:<slug>`) descends past a body index:
  // reach the chunk field-region, then the fragment's own body, and append there.
  if (isChunkTarget(s, segs)) {
    const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
    const { indices, keys } = splitChunkWithin(segs.slice(docSegs.length));
    const lines = fs.readFileSync(bodyFile, "utf8").replace(/\n$/, "").split("\n");
    const region = reachBodyAt(lines, chunkFieldRegion(lines, indices, /*ensureOmni*/ true), keys);
    appendAnnotationAt(lines, region, (indent) => annotationItemLines(a, indent));
    fs.writeFileSync(bodyFile, lines.join("\n") + "\n");
    return bodyFile;
  }
  const { bodyFile, within } = hostFor(dataRoot, s, segs);
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
  fs.writeFileSync(bodyFile, appendAnnotation(src, within, (indent) => annotationItemLines(a, indent)));
  return bodyFile;
}

/** Embed a fragment under the target's `yamlover-fragments` mapping; for an image-like selection,
 *  write the PNG crop as a sidecar blob the fragment references. Returns its slug + node path. */
function embedFragment(dataRoot: string, s: Store, mode: SidecarLocation, f: FragmentInput): { slug: string; fragmentPath: string } {
  const segs = strToSegs(f.target || ":");
  const slug = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // A chunk target (`:chapter[k]`, a positional prose item) can't be reached by the mapping-key
  // writer — turn the chunk into an omni node and hang `yamlover-fragments:` off it (ANNOTATIONS.md §3).
  if (isChunkTarget(s, segs)) {
    const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
    const { indices, keys } = splitChunkWithin(segs.slice(docSegs.length));
    if (keys.length) throw new Error("a fragment target must be the chunk itself"); // create hangs off the chunk
    const lines = fs.readFileSync(bodyFile, "utf8").replace(/\n$/, "").split("\n");
    assertProseChunk(lines, indices); // reject a `*…` / non-text chunk
    const region = chunkFieldRegion(lines, indices, /*ensureOmni*/ true); // convert the chunk to an omni node
    upsertMapEntryAt(lines, region, FRAG_KEY, slug, (indent) => fragmentBlockLines(slug, f.selector, null, indent));
    fs.writeFileSync(bodyFile, lines.join("\n") + "\n");
    return { slug, fragmentPath: segsToStr([...segs, FRAG_KEY, slug]) };
  }
  const { bodyFile, within } = hostFor(dataRoot, s, segs);
  let imagePtr: string | null = null;
  if (f.imageBase64) {
    const bytes = Buffer.from(String(f.imageBase64).replace(/^data:[^,]*,/, ""), "base64");
    if (bytes.length > 0) {
      const { dir, scope } = sidecarTarget(dataRoot, mode, CROP_SUBDIR, bodyFile);
      fs.mkdirSync(dir, { recursive: true });
      const cropName = `${slug}.png`;
      writeInside(dataRoot, dir, cropName, bytes);
      imagePtr = pointerToken(sidecarPointerRaw(CROP_SUBDIR, cropName, scope));
    }
  }
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
  fs.writeFileSync(bodyFile, upsertFragment(src, within, slug, (indent) => fragmentBlockLines(slug, f.selector, imagePtr, indent)));
  return { slug, fragmentPath: segsToStr([...segs, FRAG_KEY, slug]) };
}

// --- thumbnails: a per-type EXTRACTOR product, stored the yamlover way ------------------------ //
// A thumbnail is an omni overlay on the source blob, under `yamlover-thumbnails:`, keyed by the
// `[w, h]` resolution tuple — parallel to `yamlover-fragments`. The bytes can't live inline
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
 *  the sidecar `name` under the mode-appropriate `.yamlover/thumbnails/`. */
function embedThumbnail(dataRoot: string, s: Store, mode: SidecarLocation, segs: Seg[], w: number, h: number, name: string): void {
  const { bodyFile, within } = hostFor(dataRoot, s, segs);
  const { scope } = sidecarTarget(dataRoot, mode, THUMB_SUBDIR, bodyFile);
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
  const ptr = pointerToken(sidecarPointerRaw(THUMB_SUBDIR, name, scope));
  const key = thumbResKey(w, h);
  fs.writeFileSync(bodyFile, upsertThumbnail(src, within, key, (indent) => [`${" ".repeat(indent)}${key}: ${ptr}`]));
}

/** Ensure a `[w, h]` thumbnail of the source blob at `segs` exists: return the sidecar path,
 *  generating (decode → fit → encode → write sidecar → embed overlay) on a miss. Null when no
 *  extractor can decode the format (the caller serves the type glyph). Idempotent — safe to call
 *  concurrently behind the writer queue; a second caller finds the file already written. */
async function ensureThumbnail(dataRoot: string, s: Store, mode: SidecarLocation, segs: Seg[], row: NodeRow, w: number, h: number): Promise<string | null> {
  const sourceAbs = path.join(dataRoot, ...segs.map(String));
  const hash = row.content_hash ?? (await hashFileAsync(sourceAbs));
  const name = thumbName(hash, w, h);
  const { bodyFile } = hostFor(dataRoot, s, segs);
  const { dir } = sidecarTarget(dataRoot, mode, THUMB_SUBDIR, bodyFile);
  const abs = path.join(dir, name);
  if (fs.existsSync(abs)) return abs;
  const thumb = await renderThumbnail(fs.readFileSync(sourceAbs), row.format ?? formatFromExt(sourceAbs), w, h);
  if (!thumb) return null;
  fs.mkdirSync(dir, { recursive: true });
  writeInside(dataRoot, dir, name, thumb.buf);
  embedThumbnail(dataRoot, s, mode, segs, w, h, name);
  return abs;
}

/** Remove a tag application from the target's `yamlover-annotations` array — the first element
 *  referencing `tag` (bare pointer or object `tag:` field). When the target is a FRAGMENT and that
 *  was its last tag, the now-empty fragment node is deleted whole (its selector + crop ref) — a
 *  fragment exists only to carry tags, so a tagless one is dead weight (ANNOTATIONS.md). Sibling
 *  fragments and the host node are untouched. */
function unembedAnnotation(dataRoot: string, s: Store, target: string, tag: string): string {
  const segs = strToSegs(target || ":");
  const needle = (":" + pointerRaw(tag).replace(/^:+/, "")).replace(/\s+/g, "");
  // A tag ON a chunk fragment: reach the chunk field-region + the fragment's body, drop the tag, and
  // — when that was its last — drop the emptied slug and collapse the chunk back to a plain block.
  if (isChunkTarget(s, segs)) {
    const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
    if (!fs.existsSync(bodyFile)) return bodyFile;
    const { indices, keys } = splitChunkWithin(segs.slice(docSegs.length));
    const lines = fs.readFileSync(bodyFile, "utf8").replace(/\n$/, "").split("\n");
    const fragRegion = () => reachBodyAt(lines, chunkFieldRegion(lines, indices, /*ensureOmni*/ false), keys);
    removeAnnotationAt(lines, fragRegion, (t) => t.replace(/\s+/g, "").includes(needle));
    if (keys.length >= 2 && keys[keys.length - 2] === FRAG_KEY && !annotationsRemainAt(lines, fragRegion())) {
      removeMapEntryAt(lines, reachBodyAt(lines, chunkFieldRegion(lines, indices, false), keys.slice(0, -2)), FRAG_KEY, keys[keys.length - 1]);
      collapseChunkOmni(lines, indices); // no fields left → back to a plain `- |` chunk
    }
    fs.writeFileSync(bodyFile, lines.join("\n") + "\n");
    return bodyFile;
  }
  const { bodyFile, within } = hostFor(dataRoot, s, segs);
  if (!fs.existsSync(bodyFile)) return bodyFile;
  // Match on the tag's colon-PATH (`:tags:…:name`), tolerating the pointer's spelling: an item may
  // be project-scope (`*::tags:…`), document-scope (`*: tags: …`, spaced), bare or an object form.
  // Strip whitespace on BOTH sides before the substring test: the item's, to fold a spaced scope
  // (`*: tags: …`), AND the needle's — a tag NAME with a space is a QUOTED key (`'fifth tag'`), so
  // the stored item reads `'fifthtag'` once stripped; an unstripped needle (`'fifth tag'`) would
  // then never match (every spacey-named tag was undeletable).
  let src = removeAnnotationItem(fs.readFileSync(bodyFile, "utf8"), within, (itemText) => itemText.replace(/\s+/g, "").includes(needle));
  // within = [...host, "yamlover-fragments", "<slug>"] for a fragment target; drop it when emptied.
  if (within.length >= 2 && within[within.length - 2] === FRAG_KEY && !annotationsRemain(src, within)) {
    src = removeMapEntry(src, within.slice(0, -2), FRAG_KEY, within[within.length - 1]);
  }
  fs.writeFileSync(bodyFile, src);
  return bodyFile;
}

/** Persist a NEW named tag as a key of the tag-taxonomy body at the project's default tags
 *  location (`settings.yamlover`; `/tags` unless configured): `<location>/.yamlover/body.yamlover`
 *  gains a `<name>: !!<*yamlover/$defs/tag>` entry. The would-be body is PARSED before
 *  committing, so a name the yamlover syntax cannot hold as a plain key (one that vanishes into
 *  a comment, say) is refused instead of corrupting the taxonomy. */
function writeTag(
  dataRoot: string,
  location: string,
  name: string,
): { node: IrNode; pos: number; file: string; createdFile: boolean } {
  if (/[/\\\r\n:]/.test(name)) throw new Error("a tag name cannot contain '/', '\\', ':' or line breaks");
  const root = path.resolve(dataRoot);
  const dir = path.resolve(dataRoot, ...strToSegs(location).map(String), ".yamlover");
  if (!dir.startsWith(root + path.sep)) throw new Error("tags location escapes the data root");
  const file = path.join(dir, "body.yamlover");
  const createdFile = !fs.existsSync(file);
  const head = "# Named tags created from the annotation picker (settings.yamlover: tags.location).\n";
  const existing = createdFile ? head : fs.readFileSync(file, "utf8");
  const body = (existing === "" || existing.endsWith("\n") ? existing : existing + "\n") + `${name}: !!<*::yamlover:$defs:tag>\n`;
  const entries = parseYamlover(body, file).root.entries ?? [];
  const pos = entries.findIndex((e) => e.key === name);
  const entry = pos >= 0 ? entries[pos] : undefined;
  if (!entry || isPointer(entry.value) || entry.value.meta?.schema === undefined) {
    throw new Error(`cannot write a tag named ${JSON.stringify(name)}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  return { node: entry.value, pos, file: [...strToSegs(location).map(String), ".yamlover", "body.yamlover"].join("/"), createdFile };
}

// --------------------------------------------------------------------------- //
// Paste / upload — drop a clipboard file OR plain text into the tree. A file: a directory target
// takes it as a new child; a chapter target takes it into its owning directory and gains a `*…`
// pointer chunk. Text: a chapter target gains it as an inline chunk (no file); any other target
// gets a new chapter .yamlover file in the nearest directory, the text as its one chunk.
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

/** Handle a paste/upload onto the node at `input.path`. Returns the new file's node path and,
 *  for a chapter, the chapter path + the chunk pointer appended to it. */
function handlePaste(dataRoot: string, s: Store, input: PasteInput): Record<string, unknown> {
  const segs = strToSegs(input.path || ":");
  const row = s.node(storePath(segs));
  if (!row) throw new Error(`no such node: ${input.path}`);

  if (input.rich != null) {
    const rich = parseRich(input.rich);
    if (row.format === "x-yamlover-chapter") return pasteRichIntoChapter(dataRoot, s, segs, rich);
    return pasteRichAsChapter(dataRoot, segs, rich);
  }

  if (typeof input.text === "string") {
    const text = input.text.replace(/\r\n?/g, "\n");
    if (text.trim().length === 0) throw new Error("empty paste (no text)");
    if (row.format === "x-yamlover-chapter") return pasteTextIntoChapter(dataRoot, s, segs, text);
    return pasteTextAsChapterFile(dataRoot, segs, text);
  }

  const bytes = Buffer.from(input.contentBase64 || "", "base64");
  if (bytes.length === 0) throw new Error("empty paste (no file bytes)");
  const name = sanitizeName(input.filename ?? "");

  // A chapter gains the file as a pointer chunk appended to its body — UNLESS the caller asked for
  // an `inline` paste, in which case the file merely lands beside the chapter and the caller writes
  // its own reference (a marklower embed token, mid-prose). Appending a chunk there would leave the
  // picture on the page twice: once in the sentence, once at the end.
  if (row.format === "x-yamlover-chapter" && !input.inline) return pasteIntoChapter(dataRoot, s, segs, name, bytes);

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

// The block-structured YAML family the surgical splice engine can edit: a standalone `.yamlover`
// (chapters, and the general editor's native format) or — for the general value editor — a plain
// `.yaml`/`.yml`, whose block grammar (keyed `k:` fields, `- ` items, indentation, `|` blocks) is
// exactly what the engine walks. JSON-family files (flow syntax) are edited on a separate path.
const YAMLOVER_ONLY = /\.yamlover$/i;
const BLOCK_YAML = /\.(ya?ml|yamlover)$/i;
const JSON_FILE = /\.(json|json5|json5p)$/i;

/** The file backing the document at `segs` — directory-backed (`.yamlover/body.yamlover`) or a
 *  standalone file — plus its document root. No extension gate: callers decide which editor (block
 *  YAML vs JSON surgery) the file's extension routes to. */
function resolveBacking(dataRoot: string, s: Store, segs: Seg[]): { docSegs: Seg[]; bodyFile: string; dirBacked: boolean } {
  const docSegs = documentRootSegs(s, segs);
  const docFs = path.resolve(dataRoot, ...docSegs.map(String));
  const dirBacked = fs.existsSync(docFs) && fs.statSync(docFs).isDirectory();
  const bodyFile = dirBacked ? path.join(docFs, ".yamlover", "body.yamlover") : docFs;
  return { docSegs, bodyFile, dirBacked };
}

/** The block-YAML source holding the node at `segs`, validated by extension. `allow` restricts the
 *  STANDALONE file: `.yamlover` only for chapter/paste/annotate flows (the default), widened to
 *  `.yaml`/`.yml` by the general value editor. A directory-backed document is always a
 *  `.yamlover/body.yamlover`. Throws for a JSON-family or otherwise unsupported file. */
function chapterSource(dataRoot: string, s: Store, segs: Seg[], allow: RegExp = YAMLOVER_ONLY): { docSegs: Seg[]; bodyFile: string; dirBacked: boolean } {
  const r = resolveBacking(dataRoot, s, segs);
  const okExt = r.dirBacked ? r.bodyFile.endsWith(".yamlover") : allow.test(r.bodyFile);
  if (!okExt || !fs.existsSync(r.bodyFile)) {
    throw new Error("unsupported edit source (need a .yamlover / .yaml / .yml body)");
  }
  return r;
}

/** A chapter paste: write the file into the chapter's owning directory, then append a pointer to
 *  it as the chapter's last chunk (editing the .yamlover source). */
function pasteIntoChapter(dataRoot: string, s: Store, segs: Seg[], name: string, bytes: Buffer): Record<string, unknown> {
  const { docSegs, bodyFile, dirBacked } = chapterSource(dataRoot, s, segs);
  // the file lands in the doc-root dir (directory-backed) or beside the standalone chapter file.
  const writeDirSegs = dirBacked ? docSegs : docSegs.slice(0, -1);
  const writeDir = path.resolve(dataRoot, ...writeDirSegs.map(String));
  const final = uniqueName(writeDir, name);
  writeInside(dataRoot, writeDir, final, bytes);

  // The chunk pointer: document-scoped (`*/file`) when the file sits inside the chapter's own
  // document (directory-backed); else a project-root link (`*//dir/file`) reaching the sibling.
  const fileSegs = [...writeDirSegs, final];
  const pointer = dirBacked ? `*/${final}` : `*/${segsToStr(fileSegs)}`;
  // The chapter's location WITHIN its document — absolute body-item indices (empty = top-level).
  const within = segs.slice(docSegs.length);
  const src = fs.readFileSync(bodyFile, "utf8");
  fs.writeFileSync(bodyFile, appendBody(src, within, (indent) => [`${" ".repeat(indent)}- ${pointer}`]));
  return { path: segsToStr(fileSegs), chapter: segsToStr(segs), pointer };
}

/** A text paste onto a chapter: the text itself becomes the chapter's last chunk — no file is
 *  written, only the .yamlover source gains an item. */
function pasteTextIntoChapter(dataRoot: string, s: Store, segs: Seg[], text: string): Record<string, unknown> {
  const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
  const within = segs.slice(docSegs.length);
  const src = fs.readFileSync(bodyFile, "utf8");
  fs.writeFileSync(bodyFile, appendBody(src, within, (indent) => textChunkLines(text, indent)));
  return { path: segsToStr(segs), chapter: segsToStr(segs) };
}

/** A text paste onto anything that is NOT a chapter: a new chapter .yamlover file lands in the
 *  nearest enclosing directory — title from the text's first line, the text as its one chunk. */
function pasteTextAsChapterFile(dataRoot: string, segs: Seg[], text: string): Record<string, unknown> {
  const dirSegs = nearestDirSegs(dataRoot, segs);
  if (!dirSegs) throw new Error("no enclosing directory to paste into");
  const dir = path.resolve(dataRoot, ...dirSegs.map(String));
  const title = titleFromText(text);
  const final = uniqueName(dir, chapterFileName(title));
  const src = ["!!<*::yamlover:$defs:chapter>", `title: ${JSON.stringify(title)}`, ...textChunkLines(text, 0), ""].join("\n");
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

/** A subchapter as a positional body item: `- title: …` then its OWN body (chunks + recursive
 *  subchapters) as positional items 2 deeper — the omni chapter shape (CHAPTER.md). */
function richChildLines(node: Rich & { title: string }, indent: number, pointerFor: (name: string, bytes: Buffer) => string): string[] {
  const pad = " ".repeat(indent);
  const lines = [`${pad}- title: ${JSON.stringify(node.title)}`];
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
    return dirBacked ? `*/${final}` : `*/${segsToStr([...writeDirSegs, final])}`;
  };
  const within = segs.slice(docSegs.length);
  let src = fs.readFileSync(bodyFile, "utf8");
  if (rich.chunks.length || rich.children.length) src = appendBody(src, within, (ind) => richBodyLines(rich, ind, pointerFor));
  fs.writeFileSync(bodyFile, src);
  return { path: segsToStr(segs), chapter: segsToStr(segs), files };
}

/** A rich paste onto anything that is NOT a chapter: a new chapter in the nearest enclosing
 *  directory — DIRECTORY-BACKED when it carries files (the images live inside it), else a
 *  standalone .yamlover file. A selection that STARTS with its own heading IS the chapter:
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

  // directory-backed: <name>/.yamlover/body.yamlover + the image files inside <name>/
  const name = uniqueName(dir, chapterFileName(title).replace(/\.yamlover$/, ""));
  const chDir = path.join(dir, name);
  if (!path.resolve(chDir).startsWith(path.resolve(dataRoot) + path.sep)) throw new Error("target escapes the data root");
  fs.mkdirSync(path.join(chDir, ".yamlover"), { recursive: true });
  const pointerFor = (fname: string, bytes: Buffer): string => {
    const final = uniqueName(chDir, fname);
    writeInside(dataRoot, chDir, final, bytes);
    return `*/${final}`;
  };
  const src = renderChapterSource(title, rich, pointerFor);
  writeInside(dataRoot, path.join(chDir, ".yamlover"), "body.yamlover", Buffer.from(src, "utf8"));
  return { path: segsToStr([...dirSegs, name]), dir: segsToStr(dirSegs), open: dirSegs.length !== segs.length };
}

/** The whole .yamlover source of a new rich chapter (the tag, the title, and the positional body). */
function renderChapterSource(title: string, rich: Rich, pointerFor: (name: string, bytes: Buffer) => string): string {
  const lines = ["!!<*::yamlover:$defs:chapter>", `title: ${JSON.stringify(title)}`, ...richBodyLines(rich, 0, pointerFor)];
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

/** Write a new object document into `dir` in the given concrete — a `<base>.yamlover` file or a
 *  `<base>/.yamlover/body.yamlover` directory. `base` is the name WITHOUT extension (caller decides
 *  unicode-vs-pointer-safe). Returns the file/dir NAME actually created (unique). */
function writeObject(dataRoot: string, dir: string, base: string, concrete: string, src: string): string {
  if (concrete === "dir/yamlover") {
    const final = uniqueName(dir, base);
    fs.mkdirSync(path.join(dir, final, ".yamlover"), { recursive: true });
    writeInside(dataRoot, path.join(dir, final, ".yamlover"), "body.yamlover", Buffer.from(src, "utf8"));
    return final;
  }
  const final = uniqueName(dir, base + ".yamlover");
  writeInside(dataRoot, dir, final, Buffer.from(src, "utf8"));
  return final;
}

/** A filename for a new chapter file, from its title: unicode letters/digits/space/dot/dash kept
 *  (non-ASCII names are first-class — see uniqueName for collisions), never hidden. */
function chapterFileName(title: string): string {
  const base = title.replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim().replace(/^\.+/, "");
  return `${base || "pasted"}.yamlover`;
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

/** Write `bytes` to `dir/name`, refusing any path that escapes the served root. */
function writeInside(dataRoot: string, dir: string, name: string, bytes: Buffer): void {
  const root = path.resolve(dataRoot);
  const target = path.resolve(dir, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("target escapes the data root");
  fs.writeFileSync(target, bytes);
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
 *  dedent to the field column ends the block (YAMLOVER.md §4). Blank lines are emitted truly empty:
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
function chapterEntries(lines: string[], r: Region): ChapterEntry[] {
  const starts: { key: string | null; start: number; inline: boolean }[] = [];
  if (r.marker >= 0) {
    // Only a `- ` DASH item carries an inline first child (`- title: X`, `- name: Rex`). A KEYED
    // marker line (`pets:`, `rating: !!var 5`) is the parent's key / self-value — its entries sit on
    // the lines BELOW, never inline — so surfacing its text would inject a phantom entry (its own
    // key) and shift every index. Chapters only ever descend `- ` items, so this only bit the general
    // value editor descending a `key:` → sequence/mapping.
    const raw = lines[r.marker].replace(/^\s*/, "");
    if (raw === "-" || raw.startsWith("- ")) {
      // the item's inline `!!<…>` schema tag is META, not an entry — surfacing it would inject a
      // phantom first entry and shift every index (a `- !!<…table>` body item's rows, e.g.)
      const inline = raw.replace(/^-\s*/, "").replace(/^!!<[^>]*>\s*/, "");
      if (inline.trim()) starts.push({ key: /^-/.test(inline) ? null : inline.match(/^([^:\s]+):/)?.[1] ?? null, start: r.marker, inline: true });
    }
  }
  for (let i = r.lo; i < r.hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < r.indent) break; // left the mapping
    if (ind !== r.indent) continue; // deeper → the current entry's body
    const t = lines[i].trim();
    if (t.startsWith("!!<")) continue; // the node's OWN schema tag line — not an entry
    starts.push({ key: t === "-" || t.startsWith("- ") ? null : t.match(/^([^:\s]+):/)?.[1] ?? null, start: i, inline: false });
  }
  return starts.map((s, k) => ({
    absIndex: k,
    key: s.key,
    start: s.start,
    end: k + 1 < starts.length ? starts[k + 1].start : trimBack(lines, s.start, r.hi),
    inline: s.inline,
  }));
}

/** The entry `seg` names within `r`: a keyed field by name, or any entry by ABSOLUTE index. */
function findEntry(lines: string[], r: Region, seg: Seg): ChapterEntry | undefined {
  const entries = chapterEntries(lines, r);
  return typeof seg === "number" ? entries[seg] : entries.find((e) => e.key === seg);
}

/** An entry's own VALUE source on its opening line — past the `- ` marker, its inline `!!<…>` tag,
 *  and (for a keyed entry) its own `key:`. A block header (`|-`), a quoted/plain scalar, a `*…`
 *  pointer, or — for a positional entry holding a mapping — an inline `key: value`. */
function entryHead(lines: string[], e: ChapterEntry): string {
  let t = lines[e.start].trim().replace(/^-\s*/, "").replace(/^!!<[^>]*>\s*/, "");
  if (e.key) t = t.slice(t.indexOf(":") + 1).trim(); // a keyed entry's head is what follows `key:`
  return t;
}

/** True when the entry HOLDS entries of its own (a mapping/sequence), rather than being a scalar
 *  leaf. A block scalar's content sits at the child column, so it only counts as a container when
 *  it also carries keyed fields there (an omni node — see {@link itemHasFields}). */
function isContainerEntry(lines: string[], e: ChapterEntry, childIndent: number): boolean {
  const head = entryHead(lines, e);
  if (/^[|>][+-]?\d*$/.test(head.trim())) return itemHasFields(lines, e, childIndent); // omni block, or plain
  // The inline `key:` test must not read past a trailing comment: a scalar's comment may itself
  // contain a colon (`theme: dark   # ui palette: dark | light`), which is prose, not a mapping.
  // A plain scalar cannot contain ` #` (yamlover comments need the leading whitespace), and a
  // quoted head never enters the regex (its first char is excluded), so the strip is safe.
  const bare = head.replace(/\s+#.*$/, "");
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
    if (!entry) throw new Error(`no entry at ${typeof seg === "number" ? `[${seg}]` : seg}`);
    if (!isContainerEntry(lines, entry, r.indent + 2)) {
      throw new Error(`cannot descend into a scalar element at ${typeof seg === "number" ? `[${seg}]` : seg}`);
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
 *  chapter at `chapterPath` within a .yamlover source. */
function appendBody(text: string, chapterPath: Seg[], renderItems: (indent: number) => string[]): string {
  const lines = text.split("\n");
  const r = reachChapter(lines, chapterPath);
  lines.splice(bodyAppendPoint(lines, r), 0, ...renderItems(r.indent));
  return lines.join("\n");
}

// --- facets: the /api/edit surgical ops ------------------------------------------------------ //
// A node has four FACETS (TYPES.md): its scalar value, its keyed entries, its ordinal (positional)
// entries, and its `!!<…>` meta tag. `emplace` replaces only the facets its payload carries and
// leaves the rest standing — which is what lets a prose edit keep an annotated chunk's
// `yamlover-annotations` overlay. `replace` drops all four and assigns the payload.

/** A node's facets as column-0 yamlover source: the scalar's own source, and each keyed / ordinal
 *  entry as its own group of lines (kept verbatim, so re-emitting one never reformats it). */
interface Facets {
  scalar?: string;
  keyed: string[][];
  ordinal: string[][];
}

/** True for a line that opens an entry — a `- ` item or a `key:` field. A block scalar's content is
 *  NOT an entry, which is why prose that looks like `note: hi` must reach us escaped. */
const opensEntry = (t: string): boolean => t === "-" || t.startsWith("- ") || /^[^\s"'*|>#-][^:]*:(\s|$)/.test(t);

const isBlockHeader = (head: string): boolean => /^[|>][+-]?\d*$/.test(head.trim());

/** Group column-0 source lines into entries, keyed and ordinal, each group verbatim. */
function groupEntries(lines: string[], at: number): { keyed: string[][]; ordinal: string[][] } {
  const starts = lines.map((l, i) => i).filter((i) => isContentLine(lines[i]) && indentOf(lines[i]) === at);
  const keyed: string[][] = [];
  const ordinal: string[][] = [];
  starts.forEach((s, k) => {
    const group = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length).map((l) => l.slice(at));
    (lines[s].trim() === "-" || lines[s].trim().startsWith("- ") ? ordinal : keyed).push(group);
  });
  return { keyed, ordinal };
}

/** The facets a column-0 `yamlover` payload carries. A payload whose first content line opens no
 *  entry is a SCALAR — a block header, a quoted/plain scalar, or a `*…` pointer. */
function payloadFacets(src: string): Facets {
  const lines = src.split("\n");
  const first = lines.find(isContentLine);
  if (first === undefined) return { keyed: [], ordinal: [] };
  if (!opensEntry(first.trim())) return { scalar: src, keyed: [], ordinal: [] };
  return { scalar: undefined, ...groupEntries(lines, 0) };
}

/** The facets an EXISTING entry carries, as column-0 source (its own indentation stripped), plus
 *  the inline `!!<…>` it wears. A block scalar's content lives at the child column when the node is
 *  plain, and one step deeper when it is an omni carrying keyed fields (YAMLOVER.md §4). */
function entryFacets(lines: string[], e: ChapterEntry, indent: number): Facets & { tag?: string } {
  const marked = lines[e.start].trim().replace(/^-\s*/, "");
  const tag = marked.match(/^(!!<[^>]*>)/)?.[1];
  const head = entryHead(lines, e);
  const childIndent = indent + 2;
  // a value's continuation lines are re-emitted with their own relative indent (2 under the header)
  const value = (from: number, to: number, at: number): string =>
    [head, ...lines.slice(from, to).map((l) => (l.trim().length ? "  " + l.slice(at) : ""))].join("\n").replace(/\n+$/, "");

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
  const scalar = blockValue ? value(e.start + 1, firstChild, childIndent + 2) : undefined;
  const groups = groupEntries(lines.slice(firstChild, e.end), childIndent);
  if (!blockValue && head) groups.keyed.unshift([head]); // the key inlined on the `- ` marker
  return { tag, scalar, ...groups };
}

/** Render a node from its facets at `indent`. `marker` is `"- "` (positional) or `` `${key}: ` ``.
 *  A positional container inlines its first keyed entry on the marker line (`- title: X`), the shape
 *  a chapter's subchapters already have. A node with children keeps its block scalar one step
 *  deeper than them, so the dedent ends the block. */
function renderNode(f: Facets, indent: number, marker: string, tag?: string): string[] {
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);
  const groups = [...f.keyed, ...f.ordinal];
  const child = (g: string[]): string[] => g.map((l) => (l.trim().length ? childPad + l : ""));

  if (f.scalar !== undefined) {
    return [...renderEntry(f.scalar, indent, marker, tag, groups.length > 0), ...groups.flatMap(child)];
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

/** The `!!<…>` a payload asks for: the given `meta`, the entry's existing tag when `meta` is omitted
 *  and the op preserves (emplace), or none. */
function metaTag(meta: string | null | undefined, existing: string | undefined, preserve: boolean): string | undefined {
  if (meta === null) return undefined;
  if (meta !== undefined) return `!!<${meta}>`;
  return preserve ? existing : undefined;
}

/** `emplace` / `replace` / `remove` on the entry `seg` names within `r`; `insert` before it (or
 *  appended when `seg` is undefined — the path named the node itself). */
function assignAt(lines: string[], r: Region, seg: Seg | undefined, op: string, valueSrc: string, meta: string | null | undefined): void {
  const marker = (s: Seg | undefined): string => (typeof s === "string" ? `${s}: ` : "- ");

  if (op === "insert") {
    if (typeof seg === "string") throw new Error("`insert` needs a positional target (a path ending `[i]`, or the node itself)");
    const entry = seg === undefined ? undefined : findEntry(lines, r, seg);
    const at = entry ? entry.start : bodyAppendPoint(lines, r); // an index past the end appends
    lines.splice(at, 0, ...renderNode(payloadFacets(valueSrc), r.indent, "- ", metaTag(meta, undefined, false)));
    return;
  }

  if (seg === undefined) throw new Error(`\`${op}\` needs a key or index target`);
  const entry = findEntry(lines, r, seg);

  if (op === "remove") {
    if (!entry) throw new Error(`no entry at ${typeof seg === "number" ? `[${seg}]` : seg}`);
    lines.splice(entry.start, entry.end - entry.start);
    return;
  }
  if (op !== "emplace" && op !== "replace") throw new Error(`unknown edit op: ${op}`);

  if (!entry) {
    // emplace at a FRESH path: a new keyed field, or an appended positional item
    if (op === "replace") throw new Error(`no entry at ${typeof seg === "number" ? `[${seg}]` : seg}`);
    const rendered = renderNode(payloadFacets(valueSrc), r.indent, marker(seg), metaTag(meta, undefined, false));
    const at = typeof seg === "string" ? (r.marker >= 0 ? r.marker + 1 : trimBack(lines, r.lo - 1, r.hi)) : bodyAppendPoint(lines, r);
    lines.splice(at, 0, ...rendered);
    return;
  }

  const had = entryFacets(lines, entry, r.indent);
  const payload = payloadFacets(valueSrc);
  const inlineKey = entry.inline ? entry.key : null; // a key living on its parent's `- ` marker line
  const next: Facets =
    op === "replace"
      ? payload
      : {
          scalar: payload.scalar ?? had.scalar,
          keyed: payload.keyed.length ? payload.keyed : had.keyed,
          ordinal: payload.ordinal.length ? payload.ordinal : had.ordinal,
        };
  const tag = metaTag(meta, had.tag, op === "emplace");

  if (inlineKey) {
    // `- title: X` — rewrite the marker line in place, keeping the `- `
    const pad = " ".repeat(indentOf(lines[entry.start]));
    lines[entry.start] = `${pad}- ${tag ? tag + " " : ""}${inlineKey}: ${next.scalar ?? '""'}`;
    return;
  }
  lines.splice(entry.start, entry.end - entry.start, ...renderNode(next, r.indent, marker(seg), tag));
}

// --- chunk fragments (ANNOTATIONS.md §3): a text fragment lives ON the chunk it was drawn in ----- //
// A chunk that carries a fragment becomes an OMNI node — its prose is a block-scalar self-value and
// `yamlover-fragments:`/`yamlover-annotations:` are keyed fields. These fields sit at the item's
// child indent (item-indent + 2); the block-scalar content is pushed one step DEEPER (item-indent +
// 4) so its dedent to the field level ends the block (YAMLOVER.md §4). Reached by ABSOLUTE index
// (node-path space — what the fragment target uses), NOT the /api/edit rank space.

/** The absolute-index body item at `indices` (the last descends INTO the item; earlier ones descend
 *  subchapters), with the parent region that holds it. */
function reachChapterItem(lines: string[], indices: number[]): { parent: Region; item: ChapterEntry; itemIndent: number } {
  const parent = reachChapter(lines, indices.slice(0, -1));
  const idx = indices[indices.length - 1];
  const item = chapterEntries(lines, parent)[idx];
  if (!item || item.key !== null) throw new Error(`no chapter body item at [${idx}]`);
  return { parent, item, itemIndent: parent.indent };
}

/** True once the item at `[item.start,item.end)` already has keyed fields at `fieldIndent` (an omni
 *  node) — a `key:` line at exactly that column (its block-scalar content sits deeper). */
function itemHasFields(lines: string[], item: ChapterEntry, fieldIndent: number): boolean {
  for (let i = item.start + 1; i < item.end; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < fieldIndent) break;
    if (ind === fieldIndent && /^[^\s-][^:]*:(\s|$)/.test(lines[i].trim())) return true;
  }
  return false;
}

/** Rewrite a PLAIN chunk item into an omni node so it can carry fields: push its block-scalar
 *  content one step deeper (to item-indent + 4), or convert an inline scalar item into a `- |`
 *  block at that indent. Preserves a leading inline `!!<…>` schema tag. */
function convertChunkToOmni(lines: string[], item: ChapterEntry, itemIndent: number): void {
  const head = lines[item.start].slice(itemIndent).replace(/^-\s*/, "");
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

/** The field-level Region of the chapter body item at absolute `indices` (where `yamlover-fragments:`
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
  const head = lines[item.start].slice(indentOf(lines[item.start])).replace(/^-\s*/, "");
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
 *  keys (e.g. `[3, "yamlover-fragments", "slug"]` → `{ indices:[3], keys:["yamlover-fragments","slug"] }`). */
function splitChunkWithin(within: Seg[]): { indices: number[]; keys: string[] } {
  let i = 0;
  while (i < within.length && typeof within[i] === "number") i++;
  return { indices: within.slice(0, i).map(Number), keys: within.slice(i).map(String) };
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

// --- flow-row cell surgery (MARKLOWER.md) --------------------------------------------------------- //
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

/** Scan a flow sequence from its `[`: the matching `]` and each top-level cell's [start,end)
 *  span — nested brackets (a nested flow seq, a `*…[.-1]` pointer) and quoted cells respected. */
function scanFlowSeq(s: string, open: number): { close: number; cells: { start: number; end: number }[] } | null {
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
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
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
  if (text.includes("\n")) throw new Error("a flow-row cell cannot hold multi-line text — rewrite the row in block form (MARKLOWER.md)");
  const cell = scan.cells[cellIdx];
  if (!cell) throw new Error(`no cell [${cellIdx}] in the flow row (${scan.cells.length} cells)`);
  const lead = cellIdx === 0 ? "" : " "; // the row's own style: none after `[`, one after `,`
  lines[row.start] = raw.slice(0, cell.start) + lead + flowCellToken(text) + raw.slice(cell.end);
  return true;
}

/** Apply one surgical edit to a `.yamlover` source, addressed by `within` — the edit path relative
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
function editChapterSource(src: string, within: Seg[], op: string, valueSrc: string, meta: string | null | undefined): string {
  const lines = src.split("\n");
  if (within.length === 0) {
    if (op === "insert") {
      assignAt(lines, reachChapter(lines, []), undefined, op, valueSrc, meta);
      return lines.join("\n");
    }
    if (op === "emplace" && meta !== undefined && !valueSrc) {
      setRootTag(lines, meta);
      return lines.join("\n");
    }
    throw new Error(`\`${op}\` at a document root needs a key or index target`);
  }
  // a numeric segment into a FLOW row (a table's `- [a, b, c]` / `header: […]`): the block
  // engine cannot descend into the one-line row — splice the cell token instead (MARKLOWER.md)
  const last = within[within.length - 1];
  if (within.length >= 2 && typeof last === "number") {
    const parentR = reachChapter(lines, within.slice(0, -2));
    const rowEntry = findEntry(lines, parentR, within[within.length - 2]);
    if (rowEntry && !isContainerEntry(lines, rowEntry, parentR.indent + 2) && editFlowRowCell(lines, rowEntry, last, op, valueSrc)) {
      return lines.join("\n");
    }
  }
  assignAt(lines, reachChapter(lines, within.slice(0, -1)), within[within.length - 1], op, valueSrc, meta);
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
        ? entries.filter((e) => e.edge === "contain" && e.key === null)[seg] // positional element
        : entries.find((e) => e.edge === "contain" && e.key === seg); // keyed field
    if (!entry) throw new Error(`no entry at ${typeof seg === "number" ? `[${seg}]` : seg}`);
    const value = entry.value;
    if (k === within.length - 1) {
      if (isPointer(value) || value.kind !== "scalar") throw new Error("only a scalar value is editable in a JSON file");
      const span = entry.meta?.span;
      if (!span) throw new Error("no source span for the target value");
      const [vs, ve] = jsonValueSpan(src, span.start, span.end);
      return src.slice(0, vs) + token + src.slice(ve);
    }
    if (isPointer(value) || value.kind !== "mapping") throw new Error(`cannot descend into a non-container at ${typeof seg === "number" ? `[${seg}]` : seg}`);
    node = value;
  }
  throw new Error("empty JSON edit path"); // unreachable (within.length checked)
}

/** A one-line `*…` pointer — a legal entry VALUE, but not a legal document on its own, so it never
 *  goes through the document parser. */
const isPointerValue = (src: string): boolean => /^\*\S*$/.test(src.trim()) && !src.includes("\n");

/** A filesystem directory that backs NO yamlover document — it has no `.yamlover/body.yamlover` to
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

/** One edit, resolved to the file it lands in. */
interface ResolvedEdit {
  within: Seg[];
  op: string;
  valueSrc: string;
  meta: string | null | undefined;
  concrete?: string;
  name?: string;
  docSegs: Seg[];
  dirBacked: boolean;
}

/** `concrete: file/yamlover | dir/yamlover` — the content is born as its OWN document beside the
 *  parent, and what lands in the parent's source is a `*` pointer to it. Returns the pointer source
 *  and the new document's node path (what a create navigates to). */
function bornAsDocument(dataRoot: string, e: ResolvedEdit, tag: string | undefined): { pointer: string; path: string } {
  const writeDirSegs = e.dirBacked ? e.docSegs : e.docSegs.slice(0, -1);
  const writeDir = path.resolve(dataRoot, ...writeDirSegs.map(String));
  const src = [...(tag ? [tag] : []), e.valueSrc, ""].join("\n");
  // a linked document is reached by a `*` pointer → name it pointer-safe (no spaces/unicode)
  const final = writeObject(dataRoot, writeDir, sanitizeName(e.name || "object"), e.concrete!, src);
  const targetSegs = [...writeDirSegs, final];
  return { pointer: e.dirBacked ? `*/${final}` : `*/${segsToStr(targetSegs)}`, path: segsToStr(targetSegs) };
}

/** Apply a BATCH of edits, grouped by their backing file (a document can span several — each part
 *  routes to its own via {@link chapterSource}). Ops for one file fold in order, each re-scanning
 *  the buffer the previous one left, so absolute indices stay consistent; each touched file is
 *  written once. Returns the touched files (to reindex) and any document born along the way. */
function applyEdits(dataRoot: string, s: Store, edits: EditInput[]): { touched: string[]; created: string[]; appended: Seg[][] } {
  const byFile = new Map<string, ResolvedEdit[]>();
  const jsonByFile = new Map<string, { within: Seg[]; valueSrc: string }[]>(); // JSON-family scalar edits
  const appended: Seg[][] = []; // parents an INLINE entry was appended to — their new last child is the created node
  const created: string[] = [];
  for (const e of edits) {
    const editSegs = strToSegs(e.path ?? "");
    const op = String(e.op ?? "");

    // A directory that backs no document has no source to splice: inserting into it creates a
    // MEMBER — a document of its own, named for itself rather than pointed at from a parent's body.
    // (A dir-BACKED document is a directory too, but `chapterSource` finds its body, so it lands in
    // the ordinary path below and gains a child.)
    if (op === "insert" && (e.concrete === "file/yamlover" || e.concrete === "dir/yamlover") && isPlainDir(dataRoot, s, editSegs)) {
      const dir = path.resolve(dataRoot, ...editSegs.map(String));
      const src = [...(metaTag(e.meta, undefined, false) ? [metaTag(e.meta, undefined, false)!] : []), String(e.yamlover ?? ""), ""].join("\n");
      if (e.yamlover) parseYamlover(String(e.yamlover), "<edit>");
      const final = writeObject(dataRoot, dir, objectBaseName(String(e.name || "new")), String(e.concrete), src);
      created.push(segsToStr([...editSegs, final]));
      continue;
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

    const { docSegs, bodyFile, dirBacked } = chapterSource(dataRoot, s, editSegs, BLOCK_YAML);
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
    const list = byFile.get(bodyFile) ?? [];
    list.push({
      within: editSegs.slice(docSegs.length),
      op,
      valueSrc: String(e.yamlover ?? ""),
      meta: e.meta === undefined ? undefined : e.meta === null ? null : String(e.meta),
      concrete,
      name: e.name ? String(e.name) : undefined,
      docSegs,
      dirBacked,
    });
    byFile.set(bodyFile, list);
  }
  const touched: string[] = [];
  for (const [bodyFile, ops] of byFile) {
    let src = fs.readFileSync(bodyFile, "utf8");
    for (const o of ops) {
      let { valueSrc, meta } = o;
      const tag = metaTag(meta, undefined, false);
      // The CALLER's payload must be valid yamlover on its own — parse it before anything is
      // spliced, so a malformed fragment 400s with the document untouched. Two things are legal as
      // an entry's value but not as a whole document, and so are not parsed as one: the `!!<…>` tag
      // (`!!<…> |-`), and a bare `*` pointer (which is also what `concrete` generates below).
      if (valueSrc && !isPointerValue(valueSrc)) parseYamlover(valueSrc, "<edit>");
      if (o.concrete === "file/yamlover" || o.concrete === "dir/yamlover") {
        // the value becomes its own document; the parent gets a `*` pointer, which carries no tag
        const born = bornAsDocument(dataRoot, o, tag);
        created.push(born.path);
        valueSrc = born.pointer;
        meta = undefined;
      }
      src = editChapterSource(src, o.within, o.op, valueSrc, meta);
    }
    fs.writeFileSync(bodyFile, src);
    touched.push(bodyFile);
  }
  for (const [file, jedits] of jsonByFile) {
    let src = fs.readFileSync(file, "utf8");
    for (const j of jedits) {
      src = editJsonScalar(src, j.within, yamloverScalarToJsonToken(j.valueSrc)); // yamlover payload → JSON token
    }
    fs.writeFileSync(file, src);
    touched.push(file);
  }
  return { touched, created, appended };
}

interface EditInput {
  path?: string; // the yamlover path of the node being edited (a key or an absolute index per segment)
  op?: string; // emplace | replace | insert | remove
  yamlover?: string; // the node's value as VALID inline yamlover source — the caller escapes its own prose
  meta?: string | null; // the `!!<…>` schema pointer: set it, `null` to drop it, omit to leave it alone
  concrete?: string; // yamlover | file/yamlover | dir/yamlover — only where content is BORN
  name?: string; // the file/dir name when `concrete` births a document
}

// A dataRoot that never exists: `concreteOf`'s stats throw and every node falls through to plain
// "yamlover" — nothing a standalone-document projection does can reach the real filesystem.
const PREVIEW_ROOT = path.join(os.tmpdir(), ".yamlover-preview-nonexistent");

/** The /api/json-shaped payload for a STANDALONE yamlover document (no file behind it — e.g. the
 *  client's browser-settings text): parse, index into a throwaway in-memory store, project at
 *  UNLIMITED depth. Depth is pinned to Infinity by design — a finite depth would emit
 *  `$yamloverLink` markers into a store no later request can reach. In-document pointers resolve
 *  to in-page refs; project/world-scope ones are unrealized and render as plain pointer text. */
export function previewPayload(source: string): Record<string, unknown> {
  const doc = parseYamlover(source, "<preview>");
  // stamp what the walk stamps on a parsed file: the root IS a document root, and the head-of-file
  // banner rides its meta (collectComments reads both from the node, not the Document)
  doc.root.meta = { ...doc.root.meta, documentRoot: true, ...(doc.head?.length ? { head: doc.head } : {}) };
  const s = new Store(":memory:");
  try {
    s.indexDocument(doc);
    const row = s.node(":")!;
    return {
      path: ":",
      type: tocType(s, ":", row),
      format: row.format ?? null,
      ...facetsOf(s, ":", row),
      concrete: "yamlover", // by construction — the document IS yamlover text
      documentPath: ":",
      title: titleOf(s, ":"),
      description: descriptionOf(s, ":"),
      value: projectValue(PREVIEW_ROOT, s, [], Infinity, true),
      comments: collectComments(doc, [], Infinity),
      relations: {}, // a standalone document has no project around it
    };
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
    out = editChapterSource(out, strToSegs(String(e.path ?? "")), String(e.op ?? ""), valueSrc, meta);
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
 *  is flagged `documentRoot` (a parsed file / `.yamlover` dir / served root), as segments. It is
 *  the anchor a document-relative (`/…`) pointer resolves against, mirroring the `/` pointer scope. */
function documentRootSegs(s: Store, segs: Seg[]): Seg[] {
  for (let i = segs.length; i >= 0; i--) {
    const anc = segs.slice(0, i);
    if (s.node(storePath(anc))?.meta?.documentRoot) return anc;
  }
  return [];
}

/** The nearest enclosing document root as a client JSON path (`/…`). */
function documentPath(s: Store, segs: Seg[]): string {
  return segsToStr(documentRootSegs(s, segs));
}

/** A node's `title` child value (a scalar), if any — used as a friendly label. */
function titleOf(s: Store, p: string): string | null {
  return scalarKeyOf(s, p, "title");
}

function descriptionOf(s: Store, p: string): string | null {
  return scalarKeyOf(s, p, "description");
}

/** A node's scalar keyed child `key` (a leaf scalar), or null — the chapter title/description.
 *
 *  CHILDLESSNESS is not part of being a scalar. Annotating a title lays the tag applications over it
 *  as keyed entries (ANNOTATIONS.md): the row stays a `scalar` carrying its own value, and gains a
 *  child. That is precisely an omni/`variant` node — `type: string` and `type: variant` both match
 *  it (query.ts) — and tagging must never change how a node reads (TYPES.md §9). Demanding no
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

/** Render segments as a client-facing JSON path (`:key[0]:x`, colon-form — SEPARATOR.md M4),
 *  percent-encoding keys. */
function segsToStr(segs: Seg[]): string {
  return segs.map((seg) => (typeof seg === "number" ? `[${seg}]` : `:${encodeURIComponent(seg)}`)).join("") || ":";
}

/** Parse a client JSON path into segments (`[n]` → number, else a decoded key). */
function strToSegs(str: string): Seg[] {
  const out: Seg[] = [];
  for (const tok of str.match(PATH_TOKEN) || []) out.push(/^\[\d+\]$/.test(tok) ? Number(tok.slice(1, -1)) : safeDecode(tok));
  return out;
}

/** Build the raw Store path (un-encoded keys) the index uses, from decoded segments. */
function storePath(segs: Seg[]): string {
  return segs.map((seg) => (typeof seg === "number" ? `[${seg}]` : `:${seg}`)).join("") || ":";
}

/** Parse a raw Store path back into segments (keys are raw — no decode). */
function storePathToSegs(p: string): Seg[] {
  const out: Seg[] = [];
  for (const tok of p.match(PATH_TOKEN) || []) out.push(/^\[\d+\]$/.test(tok) ? Number(tok.slice(1, -1)) : tok);
  return out;
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

// `undefined` = absent (the caller picks a per-concrete default), `Infinity` = `.inf`/`inf`
// (unlimited), a finite integer = that level. A malformed value is treated as absent.
function parseDepth(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  if (raw === ".inf" || raw === "inf") return Infinity;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The render depth when the request pins none: ONE level for a binary leaf or a directory (a plain
 *  folder or a `.yamlover`-backed directory — the explorer shows one level), else UNLIMITED
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

/** A blob-backed node's own bytes AS a value slot — a navigable `< binary of N bytes >` link (never
 *  the raw bytes, which don't sit in the JSON tree). Used for an omni whose self-value is a file
 *  (an image with `yamlover-thumbnails`/annotations): clicking opens the file, not `null`. */
function binaryValueMarker(segs: Seg[], row: NodeRow): Record<string, unknown> {
  const info: Record<string, unknown> = { kind: "binary", type: "blob", path: segsToStr(segs), size: row.size };
  if (row.format) info.format = row.format;
  return { [LINK_KEY]: info };
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
