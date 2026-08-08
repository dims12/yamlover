// The landing page's analytics tag. Simpler than the SPA's (tools/server/bin/ga4.js): one
// static page, nothing to redact — so what matters here is that it is genuinely absent when
// unconfigured, and that the id cannot break out of the element it is embedded in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ga4Tag } from "../src/ga4.js";

test("no measurement id means no third-party script at all", () => {
  // The default, and the state every fork of this repo is in.
  assert.equal(ga4Tag(""), "");
  assert.equal(ga4Tag(undefined), "");
  assert.equal(ga4Tag(null), "");
});

test("a configured id loads gtag.js and configures it", () => {
  const tag = ga4Tag("G-ABC123");
  assert.match(tag, /googletagmanager\.com\/gtag\/js\?id=G-ABC123/);
  assert.match(tag, /gtag\("config","G-ABC123"\)/);
});

test("the id is escaped for both the URL and the script body", () => {
  // It arrives from the environment, so it is not structurally trusted even though whoever
  // sets it is.
  const tag = ga4Tag('G-X"</script><script>alert(1)</script>');
  assert.equal(tag.match(/<script/g).length, 2, "the loader and the inline config, nothing more");
  assert.ok(!tag.includes("<script>alert(1)"), "no injected element survives");
  assert.ok(tag.includes("\\u003c"), "the angle bracket is escaped inside the JS string");
});
