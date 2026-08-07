// Wait for a freshly started yamlover instance to answer on loopback: poll its own
// `/api/info` (under whatever base path it was launched with) until it returns 200.
// Shared by the per-visitor demos and the always-on docs instance.

import http from "node:http";

export async function waitForReady(port, basePath, timeoutMs = 30_000) {
  const url = `http://127.0.0.1:${port}${basePath}/api/info`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const r = http.get(url, (resp) => {
        resp.resume();
        resolve(resp.statusCode === 200);
      });
      r.on("error", () => resolve(false));
      r.setTimeout(2000, () => {
        r.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`instance on port ${port} did not become ready`);
}
