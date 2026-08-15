// Runtime configuration for the demo server, read entirely from the environment so
// the same code runs locally (process driver, console email) and in production
// (docker driver, Resend email) with only env changes. See README.md for the full list.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../.."); // tools/demo/src → repo root

const str = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
};
const int = (name, def) => {
  const v = str(name, null);
  return v == null ? def : parseInt(v, 10);
};
const num = (name, def) => {
  const v = str(name, null);
  return v == null ? def : Number(v);
};

const port = int("PORT", 8080);

/** Normalize a URL prefix: leading `/`, no trailing `/` (matches yamlover's own `--base-path`). */
const normBase = (s) => {
  let b = (s ?? "").trim();
  if (b === "" || b === "/") return "";
  if (!b.startsWith("/")) b = "/" + b;
  return b.endsWith("/") ? b.slice(0, -1) : b;
};

const reapIntervalMs = int("REAP_INTERVAL_MS", 30 * 60 * 1000);

export const config = {
  host: str("HOST", "127.0.0.1"), // behind Caddy in prod; localhost is the safe default
  port,
  // Public origin the emailed links point at (no trailing slash). MUST be set in prod.
  baseUrl: str("DEMO_BASE_URL", `http://localhost:${port}`).replace(/\/+$/, ""),

  driver: str("DEMO_DRIVER", "process"), // "docker" (prod) | "process" (local dev)

  ttlDays: num("TTL_DAYS", 3), // hard lifetime of a provisioned demo
  idleHours: str("IDLE_HOURS", null) == null ? null : num("IDLE_HOURS", null), // optional idle reclaim
  maxDemos: int("MAX_DEMOS", 50), // global concurrent-running cap
  reapIntervalMs,

  dbPath: str("DB_PATH", resolve(repoRoot, "tools/demo/.data/demos.db")),

  // email
  emailProvider: str("EMAIL_PROVIDER", "console"), // "console" (dev) | "resend" (prod)
  emailFrom: str("EMAIL_FROM", "yamlover demo <noreply@yamlover.inthemoon.net>"),
  resendApiKey: str("RESEND_API_KEY", ""),

  // abuse limits
  registerPerHour: int("REGISTER_PER_HOUR", 3), // per-IP registration token bucket
  registerPerDay: int("REGISTER_PER_DAY", 200), // global/day cap on NEW demos — Resend blast-radius guard

  // captcha (Cloudflare Turnstile). Both unset → captcha disabled (form works without it).
  turnstileSiteKey: str("TURNSTILE_SITE_KEY", ""), // public, embedded in the page
  turnstileSecret: str("TURNSTILE_SECRET", ""), // private, server-side siteverify

  // --- observability ---
  // Which proxied exchanges reach the log. Every SPA asset and every SSE poll passes through
  // here, so "all" is a firehose that Cloud Logging bills by the byte — the default keeps the
  // failures (4xx/5xx) that actually need a trace and lets GA4 answer the traffic questions.
  logHttp: str("LOG_HTTP", "errors"), // "errors" | "all" | "off"
  logInstances: str("LOG_INSTANCES", "1") !== "0", // relay each yamlover child's own output

  // --- analytics (Google Analytics 4) ---
  // Unset → no analytics anywhere: nothing is injected into the landing page and the children
  // are spawned without the variable, so a self-hosted or `npx yamlover` instance stays silent.
  ga4MeasurementId: str("GA4_MEASUREMENT_ID", ""), // public, embedded in the page (G-XXXXXXXXXX)

  // --- the always-on docs instance (one read-only yamlover serving docs/, not a demo) ---
  docsEnabled: str("DOCS_ENABLED", "1") !== "0",
  docsBasePath: normBase(str("DOCS_BASE_PATH", "/docs")), // URL prefix it is served under
  docsImage: str("DOCS_IMAGE", "dimskraft/yamlover-docs:latest"), // published on Docker Hub by CI
  // How often to re-pull the docs image and recreate the container if the tag moved. This is
  // what makes a docs edit go live: CI pushes a new :latest, and the next check picks it up
  // with no redeploy. Shares the reaper's cadence by default.
  docsRefreshMs: int("DOCS_REFRESH_MS", reapIntervalMs),
  docsDir: str("DOCS_DIR", resolve(repoRoot, "docs")), // process-driver content (served in place)

  // --- the always-on examples instance (twin of docs: read-only, not a visitor demo) ---
  // EXAMPLES_DIR below is the process-driver *content* for writable demos; these SITE_*
  // knobs are the public /examples showcase and must not collide with that name.
  examplesSiteEnabled: str("EXAMPLES_SITE_ENABLED", "1") !== "0",
  examplesSiteBasePath: normBase(str("EXAMPLES_SITE_BASE_PATH", "/examples")),
  examplesSiteImage: str("EXAMPLES_SITE_IMAGE", "dimskraft/yamlover-examples:latest"),
  examplesSiteRefreshMs: int("EXAMPLES_SITE_REFRESH_MS", reapIntervalMs),

  // process driver (local dev)
  examplesDir: str("EXAMPLES_DIR", resolve(repoRoot, "examples")),
  yamloverBin: str("YAMLOVER_BIN", resolve(repoRoot, "tools/server/bin/yamlover.js")),
  spoolDir: str("SPOOL_DIR", resolve(repoRoot, "tools/demo/.data/spool")),

  // docker driver (production)
  dockerImage: str("DEMO_IMAGE", "dimskraft/yamlover-demo:latest"), // published on Docker Hub by CI
  dockerPull: str("DEMO_IMAGE_PULL", "1") !== "0", // `docker pull` on startup to refresh a moving tag
  dockerMemory: str("DOCKER_MEMORY", "512m"),
  dockerCpus: str("DOCKER_CPUS", "1"),

  repoRoot,
};

/** Project repo, linked from the demo page + emails. */
export const REPO_URL = "https://github.com/dims12/yamlover";

/** The base-path a yamlover instance for `hash` is served under (no trailing slash). */
export const basePathFor = (hash) => `/demo/${hash}`;

/** What a demo instance reports to analytics instead of its real path. A demo hash IS the
 *  credential for that instance — anyone holding the URL can open it — so it must not be
 *  copied into a third-party report. Every demo therefore aggregates under one page. */
export const GA4_DEMO_PATH = "/demo/<id>";

/** The analytics variables handed to a spawned yamlover instance (see tools/server/bin/ga4.js).
 *
 *  Empty when analytics is off, which is what keeps a child silent — and `GA4_PAGE_PATH` is
 *  always explicit when it is on, never left to the child's default. The child would default
 *  it to its own base path, and for a demo that base path is the secret we are hiding. */
export function ga4EnvFor(pagePath, { collapse = false } = {}) {
  if (!config.ga4MeasurementId) return {};
  return {
    GA4_MEASUREMENT_ID: config.ga4MeasurementId,
    GA4_PAGE_PATH: pagePath,
    GA4_COLLAPSE_PATH: collapse ? "1" : "0",
  };
}

/** The public link emailed to a visitor for `hash` (trailing slash → SPA shell). */
export const linkFor = (hash) => `${config.baseUrl}/demo/${hash}/`;
