#!/usr/bin/env node
/**
 * yamlover — serve a directory of yamlover data as a browsable React SPA.
 *
 *   npx yamlover [ROOT] [--port N]
 *
 * ROOT is the directory to browse (default: the current directory). It may be a
 * yamlover node (with `.yamlover/`), a plain directory, or a single file — the
 * same shapes `tools/walker` understands.
 *
 * Two serve modes, chosen automatically:
 *
 *   • PRODUCTION (the published package, or `--prod`): the engine source is not on
 *     disk, so the client is served as a prebuilt static SPA from `dist/client`
 *     and the server handler comes from the bundled `dist/server.js`. No Vite at
 *     runtime, no `src/` shipped — `npx yamlover` installs with ~zero deps.
 *
 *   • LIVE (the repo checkout): the engine source IS reachable, so Vite runs in
 *     middleware mode — the client is served from `src/client` with HMR and the
 *     server materializer is loaded via `ssrLoadModule`, transpiling TS on the
 *     fly (edits take effect with no rebuild). `--prod` forces production mode
 *     here too, for testing the static build.
 *
 * Either way: API routes (`/api/*`) are handled first; live data updates flow
 * over the `/api/events` SSE stream (FS watcher → reindex → client `useDiffBump`),
 * independent of Vite. Every other route falls back to the SPA shell (client-side
 * routing on the JSON path).
 *
 * Binds 127.0.0.1 (local only) by default — the safe default for a personal viewer
 * and for the desktop wrapper (tools/desktop). `--headless` binds 0.0.0.0 to serve
 * the tree across the network (a server box with no GUI).
 */

import { createServer as createHttpServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, join, resolve, extname, sep } from "node:path";
import fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, ".."); // tools/server

// The engine's store is built on `node:sqlite`, which only became available UNFLAGGED late in
// the 22.x line — on e.g. Node 22.12 importing it dies with a raw internal stack trace
// ("ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite"). npm only WARNS on an
// engines mismatch, so check here, before anything imports the engine, and say what to do.
// getBuiltinModule itself landed in 22.3; on anything older it is undefined, which also fails
// this check — correctly, since such a runtime cannot have node:sqlite either.
if (!process.getBuiltinModule?.("node:sqlite")) {
  console.error(
    `yamlover needs Node >= 22.13 for the built-in node:sqlite module (you are on ${process.version}).\n` +
      `Upgrade Node, or re-run with:  node --experimental-sqlite $(which yamlover)`,
  );
  process.exit(1);
}

// --- argument parsing ----------------------------------------------------- //
let rootArg = null; // the ROOT path as typed (null when omitted)
let port = 5173;
// Local only by default — the safe default for a personal viewer / the desktop app.
// `--headless` opens it to the network (0.0.0.0); `--host ADDR` is an explicit override.
let host = "127.0.0.1";
let gitignore = true; // hide .gitignore'd stray files by default
let prodFlag = false; // force production (static) mode even in the repo checkout
// URL prefix to serve the whole app under (e.g. `/demo/abc123`), so many instances can sit behind
// one host on distinct paths (the demo server). "" = served at the document root (the normal case).
// Seeded from $BASE_PATH so a shell-less image (e.g. distroless) can inject it via env without
// needing `sh -c` to expand it into a `--base-path` flag; an explicit flag below still overrides.
let basePath = process.env.BASE_PATH ?? "";
// Normalize a base path: leading `/`, no trailing `/`; `""`/`"/"` → disabled.
function normBase(s) {
  let b = (s ?? "").trim();
  if (b === "" || b === "/") return "";
  if (!b.startsWith("/")) b = "/" + b;
  if (b.endsWith("/")) b = b.slice(0, -1);
  return b;
}
basePath = normBase(basePath); // normalize the $BASE_PATH seed (a flag below re-normalizes its own value)
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port" || a === "-p") port = parseInt(argv[++i], 10);
  else if (a.startsWith("--port=")) port = parseInt(a.slice("--port=".length), 10);
  else if (a === "--headless") host = "0.0.0.0"; // serve on all interfaces (no GUI / remote access)
  else if (a === "--host") host = argv[++i];
  else if (a.startsWith("--host=")) host = a.slice("--host=".length);
  else if (a === "--base-path") basePath = normBase(argv[++i]);
  else if (a.startsWith("--base-path=")) basePath = normBase(a.slice("--base-path=".length));
  else if (a === "--no-gitignore") gitignore = false;
  else if (a === "--prod") prodFlag = true;
  else if (a === "--help" || a === "-h") {
    console.log("usage: npx yamlover [ROOT] [--port N] [--headless] [--host ADDR] [--base-path PREFIX] [--no-gitignore] [--prod]");
    console.log("  default: serve on 127.0.0.1 (local only); --headless serves on all interfaces");
    console.log("  --base-path PREFIX: serve the whole app under PREFIX (e.g. /demo/abc) instead of /");
    process.exit(0);
  } else if (!a.startsWith("-")) rootArg = a;
}
const dataRoot = resolve(process.cwd(), rootArg ?? ".");
if (!fs.existsSync(dataRoot)) {
  console.error(`yamlover: no such path: ${dataRoot}`);
  process.exit(1);
}

// --- mode ----------------------------------------------------------------- //
// The engine SOURCE is present only in the monorepo checkout; its absence (the
// published package) — or an explicit `--prod` — selects production/static mode.
const engineSrc = resolve(pkgRoot, "../engine/ts/src/index.ts");
const repoLive = fs.existsSync(engineSrc);
const prod = prodFlag || !repoLive;

// --- server --------------------------------------------------------------- //
// `handle` (API) and `serveClient` (everything else) are filled in per mode just
// below; the request handler closes over them and only reads them once requests
// start arriving — after listen(), so after assignment.
let handle;
let serveClient;

const server = createHttpServer((req, res) => {
  let url = new URL(req.url, "http://localhost");
  // Under `--base-path`, strip the prefix up front (and rewrite req.url) so every downstream —
  // the engine API (exact `/api/...` matches), the static server, and the Vite middleware — sees
  // root-relative paths and stays oblivious to the prefix. Anything outside the prefix is 404.
  if (basePath) {
    const p = url.pathname;
    if (p === basePath || p.startsWith(basePath + "/")) {
      req.url = (p.slice(basePath.length) || "/") + url.search;
      url = new URL(req.url, "http://localhost");
    } else {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
  }
  if (url.pathname.startsWith("/api/")) {
    handle(req, res, url);
    return;
  }
  serveClient(req, res, url);
});

let createHandlers;
if (prod) {
  // -- production: prebuilt static client + bundled server, no Vite ---------- //
  const distClient = join(pkgRoot, "dist/client");
  const distIndex = join(distClient, "index.html");
  if (!fs.existsSync(distIndex)) {
    console.error(`yamlover: production build missing at ${distClient}`);
    console.error("          run `npm run build` in tools/server first.");
    process.exit(1);
  }
  ({ createHandlers } = await import(pathToFileURL(join(pkgRoot, "dist/server.js")).href));
  serveClient = (req, res, url) => serveStatic(res, url, distClient, distIndex);
} else {
  // -- live: Vite middleware + ssrLoadModule (repo checkout) ----------------- //
  // Vite and its plugin are DYNAMIC imports so production mode (where they are not
  // installed) never tries to resolve them.
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");

  // Resolve react/react-dom as *this package* sees them, and alias Vite to those
  // exact copies, so the SPA never picks up a stale React from a parent
  // node_modules (the "does not provide an export named 'createRoot'" failure).
  const reactAlias = {};
  // Directories Vite is allowed to serve over `/@fs`. Start with this package; add
  // the node_modules that actually holds the heavy deps — under `npx` they hoist to
  // a `_npx/<hash>/node_modules` outside `pkgRoot` and Vite's default root detection
  // misses it, so a raw asset (notably pdf.js's worker) 404s to index.html.
  // The client re-parses edited yamlover source with the real parser (renderers/value-editors.tsx →
  // ../../parser/ts/src/yamlover.ts), which lives OUTSIDE pkgRoot — allow Vite to serve it over /@fs.
  const fsAllow = [pkgRoot, resolve(pkgRoot, "../parser")];
  try {
    const req = createRequire(join(pkgRoot, "package.json"));
    reactAlias["react"] = dirname(req.resolve("react/package.json"));
    reactAlias["react-dom"] = dirname(req.resolve("react-dom/package.json"));
    for (const dep of ["pdfjs-dist", "react-pdf", "leaflet"]) {
      try {
        const nodeModules = dirname(dirname(req.resolve(`${dep}/package.json`)));
        if (!fsAllow.includes(nodeModules)) fsAllow.push(nodeModules);
      } catch {
        /* dep not resolvable from here — skip */
      }
    }
  } catch {
    /* fall back to default resolution */
  }

  // Run HMR over our own server (`hmr: { server }`) so Vite does not open a second
  // WebSocket port of its own.
  const vite = await createServer({
    root: pkgRoot,
    // Do NOT auto-load vite.config.mjs: that file is the PRODUCTION build config and
    // also lists `plugins: [react()]`. Vite would merge it with the inline `react()`
    // below, registering the React Fast-Refresh transform TWICE — every component
    // module then gets two refresh preambles and esbuild rejects it ("The symbol
    // 'inWebWorker' has already been declared"). The dev server is fully configured
    // inline here, so the config file must stay out of the picture.
    configFile: false,
    plugins: [react()],
    appType: "custom",
    // Always use this package's own React: `dedupe` collapses react/react-dom to a
    // single copy, and the aliases pin that copy to the one resolvable from here.
    resolve: { dedupe: ["react", "react-dom"], alias: reactAlias },
    // Pre-bundle the heavy renderer deps up front. These are all lazy-loaded, so
    // Vite would otherwise discover them (and their transitive CJS deps) only on
    // first use and could serve them un-interopped — the "does not provide an
    // export named …" failure. Listing them forces a clean CJS→ESM pre-bundle.
    optimizeDeps: {
      include: [
        "react-pdf",
        "marked",
        "@asciidoctor/core",
        "ag-psd",
        "utif",
        "heic2any",
        // the office/map renderer deps (all CJS/UMD — they need the CJS→ESM interop
        // a pre-bundle gives, or they fail with "does not provide an export named
        // 'default'", e.g. `import L from "leaflet"`)
        "leaflet",
        "xlsx",
        "mammoth/mammoth.browser",
        "@tmcw/togeojson",
      ],
    },
    // `allowedHosts: true` lifts Vite's Host-header allowlist so the SPA is
    // reachable under any hostname/IP (harmless on the default local bind; needed
    // when `--headless` exposes it on the network). `fs.allow` is widened to the
    // dirs holding the heavy deps so their `/@fs` assets are served, not 404'd.
    server: { middlewareMode: true, allowedHosts: true, hmr: { server }, fs: { allow: fsAllow } },
  });

  // The engine-backed handler (engine-api.ts) is loaded via `ssrLoadModule` so its
  // TS — and the engine/parser source it reaches into (`../../../engine`,
  // `../../../parser`) — is transpiled live, with no build step.
  ({ createHandlers } = await vite.ssrLoadModule("/src/server/engine-api.ts"));

  const indexHtmlPath = join(pkgRoot, "index.html");
  serveClient = (req, res, url) => {
    vite.middlewares(req, res, async () => {
      // SPA fallback: serve the (transformed) index.html for any client route.
      try {
        let html = fs.readFileSync(indexHtmlPath, "utf-8");
        html = await vite.transformIndexHtml(url.pathname, html);
        html = injectBase(html); // base-path-aware shell (no-op without --base-path)
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
      } catch (e) {
        vite.ssrFixStacktrace(e);
        res.statusCode = 500;
        res.end(e.message);
      }
    });
  };
}

// The initial index runs as a BACKGROUND task — the server listens immediately
// (serving the previous on-disk index, or an empty tree on a cold start) while
// progress lands here and in the web UI (SSE task frames + GET /api/tasks).
handle = createHandlers(dataRoot, {
  gitignore,
  watch: true, // re-index + push on external edits
  ensureSettings: true, // create .yamlover/settings.yamlover with defaults if absent (so the gear opens)
  log: (line) => console.log(`yamlover  ${line}`),
});
handle.ready.catch((e) => console.error("yamlover: indexing failed:", e));

// --- static file server (production mode) --------------------------------- //
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** Serve a file from `distClient`, or fall back to the SPA shell (`distIndex`) for
 *  any path that isn't a real asset — the client routes on the JSON path. */
function serveStatic(res, url, distClient, distIndex) {
  const filePath = resolve(distClient, "." + decodeURIComponent(url.pathname));
  // Containment guard: never serve outside dist/client (`..` traversal → shell).
  if (filePath !== distClient && !filePath.startsWith(distClient + sep)) {
    return serveIndex(res, distIndex);
  }
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    /* miss → shell */
  }
  if (!stat || !stat.isFile()) return serveIndex(res, distIndex);
  res.setHeader("Content-Type", MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream");
  // Vite emits content-hashed assets under /assets — safe to cache immutably.
  if (url.pathname.startsWith("/assets/")) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  fs.createReadStream(filePath).pipe(res);
}

function serveIndex(res, distIndex) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  if (basePath) {
    // The shell must learn its prefix (the client prepends it to every server URL) and its
    // root-absolute asset refs must point under the prefix (the strip above maps them back).
    res.end(injectBase(fs.readFileSync(distIndex, "utf-8")));
    return;
  }
  fs.createReadStream(distIndex).pipe(res);
}

/** Make a served index.html base-path-aware: expose `window.__BASE__` for the client's URL helper
 *  and prefix root-absolute `src="/…"` / `href="/…"` asset refs with the base path (protocol-relative
 *  `//…` left alone). No-op when no base path is set. */
function injectBase(html) {
  if (!basePath) return html;
  html = html.replace(/((?:src|href)=")\/(?!\/)/g, `$1${basePath}/`);
  const tag = `<script>window.__BASE__=${JSON.stringify(basePath)}</script>`;
  return html.includes("<head>") ? html.replace("<head>", `<head>${tag}`) : tag + html;
}

// Listen on `port`; if it is already in use, fall back to the next port (up to
// `MAX_PORT_TRIES`), so two instances — or a leftover one — don't collide.
const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
const MAX_PORT_TRIES = 50;

function listenWithFallback(p, triesLeft) {
  const onError = (err) => {
    server.off("listening", onListening); // drop this attempt's success handler
    if (err && err.code === "EADDRINUSE" && triesLeft > 0) {
      console.log(`yamlover  port ${p} in use — trying ${p + 1}…`);
      listenWithFallback(p + 1, triesLeft - 1);
    } else if (err && err.code === "EADDRINUSE") {
      console.error(`yamlover: no free port found in ${port}–${p}`);
      process.exit(1);
    } else {
      throw err;
    }
  };
  const onListening = () => {
    server.off("error", onError); // bound OK — stop intercepting listen errors
    console.log(`yamlover  serving ${dataRoot}${prod ? "" : "  (live/Vite)"}`);
    console.log(`          http://${shown}:${p}/  (bound to ${host})`);
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(p, host);
}

listenWithFallback(port, MAX_PORT_TRIES);
