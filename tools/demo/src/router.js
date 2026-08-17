// The demo server's HTTP router. Four concerns:
//   • registration   — GET / (the email form, plus the brand files it links to) and
//                       POST /register (mint hash + email link)
//   • demo proxying   — GET|* /demo/<hash>/... → provision-on-first-hit then reverse-proxy
//   • docs proxying   — GET|* /docs/... → the always-on read-only docs instance
//   • examples proxying — GET|* /examples/... → the always-on read-only examples instance
// Anything else 404s. Friendly status pages for unknown/expired/at-capacity links.

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, linkFor } from "./config.js";
import { log } from "./log.js";
import { ga4Tag } from "./ga4.js";
import { isHash, newHash } from "./hash.js";
import { proxy } from "./proxy.js";
import { ProvisionError } from "./provision.js";
import { sendDemoLink } from "./email.js";
import { readBody, sendJson, sendPage, isEmail, clientIp } from "./http-util.js";
import { robotsTxt, originOf } from "./robots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const DEMO_RE = /^\/demo\/([^/]+)(\/.*)?$/;

// The brand files the registration page links to. A bare `/<name>.<ext>` at the root, no
// slashes and no dot segments — so `..` cannot appear and containment needs no second check.
// register.html is deliberately unreachable through this: it is a template the handler below
// fills in, not a file to hand out raw.
const ASSET_RE = /^\/[A-Za-z0-9_-]+\.(svg|png|ico)$/;
const ASSET_MIME = { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon" };

/** Pure URL parse: a `/demo/<hash>[/...]` request → {hash, rest}, else null. Tested directly. */
export function parseDemoPath(pathname) {
  const m = pathname.match(DEMO_RE);
  if (!m) return null;
  return { hash: decodeURIComponent(m[1]), rest: m[2] ?? null };
}

/** Is this request for an always-on site (`/docs`, `/examples`, …)? Pure; tested directly. */
export function isSitePath(pathname, base) {
  return Boolean(base) && (pathname === base || pathname.startsWith(base + "/"));
}

/** Is this request for the always-on docs instance (`/docs`, `/docs/…`)? */
export function isDocsPath(pathname, base = config.docsBasePath) {
  return isSitePath(pathname, base);
}

/** Is this request for the always-on examples instance (`/examples`, `/examples/…`)? */
export function isExamplesPath(pathname, base = config.examplesSiteBasePath) {
  return isSitePath(pathname, base);
}

/** Reverse-proxy one always-on site. Returns true if the request was handled. */
async function proxySite(req, res, pathname, site, { enabled, basePath, kind, title, body }) {
  if (!site || !enabled || !isSitePath(pathname, basePath)) return false;
  if (pathname === basePath) {
    res.writeHead(301, { Location: basePath + "/" }); // canonical trailing slash
    res.end();
    return true;
  }
  let port;
  try {
    // Cheap when the instance is already up; starts (or restarts) it otherwise, so a
    // container that died between requests self-heals on the next hit.
    port = await site.ensure();
  } catch (e) {
    log.error(`${kind} unavailable`, { err: e });
    sendPage(res, 502, title, body);
    return true;
  }
  proxy(req, res, port, () => site.invalidate());
  return true;
}

export function makeRouter({ store, provision, rateLimit, docs, examples }) {
  return async function route(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");

    if (
      await proxySite(req, res, pathname, docs, {
        enabled: config.docsEnabled,
        basePath: config.docsBasePath,
        kind: "docs",
        title: "Docs unavailable",
        body: "The documentation is starting up. Please retry in a moment.",
      })
    ) {
      return;
    }

    if (
      await proxySite(req, res, pathname, examples, {
        enabled: config.examplesSiteEnabled,
        basePath: config.examplesSiteBasePath,
        kind: "examples",
        title: "Examples unavailable",
        body: "The examples are starting up. Please retry in a moment.",
      })
    ) {
      return;
    }

    // --- demo links --------------------------------------------------------- //
    const demo = parseDemoPath(pathname);
    if (demo) {
      if (!isHash(demo.hash)) return sendPage(res, 404, "Unknown demo", "That demo link is not valid.");
      if (!demo.rest) {
        res.writeHead(301, { Location: `/demo/${demo.hash}/` }); // canonical trailing slash
        return res.end();
      }
      try {
        const port = await provision(demo.hash);
        store.touch(demo.hash);
        return proxy(req, res, port);
      } catch (e) {
        if (e instanceof ProvisionError) return demoError(res, e);
        throw e;
      }
    }

    // --- registration ------------------------------------------------------- //
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      let html = await readFile(join(publicDir, "register.html"), "utf-8").catch(() => "<h1>yamlover demo</h1>");
      // Hand the (public) Turnstile site key to the page; empty string → captcha disabled.
      // The analytics tag rides along on the same substitution — both are deployment
      // posture, so the checked-in HTML stays free of keys and of any third party.
      html = html.replace(
        "</head>",
        `<script>window.__TURNSTILE_SITEKEY__=${JSON.stringify(config.turnstileSiteKey)}</script>` +
          ga4Tag(config.ga4MeasurementId) +
          "</head>",
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "GET" && ASSET_RE.test(pathname)) {
      const bytes = await readFile(join(publicDir, pathname.slice(1))).catch(() => null);
      if (bytes) {
        const ext = pathname.slice(pathname.lastIndexOf(".") + 1);
        res.writeHead(200, {
          "Content-Type": ASSET_MIME[ext],
          "Cache-Control": "public, max-age=3600",
        });
        return res.end(bytes);
      }
    }
    if (req.method === "POST" && pathname === "/register") {
      return register(req, res, { store, rateLimit });
    }
    // The origin's crawl policy. Answered here and not by the mounted sites: a crawler reads
    // `/robots.txt` and nothing else, so `/docs/robots.txt` governs nobody (robots.js).
    if (req.method === "GET" && pathname === "/robots.txt") {
      const sites = [
        config.docsEnabled ? { basePath: config.docsBasePath } : null,
        config.examplesSiteEnabled ? { basePath: config.examplesSiteBasePath } : null,
      ].filter(Boolean);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      return res.end(robotsTxt(originOf(req), sites));
    }
    if (req.method === "GET" && pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    return sendPage(res, 404, "Not found", "Nothing here.");
  };
}

function demoError(res, e) {
  if (e.status === 410) return sendPage(res, 410, "Demo expired", "This demo has expired — request a fresh one.");
  if (e.status === 404) return sendPage(res, 404, "Unknown demo", "That demo link is not valid.");
  if (e.status === 503) return sendPage(res, 503, "At capacity", "All demo slots are busy right now. Please try again in a few minutes.");
  return sendPage(res, 502, "Demo unavailable", "The demo failed to start. Please request a new one.");
}

async function register(req, res, { store, rateLimit }) {
  const ip = clientIp(req);
  if (!rateLimit.allow(ip)) {
    return sendJson(res, 429, { error: "Too many requests. Please try again later." });
  }
  let body;
  try {
    body = await readBody(req, 8192); // room for the Turnstile token alongside the email
  } catch {
    return sendJson(res, 413, { error: "Request too large." });
  }
  let email = "";
  let token = "";
  if ((req.headers["content-type"] || "").includes("application/json")) {
    try {
      const o = JSON.parse(body);
      email = (o.email || "").trim();
      token = o.token || o["cf-turnstile-response"] || "";
    } catch {
      /* fall through to validation */
    }
  } else {
    const p = new URLSearchParams(body);
    email = (p.get("email") || "").trim();
    token = p.get("cf-turnstile-response") || "";
  }
  if (!isEmail(email)) return sendJson(res, 400, { error: "Please enter a valid email address." });

  // Captcha (only enforced when a secret is configured).
  if (config.turnstileSecret && !(await verifyTurnstile(token, ip))) {
    return sendJson(res, 403, { error: "Captcha check failed. Please try again." });
  }

  // Dedupe: an existing pending/running demo for this email reuses its link — one email,
  // one live demo, so re-submitting can't spin up extra instances.
  const existing = store.getActiveByEmail(email);
  // Global daily cap on NEW demos — bounds how many emails we can fire through Resend
  // (and how many instances we can spawn) regardless of source IP.
  if (!existing && store.countCreatedSince(Date.now() - 86_400_000) >= config.registerPerDay) {
    return sendJson(res, 429, { error: "The daily demo limit has been reached. Please try again tomorrow." });
  }
  const hash = existing ? existing.hash : newHash();
  if (!existing) store.insert({ hash, email, created_at: Date.now(), state: "pending" });

  try {
    await sendDemoLink(email, linkFor(hash));
  } catch (e) {
    // No `email` field: the address is the visitor's, and a failed send is diagnosable
    // from the hash (which the store maps back to it) without copying it into the logs.
    log.error("email send failed", { err: e, hash, provider: config.emailProvider });
    return sendJson(res, 502, { error: "Could not send the email. Please try again." });
  }
  log.info(existing ? "demo link resent" : "demo registered", { hash });
  return sendJson(res, 200, { ok: true, message: "Check your email for your demo link." });
}

/** Verify a Cloudflare Turnstile token server-side. Fail-closed on any error/empty token. */
async function verifyTurnstile(token, ip) {
  if (!token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: config.turnstileSecret, response: token, remoteip: ip }),
    });
    const d = await r.json().catch(() => ({}));
    return d.success === true;
  } catch {
    return false;
  }
}
