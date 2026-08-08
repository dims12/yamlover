// The always-on docs instance: ONE read-only yamlover serving the repo's docs/ under
// `/docs`. It is not a demo — no hash, no email, no store row, and the reaper never sees
// it (demo containers carry `yamlover-demo=1`, this one `yamlover-docs=1`).
//
// Kept alive on three triggers, all funnelling through the same `ensure()`:
//   • at boot          — so it is up before the first visitor;
//   • on a /docs hit   — self-heals if the container died or the docker daemon restarted
//                        (the proxy invalidates the cached port when the upstream refuses);
//   • every DOCS_REFRESH_MS — re-pull the image and recreate if the tag moved, so a docs
//                        edit goes live from a plain CI image push, with no redeploy.

import { config } from "./config.js";
import { log } from "./log.js";
import { waitForReady } from "./ready.js";

export function makeDocs(driver) {
  let port = null; // the loopback port of the instance we believe is live
  let inflight = null; // collapses concurrent ensure() calls into one start

  /** Adopt a live, up-to-date instance if there is one; otherwise (re)create it. */
  async function start() {
    const cur = await driver.docsStatus().catch(() => null);
    if (cur && cur.port && !cur.stale) {
      await waitForReady(cur.port, config.docsBasePath);
      log.info("docs adopted", { port: cur.port });
      return cur.port;
    }
    // A stale or half-dead instance is torn down first: there can be only one (the docker
    // driver names it), and during the gap /docs answers 502 for a few seconds.
    if (cur) await driver.stopDocs().catch(() => {});
    const started = await driver.startDocs();
    try {
      await waitForReady(started.port, config.docsBasePath);
    } catch (e) {
      await driver.stopDocs().catch(() => {});
      throw e;
    }
    log.notice(cur ? "docs replaced (image moved)" : "docs started", { port: started.port });
    return started.port;
  }

  async function ensure() {
    if (port != null) return port;
    if (!inflight) {
      inflight = start()
        .then((p) => (port = p))
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return {
    ensure,
    /** Forget the cached port so the next request re-ensures (the instance looks gone). */
    invalidate() {
      port = null;
    },
    /** Pull a possibly-newer image, then ensure — `start()` recreates on an image change. */
    async refresh() {
      await driver.prepareDocs?.();
      const cur = await driver.docsStatus().catch(() => null);
      if (cur?.stale || !cur) port = null;
      await ensure();
    },
    /** The refresh timer. Failures are logged, never fatal — /docs retries on every hit. */
    startTimer() {
      const t = setInterval(
        () => this.refresh().catch((e) => log.error("docs refresh failed", { err: e })),
        config.docsRefreshMs,
      );
      t.unref?.();
      return () => clearInterval(t);
    },
  };
}
