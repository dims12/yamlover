// The demo server's HTTP router. Two concerns:
//   • registration   — GET / (the email form) and POST /register (mint hash + email link)
//   • demo proxying   — GET|* /demo/<hash>/... → provision-on-first-hit then reverse-proxy
// Anything else 404s. Friendly status pages for unknown/expired/at-capacity links.

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, linkFor } from "./config.js";
import { isHash, newHash } from "./hash.js";
import { proxy } from "./proxy.js";
import { ProvisionError } from "./provision.js";
import { sendDemoLink } from "./email.js";
import { readBody, sendJson, sendPage, isEmail, clientIp } from "./http-util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const DEMO_RE = /^\/demo\/([^/]+)(\/.*)?$/;

/** Pure URL parse: a `/demo/<hash>[/...]` request → {hash, rest}, else null. Tested directly. */
export function parseDemoPath(pathname) {
  const m = pathname.match(DEMO_RE);
  if (!m) return null;
  return { hash: decodeURIComponent(m[1]), rest: m[2] ?? null };
}

export function makeRouter({ store, provision, rateLimit }) {
  return async function route(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");

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
      html = html.replace(
        "</head>",
        `<script>window.__TURNSTILE_SITEKEY__=${JSON.stringify(config.turnstileSiteKey)}</script></head>`,
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "POST" && pathname === "/register") {
      return register(req, res, { store, rateLimit });
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
    console.error("email send failed:", e.message);
    return sendJson(res, 502, { error: "Could not send the email. Please try again." });
  }
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
