// Persistent registry of demos, on node:sqlite (the same engine yamlover itself uses,
// zero npm deps). Surviving a demo-server restart is the point: the reaper reconciles
// rows against the live driver instances on startup, so nothing leaks across restarts.
//
// A row's `state`:
//   pending  — hash minted (email sent), not yet provisioned (or reset after a restart)
//   running  — an instance is up; `instance_id` + `port` address it
//   expired  — reaped past its TTL; the row is KEPT so the link shows a friendly page

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TOUCH_THROTTLE_MS = 30_000; // coalesce last_seen writes per hash

export function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS demos (
      hash        TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      state       TEXT NOT NULL,
      instance_id TEXT,
      port        INTEGER,
      started_at  INTEGER,
      last_seen   INTEGER
    );
    CREATE INDEX IF NOT EXISTS demos_state ON demos(state);
    CREATE INDEX IF NOT EXISTS demos_email ON demos(email);
  `);

  const stmts = {
    insert: db.prepare(`INSERT INTO demos (hash, email, created_at, state) VALUES (?, ?, ?, ?)`),
    get: db.prepare(`SELECT * FROM demos WHERE hash = ?`),
    activeByEmail: db.prepare(
      `SELECT * FROM demos WHERE email = ? AND state IN ('pending','running') ORDER BY created_at DESC LIMIT 1`,
    ),
    running: db.prepare(`SELECT * FROM demos WHERE state = 'running'`),
    all: db.prepare(`SELECT * FROM demos ORDER BY created_at DESC`),
    countRunning: db.prepare(`SELECT COUNT(*) AS n FROM demos WHERE state = 'running'`),
    createdSince: db.prepare(`SELECT COUNT(*) AS n FROM demos WHERE created_at >= ?`),
    touch: db.prepare(`UPDATE demos SET last_seen = ? WHERE hash = ?`),
  };

  const lastTouch = new Map(); // hash -> ms, to throttle last_seen writes

  return {
    insert({ hash, email, created_at, state = "pending" }) {
      stmts.insert.run(hash, email, created_at, state);
    },
    get(hash) {
      return stmts.get.get(hash) ?? null;
    },
    getActiveByEmail(email) {
      return stmts.activeByEmail.get(email) ?? null;
    },
    running() {
      return stmts.running.all();
    },
    all() {
      return stmts.all.all();
    },
    countRunning() {
      return stmts.countRunning.get().n;
    },
    /** How many demos were created at/after `ts` (ms) — drives the global daily cap. */
    countCreatedSince(ts) {
      return stmts.createdSince.get(ts).n;
    },
    /** Patch arbitrary columns of one row. `null` values clear the column. */
    update(hash, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      const set = keys.map((k) => `${k} = ?`).join(", ");
      db.prepare(`UPDATE demos SET ${set} WHERE hash = ?`).run(...keys.map((k) => fields[k]), hash);
    },
    /** Delete a row outright (admin drop --delete → the link 404s instead of 410-expires). */
    remove(hash) {
      db.prepare(`DELETE FROM demos WHERE hash = ?`).run(hash);
    },
    /** Record activity (idle-reclaim clock), coalesced to at most once per 30s per hash. */
    touch(hash) {
      const now = Date.now();
      if (now - (lastTouch.get(hash) ?? 0) < TOUCH_THROTTLE_MS) return;
      lastTouch.set(hash, now);
      stmts.touch.run(now, hash);
    },
    close() {
      db.close();
    },
  };
}
