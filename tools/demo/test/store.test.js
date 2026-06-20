import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.js";

let dir, store;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "demo-store-"));
  store = openStore(join(dir, "demos.db"));
});
after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("insert / get round-trip", () => {
  store.insert({ hash: "h1", email: "a@x.com", created_at: 1000 });
  const row = store.get("h1");
  assert.equal(row.hash, "h1");
  assert.equal(row.email, "a@x.com");
  assert.equal(row.state, "pending");
  assert.equal(store.get("missing"), null);
});

test("update patches columns; null clears", () => {
  store.update("h1", { state: "running", instance_id: "c1", port: 1234 });
  let row = store.get("h1");
  assert.equal(row.state, "running");
  assert.equal(row.port, 1234);
  store.update("h1", { instance_id: null, port: null, state: "expired" });
  row = store.get("h1");
  assert.equal(row.instance_id, null);
  assert.equal(row.port, null);
  assert.equal(row.state, "expired");
});

test("getActiveByEmail returns pending/running only", () => {
  store.insert({ hash: "h2", email: "b@x.com", created_at: 2000, state: "running" });
  assert.equal(store.getActiveByEmail("b@x.com").hash, "h2");
  // h1 is expired → not active
  assert.equal(store.getActiveByEmail("a@x.com"), null);
  assert.equal(store.getActiveByEmail("nobody@x.com"), null);
});

test("running() and countRunning()", () => {
  assert.equal(store.countRunning(), 1); // only h2
  assert.deepEqual(
    store.running().map((r) => r.hash),
    ["h2"],
  );
});

test("touch is throttled but eventually writes", () => {
  store.update("h2", { last_seen: 0 });
  store.touch("h2");
  const t1 = store.get("h2").last_seen;
  assert.ok(t1 > 0, "first touch writes");
  store.update("h2", { last_seen: 1 });
  store.touch("h2"); // within 30s → coalesced, no write
  assert.equal(store.get("h2").last_seen, 1, "second touch coalesced");
});
