/**
 * api.ts — the JSON API the SPA calls.
 *
 * Endpoints, all keyed by a JSON-space `path` (`/key[0]/sub`, no "properties"):
 *
 *   GET /api/tree                        the table of contents (containers only)
 *   GET /api/json?path&depth             the node's value as JSON
 *   GET /api/schema?path&depth&format    the node's instance schema (json | yaml)
 *
 * The materialized tree is cached per server for a short window (leaf bytes load
 * lazily within it), so a burst of clicks does not re-read the filesystem; edits
 * show up after the cache window on reload.
 */

import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  loadEntity,
  getNode,
  strToSegs,
  buildTree,
  labelForSeg,
  toPlain,
  toSchema,
  binaryContent,
  typeLabel,
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

      const node = getNode(root(), segs);
      const type = typeLabel(node);
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
          concrete: node.concrete,
          title: node.title ?? null,
          description: node.description ?? null,
          value: wantBytes ? binaryContent(node) : toPlain(node, viewDepth, segs),
        });
      } else if (url.pathname === "/api/schema") {
        sendJson(res, 200, toSchema(node, viewDepth, segs));
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
