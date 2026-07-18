#!/usr/bin/env node
// Delete every yamlover index database (`.yamlover/index.db{,-wal,-shm,-journal}`) under a
// tree, so the next serve/walk rebuilds the index from scratch. These are derived caches —
// safe to remove; the engine regenerates them on the next index pass.
//
// Scoped on purpose: it matches only `index.db*` that sits directly inside a `.yamlover/`
// directory, and skips `node_modules`. It does NOT touch the demo server's `demos.db`
// (tools/demo/.data), the derived `thumbnails/`/`fragments/` sidecars (those are referenced
// by overlay files), or any other `*.db` in the tree.
//
// Portable Node rewrite of the old tools/clean-index.sh — runs anywhere Node does, Windows
// included:
//
//   npm run clean-index                  # clean the repo (the script's own root)
//   npm run clean-index -- D:/some/tree  # clean another tree (e.g. a served library)
//   npm run clean-index -- -n [DIR]      # dry run — list what would be deleted, delete nothing
//
// (or directly: node tools/clean-index.mjs [-n] [DIR])

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let dry = false;
let root = "";
for (const a of process.argv.slice(2)) {
  if (a === "-n" || a === "--dry-run") dry = true;
  else root = a;
}
// Default to the repo root (the dir holding tools/), not cwd, so it is location-independent.
root = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`clean-index: no such directory: ${root}`);
  process.exit(1);
}

const found = [];
const visit = (dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip, like `find` would after its warning
  }
  const isYamlover = path.basename(dir) === ".yamlover";
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      visit(abs);
    } else if (e.isFile() && isYamlover && e.name.startsWith("index.db")) {
      found.push(abs);
    }
  }
};
visit(root);

if (found.length === 0) {
  console.log(`clean-index: no index databases under ${root}`);
  process.exit(0);
}

for (const f of found) {
  if (dry) {
    console.log(`would delete: ${f}`);
  } else {
    fs.rmSync(f, { force: true });
    console.log(`deleted: ${f}`);
  }
}
console.log(dry ? "(dry run — nothing removed)" : `removed ${found.length} file(s)`);
