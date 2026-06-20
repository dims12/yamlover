// Lazy provisioning: a demo's instance is started on the FIRST visit to its link (the
// email click is the confirmation), then reused. A per-hash in-flight lock collapses
// concurrent first-hits into a single start. Returns the instance's loopback port.

import http from "node:http";
import { config, basePathFor } from "./config.js";

/** A provisioning failure carrying the HTTP status the router should surface. */
export class ProvisionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function makeProvisioner(driver, store) {
  const inflight = new Map(); // hash -> Promise<port>

  /** Poll the instance's own `/api/info` (under its base path) until it answers 200. */
  async function waitForReady(port, hash, timeoutMs = 30_000) {
    const url = `http://127.0.0.1:${port}${basePathFor(hash)}/api/info`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await new Promise((resolve) => {
        const r = http.get(url, (resp) => {
          resp.resume();
          resolve(resp.statusCode === 200);
        });
        r.on("error", () => resolve(false));
        r.setTimeout(2000, () => {
          r.destroy();
          resolve(false);
        });
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new ProvisionError(502, "demo did not become ready");
  }

  async function provision(hash) {
    const row = store.get(hash);
    if (!row) throw new ProvisionError(404, "unknown demo");
    if (row.state === "expired") throw new ProvisionError(410, "demo expired");

    // Already running and the instance is still alive → reuse it.
    if (row.state === "running" && row.port) {
      const live = await driver.list();
      if (live.some((i) => i.id === row.instance_id)) return row.port;
    }

    if (inflight.has(hash)) return inflight.get(hash);

    const task = (async () => {
      if (store.countRunning() >= config.maxDemos) {
        throw new ProvisionError(503, "demo capacity full");
      }
      const { id, port } = await driver.start(hash);
      try {
        await waitForReady(port, hash);
      } catch (e) {
        await driver.stop(id).catch(() => {});
        throw e instanceof ProvisionError ? e : new ProvisionError(502, "demo failed to start");
      }
      const now = Date.now();
      store.update(hash, { state: "running", instance_id: id, port, started_at: now, last_seen: now });
      return port;
    })();

    inflight.set(hash, task);
    try {
      return await task;
    } finally {
      inflight.delete(hash);
    }
  }

  return { provision, waitForReady };
}
