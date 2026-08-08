// Lazy provisioning: a demo's instance is started on the FIRST visit to its link (the
// email click is the confirmation), then reused. A per-hash in-flight lock collapses
// concurrent first-hits into a single start. Returns the instance's loopback port.

import { config, basePathFor } from "./config.js";
import { log } from "./log.js";
import { waitForReady } from "./ready.js";

/** A provisioning failure carrying the HTTP status the router should surface. */
export class ProvisionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function makeProvisioner(driver, store) {
  const inflight = new Map(); // hash -> Promise<port>

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
      // Both refusals below reach the visitor as a status page, and the access log records
      // only that a 5xx happened. The reason lives here, so log it where it is known.
      if (store.countRunning() >= config.maxDemos) {
        log.warn("provision refused: at capacity", { hash, running: store.countRunning(), max: config.maxDemos });
        throw new ProvisionError(503, "demo capacity full");
      }
      const { id, port } = await driver.start(hash);
      try {
        await waitForReady(port, basePathFor(hash));
      } catch (e) {
        log.error("provision failed: instance never became ready", { err: e, hash, port });
        await driver.stop(id).catch(() => {});
        throw new ProvisionError(502, "demo failed to start");
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

  return { provision };
}
