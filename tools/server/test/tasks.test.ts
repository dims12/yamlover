// Long-running server tasks: the background initial index (the server answers immediately;
// `ready` settles when the index lands), task lifecycle over GET /api/tasks + SSE
// `{type:"task"}` frames, the background hasher filling in large-blob hashes, and write
// serialization through the one-writer queue.

import { describe, it, expect, onTestFinished } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandlers } from "../src/server/engine-api.ts";
import { Store } from "../../engine/ts/src/store.ts";
import { tmpTree } from "./helpers.ts";
import { call, callBody } from "./http.ts";

function handlers(root: string, opts: Parameters<typeof createHandlers>[1] = {}) {
  const h = createHandlers(root, { gitignore: false, ...opts });
  onTestFinished(() => h.close());
  return h;
}

/** Attach a fake SSE subscriber; returns the JSON payloads of all data frames received. */
function sseFrames(h: ReturnType<typeof createHandlers>): () => any[] {
  const raw: string[] = [];
  const req = { method: "GET", on: () => {} } as unknown as IncomingMessage;
  const res = {
    statusCode: 200,
    setHeader() {},
    write(chunk: string) { raw.push(chunk); return true; },
    end() {},
  } as unknown as ServerResponse;
  h(req, res, new URL("http://localhost/api/events"));
  return () => raw.filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)));
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("background initial index", () => {
  it("createHandlers returns immediately; the index task shows in /api/tasks and settles ready", async () => {
    const h = handlers(tmpTree({ "a.md": "# a" }));
    const frames = sseFrames(h); // subscribed before the index lands
    const diff = await h.ready;
    expect(diff.added).toEqual(["a.md"]);

    // the finished task is still listed (brief retention) with determinate progress
    const tasks = call(h, "/api/tasks").json;
    const indexTask = tasks.find((t: any) => t.label.startsWith("indexing"));
    expect(indexTask).toBeTruthy();
    expect(indexTask.state).toBe("done");
    expect(indexTask.progress.total).toBe(1);

    // the SSE stream carried the task lifecycle and the diff, each frame typed
    await until(() => frames().some((f) => f.type === "diff"), "the diff frame");
    const taskFrames = frames().filter((f) => f.type === "task" && f.task.label.startsWith("indexing"));
    expect(taskFrames.some((f) => f.task.state === "running")).toBe(true);
    expect(taskFrames.some((f) => f.task.state === "done")).toBe(true);
    const diffFrame = frames().find((f) => f.type === "diff");
    expect(diffFrame.added).toEqual([":a.md"]); // client JSON paths
  });

  it("the tree endpoint answers (from the previous index) before ready", async () => {
    const root = tmpTree({ "a.md": "# a" });
    await handlers(root).ready; // first run persists the index

    fs.writeFileSync(path.join(root, "b.md"), "# b"); // an offline edit
    const h2 = handlers(root);
    // immediately — before the background reindex commits — yesterday's index answers
    const labels = call(h2, "/api/tree", { path: ":", depth: "1" }).json.children.map((c: any) => c.label).filter((l: string) => l !== "yamlover"); // ignore the built-in palette graft
    expect(labels).toEqual(["a.md"]);
    await h2.ready;
    const fresh = call(h2, "/api/tree", { path: ":", depth: "1" }).json.children.map((c: any) => c.label).filter((l: string) => l !== "yamlover"); // ignore the built-in palette graft
    expect(fresh).toEqual(["a.md", "b.md"]);
  });
});

describe("background hasher", () => {
  it("a large blob indexes unhashed, then the hasher task fills in its xxh64", async () => {
    const root = tmpTree({});
    // > 1 MiB (the walk's inline-hash limit) with PNG magic so it lands as a blob
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.alloc(1.5 * 2 ** 20, 7)]);
    fs.writeFileSync(path.join(root, "big.png"), big);
    const h = handlers(root);
    await h.ready;

    // poll the SAME on-disk store (WAL allows a second reader) until the hasher lands
    const probe = new Store(path.join(root, ".yamlover", "index.db"));
    onTestFinished(() => probe.close());
    await until(() => probe.node(":big.png")?.content_hash != null, "the background hash");
    expect(probe.node(":big.png")!.content_hash).toMatch(/^xxh64:/);
    expect(probe.unhashedFiles()).toEqual([]);

    // and the hasher reported itself as a task
    await until(
      () => call(h, "/api/tasks").json.some((t: any) => t.label.includes("hashing") && t.state === "done"),
      "the hasher task to finish",
    );
  });
});

describe("write serialization", () => {
  it("an annotation fired while a reconcile is queued survives it", async () => {
    // the `!!<…$defs/tag>` attach makes `yellow` an x-yamlover-tag node (same fixture shape
    // as engine-api-write.test.ts)
    const TAG_FILE = { "tags.yamlover": 'yellow: !!<*yamlover/$defs/tag>\n  color: "#f9e2af"\n' };
    const root = tmpTree({ "doc.md": "# doc", ...TAG_FILE });
    const h = handlers(root);
    await h.ready;

    // queue a reconcile and, WITHOUT waiting, an annotation right behind it
    const reconcile = callBody(h, "POST", "/api/reindex");
    const annotate = callBody(h, "POST", "/api/annotate", { target: ":doc.md", tag: ":tags.yamlover:yellow" });
    const [r1, r2] = await Promise.all([reconcile, annotate]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(201);

    // the annotation is in the index (it queued behind the full walk, not under it)
    const anns = call(h, "/api/annotations", { path: ":doc.md" }).json;
    expect(anns).toHaveLength(1);
  });
});
