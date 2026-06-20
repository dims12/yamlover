import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRateLimit } from "../src/rate-limit.js";
import { isEmail } from "../src/http-util.js";
import { sendDemoLink } from "../src/email.js";

test("rate limit allows up to perHour then blocks, per key", () => {
  const rl = makeRateLimit({ perHour: 3 });
  assert.ok(rl.allow("ip1"));
  assert.ok(rl.allow("ip1"));
  assert.ok(rl.allow("ip1"));
  assert.ok(!rl.allow("ip1"), "4th is blocked");
  assert.ok(rl.allow("ip2"), "other key is independent");
});

test("isEmail basic validation", () => {
  assert.ok(isEmail("a@b.co"));
  assert.ok(isEmail("first.last+tag@sub.example.com"));
  assert.ok(!isEmail("nope"));
  assert.ok(!isEmail("a@b"));
  assert.ok(!isEmail("a b@c.com"));
  assert.ok(!isEmail(""));
  assert.ok(!isEmail("a@@b.com"));
  assert.ok(!isEmail("x".repeat(255) + "@b.com"));
});

test("console email provider logs the link and does not throw", async () => {
  const orig = console.log;
  let captured = "";
  console.log = (...a) => (captured += a.join(" "));
  try {
    await sendDemoLink("u@x.com", "http://h/demo/abc/");
  } finally {
    console.log = orig;
  }
  assert.match(captured, /u@x\.com/);
  assert.match(captured, /http:\/\/h\/demo\/abc\//);
});
