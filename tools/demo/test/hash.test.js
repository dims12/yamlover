import { test } from "node:test";
import assert from "node:assert/strict";
import { newHash, isHash } from "../src/hash.js";

test("newHash is 22-char base64url and unique", () => {
  const a = newHash();
  const b = newHash();
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, b);
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(newHash());
  assert.equal(seen.size, 1000, "no collisions across 1000 hashes");
});

test("isHash accepts valid, rejects junk", () => {
  assert.ok(isHash(newHash()));
  assert.ok(isHash("abcDEF123_-xyz0099"));
  assert.ok(!isHash(""));
  assert.ok(!isHash("short"));
  assert.ok(!isHash("has spaces in it now"));
  assert.ok(!isHash("../etc/passwd"));
  assert.ok(!isHash("has/slash/here/now"));
  assert.ok(!isHash(null));
  assert.ok(!isHash(123));
});
