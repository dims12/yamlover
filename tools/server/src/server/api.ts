/**
 * api.ts — the JSON API the SPA calls.
 *
 * Endpoints, all keyed by a JSON-space `path` (`/key[0]/sub`, no "properties"):
 *
 *   GET /api/tree                        the table of contents (containers only)
 *   GET /api/json?path&depth             the node's value as JSON
 *   GET /api/schema?path&depth&format    the node's instance schema (json | yaml)
 *   GET /api/blob?path                   a file-backed node's raw bytes (for the
 *                                        image / pdf / html / djvu / markup renderers)
 *
 * The materialized tree is cached per server for a short window (leaf bytes load
 * lazily within it), so a burst of clicks does not re-read the filesystem; edits
 * show up after the cache window on reload.
 */

import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  loadEntity,
  getNode,
  strToSegs,
  buildTree,
  labelForSeg,
  toPlain,
  toSchema,
  buildRelations,
  binaryContent,
  displayTypeLabel,
  formatFromExt,
  setIgnoreFilter,
  YNode,
} from "./yamlover.js";
import { buildGitIgnore } from "./gitignore.js";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

interface Options {
  gitignore?: boolean; // honor .gitignore for stray files (default: true)
}

const CACHE_TTL_MS = 2000;

export function createHandlers(dataRoot: string, opts: Options = {}): Handler {
  // The root label (breadcrumb head and TOC root): the yamlover title if set,
  // else the served directory's name — always non-empty.
  const rootName = path.basename(path.resolve(dataRoot)) || "/";
  setIgnoreFilter(opts.gitignore === false ? () => false : buildGitIgnore(dataRoot));

  let cache: { root: YNode; time: number } | null = null;
  const root = (): YNode => {
    const now = Date.now();
    if (!cache || now - cache.time > CACHE_TTL_MS) cache = { root: loadEntity(dataRoot), time: now };
    return cache.root;
  };

  return (_req, res, url) => {
    try {
      const segs = strToSegs(url.searchParams.get("path") || "/");
      const depth = parseDepth(url.searchParams.get("depth"));

      if (url.pathname === "/api/info") {
        sendJson(res, 200, { root: root().title || rootName }); // breadcrumb head
        return;
      }

      if (url.pathname === "/api/tree") {
        // The TOC loads lazily: a subtree rooted at `path`, `depth` levels deep
        // (default 3). Past the boundary, nodes carry hasChildren for the client
        // to fetch on expand.
        const start = getNode(root(), segs);
        const label = segs.length === 0 ? start.title || rootName : labelForSeg(start, segs[segs.length - 1]);
        sendJson(res, 200, buildTree(start, segs, label, depth ?? 3));
        return;
      }

      if (url.pathname === "/api/blob") {
        // Raw file bytes, served with the node's (inferred) format as the
        // Content-Type, so a renderer can point an <img>/<iframe>/pdf loader at
        // the URL — or fetch the text of a markdown/asciidoc file — directly.
        const n = getNode(root(), segs);
        if (!n.path || !fs.existsSync(n.path) || fs.statSync(n.path).isDirectory()) {
          sendJson(res, 404, { error: `not a file-backed node: ${url.searchParams.get("path")}` });
          return;
        }
        const data = fs.readFileSync(n.path);
        res.statusCode = 200;
        res.setHeader("Content-Type", n.format ?? formatFromExt(n.path) ?? "application/octet-stream");
        res.setHeader("Content-Length", String(data.length));
        res.end(data);
        return;
      }

      const node = getNode(root(), segs);
      // display type: a virtual-children overlay reads as `object` (matches the TOC)
      const type = displayTypeLabel(node);
      // Every representation is one level deep with nested containers as links;
      // the client picks the YAML/JSON syntax. `depth` defaults to 1.
      const viewDepth = depth ?? 1;

      if (url.pathname === "/api/json") {
        // A binary leaf's bytes load only on explicit request (?binary=1) — the
        // selection's header fetch shows its cheap `repr` (size) via toPlain.
        const wantBytes = type === "binary" && url.searchParams.get("binary") === "1";
        sendJson(res, 200, {
          path: url.searchParams.get("path") || "/",
          type,
          format: node.format ?? null, // with `type`, the (type, format) renderer key
          concrete: node.concrete,
          title: node.title ?? null,
          description: node.description ?? null,
          // virtual children are merged into the value; named up-edges (+ `..`)
          // ride alongside as `relations` for the panel above the divider
          value: wantBytes ? binaryContent(node) : toPlain(node, viewDepth, segs, true, root()),
          relations: buildRelations(node, segs, root()),
        });
      } else if (url.pathname === "/api/schema") {
        // pass the real root so a node's rel pointers (esp. absolute /…) resolve
        sendJson(res, 200, toSchema(node, viewDepth, segs, true, root()));
      } else {
        sendJson(res, 404, { error: `no such endpoint: ${url.pathname}` });
      }
    } catch (exc) {
      sendJson(res, 400, { error: (exc as Error).message || String(exc) });
    }
  };
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
