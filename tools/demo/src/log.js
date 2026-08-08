// Structured logging. One JSON object per line on stdout/stderr, in the shape Google Cloud
// Logging understands once the Ops Agent has parsed it (see deploy/ops-agent-config.yaml):
// `severity` and `message` are lifted into the LogEntry, everything else stays queryable
// under jsonPayload.
//
// NOTHING IS SHIPPED FROM HERE. The process only writes to its own stdout; systemd puts
// that in the journal and the Ops Agent already on the box forwards it. That is what keeps
// this package at zero npm dependencies, keeps `journalctl --user -u yamlover-demo`
// working unchanged, and means a logging outage can never block a request.
//
// LOG_FORMAT=text prints the same records as a readable line instead. The default follows
// the TTY, so an interactive dev run stays legible and a service run (no TTY) emits JSON.

const LEVELS = { debug: 100, info: 200, notice: 300, warning: 400, error: 500, critical: 600 };

const env = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
};

const format = env("LOG_FORMAT", process.stdout.isTTY ? "text" : "json");
const threshold = LEVELS[env("LOG_LEVEL", "info").toLowerCase()] ?? LEVELS.info;

/** Errors don't survive JSON.stringify (message and stack are non-enumerable) — unpack any
 *  `err`/`error` value into flat fields so a failure is readable in the Logs Explorer. */
function normalize(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined) continue;
    if ((k === "err" || k === "error") && v instanceof Error) {
      out.error = v.message;
      if (v.stack) out.stack = v.stack;
    } else {
      out[k] = v;
    }
  }
  return out;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

function write(severity, message, fields) {
  if (LEVELS[severity.toLowerCase()] < threshold) return;
  const now = new Date();
  // Warnings and worse go to stderr so they keep their journal priority even if the JSON
  // is never parsed (and so a plain `node bin/demo-server.js 2>err.log` still separates them).
  const stream = LEVELS[severity.toLowerCase()] >= LEVELS.warning ? process.stderr : process.stdout;
  if (format === "json") {
    stream.write(JSON.stringify({ severity, message, time: now.toISOString(), ...fields }) + "\n");
    return;
  }
  const rest = Object.entries(fields)
    .filter(([k]) => k !== "stack")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  stream.write(`${clock(now)} ${severity.padEnd(7)} ${message}${rest ? "  " + rest : ""}\n`);
  if (fields.stack) stream.write(fields.stack + "\n");
}

/** A logger whose `bindings` are merged into every record it writes (e.g. the demo hash). */
export function makeLog(bindings = {}) {
  const emit = (severity) => (message, fields) => write(severity, message, { ...bindings, ...normalize(fields) });
  return {
    debug: emit("DEBUG"),
    info: emit("INFO"),
    notice: emit("NOTICE"),
    warn: emit("WARNING"),
    error: emit("ERROR"),
    child: (extra) => makeLog({ ...bindings, ...normalize(extra) }),

    /** An HTTP exchange. `logging.googleapis.com/httpRequest` is a special key the agent
     *  lifts into the LogEntry's own httpRequest field, which is what makes method, status
     *  and latency render as a request (and stay filterable) in the Logs Explorer. */
    request({ method, url, status, latencyMs, ip, userAgent, referer, ...fields }) {
      const severity = status >= 500 ? "ERROR" : status >= 400 ? "WARNING" : "INFO";
      const http = {
        requestMethod: method,
        requestUrl: url,
        status,
        latency: `${(latencyMs / 1000).toFixed(3)}s`,
        remoteIp: ip,
        userAgent,
        referer,
      };
      for (const k of Object.keys(http)) if (http[k] === undefined) delete http[k];
      write(severity, `${method} ${url} ${status}`, {
        ...bindings,
        ...normalize(fields),
        ...(format === "json" ? { "logging.googleapis.com/httpRequest": http } : { ms: Math.round(latencyMs) }),
      });
    },
  };
}

export const log = makeLog();

/** Re-emit a child process's output line by line through `logger`, so a spawned yamlover
 *  instance lands in the same stream as everything else instead of being discarded. The
 *  child's own stdout is plain text, so each line becomes the `message` of one record and
 *  the logger's bindings (component, hash, …) say which instance it came from. */
export function captureLines(stream, logger, severity = "info") {
  let buf = "";
  stream.setEncoding("utf-8");
  stream.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // the trailing partial line waits for the next chunk
    for (const line of lines) {
      const text = line.trimEnd();
      if (text) logger[severity](text);
    }
  });
  stream.on("end", () => {
    const text = buf.trim();
    if (text) logger[severity](text);
    buf = "";
  });
}
