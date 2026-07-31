#!/usr/bin/env node
// migrate-yo — one-time sweep renaming a tree from the legacy overlay spelling to `yo`
// (YOMIGRATION.md): `.yamlover/` dirs → `.yo/`, and `body/meta/settings.yamlover` inside
// them → `body/meta/settings.yo`. Stale `index.db*` caches (derived, rebuildable) are
// deleted rather than carried over. Standalone `*.yamlover` DATA files are NOT renamed —
// the engine reads that extension forever (§1 alias); pass --files to rename them too.
//
//   node tools/migrate-yo.mjs <root> [--dry-run] [--files]

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const renameFiles = args.includes("--files");
const root = args.find((a) => !a.startsWith("--"));
if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error("usage: node tools/migrate-yo.mjs <root> [--dry-run] [--files]");
  process.exit(1);
}

const OVERLAY_FILES = new Set(["body.yamlover", "meta.yamlover", "settings.yamlover"]);
let did = 0;
const act = (msg, fn) => {
  console.log(`${dry ? "[dry] " : ""}${msg}`);
  if (!dry) {
    try {
      fn();
    } catch (e) {
      // a locked index.db (a server still running on the tree) must not abort the sweep
      console.warn(`SKIP (${e.code ?? e.message}) — stop any server on this tree and re-run`);
      return;
    }
  }
  did++;
};

const visit = (dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      if (e.name === ".yamlover") {
        // rename the overlay's contents first, then the dir itself
        for (const f of fs.readdirSync(abs)) {
          const from = path.join(abs, f);
          if (OVERLAY_FILES.has(f)) {
            const to = path.join(abs, f.replace(/\.yamlover$/, ".yo"));
            act(`rename ${from} -> ${to}`, () => fs.renameSync(from, to));
          } else if (f.startsWith("index.db")) {
            act(`delete stale cache ${from}`, () => fs.rmSync(from));
          }
        }
        const to = path.join(dir, ".yo");
        if (fs.existsSync(to)) console.warn(`SKIP ${abs}: ${to} already exists — merge by hand`);
        else act(`rename ${abs} -> ${to}`, () => fs.renameSync(abs, to));
        continue; // never recurse into the (old or new) overlay beyond its own entries
      }
      if (!e.name.startsWith(".")) visit(abs);
    } else if (renameFiles && e.isFile() && e.name.endsWith(".yamlover")) {
      const to = abs.replace(/\.yamlover$/, ".yo");
      act(`rename ${abs} -> ${to}`, () => fs.renameSync(abs, to));
    }
  }
};

visit(path.resolve(root));
console.log(`${did} change(s)${dry ? " (dry run — nothing written)" : ""}`);
