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
 * The server runs Vite in middleware mode: the client (`src/client`) is served
 * with HMR straight from source, and the server-side materializer
 * (`src/server`) is loaded through Vite's `ssrLoadModule`, so there is no build
 * step. API routes are handled before Vite; every other route falls back to the
 * SPA's index.html (client-side routing on the JSON path).
 */

import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, ".."); // tools/server

// Resolve react/react-dom as *this package* sees them, and alias Vite to those
// exact copies, so the SPA never picks up a stale React from a parent
// node_modules (which surfaces as "react-dom … does not provide an export named
// 'createRoot'" — createRoot is React 18+). Best-effort: if resolution fails we
// leave Vite to its defaults.
const reactAlias = {};
// Directories Vite is allowed to serve over `/@fs` (its file-system allowlist).
// Start with this package; below we add the node_modules that actually holds the
// heavy deps. Under `npx`, deps hoist to a `_npx/<hash>/node_modules` *outside*
// `pkgRoot`, and Vite's default workspace-root detection misses it — so a raw asset
// fetch (notably pdf.js's `pdf.worker.min.mjs`) gets denied and falls through to
// index.html, surfacing as the "non-JavaScript MIME type text/html" worker error.
const fsAllow = [pkgRoot];
try {
  const req = createRequire(join(pkgRoot, "package.json"));
  reactAlias["react"] = dirname(req.resolve("react/package.json"));
  reactAlias["react-dom"] = dirname(req.resolve("react-dom/package.json"));
  // Allow whichever node_modules each heavy dep resolves from (hoisted under npx,
  // or nested in dev) so Vite serves their worker/asset files over `/@fs`.
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

// --- argument parsing ----------------------------------------------------- //
let rootArg = null; // the ROOT path as typed (null when omitted)
let port = 5173;
let host = "0.0.0.0"; // all interfaces by default — reachable from the network
let gitignore = true; // hide .gitignore'd stray files by default
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port" || a === "-p") port = parseInt(argv[++i], 10);
  else if (a.startsWith("--port=")) port = parseInt(a.slice("--port=".length), 10);
  else if (a === "--host") host = argv[++i];
  else if (a.startsWith("--host=")) host = a.slice("--host=".length);
  else if (a === "--no-gitignore") gitignore = false;
  else if (a === "--help" || a === "-h") {
    console.log("usage: npx yamlover [ROOT] [--port N] [--host ADDR] [--no-gitignore]");
    process.exit(0);
  } else if (!a.startsWith("-")) rootArg = a;
}
const dataRoot = resolve(process.cwd(), rootArg ?? ".");
if (!fs.existsSync(dataRoot)) {
  console.error(`yamlover: no such path: ${dataRoot}`);
  process.exit(1);
}

// --- server --------------------------------------------------------------- //
// `vite` and `handle` are filled in just below; the request handler closes over
// them and only reads them once requests start arriving, after assignment.
let vite;
let handle;
const indexHtmlPath = join(pkgRoot, "index.html");

const server = createHttpServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    handle(req, res, url);
    return;
  }
  vite.middlewares(req, res, async () => {
    // SPA fallback: serve the (transformed) index.html for any client route.
    try {
      let html = fs.readFileSync(indexHtmlPath, "utf-8");
      html = await vite.transformIndexHtml(url.pathname, html);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      res.statusCode = 500;
      res.end(e.message);
    }
  });
});

// Run HMR over our own server (`hmr: { server }`) so Vite does not open a
// second WebSocket port of its own.
vite = await createServer({
  root: pkgRoot,
  plugins: [react()],
  appType: "custom",
  // Always use this package's own React: `dedupe` collapses react/react-dom to a
  // single copy, and the aliases pin that copy to the one resolvable from here —
  // so a stale react-dom in a *parent* node_modules (the classic "does not
  // provide an export named 'createRoot'" failure) cannot shadow it.
  resolve: { dedupe: ["react", "react-dom"], alias: reactAlias },
  // Pre-bundle the heavy renderer deps up front. These are all lazy-loaded, so
  // Vite would otherwise discover them (and their transitive CJS deps such as
  // `warning` for react-pdf or `base64-js` for ag-psd) only on first use and could
  // serve them un-interopped — the "does not provide an export named …" failure.
  // Listing them forces a clean CJS→ESM bundle before any renderer mounts.
  optimizeDeps: {
    include: [
      "react-pdf",
      "marked",
      "@asciidoctor/core",
      "ag-psd",
      "utif",
      "heic2any",
      // the office/map renderer deps (all CJS/UMD — they need the CJS→ESM interop
      // a pre-bundle gives, or they are served raw and fail with "does not provide
      // an export named 'default'", e.g. `import L from "leaflet"`)
      "leaflet",
      "xlsx",
      "mammoth/mammoth.browser",
      "@tmcw/togeojson",
    ],
  },
  // `allowedHosts: true` lifts Vite's Host-header allowlist so the SPA is
  // reachable from the network (any hostname/IP), matching the 0.0.0.0 bind.
  // `fs.allow` is widened (above) to the dirs holding the heavy deps so their
  // `/@fs` assets — chiefly pdf.js's worker — are served, not 404'd to index.html.
  server: { middlewareMode: true, allowedHosts: true, hmr: { server }, fs: { allow: fsAllow } },
});

// Load the server-side materializer through Vite (transpiled on the fly). The engine-backed
// handler (engine-api.ts) supersedes the legacy loadEntity materializer (api.ts kept for ref).
const { createHandlers } = await vite.ssrLoadModule("/src/server/engine-api.ts");
handle = createHandlers(dataRoot, { gitignore });

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
    console.log(`yamlover  serving ${dataRoot}`);
    console.log(`          http://${shown}:${p}/  (bound to ${host})`);
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(p, host);
}

listenWithFallback(port, MAX_PORT_TRIES);
