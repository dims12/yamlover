// POST /api/mv — the engine-mediated move over HTTP: FS rename + inbound-ref rewriting,
// then a reindex whose diff rides on the response.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers.js";
import { call, callBody } from "./http.js";
import { nodeJson } from "./node-json";

describe("POST /api/mv", () => {
  it("moves a file, rewrites the referrer on disk, and the node answers at the new path", async () => {
    const root = tmpTree({
      "old.md": "# doc",
      "refs.yo": "link: *:: old.md\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/mv", { from: ":old.md", to: ":new.md" });
    expect(r.status).toBe(200);
    expect(r.json.from).toBe("old.md");
    expect(r.json.to).toBe("new.md");
    expect(r.json.rewritten).toHaveLength(1);
    expect(r.json.unrewritten).toHaveLength(0);
    // the reindex sees the rename as an inferred move (manifest-relative paths)
    expect(r.json.diff.moved).toEqual([{ from: "old.md", to: "new.md" }]);
    expect(r.json.diff.changed).toContain("refs.yo"); // the rewritten referrer
    expect(fs.readFileSync(path.join(root, "refs.yo"), "utf8")).toBe("link: *:: new.md\n");
    expect(fs.existsSync(path.join(root, "old.md"))).toBe(false);

    const node = (await nodeJson(h, { path: ":new.md" }));
    expect(node.status).toBe(200);
    const dangling = call(h, "/api/dangling", {});
    expect(dangling.json).toEqual([]);
    h.close();
  });

  it("a dir-body ORDER pointer for the moved child is repaired in the merged report (post-rename pass)", async () => {
    const root = tmpTree({
      "D/.yo/body.yo": "Doc D\n- *: x.md\n",
      "D/x.md": "X\n",
      "pages.md": "see [a](::D:x.md) end\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/mv", { from: ":D:x.md", to: ":E:x.md" });
    expect(r.status).toBe(200);
    // the consumed order pointer surfaces post-rename and is escalated — never deleted
    expect(fs.readFileSync(path.join(root, "D", ".yo", "body.yo"), "utf8")).toBe("Doc D\n- *:: E: x.md\n");
    // the whole-file prose link is rewritten surgically — sigiled compact canonical
    expect(fs.readFileSync(path.join(root, "pages.md"), "utf8")).toBe("see [a](*::E:x.md) end\n");
    expect(r.json.unrewritten).toHaveLength(0);
    expect(r.json.rewritten.map((x: { newRaw: string }) => x.newRaw).sort()).toEqual([":: E: x.md", "[a](*::E:x.md)"]);
    expect(call(h, "/api/dangling", {}).json).toEqual([]);
    h.close();
  });

  it("rejects positional segments, missing sources, and existing targets", async () => {
    const root = tmpTree({ "a.md": "A", "b.md": "B" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect((await callBody(h, "POST", "/api/mv", { from: ":a.md[0]", to: ":x.md" })).status).toBe(400);
    expect((await callBody(h, "POST", "/api/mv", { from: ":nope.md", to: ":x.md" })).status).toBe(400);
    expect((await callBody(h, "POST", "/api/mv", { from: ":a.md", to: ":b.md" })).status).toBe(400);
    expect(fs.existsSync(path.join(root, "a.md"))).toBe(true);
    h.close();
  });
});
