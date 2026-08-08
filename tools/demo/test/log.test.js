// The structured logger. Its whole reason for existing is that the Ops Agent can parse what
// it writes (deploy/ops-agent-config.yaml), so the tests assert the WIRE SHAPE — the keys the
// agent looks for — rather than that something was printed.
//
// LOG_FORMAT is read once at import, so it is set before the dynamic import below and this
// file only ever exercises json mode. The text path is for humans reading a terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

process.env.LOG_FORMAT = "json";
process.env.LOG_LEVEL = "info";
const { makeLog, captureLines } = await import("../src/log.js");

/** Capture what `fn` writes to stdout/stderr, as one parsed record per line. */
function records(fn) {
  const out = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const grab = (chunk) => {
    for (const line of String(chunk).split("\n")) if (line.trim()) out.push(JSON.parse(line));
    return true;
  };
  process.stdout.write = grab;
  process.stderr.write = grab;
  try {
    fn();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return out;
}

test("a record carries the severity, message and timestamp the agent lifts", () => {
  const [r] = records(() => makeLog().info("listening"));
  assert.equal(r.severity, "INFO");
  assert.equal(r.message, "listening");
  assert.ok(!Number.isNaN(Date.parse(r.time)), "time is parseable");
});

test("severity names are the ones Cloud Logging accepts", () => {
  // Not WARN, not W: LogEntry.severity is a closed enum and an unrecognised name lands as
  // DEFAULT, which silently breaks every severity filter.
  const log = makeLog();
  const got = records(() => {
    log.info("i");
    log.notice("n");
    log.warn("w");
    log.error("e");
  }).map((r) => r.severity);
  assert.deepEqual(got, ["INFO", "NOTICE", "WARNING", "ERROR"]);
});

test("fields are merged in, and bindings ride on every record from a child", () => {
  const [r] = records(() => makeLog({ component: "instance" }).child({ hash: "abc" }).info("started", { port: 5173 }));
  assert.equal(r.component, "instance");
  assert.equal(r.hash, "abc");
  assert.equal(r.port, 5173);
});

test("an Error is unpacked, because JSON.stringify cannot see it", () => {
  // message and stack are non-enumerable, so `{err}` would serialise to `{"err":{}}` — the
  // failure would reach the Logs Explorer as an empty object.
  const [r] = records(() => makeLog().error("email send failed", { err: new Error("resend 502") }));
  assert.equal(r.error, "resend 502");
  assert.match(r.stack, /^Error: resend 502/);
  assert.equal(r.err, undefined);
});

test("undefined fields are dropped rather than serialised as null", () => {
  const [r] = records(() => makeLog().info("x", { a: 1, b: undefined }));
  assert.equal(r.a, 1);
  assert.ok(!("b" in r), "an absent optional stays absent");
});

test("below the level threshold nothing is written at all", () => {
  assert.equal(records(() => makeLog().debug("noise")).length, 0);
});

test("warnings and worse go to stderr, so journald priority survives an unparsed line", () => {
  const seen = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = () => (seen.push("out"), true);
  process.stderr.write = () => (seen.push("err"), true);
  try {
    const log = makeLog();
    log.info("i");
    log.warn("w");
    log.error("e");
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  assert.deepEqual(seen, ["out", "err", "err"]);
});

test("request() emits the special httpRequest key the agent maps to LogEntry.httpRequest", () => {
  const [r] = records(() =>
    makeLog().request({ method: "GET", url: "/demo/abc/", status: 200, latencyMs: 12, ip: "1.2.3.4" }),
  );
  const http = r["logging.googleapis.com/httpRequest"];
  assert.ok(http, "the special key is present — a plain `httpRequest` would stay in jsonPayload");
  assert.equal(http.requestMethod, "GET");
  assert.equal(http.requestUrl, "/demo/abc/");
  assert.equal(http.status, 200);
  assert.equal(http.latency, "0.012s"); // a Duration string, not a number
  assert.equal(http.remoteIp, "1.2.3.4");
  assert.ok(!("userAgent" in http), "absent optionals are omitted, not sent as null");
});

test("request() derives severity from the status", () => {
  const log = makeLog();
  const sev = (status) => records(() => log.request({ method: "GET", url: "/", status, latencyMs: 1 }))[0].severity;
  assert.equal(sev(200), "INFO");
  assert.equal(sev(301), "INFO");
  assert.equal(sev(404), "WARNING");
  assert.equal(sev(500), "ERROR");
});

test("captureLines splits a child's output into one record per line", async () => {
  const stream = new PassThrough();
  const out = [];
  captureLines(stream, { info: (line) => out.push(line) }, "info");
  stream.write("first\nsecond\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, ["first", "second"]);
});

test("captureLines holds a partial line until the rest of it arrives", async () => {
  // A child's stdout arrives in arbitrary chunks; splitting per chunk would cut messages in
  // half and each half would reach Cloud Logging as its own entry.
  const stream = new PassThrough();
  const out = [];
  captureLines(stream, { info: (line) => out.push(line) }, "info");
  stream.write("indexing ");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, [], "nothing is emitted for a line that has not ended");
  stream.write("examples: done\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, ["indexing examples: done"]);
});

test("captureLines flushes a trailing line with no newline when the stream ends", async () => {
  const stream = new PassThrough();
  const out = [];
  captureLines(stream, { info: (line) => out.push(line) }, "info");
  stream.end("last words");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, ["last words"]);
});

test("captureLines drops blank lines, which yamlover prints between phases", async () => {
  const stream = new PassThrough();
  const out = [];
  captureLines(stream, { info: (line) => out.push(line) }, "info");
  stream.end("a\n\n   \nb\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, ["a", "b"]);
});
