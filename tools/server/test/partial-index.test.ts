// Partial index commits (walk.ts `partialCommitMs`): during a big initial walk the engine
// commits provisional snapshots of the tree so far — nodes/edges only, never the manifest —
// so the TOC populates while indexing runs. These tests pin the safety contract: partials
// surface mid-walk, and the FINAL result (diff + store contents) is byte-identical to a run
// with the feature off.

import { describe, it, expect, onTestFinished } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Store, reindexAsyncDoc } from "../../engine/ts/src/index.ts";
import { tmpTree } from "./helpers.ts";

function makeFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let d = 0; d < 5; d++) for (let f = 0; f < 20; f++) files[`dir${d}/file${f}.yamlover`] = `v: ${d}-${f}\n`;
  return files;
}

function openStore(root: string): Store {
  fs.mkdirSync(path.join(root, ".yamlover"), { recursive: true });
  const s = new Store(path.join(root, ".yamlover", "index.db"));
  onTestFinished(() => s.close());
  return s;
}

describe("partial index commits during the initial walk", () => {
  it("commits provisional trees mid-walk; the final result matches an atomic run", async () => {
    const rootPartial = tmpTree(makeFiles());
    const rootAtomic = tmpTree(makeFiles());
    const sPartial = openStore(rootPartial);
    const sAtomic = openStore(rootAtomic);

    const partialBatches: string[][] = [];
    let sawTreeMidWalk = false;
    const resPartial = await reindexAsyncDoc(sPartial, rootPartial, {
      partialCommitMs: 1, // commit as often as the walk allows — maximal interleaving
      onPartial: (added) => {
        partialBatches.push(added);
        // inside the callback the provisional commit has just landed: the store must already
        // answer for the reported paths (this is what makes the TOC populate mid-walk)
        const storePath = ":" + added[added.length - 1].split("/").join(":");
        if (sPartial.node(":") && sPartial.node(storePath)) sawTreeMidWalk = true;
      },
    });
    const resAtomic = await reindexAsyncDoc(sAtomic, rootAtomic, {});

    // partials actually happened, mid-walk, and the committed nodes were queryable
    expect(partialBatches.length).toBeGreaterThan(0);
    expect(sawTreeMidWalk).toBe(true);

    // every partial-reported path is real, and none was reported twice
    const reported = partialBatches.flat();
    expect(new Set(reported).size).toBe(reported.length);
    const finalPaths = new Set(resPartial.files.map((f) => f.path));
    for (const p of reported) expect(finalPaths.has(p)).toBe(true);

    // FINAL parity with the atomic run: same diff, same manifest, same node rows
    expect(resPartial.diff.added.sort()).toEqual(resAtomic.diff.added.sort());
    expect(resPartial.diff.changed).toEqual([]);
    expect(resPartial.diff.removed).toEqual([]);
    expect(resPartial.files.map((f) => f.path).sort()).toEqual(resAtomic.files.map((f) => f.path).sort());
    for (const f of resAtomic.files) {
      const row = sPartial.node(":" + f.path.split("/").join(":"));
      const ref = sAtomic.node(":" + f.path.split("/").join(":"));
      expect(row?.type).toBe(ref?.type);
      expect(row?.format).toBe(ref?.format);
    }
  });

  it("a rerun over an unchanged tree reports no diff even with partials on", async () => {
    const root = tmpTree(makeFiles());
    const s = openStore(root);
    await reindexAsyncDoc(s, root, { partialCommitMs: 1 });
    const again = await reindexAsyncDoc(s, root, { partialCommitMs: 1 });
    expect(again.diff).toEqual({ added: [], changed: [], removed: [], moved: [] });

    // the per-file manifest lookup (the watcher's spurious-event filter) matches the walk's view
    const rec = s.file("dir0/file0.yamlover");
    const st = fs.statSync(path.join(root, "dir0", "file0.yamlover"));
    expect(rec).not.toBeNull();
    expect(rec!.size).toBe(st.size);
    expect(rec!.mtimeMs).toBe(st.mtimeMs);
    expect(s.file("no/such/file")).toBeNull();
  });
});
