// Local-dev driver: each demo is a yamlover child process serving a fresh copy of
// examples/ under its own base path. No Docker required — handy for developing the
// demo server itself. Cleanup is manual (kill + rm the temp dir); on a demo-server
// restart the child list is lost (in-memory), so old children are orphaned — acceptable
// for dev. Use the docker driver in production.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { config, basePathFor, ga4EnvFor, GA4_DEMO_PATH } from "../config.js";
import { log, captureLines } from "../log.js";

const procs = new Map(); // id -> { hash, child, dir }

/** One always-on read-only child (docs or examples), serving `dir` in place. */
function makeReadonlyProc({ dir, basePath, component }) {
  let rec = null;
  return {
    async status() {
      if (!rec) return null;
      return { id: rec.id, port: rec.port, stale: false };
    },
    async start() {
      const bp = basePath();
      const { child, port } = await spawnYamlover(dir(), bp, ["--read-only"], {
        env: ga4EnvFor(bp),
        bindings: { component },
      });
      const id = `p${child.pid}`;
      rec = { id, child, port };
      child.on("exit", () => {
        if (rec?.id === id) rec = null;
      });
      return { id, port };
    },
    async stop() {
      const cur = rec;
      rec = null;
      try {
        cur?.child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    },
  };
}

const docsSite = makeReadonlyProc({
  dir: () => config.docsDir,
  basePath: () => config.docsBasePath,
  component: "docs",
});

const examplesSite = makeReadonlyProc({
  dir: () => config.examplesDir,
  basePath: () => config.examplesSiteBasePath,
  component: "examples",
});

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

/** Spawn a yamlover child serving `dir` under `basePath`, resolved once it reports its port.
 *
 *  `env` adds to the inherited environment (the analytics variables). `bindings` label every
 *  line the child prints, which is how its output stays attributable once several instances
 *  are interleaved into one stream. */
async function spawnYamlover(dir, basePath, extraArgs = [], { env = {}, bindings = {} } = {}) {
  const hint = await freePort();
  const child = spawn(
    process.execPath,
    [config.yamloverBin, dir, "--prod", "--headless", "--port", String(hint), "--base-path", basePath, ...extraArgs],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
  );
  // The child's pipes MUST be drained either way or they fill and block it. Capturing is
  // just a drain that keeps what it reads.
  if (config.logInstances) {
    const logger = log.child(bindings);
    captureLines(child.stdout, logger, "info");
    captureLines(child.stderr, logger, "warn");
  } else {
    child.stdout.resume();
    child.stderr.resume();
  }
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
        resolve(Number(m[1]));
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`yamlover exited early (code ${code})`));
    });
  });
  return { child, port };
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
    const { child, port } = await spawnYamlover(dir, basePathFor(hash), [], {
      env: ga4EnvFor(GA4_DEMO_PATH, { collapse: true }),
      bindings: { component: "instance", hash },
    });
    const id = `p${child.pid}`;
    procs.set(id, { hash, child, dir: parent }); // remove the whole parent on stop
    child.on("exit", (code) => {
      procs.delete(id);
      log.info("instance exited", { hash, code });
    });
    log.info("instance started", { hash, port, pid: child.pid });
    return { id, port };
  },

  // Always-on sites serve the repo tree IN PLACE (no temp copy): `--read-only` means the
  // child never writes user data, and its index under <dir>/.yo is exactly what a local
  // yamlover would build anyway. There is no image, so nothing is ever stale.
  docsStatus: () => docsSite.status(),
  startDocs: () => docsSite.start(),
  stopDocs: () => docsSite.stop(),
  examplesStatus: () => examplesSite.status(),
  startExamples: () => examplesSite.start(),
  stopExamples: () => examplesSite.stop(),

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
    await this.stopDocs();
    await this.stopExamples();
    for (const rec of procs.values()) {
      try {
        rec.child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  },
};
