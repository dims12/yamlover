// THE WIRE GOLDENS — the /api/json responses over the frozen deep fixture
// (examples/74-deep-book): every TOC-addressable node × depth {0, 1, 2, default, .inf},
// recorded under goldens/deep-book/depth-<d>.json.
//
// Purpose (the one-wire migration, Stage 0): pin the OLD wire byte-for-byte so the Stage-2
// client derivation (`deriveNodeJson` over /api/content) can be proven EQUIVALENT while both
// wires are live. After /api/json retires (Stage 4) these goldens flip role: they become the
// derivation's own goldens — the shape every renderer still consumes.
//
// RECORD: `RECORD_GOLDENS=1 npx vitest run test/wire-goldens.test.ts` rewrites the files.
// The goldens directory carries `* -text` (byte-golden law) — record on LF, never hand-edit.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createHandlers, tmpExample } from "./helpers";
import { call } from "./http";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(HERE, "goldens", "deep-book");
const RECORD = process.env.RECORD_GOLDENS === "1";

/** The depth axis: bare finite levels, the server default (param omitted), and unlimited. */
const DEPTHS: { name: string; param: string | undefined }[] = [
  { name: "0", param: "0" },
  { name: "1", param: "1" },
  { name: "2", param: "2" },
  { name: "default", param: undefined },
  { name: "inf", param: ".inf" },
];

interface TreeRow { path: string; children?: TreeRow[] }
const collectPaths = (t: TreeRow, out: string[] = []): string[] => {
  out.push(t.path);
  for (const c of t.children ?? []) collectPaths(c, out);
  return out;
};

describe("the wire goldens — /api/json over examples/74-deep-book", () => {
  it("every node × every depth matches the recorded wire", async () => {
    const h = createHandlers(tmpExample("74-deep-book"), { gitignore: false });
    await h.ready;
    const tree = call(h, "/api/tree", { depth: "12" });
    expect(tree.status).toBe(200);
    const paths = collectPaths(tree.json as TreeRow).sort();
    expect(paths.length).toBeGreaterThan(10); // the fixture is DEEP — a flat walk means it broke

    for (const d of DEPTHS) {
      const bucket: Record<string, unknown> = {};
      for (const p of paths) {
        const r = call(h, "/api/json", { path: p, ...(d.param !== undefined ? { depth: d.param } : {}) });
        expect(r.status, `GET /api/json ${p} depth=${d.name}`).toBe(200);
        bucket[p] = r.json;
      }
      const file = path.join(GOLDEN_DIR, `depth-${d.name}.json`);
      const text = JSON.stringify(bucket, null, 2) + "\n";
      if (RECORD) {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        fs.writeFileSync(file, text);
        continue;
      }
      expect(fs.existsSync(file), `${file} missing — record with RECORD_GOLDENS=1`).toBe(true);
      const golden = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      // path-by-path, so a drift names its node instead of dumping the whole bucket
      expect(Object.keys(golden).sort()).toEqual(paths);
      for (const p of paths) {
        expect(bucket[p], `${p} @ depth=${d.name}`).toEqual(golden[p]);
      }
    }
  }, 120_000);
});
