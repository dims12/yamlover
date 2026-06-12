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
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store, reindex, reindexAsync, hashFileAsync, watchTree, loadSettings, mv, relinkMoved, evalQuery } from "../../../engine/ts/src/index.ts";
import type { NodeRow, EdgeRow, Settings, IndexDiff } from "../../../engine/ts/src/index.ts";
import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { pointerToken, anchorToken } from "../../../parser/ts/src/serialize-yamlover.ts";
import { colonSegment } from "../../../parser/ts/src/pointer.ts";
import { isPointer } from "../../../parser/ts/src/ir.ts";
import type { Node as IrNode } from "../../../parser/ts/src/ir.ts";
import { buildGitIgnore } from "./gitignore.js";
import { displayKind, ownedEntries, typeName } from "./node-kind.js";
import { TaskRegistry } from "./tasks.js";
import type { TaskHandle } from "./tasks.js";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;
interface Options {
  gitignore?: boolean; // honor .gitignore for stray files (default: true)
  watch?: boolean; // watch the tree and re-index on external edits (default: false; bin turns it on)
  log?: (line: string) => void; // server-side progress lines (the bin wires console.log; tests stay silent)
}

// Marker keys + types the client recognizes (must match src/client expectations).
const LINK_KEY = "$yamloverLink";
const BINARY_KEY = "$yamloverBinary";
const MIXED_KEY = "$yamloverMixed"; // an omni/mix node: a self-value and/or interleaved items+fields
type Seg = string | number;
// Node-KIND classification (object|array|scalar|binary|omni|mix → the client `type:`) lives in
// ./node-kind.ts so it can be unit-tested against a Store without the HTTP layer.

export function createHandlers(dataRoot: string, opts: Options = {}): Handler & { close: () => void; ready: Promise<IndexDiff> } {
  const rootName = path.basename(path.resolve(dataRoot)) || "/";
  const dbPath = path.join(dataRoot, ".yamlover", "index.db");
  // Project configuration (<root>/.yamlover/settings.yamlover) — defaults for WRITE paths
  // (e.g. where new annotations are created). Read once at startup, like the index.
  const settings: Settings = loadSettings(dataRoot);
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

  // A reindex usable inside an already-queued job (NOT queued itself — callers queue).
  const doReindex = (): Promise<IndexDiff> => reindexAsync(store0, dataRoot, { ignore });

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
        const diff = await reindexAsync(store0, dataRoot, {
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

      // Create an annotation — ONE TAG APPLICATION (a WRITE path): persist it as a yamlover file
      // under the project's default annotation location (settings.yamlover; `/annotations` by
      // default), then index it so it joins the graph (reverse-linked to its material, member of
      // its tag). An annotation is NOT tied to that location — it may be moved to (or authored
      // in) any directory and keeps working; the setting only says where NEW ones land. Body:
      // { target, tag, selector?, description? } — target/tag are the material's and the applied
      // tag's JSON paths; no selector applies the tag to the WHOLE node.
      if (req.method === "POST" && url.pathname === "/api/annotate") {
        readBody(req)
          .then((data) =>
            // Queued: an incremental row added while a full walk (whose disk snapshot predates
            // this annotation) is committing would be silently swapped away.
            enqueue(() => {
              const a = data as AnnotationInput;
              const tagStore = storePath(strToSegs(a.tag ?? ""));
              if (!a?.tag || s.node(tagStore)?.format !== TAG_FORMAT) {
                throw new Error("annotation needs a `tag` that is an x-yamlover-tag node");
              }
              const annPath = writeAnnotation(dataRoot, settings.annotations.location, a);
              // Update the index INCREMENTALLY (not a full rebuild — that re-reads every changed
              // file and blocks the next click). Add just this annotation's nodes + its edges.
              const doc = parseYamlover(fs.readFileSync(path.join(dataRoot, ...strToSegs(annPath).map(String)), "utf8"), annPath);
              s.addAnnotation(storePath(strToSegs(annPath)), storePath(strToSegs(a.target)), doc, tagStore);
              announce({ added: [relFileOf(annPath)] });
              return { path: annPath };
            }),
          )
          .then((body) => sendJson(res, 201, body))
          .catch((e) => sendJson(res, 400, { error: String((e as Error).message || e) }));
        return;
      }

      // Delete an annotation by its node path (recolor = delete + create, client-side). Removes
      // the annotation FILE and its index rows — incrementally. Works wherever the annotation
      // lives: the guard is its schema (`x-yamlover-annotation`), not a directory.
      if (req.method === "DELETE" && url.pathname === "/api/annotate") {
        const annPath = url.searchParams.get("path") || "";
        enqueue(() => {
          deleteAnnotation(dataRoot, s, annPath);
          s.removeAnnotation(storePath(strToSegs(annPath)));
          announce({ removed: [relFileOf(annPath)] });
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
              const segs = [...strToSegs(settings.tags.location), name];
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
              const written = writeTag(dataRoot, settings.tags.location, name);
              s.addTag(storePath(strToSegs(settings.tags.location)), name, written.pos, written.node);
              if (s.node(storePath(segs))?.format !== TAG_FORMAT) throw new Error(`the created tag did not index as a tag: ${tagPath}`);
              announce(written.createdFile ? { added: [written.file] } : { changed: [written.file] });
              return { path: tagPath, name, color: null, created: true };
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

      const row = s.node(p);
      if (!row) return notFound(res, url);
      const viewDepth = depth ?? 1;
      const kind = displayKind(s, p, row);

      if (url.pathname === "/api/json") {
        const wantBytes = kind === "binary" && url.searchParams.get("binary") === "1";
        sendJson(res, 200, {
          path: segsToStr(segs),
          type: tocType(s, p, row),
          format: row.format ?? null,
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

/** How the node at `segs` is stored on disk, as far as a stat can tell: `"yamlover"` (a directory
 *  with a `.yamlover/` marker), `"dir"` (a plain folder), or null (not a filesystem directory —
 *  files and interior nodes alike; the engine does not track per-node concrete yet). Only a
 *  mapping can be a directory, and positional segments never name FS entries, so most nodes
 *  short-circuit without touching the disk. */
function concreteOf(dataRoot: string, segs: Seg[], row: NodeRow): "dir" | "yamlover" | null {
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
function downstreamEntries(s: Store, p: string): { to: string; label: string | null; pos: number | null; kind: EdgeRow["kind"] }[] {
  const isSet = !!s.node(p)?.meta?.set;
  let own = s.entries(p).filter((e) => e.kind !== "back"); // contain + forward ref, ordered by pos
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
  const project = (c: { to: string; label: string | null; pos: number | null; kind: string }) =>
    c.kind === "contain"
      ? projectValue(dataRoot, s, [...segs, c.label ?? c.pos ?? 0], depth - 1, false)
      : linkMarker(dataRoot, s, storePathToSegs(c.to)); // pointer → a marker to where it resolves
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
  const info: Record<string, unknown> = { kind: k, type: tocType(s, p, row), path: segsToStr(segs) };
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
  } else info.count = s.children(p).length;
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

  // The containment parent — the upstream containment relation, always the primary way up.
  if (segs.length > 0) put("..", linkMarker(dataRoot, s, segs.slice(0, -1)));

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
    put(scopedPath(s, segs2, currentDoc), linkMarker(dataRoot, s, segs2));
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
    concrete: concreteOf(dataRoot, segs, row),
    hasChildren: s.hasChildren(p),
    children: [],
  };
  if (s.hasChildren(p) && depth > 0) {
    for (const c of s.children(p)) {
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
// Annotations — graph-native TAG APPLICATIONS: each is a yamlover object under
// `<root>/annotations/`, pointing (`target: *//…`) at its material and holding a keyless `~-`
// membership in its applied tag; a material's annotations are the inverse of the target edges.
// --------------------------------------------------------------------------- //

const TAG_FORMAT = "x-yamlover-tag";

interface AnnotationInput {
  target: string; // the material's JSON path (e.g. "/60-simple-chapter.yamlover")
  tag: string; // the applied tag's JSON path (e.g. "/yamlover/tags/colors/yellow")
  selector?: Record<string, unknown>; // { type: "text", exact, prefix, suffix } | { type:"rect", … }; absent = whole node
  description?: string; // the per-application comment
}

/** The tag an annotation applies — its keyless `back` edge to an `x-yamlover-tag` node —
 *  projected as { path, name, color } (color = the tag's explicit `color`, else null: the
 *  client derives a hue from the name). Null for a legacy annotation with no tag. */
function appliedTag(s: Store, annStorePath: string): { path: string; name: string; color: string | null } | null {
  const e = s.relationships(annStorePath).out.find(
    (t) => t.kind === "back" && t.label === null && s.node(t.to)?.format === TAG_FORMAT,
  );
  if (!e) return null;
  const segs = storePathToSegs(e.to);
  const color = s.node(e.to + ":color")?.value;
  return { path: segsToStr(segs), name: String(segs[segs.length - 1] ?? ""), color: typeof color === "string" ? color : null };
}

/** The annotations whose `target` resolves to this material — the incoming `ref` edges from
 *  `x-yamlover-annotation` nodes — each projected to its full object (selector, description,
 *  created) plus its applied `tag` { path, name, color }. */
function annotationsFor(dataRoot: string, s: Store, segs: Seg[]): unknown[] {
  const p = storePath(segs);
  const out: unknown[] = [];
  for (const e of s.relationships(p).in) {
    if (e.kind !== "ref") continue;
    const src = s.node(e.from);
    if (src?.format !== "x-yamlover-annotation") continue;
    const aSegs = storePathToSegs(e.from);
    out.push({
      path: segsToStr(aSegs),
      tag: appliedTag(s, e.from),
      ...(projectValue(dataRoot, s, aSegs, 6, true) as Record<string, unknown>),
    });
  }
  return out;
}

/** The MATERIALS filed under a tag — every node holding a `~` membership in it, with an
 *  annotation (one tag APPLICATION) resolved to its `target` material. Deduped by material:
 *  two annotations applying the same tag to one node, or a direct `~- *tag` alongside an
 *  annotation, show the material once. Subtags are containment children, not memberships —
 *  they never appear here. Ordered lexicographically by the member's path, like
 *  {@link downstreamEntries}' back-edge tail. */
function taggedMaterials(dataRoot: string, s: Store, tagStorePath: string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  const backs = s.relationships(tagStorePath).in
    .filter((e) => e.kind === "back" && e.from)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  for (const e of backs) {
    let material = e.from;
    if (s.node(e.from)?.format === "x-yamlover-annotation") {
      const t = s.relationships(e.from).out.find((o) => o.kind === "ref" && o.label === "target");
      if (!t) continue; // a dangling annotation — no resolvable material
      material = t.to;
    }
    if (seen.has(material) || !s.node(material)) continue;
    seen.add(material);
    out.push(linkMarker(dataRoot, s, storePathToSegs(material)));
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

/** Serialize a value as a yamlover scalar (double-quoted strings round-trip through the parser). */
function yScalar(v: unknown): string {
  return typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v ?? ""));
}

/** Persist a new annotation (one tag application) as a yamlover file under the project's default
 *  annotation location (`settings.yamlover`; `/annotations` unless configured); returns its node
 *  path. The material and the applied tag are referenced with project-scoped deref pointers so
 *  the engine reverse-links them on re-index (a leading star + a "//path" project path; the tag
 *  as an ordinal path anchor `&//path/to/tag[]` — the deprecated `~-` spelling still parses).
 *  The location is only the CREATION default — an annotation file works from any directory. */
function writeAnnotation(dataRoot: string, location: string, a: AnnotationInput): string {
  if (!a?.target || !a?.tag) throw new Error("annotation needs a target and a tag");
  const dir = path.resolve(dataRoot, ...strToSegs(location).map(String));
  const root = path.resolve(dataRoot);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error("annotation location escapes the data root");
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `${id}.yamlover`;
  const lines = [
    "!!<*yamlover/$defs/annotation>",
    `target: ${pointerToken(pointerRaw(a.target))}`,
    anchorToken(`${pointerRaw(a.tag)}[]`), // the applied tag holds me (ordinal path anchor)
  ];
  if (a.selector) lines.push("selector:", ...Object.entries(a.selector).map(([k, v]) => `  ${k}: ${yScalar(v)}`));
  if (a.description) lines.push(`description: ${yScalar(a.description)}`);
  lines.push(`created: ${new Date().toISOString()}`, "");
  fs.writeFileSync(path.join(dir, file), lines.join("\n"));
  return `${location}:${file}`;
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
  const body = (existing === "" || existing.endsWith("\n") ? existing : existing + "\n") + `${name}: !!<*yamlover/$defs/tag>\n`;
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

/** Delete an annotation file given its node path. The guard is the GRAPH, not a directory: the
 *  node must be indexed as an `x-yamlover-annotation` and be a whole standalone `.yamlover` file
 *  (an annotation authored inline in a shared document cannot be deleted this way), inside the
 *  served root. So an annotation moved to any directory remains deletable. */
function deleteAnnotation(dataRoot: string, s: Store, annPath: string): void {
  const segs = strToSegs(annPath);
  if (!String(segs[segs.length - 1] ?? "").endsWith(".yamlover")) throw new Error("not an annotation file");
  if (s.node(storePath(segs))?.format !== "x-yamlover-annotation") throw new Error("not an annotation node");
  const root = path.resolve(dataRoot);
  const file = path.resolve(dataRoot, ...segs.map(String));
  if (!file.startsWith(root + path.sep)) throw new Error("outside the served root");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) throw new Error("not an annotation file");
  fs.rmSync(file, { force: true });
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
  const src = ["!!<*yamlover/$defs/chapter>", `title: ${JSON.stringify(title)}`, "chunks:", ...textChunkLines(text, 0), ""].join("\n");
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
  const lines = ["!!<*yamlover/$defs/chapter>", `title: ${JSON.stringify(title)}`];
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

function parseDepth(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}
function notFound(res: ServerResponse, url: URL): void {
  sendJson(res, 404, { error: `no such node/endpoint: ${url.pathname}?${url.searchParams}` });
}
