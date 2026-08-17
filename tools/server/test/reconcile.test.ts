// Freshness (PLAN.md 3e): external edits reach the served index — via POST /api/reindex (the
// manual reconcile), the FS watcher + SSE (watch: true), and GET /api/dangling reporting.

import { describe, it, expect, onTestFinished } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers.ts";
import { call, callBody } from "./http.ts";
import { nodeJson } from "./node-json";

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
    expect((await nodeJson(h, { path: ":b.md" })).json.value).toBe("# b");
  });

  it("a deleted file disappears, an edited one re-reads", async () => {
    const root = tmpTree({ "a.md": "# a", "b.yo": "x: 1\n" });
    const h = await handlers(root);
    fs.rmSync(path.join(root, "a.md"));
    fs.writeFileSync(path.join(root, "b.yo"), "x: 2\n");

    const r = await callBody(h, "POST", "/api/reindex");
    expect(r.json).toEqual({ added: [], changed: ["b.yo"], removed: ["a.md"], moved: [] });
    expect(treeLabels(h)).toEqual(["b.yo"]);
    expect((await nodeJson(h, { path: ":b.yo:x" })).json.value).toBe(2);
  });

  it("the persisted index survives a restart without a re-walk being wrong", async () => {
    const root = tmpTree({ "a.md": "# a" });
    await handlers(root); // first run writes <root>/.yo/index.db + the manifest

    fs.writeFileSync(path.join(root, "b.md"), "# b"); // an edit while "down"
    const h2 = await handlers(root); // startup reconcile picks it up
    expect(treeLabels(h2)).toEqual(["a.md", "b.md"]);
  });

  it("an external rename is inferred as a move and the inbound refs are RELINKED", async () => {
    const root = tmpTree({ "old.md": "# unique doc", "refs.yo": "link: *:: old.md\n" });
    const h = await handlers(root);

    // an external actor renames the file — no engine mediation
    fs.renameSync(path.join(root, "old.md"), path.join(root, "new.md"));
    const r = await callBody(h, "POST", "/api/reindex");
    expect(r.json.moved).toEqual([{ from: "old.md", to: "new.md" }]);
    expect(r.json.added).toEqual([]);
    expect(r.json.removed).toEqual([]);
    // the mediated-tier rewrite ran on the inferred move (ENGINE.md tier 2: "relinked")
    expect(fs.readFileSync(path.join(root, "refs.yo"), "utf8")).toBe("link: *:: new.md\n");
    expect(call(h, "/api/dangling").json).toEqual([]);
  });

  it("an external DIRECTORY move relinks too — the file-level diff collapses to the dir", async () => {
    const root = tmpTree({
      "privacy/tax/.yo/body.yo": "Taxonomy\n",
      "privacy/gdpr/index.yo": "GDPR\n",
      "probe.yo": "ptr: *::privacy:tax\n",
    });
    const h = await handlers(root);

    // an external actor: mv privacy kb/privacy (the dogfooding repro, 2026-08-10)
    fs.mkdirSync(path.join(root, "kb"));
    fs.renameSync(path.join(root, "privacy"), path.join(root, "kb", "privacy"));
    const r = await callBody(h, "POST", "/api/reindex");
    expect(r.json.moved.length).toBeGreaterThan(0); // the diff itself stays file-level
    // the inbound ref followed the directory — compact spelling preserved
    expect(fs.readFileSync(path.join(root, "probe.yo"), "utf8")).toBe("ptr: *::kb:privacy:tax\n");
    expect(call(h, "/api/dangling").json).toEqual([]);
  });

  it("an external move relinks prose links AND the dir-body order pointer end-to-end", async () => {
    const root = tmpTree({
      "D/.yo/body.yo": "Doc D\n- *: x.md\n",
      "D/x.md": "X unique content\n",
      "pages.md": "see [a](::D:x.md) and [w](https://example.com/keep) end\n",
    });
    const h = await handlers(root);

    fs.mkdirSync(path.join(root, "E"));
    fs.renameSync(path.join(root, "D", "x.md"), path.join(root, "E", "x.md"));
    const r = await callBody(h, "POST", "/api/reindex");
    expect(r.status).toBe(200);
    // the .md file keeps its NATIVE links — md/adoc links are the author's, never the
    // engine's (a move may break them; the author fixes them)
    expect(fs.readFileSync(path.join(root, "pages.md"), "utf8"))
      .toBe("see [a](::D:x.md) and [w](https://example.com/keep) end\n");
    // the dangling order pointer is escalated to the project form — never deleted
    expect(fs.readFileSync(path.join(root, "D", ".yo", "body.yo"), "utf8")).toBe("Doc D\n- *:: E: x.md\n");
    expect(call(h, "/api/dangling").json).toEqual([]);
  });

  it("read-only: an external move relinks NOTHING — every byte stays", async () => {
    const files = {
      "D/.yo/body.yo": "Doc D\n- *: x.md\n",
      "D/x.md": "X unique content\n",
      "pages.md": "see [a](::D:x.md) end\n",
    };
    const root = tmpTree(files);
    const h = await handlers(root, { readOnly: true });

    fs.mkdirSync(path.join(root, "E"));
    fs.renameSync(path.join(root, "D", "x.md"), path.join(root, "E", "x.md"));
    await callBody(h, "POST", "/api/reindex"); // reindex is allowed read-only; relinking is not
    expect(fs.readFileSync(path.join(root, "pages.md"), "utf8")).toBe(files["pages.md"]);
    expect(fs.readFileSync(path.join(root, "D", ".yo", "body.yo"), "utf8")).toBe(files["D/.yo/body.yo"]);
  });

  it("GET /api/dangling reports a pointer whose target is missing", async () => {
    const root = tmpTree({ "doc.yo": "friend: *missing\n" });
    const h = await handlers(root);
    expect(call(h, "/api/dangling").json).toEqual([
      { from: ":doc.yo:friend", raw: "missing", reason: expect.stringContaining("missing") },
    ]);

    fs.writeFileSync(path.join(root, "doc.yo"), "missing: 1\nfriend: *missing\n");
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

  // THE TWO TIERS. The watcher already knows the exact changed paths; a one-file in-place edit takes
  // the subtree patch (the tier an in-server edit uses), everything else re-walks the tree. The line
  // the log prints names the tier that ACTUALLY ran, so it also catches doReindexFile falling back.
  describe("the tier: one edited file patches, anything else re-walks", () => {
    // wait for a line matching `re`, returning it (the watcher is asynchronous and debounced)
    const awaitLine = async (lines: string[], re: RegExp): Promise<string> => {
      const t0 = Date.now();
      for (;;) {
        const hit = lines.find((l) => re.test(l));
        if (hit) return hit;
        if (Date.now() - t0 > 5000) throw new Error(`no ${re} within 5s; saw:\n${lines.join("\n")}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    it("an in-place edit of one file takes the patch tier", async () => {
      const root = tmpTree({ "deep/dir/b.yo": "x: 1\n", "other.yo": "y: 1\n" });
      const lines: string[] = [];
      const h = await handlers(root, { watch: true, log: (l) => lines.push(l) });

      fs.writeFileSync(path.join(root, "deep/dir/b.yo"), "x: 2\n");
      expect(await awaitLine(lines, /^patch: /)).toMatch(/^patch: \+0 ~1 −0 →0$/); // not "patch → full walk"
      expect(lines.some((l) => l.startsWith("reconcile:"))).toBe(false);
      expect((await nodeJson(h, { path: ":deep:dir:b.yo:x" })).json.value).toBe(2);
    });

    it("a new file re-walks — an addition can be half of a move", async () => {
      const root = tmpTree({ "a.md": "# a" });
      const lines: string[] = [];
      const h = await handlers(root, { watch: true, log: (l) => lines.push(l) });

      fs.writeFileSync(path.join(root, "b.md"), "# b");
      expect(await awaitLine(lines, /^reconcile: /)).toMatch(/\+1 /);
      expect(lines.some((l) => l.startsWith("patch:"))).toBe(false);
      expect(treeLabels(h)).toEqual(["a.md", "b.md"]);
    });

    it("a removal re-walks — only the whole-tree diff pairs a move's two halves", async () => {
      const root = tmpTree({ "a.md": "# a", "b.md": "# b" });
      const lines: string[] = [];
      const h = await handlers(root, { watch: true, log: (l) => lines.push(l) });

      fs.rmSync(path.join(root, "b.md"));
      expect(await awaitLine(lines, /^reconcile: /)).toMatch(/−1 /);
      expect(lines.some((l) => l.startsWith("patch:"))).toBe(false);
      expect(treeLabels(h)).toEqual(["a.md"]);
    });
  });
});
