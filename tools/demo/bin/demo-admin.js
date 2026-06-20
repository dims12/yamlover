#!/usr/bin/env node
// Admin CLI for the demo server — list demos and drop them before their TTL. Run ON the
// host, against the same sqlite registry the server uses. Stopping a `--rm` container
// discards it; expiring the row makes the link return 410 (or 404 with --delete).
//
//   node bin/demo-admin.js list
//   node bin/demo-admin.js drop <hash> [<hash> …]      # stop + expire (link → 410)
//   node bin/demo-admin.js drop --all                  # every running demo
//   node bin/demo-admin.js drop <hash> --delete        # remove the row (link → 404)
//
// DB path: $DB_PATH, else ./.data/demos.db next to this checkout (same default the unit
// uses). Driver: docker unless DEMO_DRIVER=process. On design-vm just:
//   cd ~/Design/www/yamlover-demo && node bin/demo-admin.js list
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.js";
import { dockerDriver } from "../src/drivers/docker.js";
import { processDriver } from "../src/drivers/process.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || resolve(__dirname, "../.data/demos.db");
// Admin = production = docker by default; opt into the dev driver explicitly.
const driver = process.env.DEMO_DRIVER === "process" ? processDriver : dockerDriver;
const store = openStore(dbPath);

const age = (ms) => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

function list() {
  const rows = store.all();
  if (!rows.length) return console.log("(no demos)");
  for (const r of rows) {
    console.log(
      `${r.hash}  ${r.state.padEnd(7)}  age=${age(r.created_at).padStart(4)}  ${r.port ?? "-"}  ${r.email}`,
    );
  }
}

async function dropOne(hash, del) {
  const row = store.get(hash);
  if (!row) return console.log(`unknown  ${hash}`);
  // Prefer the recorded instance id; fall back to matching the live set by hash.
  let id = row.instance_id;
  if (!id) id = (await driver.list()).find((i) => i.hash === hash)?.id;
  if (id) await driver.stop(id);
  if (del) store.remove(hash);
  else store.update(hash, { state: "expired", port: null, instance_id: null });
  console.log(`${del ? "deleted" : "expired"}  ${hash}${id ? "  (container stopped)" : ""}`);
}

async function drop(args) {
  const del = args.includes("--delete");
  let hashes = args.filter((a) => !a.startsWith("--"));
  if (args.includes("--all")) hashes = store.running().map((r) => r.hash);
  if (!hashes.length) {
    console.error("usage: drop <hash…> | drop --all  [--delete]");
    process.exit(1);
  }
  for (const h of hashes) await dropOne(h, del);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "list") list();
  else if (cmd === "drop") await drop(rest);
  else {
    console.error("usage: demo-admin <list | drop> …");
    process.exit(1);
  }
} finally {
  store.close();
}
