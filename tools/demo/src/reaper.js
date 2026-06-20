// The TTL reaper: periodically stops demos past their lifetime, and on startup
// reconciles the store against the live driver instances so a restart never leaks.

import { config } from "./config.js";

export function makeReaper(driver, store) {
  /** Stop demos older than the hard TTL (or idle past IDLE_HOURS, if configured). */
  async function sweep() {
    const now = Date.now();
    const ttlMs = config.ttlDays * 86_400_000;
    const idleMs = config.idleHours != null ? config.idleHours * 3_600_000 : null;
    for (const row of store.running()) {
      const tooOld = now - row.created_at > ttlMs;
      const tooIdle = idleMs != null && row.last_seen != null && now - row.last_seen > idleMs;
      if (!tooOld && !tooIdle) continue;
      if (row.instance_id) await driver.stop(row.instance_id).catch(() => {});
      store.update(row.hash, { state: "expired", instance_id: null, port: null });
    }
  }

  /** On startup: drop rows whose instance vanished back to `pending`, and stop any
   *  orphaned instance with no matching running row. With the docker driver a surviving
   *  container is adopted (its id + published port are stable across our restart). */
  async function reconcile() {
    const live = await driver.list().catch(() => []);
    const liveIds = new Set(live.map((i) => i.id));
    for (const row of store.running()) {
      if (!row.instance_id || !liveIds.has(row.instance_id)) {
        store.update(row.hash, { state: "pending", instance_id: null, port: null });
      }
    }
    const runningHashes = new Set(store.running().map((r) => r.hash));
    for (const inst of live) {
      if (!runningHashes.has(inst.hash)) await driver.stop(inst.id).catch(() => {});
    }
  }

  let timer = null;
  return {
    sweep,
    reconcile,
    async start() {
      await reconcile().catch((e) => console.error("reconcile error:", e.message));
      timer = setInterval(() => sweep().catch((e) => console.error("sweep error:", e.message)), config.reapIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
