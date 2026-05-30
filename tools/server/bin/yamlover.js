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
import { dirname, join, resolve } from "node:path";
import fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, ".."); // tools/server

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
  // `allowedHosts: true` lifts Vite's Host-header allowlist so the SPA is
  // reachable from the network (any hostname/IP), matching the 0.0.0.0 bind.
  server: { middlewareMode: true, allowedHosts: true, hmr: { server } },
});

// Load the server-side materializer through Vite (transpiled on the fly).
const { createHandlers } = await vite.ssrLoadModule("/src/server/api.ts");
handle = createHandlers(dataRoot, { gitignore });

server.listen(port, host, () => {
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  console.log(`yamlover  serving ${dataRoot}`);
  console.log(`          http://${shown}:${port}/  (bound to ${host})`);
});
