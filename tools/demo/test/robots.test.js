// The origin's crawl policy. It lives in this package and not in the yamlover server because of
// where crawlers look: only `https://host/robots.txt` is ever read, and the always-on sites are
// mounted under prefixes — so `/docs/robots.txt` governs nobody.

import { test } from "node:test";
import assert from "node:assert/strict";
import { robotsTxt, originOf } from "../src/robots.js";

const SITES = [{ basePath: "/docs" }, { basePath: "/examples" }];

test("declares a sitemap per mounted site, under its own prefix", () => {
  const txt = robotsTxt("https://yamlover.inthemoon.net", SITES);
  assert.match(txt, /^Sitemap: https:\/\/yamlover\.inthemoon\.net\/docs\/sitemap\.xml$/m);
  assert.match(txt, /^Sitemap: https:\/\/yamlover\.inthemoon\.net\/examples\/sitemap\.xml$/m);
});

test("keeps visitor demos out — they are private, disposable instances sent by email", () => {
  assert.match(robotsTxt("https://h", SITES), /^Disallow: \/demo\/$/m);
});

// THE line nobody may add: the sites are SPAs whose text arrives from /api/content while the page
// renders, so a crawler blocked from it indexes an empty shell for every URL — the exact opposite
// of what adding a robots.txt is meant to achieve.
test("never disallows /api/, and carries the reason in the file", () => {
  const txt = robotsTxt("https://h", SITES);
  assert.doesNotMatch(txt, /Disallow:\s*\/api/i);
  assert.ok(txt.includes("/api/content"));
});

test("stays quiet about a disabled site rather than pointing at a sitemap that 404s", () => {
  const txt = robotsTxt("https://h", [{ basePath: "/docs" }]);
  assert.ok(txt.includes("/docs/sitemap.xml"));
  assert.ok(!txt.includes("/examples/"));
});

test("still answers with a usable policy when nothing is mounted", () => {
  const txt = robotsTxt("https://h", []);
  assert.ok(txt.includes("User-agent: *"));
  assert.ok(!txt.includes("Sitemap:"));
});

test("trusts the proxy's scheme — TLS terminates in front of this process", () => {
  assert.equal(
    originOf({ headers: { "x-forwarded-proto": "https", host: "yamlover.inthemoon.net" } }),
    "https://yamlover.inthemoon.net",
  );
});

test("takes the FIRST value when a header was appended to through a chain of proxies", () => {
  const req = { headers: { "x-forwarded-proto": "https, http", "x-forwarded-host": "a.example, b" } };
  assert.equal(originOf(req), "https://a.example");
});

test("prefers the forwarded host over the one the last hop set", () => {
  const req = { headers: { "x-forwarded-host": "public.example", host: "127.0.0.1:8080" } };
  assert.equal(originOf(req), "https://public.example");
});

test("assumes https with no forwarded scheme — this front door is only ever served over TLS", () => {
  assert.equal(originOf({ headers: { host: "h" } }), "https://h");
});
