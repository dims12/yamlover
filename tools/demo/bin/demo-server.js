#!/usr/bin/env node
// yamlover demo server — registration + per-hash disposable yamlover instances.
//
//   DEMO_DRIVER=process EMAIL_PROVIDER=console node bin/demo-server.js   (local dev)
//   DEMO_DRIVER=docker  EMAIL_PROVIDER=resend  node bin/demo-server.js   (production)
//
// All configuration is environment-driven — see src/config.js / README.md.

import { createServer } from "node:http";
import { config } from "../src/config.js";
import { log } from "../src/log.js";
import { clientIp } from "../src/http-util.js";
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
  const started = Date.now();
  // `finish` (not `close`) — the response was fully written, so res.statusCode is final.
  // A client that hangs up mid-stream, which every open SSE tab eventually does, is not
  // an event worth a log line.
  if (config.logHttp !== "off") {
    res.once("finish", () => {
      if (config.logHttp !== "all" && res.statusCode < 400) return;
      log.request({
        method: req.method,
        url: req.url,
        status: res.statusCode,
        latencyMs: Date.now() - started,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        referer: req.headers.referer,
      });
    });
  }
  Promise.resolve(route(req, res)).catch((e) => {
    log.error("request failed", { err: e, method: req.method, url: req.url });
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
  // One record, not a banner: the fields are what an operator filters on later (and what
  // tells them, on a box they did not deploy, which posture this process is actually in).
  log.notice(`listening on http://${config.host}:${config.port}/`, {
    driver: config.driver,
    email: config.emailProvider,
    baseUrl: config.baseUrl,
    ttlDays: config.ttlDays,
    maxDemos: config.maxDemos,
    docs: docs ? config.docsBasePath : false,
    analytics: config.ga4MeasurementId || false,
    logHttp: config.logHttp,
  });
});

// The docs instance comes up alongside the server rather than blocking it: a docs failure
// must never keep the registration page or the demos down. A miss is retried on every
// /docs hit and by the refresh timer.
let stopDocsTimer = () => {};
if (docs) {
  await docs.refresh().catch((e) => log.error("docs start failed (will retry)", { err: e }));
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
