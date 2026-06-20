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

export const dockerDriver = {
  name: "docker",

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

    // Read the published host port (e.g. "127.0.0.1:49153").
    const { stdout: portOut } = await run("docker", ["port", name, "5173"]);
    const m = portOut.match(/:(\d+)\s*$/m);
    if (!m) {
      await this.stop(id).catch(() => {});
      throw new Error("could not read docker port mapping");
    }
    return { id, port: Number(m[1]) };
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
