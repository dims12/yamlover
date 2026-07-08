import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// GET/POST /api/config — the project config page (IMPORTS.md). settings.yamlover is engine-owned
// (not a graph node), so it is read/written through this dedicated pair, not the node pipeline.

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

  it("POST writes the source, reloads settings, and round-trips through GET", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const src = "uri: ::: acme.example\nannotations: *:: marks\n";
    const w = await callBody(h, "POST", "/api/config", { source: src });
    expect(w.status).toBe(200);
    expect(w.json.ok).toBe(true);
    expect(w.json.settings.uri).toBe("acme.example");
    expect(w.json.settings.annotations).toBe(":marks");
    // persisted on disk
    expect(fs.readFileSync(path.join(root, ".yamlover", "settings.yamlover"), "utf8")).toBe(src);
    // and visible on a fresh GET
    expect(call(h, "/api/config").json.settings.annotations).toBe(":marks");
    h.close();
  });

  it("POST rejects a config that does not parse, leaving the file untouched", async () => {
    const root = tmpTree({ name: "Alice", ".yamlover/settings.yamlover": "tags:\n  location: *tags\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/config", { source: "a: [1, 2" }); // unterminated flow seq
    expect(r.status).toBe(400);
    expect(r.json.error).toBeTruthy();
    // the previous file is intact
    expect(fs.readFileSync(path.join(root, ".yamlover", "settings.yamlover"), "utf8")).toBe("tags:\n  location: *tags\n");
    h.close();
  });
});
