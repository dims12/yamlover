import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDemoPath } from "../src/router.js";

test("parseDemoPath extracts hash + rest", () => {
  assert.deepEqual(parseDemoPath("/demo/abc123/"), { hash: "abc123", rest: "/" });
  assert.deepEqual(parseDemoPath("/demo/abc123"), { hash: "abc123", rest: null });
  assert.deepEqual(parseDemoPath("/demo/abc123/api/info"), { hash: "abc123", rest: "/api/info" });
  assert.deepEqual(parseDemoPath("/demo/a_b-C9/assets/x.js"), { hash: "a_b-C9", rest: "/assets/x.js" });
});

test("parseDemoPath decodes the hash segment", () => {
  assert.equal(parseDemoPath("/demo/ab%2Dcd/")?.hash, "ab-cd");
});

test("parseDemoPath returns null for non-demo paths", () => {
  assert.equal(parseDemoPath("/"), null);
  assert.equal(parseDemoPath("/register"), null);
  assert.equal(parseDemoPath("/demo"), null);
  assert.equal(parseDemoPath("/demo/"), null);
  assert.equal(parseDemoPath("/other/abc/"), null);
});
