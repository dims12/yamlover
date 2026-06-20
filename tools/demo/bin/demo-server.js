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

const driver = config.driver === "docker" ? dockerDriver : processDriver;
const store = openStore(config.dbPath);
const { provision } = makeProvisioner(driver, store);
const rateLimit = makeRateLimit({ perHour: config.registerPerHour });
const route = makeRouter({ store, provision, rateLimit });
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

await reaper.start();
server.listen(config.port, config.host, () => {
  console.log(`yamlover-demo  driver=${config.driver}  email=${config.emailProvider}`);
  console.log(`               listening http://${config.host}:${config.port}/`);
  console.log(`               links → ${config.baseUrl}/demo/<hash>/   ttl=${config.ttlDays}d  max=${config.maxDemos}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  reaper.stop();
  server.close();
  await driver.shutdown?.().catch(() => {});
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
