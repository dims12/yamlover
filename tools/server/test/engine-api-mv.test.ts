// POST /api/mv — the engine-mediated move over HTTP: FS rename + inbound-ref rewriting,
// then a reindex whose diff rides on the response.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api.ts";
import { tmpTree } from "./helpers.js";
import { call, callBody } from "./http.js";

describe("POST /api/mv", () => {
  it("moves a file, rewrites the referrer on disk, and the node answers at the new path", async () => {
    const root = tmpTree({
      "old.md": "# doc",
      "refs.yamlover": "link: *//old.md\n",
    });
    const h = createHandlers(root, { gitignore: false });
    const r = await callBody(h, "POST", "/api/mv", { from: "/old.md", to: "/new.md" });
    expect(r.status).toBe(200);
    expect(r.json.from).toBe("old.md");
    expect(r.json.to).toBe("new.md");
    expect(r.json.rewritten).toHaveLength(1);
    expect(r.json.unrewritten).toHaveLength(0);
    expect(r.json.diff.added).toContain("new.md"); // the diff carries manifest-relative paths
    expect(fs.readFileSync(path.join(root, "refs.yamlover"), "utf8")).toBe("link: *//new.md\n");
    expect(fs.existsSync(path.join(root, "old.md"))).toBe(false);

    const node = call(h, "/api/json", { path: "/new.md" });
    expect(node.status).toBe(200);
    const dangling = call(h, "/api/dangling", {});
    expect(dangling.json).toEqual([]);
    h.close();
  });

  it("rejects positional segments, missing sources, and existing targets", async () => {
    const root = tmpTree({ "a.md": "A", "b.md": "B" });
    const h = createHandlers(root, { gitignore: false });
    expect((await callBody(h, "POST", "/api/mv", { from: "/a.md[0]", to: "/x.md" })).status).toBe(400);
    expect((await callBody(h, "POST", "/api/mv", { from: "/nope.md", to: "/x.md" })).status).toBe(400);
    expect((await callBody(h, "POST", "/api/mv", { from: "/a.md", to: "/b.md" })).status).toBe(400);
    expect(fs.existsSync(path.join(root, "a.md"))).toBe(true);
    h.close();
  });
});
