import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDemoPath, isDocsPath, isExamplesPath, isSitePath } from "../src/router.js";

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

test("isDocsPath matches the prefix and its subtree only", () => {
  assert.equal(isDocsPath("/docs", "/docs"), true); // redirected to the trailing slash
  assert.equal(isDocsPath("/docs/", "/docs"), true);
  assert.equal(isDocsPath("/docs/api/info", "/docs"), true);
  assert.equal(isDocsPath("/docs/assets/x.js", "/docs"), true);
  // a sibling path that merely starts with the same characters is NOT the docs instance
  assert.equal(isDocsPath("/docsomething", "/docs"), false);
  assert.equal(isDocsPath("/", "/docs"), false);
  assert.equal(isDocsPath("/demo/abc/", "/docs"), false);
});

test("isDocsPath matches nothing when the prefix is empty (docs disabled)", () => {
  assert.equal(isDocsPath("/docs/", ""), false);
  assert.equal(isDocsPath("/", ""), false);
});

test("isExamplesPath matches the prefix and its subtree only", () => {
  assert.equal(isExamplesPath("/examples", "/examples"), true);
  assert.equal(isExamplesPath("/examples/", "/examples"), true);
  assert.equal(isExamplesPath("/examples/types/map", "/examples"), true);
  assert.equal(isExamplesPath("/examplessomething", "/examples"), false);
  assert.equal(isExamplesPath("/docs/", "/examples"), false);
  assert.equal(isExamplesPath("/demo/abc/", "/examples"), false);
});

test("isSitePath is the shared prefix check", () => {
  assert.equal(isSitePath("/foo/bar", "/foo"), true);
  assert.equal(isSitePath("/foobar", "/foo"), false);
  assert.equal(isSitePath("/foo", ""), false);
});
