// Local-dev driver: each demo is a yamlover child process serving a fresh copy of
// examples/ under its own base path. No Docker required — handy for developing the
// demo server itself. Cleanup is manual (kill + rm the temp dir); on a demo-server
// restart the child list is lost (in-memory), so old children are orphaned — acceptable
// for dev. Use the docker driver in production.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { config, basePathFor } from "../config.js";

const procs = new Map(); // id -> { hash, child, dir }

/** An OS-assigned free TCP port on loopback (a hint; the actual bound port is read back). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export const processDriver = {
  name: "process",

  async start(hash) {
    await mkdir(config.spoolDir, { recursive: true });
    // Copy into a `…/examples` dir so yamlover's root label reads "examples" (the dir
    // basename), matching the docker driver. The unique parent is removed on stop.
    const parent = await mkdtemp(join(config.spoolDir, hash + "-"));
    const dir = join(parent, "examples");
    await cp(config.examplesDir, dir, { recursive: true });
    const hint = await freePort();
    const child = spawn(
      process.execPath,
      [config.yamloverBin, dir, "--prod", "--headless", "--port", String(hint), "--base-path", basePathFor(hash)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const id = `p${child.pid}`;
    procs.set(id, { hash, child, dir: parent }); // remove the whole parent on stop
    child.on("exit", () => procs.delete(id));

    // yamlover prints "http://<host>:<port>/" once bound; trust that port (it may have
    // bumped off our hint via its own EADDRINUSE fallback).
    const port = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("yamlover start timeout")), 20_000);
      const onData = (d) => {
        buf += d.toString();
        const m = buf.match(/http:\/\/[^/]+:(\d+)\//);
        if (m) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.stdout.resume(); // keep draining so the pipe never fills
          resolve(Number(m[1]));
        }
      };
      child.stdout.on("data", onData);
      child.stderr.resume();
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`yamlover exited early (code ${code})`));
      });
    });
    return { id, port };
  },

  async stop(id) {
    const rec = procs.get(id);
    if (!rec) return;
    procs.delete(id);
    try {
      rec.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // Let it release file handles before removing its data dir.
    setTimeout(() => rm(rec.dir, { recursive: true, force: true }).catch(() => {}), 1000);
  },

  async list() {
    return [...procs.entries()].map(([id, r]) => ({ id, hash: r.hash }));
  },

  // Kill children on graceful shutdown — they can't be adopted across a restart
  // (the child list is in-memory), so leaving them would orphan real processes.
  async shutdown() {
    for (const rec of procs.values()) {
      try {
        rec.child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  },
};
