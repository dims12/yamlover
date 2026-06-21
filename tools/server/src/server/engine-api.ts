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
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store, reindex, reindexAsyncDoc, reindexPathAsync, hashFileAsync, watchTree, loadSettings, ensureSettingsFile, writeSettingKey, mv, relinkMoved, evalQuery } from "../../../engine/ts/src/index.ts";
import type { NodeRow, EdgeRow, Settings, SidecarLocation, IndexDiff } from "../../../engine/ts/src/index.ts";
import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { pointerToken } from "../../../parser/ts/src/serialize-yamlover.ts";
import { appendAnnotation, upsertFragment, upsertThumbnail, removeAnnotation as removeAnnotationItem, keyToken } from "./embed.js";
import { renderThumbnail } from "./extract/thumbnails.js";
import { colonSegment } from "../../../parser/ts/src/pointer.ts";
import { isPointer } from "../../../parser/ts/src/ir.ts";
import type { Node as IrNode, Document } from "../../../parser/ts/src/ir.ts";
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
      // view). Rewrites the board directory's overlay `columns:` block (a sequence of lanes, each a
      // flow-sequence of tag pointers), then reconciles. Body: { path, columns: string[][] } where
      // each inner string is a tag client-path. The pointers are written project-scope (`*::…`),
      // exactly like an annotation's tag (so they resolve from the served root).
      if (req.method === "POST" && url.pathname === "/api/board") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const b = data as { path?: string; columns?: unknown };
              const cols: string[][] = Array.isArray(b?.columns) ? b.columns.map((lane) => (Array.isArray(lane) ? lane.map((p) => String(p)) : [])) : [];
              const { bodyFile } = hostFor(dataRoot, s, strToSegs(b?.path || ":"));
              fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
              const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
              fs.writeFileSync(bodyFile, writeBoardColumns(src, cols));
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
      // so an AI agent co-editing this directory has the authoring/safety rules to hand. Skip &
      // report by default — existing files are left untouched (status "exists") unless the body
      // says `{ overwrite: true }`. Triggered by the leftmost breadcrumb button in the client.
      if (req.method === "POST" && url.pathname === "/api/agent-docs") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const overwrite = !!(data as { overwrite?: unknown })?.overwrite;
              const files: { name: string; status: "created" | "overwritten" | "exists" }[] = [];
              let wrote = false;
              for (const doc of loadAgentDocs()) {
                const exists = fs.existsSync(path.resolve(dataRoot, doc.name));
                if (exists && !overwrite) {
                  files.push({ name: doc.name, status: "exists" });
                  continue;
                }
                writeInside(dataRoot, dataRoot, doc.name, Buffer.from(doc.content, "utf8"));
                files.push({ name: doc.name, status: exists ? "overwritten" : "created" });
                wrote = true;
              }
              if (wrote) {
                broadcast(await doReindex());
                scheduleHasher();
              }
              return { files };
            }),
          )
          .then((body) => sendJson(res, 201, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // The project config (IMPORTS.md) — `<root>/.yamlover/settings.yamlover`. It is indexed as a
      // HIDDEN node (`:.yamlover:settings.yamlover`, format x-yamlover-config) rendered by the
      // SETTINGS EDITOR; this pair gives that editor the RAW source (the node projection drops
      // comments) and the PARSED settings, and writes edits back. GET → { source, settings }.
      if (req.method !== "POST" && url.pathname === "/api/config") {
        const source = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "";
        sendJson(res, 200, { source, settings, path: ":.yamlover:settings.yamlover" });
        return;
      }
      // Save edited config source. Body: { source }. The source must PARSE (parseYamlover throws on
      // garbage — settings must never break serving), then it is written, the in-memory Settings
      // reloaded, and the now-indexed settings node REINDEXED + broadcast so the open editor (and any
      // view) refreshes through the unified SSE flow. Returns the freshly parsed Settings.
      if (req.method === "POST" && url.pathname === "/api/config") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const source = String((data as { source?: unknown })?.source ?? "");
              parseYamlover(source, settingsFile); // validate — throws ⇒ 400, file untouched
              fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
              fs.writeFileSync(settingsFile, source);
              settings = loadSettings(dataRoot);
              broadcast(await doReindexFile(settingsFile));
              return { ok: true, settings };
            }),
          )
          .then((body) => sendJson(res, 200, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Persist the LAST-USED annotation tag (the picker default) into settings.yamlover — a single
      // surgical line (`annotation-tag: *:: …`) preserving the rest of the config (IMPORTS.md / the
      // tag is project-scoped, not browser-local). Body: { tag } (a client tag path). Reloads
      // settings + reindexes the config node. Best-effort: a bad path is a 400, settings untouched.
      if (req.method === "POST" && url.pathname === "/api/last-tag") {
        readBody(req)
          .then((data) =>
            enqueue(async () => {
              const tag = String((data as { tag?: unknown })?.tag ?? "").trim();
              if (!tag) throw new Error("last-tag needs a `tag` path");
              const segs = strToSegs(tag);
              if (segs.length === 0 || segs.some((g) => typeof g === "number")) throw new Error(`not a tag node path: ${tag}`);
              // a PROJECT-scope pointer naming the tag at the project root: `*:: a: b: c`
              writeSettingKey(dataRoot, "annotation-tag", "*:: " + segs.map((s) => colonSegment(String(s))).join(": "));
              settings = loadSettings(dataRoot);
              // announce-only (no full reindex): this fires on every annotation, and the seed is read
              // live from the file via GET /api/config — the indexed node trues up on the next reconcile.
              announce({ changed: [relFileOf(":.yamlover:settings.yamlover")] });
              return { ok: true, annotationTag: settings.annotationTag };
            }),
          )
          .then((body) => sendJson(res, 200, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
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
      const viewDepth = depth === undefined ? defaultDepth(dataRoot, segs, row, kind) : depth;

      if (url.pathname === "/api/json") {
        // Gate the byte fetch on the binary VALUE FACET (a blob), not the display `kind`: an image
        // that also owns overlay entries (thumbnails/fragments/annotations) reads as `variant`/omni,
        // but its bytes are still fetchable via ?binary=1.
        const wantBytes = row.type === "blob" && url.searchParams.get("binary") === "1";
        sendJson(res, 200, {
          path: segsToStr(segs),
          type: tocType(s, p, row),
          format: row.format ?? null,
          ...facetsOf(s, p, row), // valueType / hasKeyed / hasOrdinal — the renderer dispatch facets (TYPES.md §9)
          concrete: concreteOf(dataRoot, segs, row), // dir | yamlover | null (stat-derived; engine tracks no per-node concrete yet)
          documentPath: documentPath(s, segs), // nearest enclosing document root (for `/…` links)
          title: titleOf(s, p),
          description: null,
          value: wantBytes ? binaryContent(dataRoot, segs, row) : projectValue(dataRoot, s, segs, viewDepth, true),
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
  // DB. `ready` resolves when the initial background index lands (tests await it; the bin
  // catches it so a failed index cannot crash as an unhandled rejection).
  return Object.assign(handler, {
    ready,
    close: (): void => {
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

/** The json-family surface concrete a file's extension names, or null. */
const JSON_EXT: Record<string, "json" | "json5" | "json5p"> = { ".json": "json", ".json5": "json5", ".json5p": "json5p" };

/** How the node at `segs` is stored on disk, as far as a stat can tell: a json-family file
 *  (`"json"`/`"json5"`/`"json5p"` — file children are keyed by their full filename, so the last
 *  segment carries the extension), `"yamlover"` (a directory with a `.yamlover/` marker), `"dir"`
 *  (a plain folder), or null (any other file or interior node — the engine does not track per-node
 *  concrete yet, so only a file-document ROOT gets the json concrete). Only a mapping can be a
 *  directory, and positional segments never name FS entries, so most nodes short-circuit without
 *  touching the disk. */
function concreteOf(dataRoot: string, segs: Seg[], row: NodeRow): "dir" | "yamlover" | "json" | "json5" | "json5p" | null {
  const last = segs[segs.length - 1];
  if (typeof last === "string") {
    const json = JSON_EXT[path.extname(last).toLowerCase()];
    if (json) {
      const abs = path.resolve(dataRoot, ...segs.map(String));
      try { if (fs.statSync(abs).isFile()) return json; } catch { /* not a backing file */ }
    }
  }
  if (row.type !== "mapping") return null;
  if (segs.some((g) => typeof g === "number")) return null;
  const abs = path.resolve(dataRoot, ...segs.map(String));
  let st: fs.Stats | undefined;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isDirectory()) return null;
  return fs.existsSync(path.join(abs, ".yamlover")) ? "yamlover" : "dir";
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
/** Has a child that ISN'T hidden — the `hasChildren` a directory should report (a dir whose only
 *  child is `.yamlover` reads as a leaf). */
const visibleHasChildren = (s: Store, p: string): boolean => s.children(p).some((c) => !isHidden(s, c.to));

function downstreamEntries(s: Store, p: string): { to: string; label: string | null; pos: number | null; kind: EdgeRow["kind"] }[] {
  const isSet = !!s.node(p)?.meta?.set;
  // contain + forward ref, ordered by pos — but a CONTAIN edge to a hidden node (`.yamlover`) is
  // omitted from the listing (forward `*` refs INTO the hidden subtree, e.g. a thumbnail pointer,
  // are kept — they're how the overlay surfaces the sidecar).
  let own = s.entries(p).filter((e) => e.kind !== "back" && !(e.kind === "contain" && isHidden(s, e.to)));
  const seen = new Set(own.map((e) => relKey(e.label, e.to)));
  if (isSet) {
    const kept = new Set<string>(); // set semantics: an element appears at most once
    own = own.filter((e) => { const k = relKey(e.label, e.to); if (kept.has(k)) return false; kept.add(k); return true; });
  }
  const out: { to: string; label: string | null; pos: number | null; kind: EdgeRow["kind"] }[] = [...own];
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
  const project = (c: { to: string; label: string | null; pos: number | null; kind: string }) => {
    if (c.kind === "contain") return projectValue(dataRoot, s, [...segs, c.label ?? c.pos ?? 0], depth - 1, false);
    // a reference (a forward `*` ref or an incoming `~` back-edge). At UNLIMITED depth show it AS a
    // reference — its yamlover pointer text, hyperlinked — so the link syntax stays visible (and the
    // possibly-cyclic graph is never inlined). At a FINITE depth it is RESOLVED to a navigable link
    // marker (a `{ … }` summary of the target); since that only happens under an explicit finite
    // `?depth=`, the `{ … }` marker means "truncated by the depth setting" everywhere it appears.
    const targetSegs = storePathToSegs(c.to);
    return depth === Infinity
      ? refMarker(scopedPath(s, targetSegs, currentDoc), segsToStr(targetSegs))
      : linkMarker(dataRoot, s, targetSegs);
  };
  if (k === "array") return kids.map(project);
  if (k === "omni" || k === "mix") {
    // A `$yamloverMixed` marker preserving source order: each entry is positional (`key: null` →
    // a `- item`) or keyed (`key: "scale"` → `scale: …`); an omni also carries its self-value.
    const entries = kids.map((c) => ({ key: c.label, value: project(c) }));
    const marker: Record<string, unknown> = { kind: k, entries };
    if (k === "omni") marker.value = row.value; // the node's own scalar self-value (the `!!omni 5`)
    return { [MIXED_KEY]: marker };
  }
  if (k === "object") {
    const out: Record<string, unknown> = {};
    for (const c of kids) out[c.label ?? String(c.pos)] = project(c);
    return out;
  }
  return row.value; // scalar
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
  const sub = (c: { to: string; label: string | null; pos: number | null; kind: string }) =>
    c.kind === "contain" ? projectSchema(dataRoot, s, [...segs, c.label ?? c.pos ?? 0], depth - 1, false) : linkMarker(dataRoot, s, storePathToSegs(c.to));
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
  const concrete = concreteOf(dataRoot, segs, row);
  if (concrete) info.concrete = concrete; // a folder child renders with a folder icon
  const title = titleOf(s, p);
  if (title) info.title = title;
  if (k === "binary") info.size = row.size;
  else if (k === "scalar") info.value = row.value;
  else if (k === "omni" || k === "mix") {
    info.count = ownedEntries(s, p).length; // owned items + fields (reverse members excluded)
    if (k === "omni") info.value = row.value; // the self-scalar, for the link label
  } else info.count = s.children(p).filter((c) => !isHidden(s, c.to)).length; // visible members only (omit `.yamlover`)
  if (row.format === TAG_FORMAT) {
    // a pure color tag's explicit color rides the link, so badges color correctly everywhere
    const c = s.node(p + ":color")?.value;
    if (typeof c === "string") info.color = c;
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
    concrete: concreteOf(dataRoot, segs, row),
    hasChildren: visibleHasChildren(s, p),
    children: [],
  };
  if (node.hasChildren && depth > 0) {
    for (const c of s.children(p)) {
      if (isHidden(s, c.to)) continue; // omit the hidden `.yamlover` overlay subtree from the TOC
      const seg = c.label ?? c.pos ?? 0;
      node.children.push(buildTree(dataRoot, s, [...segs, seg], labelFor(s, c.to, seg), depth - 1));
    }
  }
  return node;
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
 *  that fragment's selector + crop (so the client highlights the region and colors by tag). */
function annotationsFor(dataRoot: string, s: Store, segs: Seg[]): unknown[] {
  void dataRoot;
  const p = storePath(segs);
  const out: unknown[] = [];
  for (const a of readAnnotations(s, p)) out.push({ ...a });
  for (const f of readFragments(s, p)) {
    for (const a of readAnnotations(s, f.node)) {
      out.push({ ...a, selector: f.selector, fragmentSlug: f.slug, ...(f.imageUrl ? { imageUrl: f.imageUrl } : {}) });
    }
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
    if (owner === tagStorePath || seen.has(owner) || !s.node(owner)) continue;
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

/** Rewrite a board overlay's top-level `columns:` block (TICKETS.md §3). `cols` is the lanes, each a
 *  list of tag client-paths; each lane is emitted as a flow-sequence of project-scope pointers. An
 *  existing `columns:` block (its `- …` items) is replaced; otherwise the block is appended. A fresh
 *  file is seeded with the board schema tag so it indexes as a board. */
function writeBoardColumns(src: string, cols: string[][]): string {
  const laneLine = (lane: string[]) => `- [${lane.map((p) => pointerToken(pointerRaw(p))).join(", ")}]`;
  const block = cols.length === 0 ? ["columns: []"] : ["columns:", ...cols.map(laneLine)];
  let lines = src.replace(/\n+$/, "").split("\n");
  if (src.trim() === "") lines = ["!!<*yamlover:$defs:board>"];
  const start = lines.findIndex((l) => /^columns:/.test(l));
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
  const { bodyFile, within } = hostFor(dataRoot, s, strToSegs(a.target || ":"));
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  const src = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
  fs.writeFileSync(bodyFile, appendAnnotation(src, within, (indent) => annotationItemLines(a, indent)));
  return bodyFile;
}

/** Embed a fragment under the target's `yamlover-fragments` mapping; for an image-like selection,
 *  write the PNG crop as a sidecar blob the fragment references. Returns its slug + node path. */
function embedFragment(dataRoot: string, s: Store, mode: SidecarLocation, f: FragmentInput): { slug: string; fragmentPath: string } {
  const segs = strToSegs(f.target || ":");
  const { bodyFile, within } = hostFor(dataRoot, s, segs);
  const slug = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
 *  referencing `tag` (bare pointer or object `tag:` field). */
function unembedAnnotation(dataRoot: string, s: Store, target: string, tag: string): string {
  const { bodyFile, within } = hostFor(dataRoot, s, strToSegs(target || ":"));
  if (!fs.existsSync(bodyFile)) return bodyFile;
  // Match on the tag's colon-PATH (`:tags:…:name`), tolerating the pointer's spelling: an item may
  // be project-scope (`*::tags:…`), document-scope (`*: tags: …`, spaced), bare or an object form.
  // Normalizing away whitespace and matching the `:`-prefixed path catches them all (the leading
  // `:` keeps it on segment boundaries), where a raw `includes(pointerRaw)` missed spaced/doc-scope.
  const needlePath = ":" + pointerRaw(tag).replace(/^:+/, ""); // :tags:field:mathematics:number-theory
  const src = fs.readFileSync(bodyFile, "utf8");
  fs.writeFileSync(bodyFile, removeAnnotationItem(src, within, (itemText) => itemText.replace(/\s+/g, "").includes(needlePath)));
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

  if (row.format === "x-yamlover-chapter") return pasteIntoChapter(dataRoot, s, segs, name, bytes);

  // a directory page, or a MEMBER of one (any non-chapter node): the file lands in the nearest
  // enclosing directory. `open` marks the member case — the page is not the directory, so the
  // client opens the new file (on a directory page it just refreshes in place).
  const dirSegs = nearestDirSegs(dataRoot, segs);
  if (!dirSegs) throw new Error("no enclosing directory to paste into");
  const dir = path.resolve(dataRoot, ...dirSegs.map(String));
  const final = uniqueName(dir, name);
  writeInside(dataRoot, dir, final, bytes);
  return { path: segsToStr([...dirSegs, final]), dir: segsToStr(dirSegs), open: dirSegs.length !== segs.length };
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

/** The .yamlover source holding the chapter at `segs` — directory-backed
 *  (`.yamlover/body.yamlover`) or a standalone `*.yamlover` file — plus its document root. */
function chapterSource(dataRoot: string, s: Store, segs: Seg[]): { docSegs: Seg[]; bodyFile: string; dirBacked: boolean } {
  const docSegs = documentRootSegs(s, segs);
  const docFs = path.resolve(dataRoot, ...docSegs.map(String));
  const dirBacked = fs.existsSync(docFs) && fs.statSync(docFs).isDirectory();
  const bodyFile = dirBacked ? path.join(docFs, ".yamlover", "body.yamlover") : docFs;
  if (!bodyFile.endsWith(".yamlover") || !fs.existsSync(bodyFile)) {
    throw new Error("unsupported chapter source (need a .yamlover body)");
  }
  return { docSegs, bodyFile, dirBacked };
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
  // The chapter's location WITHIN its document — alternating `children`,N pairs (empty = top-level).
  const within = segs.slice(docSegs.length);
  const src = fs.readFileSync(bodyFile, "utf8");
  fs.writeFileSync(bodyFile, appendToList(src, within, "chunks", (indent) => [`${" ".repeat(indent)}- ${pointer}`]));
  return { path: segsToStr(fileSegs), chapter: segsToStr(segs), pointer };
}

/** A text paste onto a chapter: the text itself becomes the chapter's last chunk — no file is
 *  written, only the .yamlover source gains an item. */
function pasteTextIntoChapter(dataRoot: string, s: Store, segs: Seg[], text: string): Record<string, unknown> {
  const { docSegs, bodyFile } = chapterSource(dataRoot, s, segs);
  const within = segs.slice(docSegs.length);
  const src = fs.readFileSync(bodyFile, "utf8");
  fs.writeFileSync(bodyFile, appendToList(src, within, "chunks", (indent) => textChunkLines(text, indent)));
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
  const src = ["!!<*::yamlover:$defs:chapter>", `title: ${JSON.stringify(title)}`, "chunks:", ...textChunkLines(text, 0), ""].join("\n");
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

/** A subchapter as a `children:` list item (title + chunks + recursive children), at the
 *  list's indent — the item body keys sit 2 deeper, matching the chapter examples. */
function richChildLines(node: Rich & { title: string }, indent: number, pointerFor: (name: string, bytes: Buffer) => string): string[] {
  const pad = " ".repeat(indent);
  const lines = [`${pad}- title: ${JSON.stringify(node.title)}`];
  if (node.chunks.length) lines.push(`${pad}  chunks:`, ...node.chunks.flatMap((c) => richItemLines(c, indent + 2, pointerFor)));
  if (node.children.length) lines.push(`${pad}  children:`, ...node.children.flatMap((k) => richChildLines(k, indent + 2, pointerFor)));
  return lines;
}

/** A rich paste onto a chapter: files land in the chapter's owning directory, the chunks
 *  (text + pointers, order kept) append to `chunks:` and the subchapters to `children:` —
 *  either list is created when the chapter source lacks it. */
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
  if (rich.chunks.length) src = appendToList(src, within, "chunks", (ind) => rich.chunks.flatMap((c) => richItemLines(c, ind, pointerFor)));
  if (rich.children.length) src = appendToList(src, within, "children", (ind) => rich.children.flatMap((k) => richChildLines(k, ind, pointerFor)));
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

/** The whole .yamlover source of a new rich chapter (the tag, the title, chunks, children). */
function renderChapterSource(title: string, rich: Rich, pointerFor: (name: string, bytes: Buffer) => string): string {
  const lines = ["!!<*::yamlover:$defs:chapter>", `title: ${JSON.stringify(title)}`];
  if (rich.chunks.length) lines.push("chunks:", ...rich.chunks.flatMap((c) => richItemLines(c, 0, pointerFor)));
  if (rich.children.length) lines.push("children:", ...rich.children.flatMap((k) => richChildLines(k, 0, pointerFor)));
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

// --- chapter list insertion (indentation-aware; the parser does not track spans) ------------- //
// A directory body / standalone chapter is YAML-shaped: a mapping's keys at one indent, a
// sequence's `- ` items at the SAME indent as their key, an item's mapping body at key-indent+2.
// To reach a subchapter we descend `children:` sequences by index; then we append to a list key
// (`chunks:` for content, `children:` for pasted subchapters), creating it when absent.

const indentOf = (line: string): number => { let i = 0; while (line[i] === " ") i++; return i; };
const isContentLine = (line: string): boolean => { const t = line.trim(); return t.length > 0 && !t.startsWith("#"); };

/** Render a pasted text as the lines of one `- ` chunk item at `indent`. A literal block scalar
 *  when the text round-trips — the parser detects the block indent from the FIRST content line,
 *  so it must be unindented; else one double-quoted line (JSON escapes — exactly the subset
 *  quotedScalar reads back). */
function textChunkLines(text: string, indent: number): string[] {
  const pad = " ".repeat(indent);
  const first = text.split("\n").find((l) => l.trim().length > 0);
  if (!first || /^\s/.test(first)) return [`${pad}- ${JSON.stringify(text)}`];
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const head = text.endsWith("\n") ? "|" : "|-"; // the chomping matches the text's own ending
  return [`${pad}- ${head}`, ...body.split("\n").map((l) => (l.trim().length ? `${pad}  ${l}` : ""))];
}

/** Append items (rendered by `renderItems` at the list's indent) to the `key:` list of the
 *  chapter at `chapterPath` (alternating ["children", N, …] pairs; empty = the top-level
 *  chapter) within a .yamlover source. A chapter authored without the list gains the key at
 *  the end of its mapping. */
function appendToList(text: string, chapterPath: Seg[], key: string, renderItems: (indent: number) => string[]): string {
  const lines = text.split("\n");
  let lo = 0;
  let hi = lines.length;
  let indent = firstContentIndent(lines); // the chapter mapping's key indent

  for (let i = 0; i < chapterPath.length; i += 2) {
    const idx = Number(chapterPath[i + 1]);
    const kids = findKeyLine(lines, lo, hi, indent, "children");
    if (kids < 0) throw new Error(`no 'children:' at indent ${indent}`);
    const items = seqItems(lines, kids + 1, hi, indent);
    if (!(idx >= 0 && idx < items.length)) throw new Error(`children[${idx}] out of range (${items.length})`);
    hi = idx + 1 < items.length ? items[idx + 1] : seqEnd(lines, kids + 1, hi, indent);
    lo = items[idx] + 1; // body starts past the `- ` marker (its inline key sits at the parent indent)
    indent += 2;
  }

  const keyLine = findKeyLine(lines, lo, hi, indent, key);
  if (keyLine < 0) {
    const end = trimBack(lines, lo - 1, hi); // the chapter mapping's end, sans trailing blanks
    lines.splice(end, 0, `${" ".repeat(indent)}${key}:`, ...renderItems(indent));
  } else {
    const end = seqEnd(lines, keyLine + 1, hi, indent);
    lines.splice(end, 0, ...renderItems(indent));
  }
  return lines.join("\n");
}

/** The indent of the first content line — the chapter mapping's key column. */
function firstContentIndent(lines: string[]): number {
  for (const l of lines) if (isContentLine(l)) return indentOf(l);
  return 0;
}

/** Line index of `key:` at exactly `indent` within [lo,hi); -1 once the mapping ends (a dedent). */
function findKeyLine(lines: string[], lo: number, hi: number, indent: number, key: string): number {
  for (let i = lo; i < hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < indent) return -1; // left the mapping
    if (ind !== indent) continue; // deeper (a nested value / block scalar)
    const t = lines[i].trim();
    if (t === `${key}:` || t.startsWith(`${key}:`)) return i;
  }
  return -1;
}

/** Start lines of the `- ` items of a sequence whose items sit at `indent`, from `from`. */
function seqItems(lines: string[], from: number, hi: number, indent: number): number[] {
  const out: number[] = [];
  for (let i = from; i < hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < indent) break; // dedent → sequence ended
    if (ind !== indent) continue; // deeper → the current item's body
    const t = lines[i].trim();
    if (t === "-" || t.startsWith("- ")) out.push(i);
    else break; // a sibling key at the same indent → sequence ended
  }
  return out;
}

/** The line index that ends the sequence starting at `from` (a dedent below `indent`, or a
 *  non-item sibling key at `indent`), skipping back over trailing blank lines. */
function seqEnd(lines: string[], from: number, hi: number, indent: number): number {
  let last = from;
  for (let i = from; i < hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < indent) return trimBack(lines, last, i);
    if (ind === indent) {
      const t = lines[i].trim();
      if (t === "-" || t.startsWith("- ")) { last = i; continue; }
      return trimBack(lines, last, i); // sibling key
    }
    last = i; // deeper: part of the current item
  }
  return trimBack(lines, last, hi);
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
  const titlePath = (p === ":" ? "" : p) + ":title";
  const t = s.node(titlePath);
  if (t && t.type === "scalar" && !s.hasChildren(titlePath) && t.value != null) return String(t.value);
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
function defaultDepth(dataRoot: string, segs: Seg[], row: NodeRow, kind: string): number {
  if (kind === "binary") return 1;
  const c = concreteOf(dataRoot, segs, row);
  return c === "dir" || c === "yamlover" ? 1 : Infinity;
}

/** A `$yamloverRef` marker: a reference shown by its pointer `text`, hyperlinked to `path`. */
function refMarker(text: string, path: string): Record<string, unknown> {
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
