// Freshness (PLAN.md 3e): external edits reach the served index — via POST /api/reindex (the
// manual reconcile), the FS watcher + SSE (watch: true), and GET /api/dangling reporting.

import { describe, it, expect, onTestFinished } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandlers } from "../src/server/engine-api.ts";
import { tmpTree } from "./helpers.ts";
import { call, callBody } from "./http.ts";

async function handlers(root: string, opts: Parameters<typeof createHandlers>[1] = {}) {
  const h = createHandlers(root, { gitignore: false, ...opts });
  onTestFinished(() => h.close());
  await h.ready; // the initial index runs in the background — tests assert against a settled one
  return h;
}

const treeLabels = (h: ReturnType<typeof createHandlers>): string[] =>
  call(h, "/api/tree", { path: ":", depth: "1" }).json.children
    .map((c: { label: string }) => c.label)
    .filter((l: string) => l !== "yamlover"); // ignore the built-in palette graft (always present)

describe("reconcile: external edits reach the index", () => {
  it("a file created after startup appears once /api/reindex runs", async () => {
    const root = tmpTree({ "a.md": "# a" });
    const h = await handlers(root);
    expect(treeLabels(h)).toEqual(["a.md"]);

    fs.writeFileSync(path.join(root, "b.md"), "# b");
    expect(treeLabels(h)).toEqual(["a.md"]); // the snapshot is stale until a reconcile

    const r = await callBody(h, "POST", "/api/reindex");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ added: ["b.md"], changed: [], removed: [], moved: [] });
    expect(treeLabels(h)).toEqual(["a.md", "b.md"]);
    expect(call(h, "/api/json", { path: ":b.md" }).json.value).toBe("# b");
  });

  it("a deleted file disappears, an edited one re-reads", async () => {
    const root = tmpTree({ "a.md": "# a", "b.yamlover": "x: 1\n" });
    const h = await handlers(root);
    fs.rmSync(path.join(root, "a.md"));
    fs.writeFileSync(path.join(root, "b.yamlover"), "x: 2\n");

    const r = await callBody(h, "POST", "/api/reindex");
    expect(r.json).toEqual({ added: [], changed: ["b.yamlover"], removed: ["a.md"], moved: [] });
    expect(treeLabels(h)).toEqual(["b.yamlover"]);
    expect(call(h, "/api/json", { path: ":b.yamlover:x" }).json.value).toBe(2);
  });

  it("the persisted index survives a restart without a re-walk being wrong", async () => {
    const root = tmpTree({ "a.md": "# a" });
    await handlers(root); // first run writes <root>/.yamlover/index.db + the manifest

    fs.writeFileSync(path.join(root, "b.md"), "# b"); // an edit while "down"
    const h2 = await handlers(root); // startup reconcile picks it up
    expect(treeLabels(h2)).toEqual(["a.md", "b.md"]);
  });

  it("an external rename is inferred as a move and the inbound refs are RELINKED", async () => {
    const root = tmpTree({ "old.md": "# unique doc", "refs.yamlover": "link: *//old.md\n" });
    const h = await handlers(root);

    // an external actor renames the file — no engine mediation
    fs.renameSync(path.join(root, "old.md"), path.join(root, "new.md"));
    const r = await callBody(h, "POST", "/api/reindex");
    expect(r.json.moved).toEqual([{ from: "old.md", to: "new.md" }]);
    expect(r.json.added).toEqual([]);
    expect(r.json.removed).toEqual([]);
    // the mediated-tier rewrite ran on the inferred move (ENGINE.md tier 2: "relinked")
    expect(fs.readFileSync(path.join(root, "refs.yamlover"), "utf8")).toBe("link: *//new.md\n");
    expect(call(h, "/api/dangling").json).toEqual([]);
  });

  it("GET /api/dangling reports a pointer whose target is missing", async () => {
    const root = tmpTree({ "doc.yamlover": "friend: *missing\n" });
    const h = await handlers(root);
    expect(call(h, "/api/dangling").json).toEqual([
      { from: ":doc.yamlover:friend", raw: "missing", reason: expect.stringContaining("missing") },
    ]);

    fs.writeFileSync(path.join(root, "doc.yamlover"), "missing: 1\nfriend: *missing\n");
    await callBody(h, "POST", "/api/reindex");
    expect(call(h, "/api/dangling").json).toEqual([]);
  });
});

describe("watch: true — the FS watcher reindexes and pushes SSE", () => {
  it("a new file is indexed and broadcast without any client call", async () => {
    const root = tmpTree({ "a.md": "# a" });
    const h = await handlers(root, { watch: true });

    // a minimal SSE subscriber: collect data frames written to the fake response
    const frames: string[] = [];
    const req = { method: "GET", on: () => {} } as unknown as IncomingMessage;
    const res = {
      statusCode: 200,
      setHeader() {},
      write(chunk: string) { frames.push(chunk); return true; },
      end() {},
    } as unknown as ServerResponse;
    h(req, res, new URL("http://localhost/api/events"));

    fs.writeFileSync(path.join(root, "b.md"), "# b");
    // task frames ({type:"task"} — the reconcile's lifecycle) interleave with the diff
    const diffFrame = (): string | undefined =>
      frames.find((f) => f.startsWith("data: ") && JSON.parse(f.slice(6)).type === "diff");
    const t0 = Date.now();
    while (!diffFrame()) {
      if (Date.now() - t0 > 5000) throw new Error("no SSE broadcast within 5s");
      await new Promise((r) => setTimeout(r, 50));
    }
    const payload = JSON.parse(diffFrame()!.slice(6));
    expect(payload.added).toEqual([":b.md"]); // client JSON paths, not file paths
    expect(treeLabels(h)).toEqual(["a.md", "b.md"]); // and the index is already fresh
  });
});
