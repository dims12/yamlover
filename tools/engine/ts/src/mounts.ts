// Mounted authorities — the yamlover self-import taxonomy, shipped as PACKAGE DATA so that
// `*::yamlover:…` and `*::: yamlover.inthemoon.net:…` resolve from ANY served root, even a
// detached copy with no project taxonomy of its own (IMPORTS.md §4). The canonical
// {$defs, tags} live at the repo root in dev; `tools/server/scripts/build.mjs` copies them to
// `dist/builtin-taxonomy/` for the published package. The tree is loaded once and CLONED per
// graft (a walk attaches derived schema meta to the instance it grafts — never the shared base).
//
// Only `yamlover.inthemoon.net` is mounted: it is the canonical project, bundled with the tool.
// Every OTHER world authority (`*::: acme.example:…`) stays `external` — transport is out of
// scope (IMPORTS.md §5). This is the one exception the user asked for.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node, Entry } from '../../../parser/ts/src/ir.ts';
import { isPointer } from '../../../parser/ts/src/ir.ts';
import { walkTree } from './walk.ts';

/** The yamlover project's world URI authority (SEPARATOR.md §2). */
export const YAMLOVER_AUTHORITY = 'yamlover.inthemoon.net';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** First candidate dir holding a `$defs/` subtree: the bundled copy next to the dist bundle, or
 *  the repo root in a dev/source run (src → ts → engine → tools → repo). Null if neither exists. */
function taxonomyDir(): string | null {
  const candidates = [
    path.join(moduleDir, 'builtin-taxonomy'),   // published package: dist/builtin-taxonomy
    path.resolve(moduleDir, '../../../../'),     // dev/source run: the repo root
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, '$defs'))) return c;
  return null;
}

let cached: { node: Node; defs: Map<string, Node> } | null | undefined;

/** Build the `{$defs, tags}` mapping node for the bundled taxonomy once (cached). `noGraft`
 *  stops the inner walks from grafting a `yamlover` self-import INTO the taxonomy itself. */
function loadBundledTaxonomy(): { node: Node; defs: Map<string, Node> } | null {
  if (cached !== undefined) return cached;
  const dir = taxonomyDir();
  if (!dir) return (cached = null);
  const defsRoot = walkTree(path.join(dir, '$defs'), { noGraft: true }).doc.root;
  const entries: Entry[] = [{ key: '$defs', edge: 'contain', value: defsRoot }];
  const tagsDir = path.join(dir, 'tags');
  if (fs.existsSync(tagsDir)) {
    entries.push({ key: 'tags', edge: 'contain', value: walkTree(tagsDir, { noGraft: true }).doc.root });
  }
  const defs = defsMap(defsRoot);
  return (cached = { node: { kind: 'mapping', array: false, entries }, defs });
}

/** A fresh CLONE of the bundled taxonomy graft node + its `$defs` map (for applySchemas to
 *  resolve `*yamlover:$defs:<name>` without a disk read). Null when no taxonomy dir is found —
 *  the caller then falls back to the minimal in-source builtin. */
export function graftTaxonomy(): { node: Node; defs: Map<string, Node> } | null {
  const base = loadBundledTaxonomy();
  if (!base) return null;
  const node = structuredClone(base.node);
  const defsNode = node.entries?.find((e) => e.key === '$defs')?.value as Node | undefined;
  return { node, defs: defsNode ? defsMap(defsNode) : new Map() };
}

/** Map each contained `$defs/<name>` schema node by its key (skipping any pointer entry). */
function defsMap(defsNode: Node): Map<string, Node> {
  const m = new Map<string, Node>();
  for (const e of defsNode.entries ?? []) if (e.key && !isPointer(e.value)) m.set(e.key, e.value as Node);
  return m;
}
