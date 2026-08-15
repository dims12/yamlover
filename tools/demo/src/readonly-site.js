// An always-on read-only yamlover (docs/ or examples/): not a demo — no hash, no email,
// no store row, and the reaper never sees it (demo containers carry `yamlover-demo=1`).
//
// Kept alive on three triggers, all funnelling through the same `ensure()`:
//   • at boot          — so it is up before the first visitor;
//   • on a hit         — self-heals if the container died or the docker daemon restarted
//                        (the proxy invalidates the cached port when the upstream refuses);
//   • every refreshMs  — re-pull the image and recreate if the tag moved, so an edit goes
//                        live from a plain CI image push, with no redeploy.

import { config } from "./config.js";
import { log } from "./log.js";
import { waitForReady } from "./ready.js";

/** `kind` is the log/label stem (`docs`, `examples`). Driver methods are injected so the
 *  same controller drives both sites. */
export function makeReadonlySite(driver, spec) {
  const { kind, basePath, refreshMs, prepare, status, start, stop } = spec;
  let port = null;
  let inflight = null;

  async function boot() {
    const cur = await status().catch(() => null);
    if (cur && cur.port && !cur.stale) {
      await waitForReady(cur.port, basePath);
      log.info(`${kind} adopted`, { port: cur.port });
      return cur.port;
    }
    if (cur) await stop().catch(() => {});
    const started = await start();
    try {
      await waitForReady(started.port, basePath);
    } catch (e) {
      await stop().catch(() => {});
      throw e;
    }
    log.notice(cur ? `${kind} replaced (image moved)` : `${kind} started`, { port: started.port });
    return started.port;
  }

  async function ensure() {
    if (port != null) return port;
    if (!inflight) {
      inflight = boot()
        .then((p) => (port = p))
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return {
    ensure,
    invalidate() {
      port = null;
    },
    async refresh() {
      await prepare?.();
      const cur = await status().catch(() => null);
      if (cur?.stale || !cur) port = null;
      await ensure();
    },
    startTimer() {
      const t = setInterval(
        () => this.refresh().catch((e) => log.error(`${kind} refresh failed`, { err: e })),
        refreshMs,
      );
      t.unref?.();
      return () => clearInterval(t);
    },
  };
}

export function makeDocs(driver) {
  return makeReadonlySite(driver, {
    kind: "docs",
    basePath: config.docsBasePath,
    refreshMs: config.docsRefreshMs,
    prepare: () => driver.prepareDocs?.(),
    status: () => driver.docsStatus(),
    start: () => driver.startDocs(),
    stop: () => driver.stopDocs(),
  });
}

export function makeExamples(driver) {
  return makeReadonlySite(driver, {
    kind: "examples",
    basePath: config.examplesSiteBasePath,
    refreshMs: config.examplesSiteRefreshMs,
    prepare: () => driver.prepareExamples?.(),
    status: () => driver.examplesStatus(),
    start: () => driver.startExamples(),
    stop: () => driver.stopExamples(),
  });
}
