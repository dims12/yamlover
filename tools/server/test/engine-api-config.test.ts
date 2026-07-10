import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// GET /api/config — the project config (IMPORTS.md). settings.yamlover is read through this endpoint
// for its parsed settings (the annotate flow's tags location). It is now EDITED through the ordinary
// yamlover data view + /api/edit (or directly on disk); the server reloads its in-memory Settings on
// ANY reindex that touches the file (`broadcast`), so there is no dedicated write endpoint.

describe("/api/config (project configuration)", () => {
  it("GET returns the source + parsed settings (uri, exports, locations)", async () => {
    const root = tmpTree({
      name: "Alice",
      ".yamlover/settings.yamlover": "uri: ::: yamlover.inthemoon.net\nexports:\n- *:: $defs\n- *:: tags\ntags: *:: taxonomy\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = call(h, "/api/config");
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(":.yamlover:settings.yamlover");
    expect(r.json.source).toContain("yamlover.inthemoon.net");
    expect(r.json.settings.uri).toBe("yamlover.inthemoon.net");
    expect(r.json.settings.exports).toEqual(["*:: $defs", "*:: tags"]);
    expect(r.json.settings.tags).toBe(":taxonomy");
    h.close();
  });

  it("GET on a project with no config file returns empty source + defaults", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = call(h, "/api/config");
    expect(r.status).toBe(200);
    expect(r.json.source).toBe("");
    expect(r.json.settings.exports).toEqual([]);
    expect(r.json.settings.tags).toBe(":tags"); // default
    h.close();
  });

  it("with { ensureSettings } a missing config file is materialized with defaults + becomes a fetchable node", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false, ensureSettings: true });
    await h.ready;
    // the file now exists on disk with the defaults template
    const onDisk = fs.readFileSync(path.join(root, ".yamlover", "settings.yamlover"), "utf8");
    expect(onDisk).toContain("!!<*yamlover:$defs:config>");
    // GET sees the materialized source + parsed defaults
    const cfg = call(h, "/api/config");
    expect(cfg.json.source).toContain("annotations: *:: annotations");
    expect(cfg.json.settings.tags).toBe(":tags");
    // and it is now a real, fetchable node (the gear's /api/json no longer 404s) with the config format
    const node = call(h, "/api/json", { path: ":.yamlover:settings.yamlover" });
    expect(node.status).toBe(200);
    expect(node.json.format).toBe("x-yamlover-config");
    h.close();
  });

  it("reloads in-memory settings when the config file is edited DIRECTLY on disk (watcher/reindex path)", async () => {
    const root = tmpTree({ name: "Alice", ".yamlover/settings.yamlover": "tags: *:: taxonomy\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect(call(h, "/api/config").json.settings.tags).toBe(":taxonomy");
    // a DIRECT disk edit (what the FS watcher would see), then a manual reconcile (the watcher's path)
    fs.writeFileSync(path.join(root, ".yamlover", "settings.yamlover"), "tags: *:: newloc\n");
    await callBody(h, "POST", "/api/reindex");
    expect(call(h, "/api/config").json.settings.tags).toBe(":newloc"); // reloaded, not stale
    h.close();
  });

  it("reloads settings when the config is edited through the generic /api/edit (a scalar value)", async () => {
    const root = tmpTree({ name: "Alice", ".yamlover/settings.yamlover": "sidecars: per-directory\ntags: *:: taxonomy\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect(call(h, "/api/config").json.settings.sidecars).toBe("per-directory");
    const w = await callBody(h, "POST", "/api/edit", { path: ":.yamlover:settings.yamlover:sidecars", op: "emplace", yamlover: "project" });
    expect(w.status).toBe(200);
    expect(call(h, "/api/config").json.settings.sidecars).toBe("project"); // reloaded via broadcast
    h.close();
  });
});
