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

export const config = {
  host: str("HOST", "127.0.0.1"), // behind Caddy in prod; localhost is the safe default
  port,
  // Public origin the emailed links point at (no trailing slash). MUST be set in prod.
  baseUrl: str("DEMO_BASE_URL", `http://localhost:${port}`).replace(/\/+$/, ""),

  driver: str("DEMO_DRIVER", "process"), // "docker" (prod) | "process" (local dev)

  ttlDays: num("TTL_DAYS", 3), // hard lifetime of a provisioned demo
  idleHours: str("IDLE_HOURS", null) == null ? null : num("IDLE_HOURS", null), // optional idle reclaim
  maxDemos: int("MAX_DEMOS", 50), // global concurrent-running cap
  reapIntervalMs: int("REAP_INTERVAL_MS", 30 * 60 * 1000),

  dbPath: str("DB_PATH", resolve(repoRoot, "tools/demo/.data/demos.db")),

  // email
  emailProvider: str("EMAIL_PROVIDER", "console"), // "console" (dev) | "resend" (prod)
  emailFrom: str("EMAIL_FROM", "yamlover demo <onboarding@resend.dev>"),
  resendApiKey: str("RESEND_API_KEY", ""),

  // abuse limits
  registerPerHour: int("REGISTER_PER_HOUR", 3), // per-IP registration token bucket

  // process driver (local dev)
  examplesDir: str("EXAMPLES_DIR", resolve(repoRoot, "examples")),
  yamloverBin: str("YAMLOVER_BIN", resolve(repoRoot, "tools/server/bin/yamlover.js")),
  spoolDir: str("SPOOL_DIR", resolve(repoRoot, "tools/demo/.data/spool")),

  // docker driver (production)
  dockerImage: str("DEMO_IMAGE", "yamlover-demo"),
  dockerMemory: str("DOCKER_MEMORY", "512m"),
  dockerCpus: str("DOCKER_CPUS", "1"),

  repoRoot,
};

/** The base-path a yamlover instance for `hash` is served under (no trailing slash). */
export const basePathFor = (hash) => `/demo/${hash}`;

/** The public link emailed to a visitor for `hash` (trailing slash → SPA shell). */
export const linkFor = (hash) => `${config.baseUrl}/demo/${hash}/`;
