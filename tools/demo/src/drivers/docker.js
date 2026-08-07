// Production driver: each demo is a Docker container running the yamlover image with
// examples/ baked in. `--rm` makes cleanup automatic — stopping the container discards
// its writable layer (including yamlover's index), so there are no host temp dirs to
// reap. Containers are labeled so list() can find them after a demo-server restart
// (their id + published port are stable, so a survivor is adopted, not restarted).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, basePathFor } from "../config.js";

const run = promisify(execFile);
const containerName = (hash) => `yld-${hash}`;
const DOCS_NAME = "yld-docs"; // the single always-on docs container

/** The host port a container publishes 5173 on, or null if it publishes none. */
async function publishedPort(idOrName) {
  const { stdout } = await run("docker", ["port", idOrName, "5173"]).catch(() => ({ stdout: "" }));
  const m = stdout.match(/:(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

export const dockerDriver = {
  name: "docker",

  // Pull the image once at boot so a moving tag (e.g. `:latest`, pushed by CI) is refreshed
  // on every restart — otherwise `docker run` keeps using the first cached copy forever.
  // Best-effort: a failed pull (offline, private repo without login, locally-built tag) is a
  // warning, not fatal — `run()` below will still use whatever copy is cached locally.
  async prepare() {
    if (!config.dockerPull) return;
    try {
      await run("docker", ["pull", config.dockerImage]);
      console.log(`               image  ${config.dockerImage} (pulled)`);
    } catch (e) {
      console.warn(`               image  ${config.dockerImage} — pull failed, using local copy: ${e.message}`);
    }
  },

  // Same rationale as prepare(), for the docs image. Separate so the docs refresh timer can
  // re-pull it on its own cadence without disturbing the demo image.
  async prepareDocs() {
    if (!config.dockerPull) return;
    try {
      await run("docker", ["pull", config.docsImage]);
    } catch (e) {
      console.warn(`               docs image ${config.docsImage} — pull failed, using local copy: ${e.message}`);
    }
  },

  /** The live docs container, if any: `{ id, port, stale }`. `stale` means it is running an
   *  image other than the one `${config.docsImage}` now resolves to — i.e. CI pushed a new
   *  build and the last `docker pull` fetched it, so the container should be recreated.
   *  Compares image IDs, not tags: a moving tag like `:latest` never changes name. */
  async docsStatus() {
    const { stdout } = await run("docker", [
      "ps",
      "--no-trunc",
      "--filter",
      "label=yamlover-docs=1",
      "--format",
      "{{.ID}}",
    ]);
    const id = stdout.trim().split("\n").filter(Boolean)[0];
    if (!id) return null;
    const [port, running, wanted] = await Promise.all([
      publishedPort(id),
      run("docker", ["inspect", "-f", "{{.Image}}", id]).then((r) => r.stdout.trim()),
      run("docker", ["image", "inspect", "-f", "{{.Id}}", config.docsImage])
        .then((r) => r.stdout.trim())
        .catch(() => null), // image not present locally (pull failed) → nothing to compare against
    ]);
    return { id, port, stale: wanted != null && running !== wanted };
  },

  async startDocs() {
    // Clear any leftover of the same name (a stopped-but-not-removed or stale container)
    // so the run below cannot fail on a name collision.
    await run("docker", ["rm", "-f", DOCS_NAME]).catch(() => {});
    const { stdout } = await run("docker", [
      "run",
      "-d",
      "--rm",
      "--init",
      "--label",
      "yamlover-docs=1", // deliberately NOT yamlover-demo=1: the reaper must never touch this
      "--name",
      DOCS_NAME,
      "--memory",
      config.dockerMemory,
      "--cpus",
      config.dockerCpus,
      "-e",
      `BASE_PATH=${config.docsBasePath}`,
      "-p",
      "127.0.0.1::5173",
      config.docsImage,
    ]);
    const id = stdout.trim();
    const port = await publishedPort(DOCS_NAME);
    if (!port) {
      await run("docker", ["rm", "-f", DOCS_NAME]).catch(() => {});
      throw new Error("could not read docker port mapping for the docs container");
    }
    return { id, port };
  },

  async stopDocs() {
    await run("docker", ["rm", "-f", DOCS_NAME]).catch(() => {}); // --rm tears it down
  },

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
    return { id, port };
  },

  async stop(id) {
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
  // and are adopted by reconcile() (their id + published port are stable).
  async shutdown() {},
};
