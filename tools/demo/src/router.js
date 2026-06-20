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
      const html = await readFile(join(publicDir, "register.html"), "utf-8").catch(() => "<h1>yamlover demo</h1>");
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
  if (!rateLimit.allow(clientIp(req))) {
    return sendJson(res, 429, { error: "Too many requests. Please try again later." });
  }
  let body;
  try {
    body = await readBody(req, 4096);
  } catch {
    return sendJson(res, 413, { error: "Request too large." });
  }
  let email = "";
  if ((req.headers["content-type"] || "").includes("application/json")) {
    try {
      email = (JSON.parse(body).email || "").trim();
    } catch {
      /* fall through to validation */
    }
  } else {
    email = (new URLSearchParams(body).get("email") || "").trim();
  }
  if (!isEmail(email)) return sendJson(res, 400, { error: "Please enter a valid email address." });

  // Dedupe: an existing pending/running demo for this email reuses its link — one email,
  // one live demo, so re-submitting can't spin up extra instances.
  const existing = store.getActiveByEmail(email);
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
