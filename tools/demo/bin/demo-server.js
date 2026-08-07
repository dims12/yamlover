#!/usr/bin/env node
// yamlover demo server — registration + per-hash disposable yamlover instances.
//
//   DEMO_DRIVER=process EMAIL_PROVIDER=console node bin/demo-server.js   (local dev)
//   DEMO_DRIVER=docker  EMAIL_PROVIDER=resend  node bin/demo-server.js   (production)
//
// All configuration is environment-driven — see src/config.js / README.md.

import { createServer } from "node:http";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { processDriver } from "../src/drivers/process.js";
import { dockerDriver } from "../src/drivers/docker.js";
import { makeProvisioner } from "../src/provision.js";
import { makeRateLimit } from "../src/rate-limit.js";
import { makeRouter } from "../src/router.js";
import { makeReaper } from "../src/reaper.js";
import { makeDocs } from "../src/docs.js";

const driver = config.driver === "docker" ? dockerDriver : processDriver;
const store = openStore(config.dbPath);
const { provision } = makeProvisioner(driver, store);
const rateLimit = makeRateLimit({ perHour: config.registerPerHour });
const docs = config.docsEnabled ? makeDocs(driver) : null;
const route = makeRouter({ store, provision, rateLimit, docs });
const reaper = makeReaper(driver, store);

const server = createServer((req, res) => {
  Promise.resolve(route(req, res)).catch((e) => {
    console.error("request error:", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("internal error");
    } else {
      res.destroy();
    }
  });
});

await driver.prepare?.(); // docker: pull the image so a moving tag is refreshed on restart
await reaper.start();
server.listen(config.port, config.host, () => {
  console.log(`yamlover-demo  driver=${config.driver}  email=${config.emailProvider}`);
  console.log(`               listening http://${config.host}:${config.port}/`);
  console.log(`               links → ${config.baseUrl}/demo/<hash>/   ttl=${config.ttlDays}d  max=${config.maxDemos}`);
  if (docs) console.log(`               docs  → ${config.baseUrl}${config.docsBasePath}/   (read-only, always on)`);
});

// The docs instance comes up alongside the server rather than blocking it: a docs failure
// must never keep the registration page or the demos down. A miss is retried on every
// /docs hit and by the refresh timer.
let stopDocsTimer = () => {};
if (docs) {
  await docs.refresh().catch((e) => console.error("docs start failed (will retry):", e.message));
  stopDocsTimer = docs.startTimer();
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopDocsTimer();
  reaper.stop();
  server.close();
  await driver.shutdown?.().catch(() => {});
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
