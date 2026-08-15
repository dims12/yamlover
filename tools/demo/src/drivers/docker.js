// Production driver: each demo is a Docker container running the yamlover image with
// examples/ baked in. `--rm` makes cleanup automatic — stopping the container discards
// its writable layer (including yamlover's index), so there are no host temp dirs to
// reap. Containers are labeled so list() can find them after a demo-server restart
// (their id + published port are stable, so a survivor is adopted, not restarted).

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config, basePathFor, ga4EnvFor, GA4_DEMO_PATH } from "../config.js";
import { log, captureLines } from "../log.js";

const run = promisify(execFile);
const containerName = (hash) => `yld-${hash}`;

/** The host port a container publishes 5173 on, or null if it publishes none. */
async function publishedPort(idOrName) {
  const { stdout } = await run("docker", ["port", idOrName, "5173"]).catch(() => ({ stdout: "" }));
  const m = stdout.match(/:(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

// --- container log capture ------------------------------------------------- //
// Containers are detached and `--rm`, so their stdout goes to the daemon's json-file log and
// is deleted with the container. `docker logs -f` relays it into ours while it lives, which
// keeps one pipeline for the whole system: the demo server, its children and the
// always-on sites all end up in the same journal, and the Ops Agent ships them together.
//
// IDEMPOTENT AND KEYED BY CONTAINER ID, because the call sites include the adoption paths —
// a demo server restart leaves containers running, and they must pick their followers back
// up without spawning a second one for a container already being followed.

const followers = new Map(); // container id -> the `docker logs -f` child

function follow(id, bindings) {
  if (!config.logInstances || followers.has(id)) return;
  const child = spawn("docker", ["logs", "-f", id], { stdio: ["ignore", "pipe", "pipe"] });
  const logger = log.child(bindings);
  captureLines(child.stdout, logger, "info");
  captureLines(child.stderr, logger, "warn");
  child.on("error", (e) => log.warn("cannot follow container logs", { err: e, ...bindings }));
  // The follower ends by itself when the container is removed — no cleanup needed for the
  // common case, only for a container we stop deliberately.
  child.once("exit", () => followers.delete(id));
  followers.set(id, child);
}

function unfollow(id) {
  const child = followers.get(id);
  followers.delete(id);
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
}

/** `-e NAME=value` arguments for `docker run`, from an env object. */
const envArgs = (env) => Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

/** One always-on read-only container (docs or examples). Label is never `yamlover-demo=1`,
 *  so the reaper cannot touch it. `image` / `basePath` are functions so a refresh reads
 *  the current config after a pull. */
function makeAlwaysOn({ name, label, image, basePath, component }) {
  let followedId = null;
  return {
    async prepare() {
      if (!config.dockerPull) return;
      const img = image();
      try {
        await run("docker", ["pull", img]);
      } catch (e) {
        log.warn(`${component} image pull failed, using local copy`, { err: e, image: img });
      }
    },
    async status() {
      const { stdout } = await run("docker", [
        "ps",
        "--no-trunc",
        "--filter",
        `label=${label}`,
        "--format",
        "{{.ID}}",
      ]);
      const id = stdout.trim().split("\n").filter(Boolean)[0];
      if (!id) return null;
      const img = image();
      const [port, running, wanted] = await Promise.all([
        publishedPort(id),
        run("docker", ["inspect", "-f", "{{.Image}}", id]).then((r) => r.stdout.trim()),
        run("docker", ["image", "inspect", "-f", "{{.Id}}", img])
          .then((r) => r.stdout.trim())
          .catch(() => null), // image not present locally (pull failed) → nothing to compare against
      ]);
      // Adoption path: this container may predate us, in which case start() never ran and
      // this is the only place that learns its id.
      follow(id, { component });
      followedId = id;
      return { id, port, stale: wanted != null && running !== wanted };
    },
    async start() {
      // Clear any leftover of the same name (a stopped-but-not-removed or stale container)
      // so the run below cannot fail on a name collision.
      await run("docker", ["rm", "-f", name]).catch(() => {});
      const bp = basePath();
      const { stdout } = await run("docker", [
        "run",
        "-d",
        "--rm",
        "--init",
        "--label",
        label, // deliberately NOT yamlover-demo=1: the reaper must never touch this
        "--name",
        name,
        "--memory",
        config.dockerMemory,
        "--cpus",
        config.dockerCpus,
        "-e",
        `BASE_PATH=${bp}`,
        // Not collapsed, unlike a demo: this is published content, so which node a visitor
        // reaches is exactly the thing worth measuring, and its URL gives nothing away.
        ...envArgs(ga4EnvFor(bp)),
        "-p",
        "127.0.0.1::5173",
        image(),
      ]);
      const id = stdout.trim();
      const port = await publishedPort(name);
      if (!port) {
        await run("docker", ["rm", "-f", name]).catch(() => {});
        throw new Error(`could not read docker port mapping for the ${component} container`);
      }
      follow(id, { component });
      followedId = id;
      return { id, port };
    },
    async stop() {
      if (followedId) unfollow(followedId);
      followedId = null;
      await run("docker", ["rm", "-f", name]).catch(() => {}); // --rm tears it down
    },
  };
}

const docsSite = makeAlwaysOn({
  name: "yld-docs",
  label: "yamlover-docs=1",
  image: () => config.docsImage,
  basePath: () => config.docsBasePath,
  component: "docs",
});

const examplesSite = makeAlwaysOn({
  name: "yld-examples",
  label: "yamlover-examples=1",
  image: () => config.examplesSiteImage,
  basePath: () => config.examplesSiteBasePath,
  component: "examples",
});

export const dockerDriver = {
  name: "docker",

  // Pull the image once at boot so a moving tag (e.g. `:latest`, pushed by CI) is refreshed
  // on every restart — otherwise `docker run` keeps using the first cached copy forever.
  // Best-effort: a failed pull (offline, private repo without login, locally-built tag) is a
  // warning, not fatal — `run()` below will still use whatever copy is cached locally.
  async prepare() {
    // Containers that outlived the last demo server are adopted, so their output has to be
    // picked back up here or it would be lost for the rest of their lifetime.
    for (const inst of await this.list().catch(() => [])) {
      follow(inst.id, { component: "instance", hash: inst.hash });
    }
    if (!config.dockerPull) return;
    try {
      await run("docker", ["pull", config.dockerImage]);
      log.info("demo image pulled", { image: config.dockerImage });
    } catch (e) {
      log.warn("demo image pull failed, using local copy", { err: e, image: config.dockerImage });
    }
  },

  // Same rationale as prepare(), for the always-on images. Separate so each refresh timer
  // can re-pull on its own cadence without disturbing the demo image.
  prepareDocs: () => docsSite.prepare(),
  docsStatus: () => docsSite.status(),
  startDocs: () => docsSite.start(),
  stopDocs: () => docsSite.stop(),

  prepareExamples: () => examplesSite.prepare(),
  examplesStatus: () => examplesSite.status(),
  startExamples: () => examplesSite.start(),
  stopExamples: () => examplesSite.stop(),

  async start(hash) {
    const name = containerName(hash);
    const { stdout } = await run("docker", [
      "run",
      "-d",
      "--rm",
      "--init", // tini as PID 1: forwards SIGTERM to node (PID 1 would otherwise ignore it) so
      //          `docker stop` is fast, and reaps zombies
      "--label",
      "yamlover-demo=1",
      "--label",
      `demohash=${hash}`,
      "--name",
      name,
      "--memory",
      config.dockerMemory,
      "--cpus",
      config.dockerCpus,
      "-e",
      `BASE_PATH=${basePathFor(hash)}`,
      ...envArgs(ga4EnvFor(GA4_DEMO_PATH, { collapse: true })),
      "-p",
      "127.0.0.1::5173", // publish the container's 5173 to an OS-assigned loopback port
      config.dockerImage,
    ]);
    const id = stdout.trim(); // full 64-char container id

    const port = await publishedPort(name); // the OS-assigned loopback port (e.g. 49153)
    if (!port) {
      await this.stop(id).catch(() => {});
      throw new Error("could not read docker port mapping");
    }
    follow(id, { component: "instance", hash });
    log.info("instance started", { hash, port, container: id.slice(0, 12) });
    return { id, port };
  },

  async stop(id) {
    unfollow(id);
    await run("docker", ["stop", id]).catch(() => {}); // --rm tears it down
  },

  async list() {
    const { stdout } = await run("docker", [
      "ps",
      "--no-trunc", // full ids, to match the `docker run` output
      "--filter",
      "label=yamlover-demo=1",
      "--format",
      '{{.ID}} {{.Label "demohash"}}',
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, hash] = line.split(/\s+/);
        return { id, hash };
      });
  },

  // Leave containers running on graceful shutdown: they survive a demo-server restart
  // and are adopted by reconcile() (their id + published port are stable). Only the log
  // followers go — they are ours, not theirs, and prepare() re-attaches on the way back up.
  async shutdown() {
    for (const id of [...followers.keys()]) unfollow(id);
  },
};
