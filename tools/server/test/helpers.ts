import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

// The repo root, three levels up from tools/server/test/.
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** A fresh temp dir, removed when the current test finishes. */
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yamlover-test-"));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A DISPOSABLE COPY of one example fixture (e.g. tmpExample("51-object-in-dir")), in a temp
 *  dir cleaned up after the test. Tests must never run the engine against the repo's own
 *  `examples/` — indexing and the write paths (annotate/paste) mutate the served tree. */
export function tmpExample(name: string): string {
  const dest = path.join(tmpDir(), name);
  fs.cpSync(path.join(REPO, "examples", name), dest, { recursive: true });
  return dest;
}

/** A synthetic served tree in a temp dir: `files` maps relative paths to contents
 *  (e.g. {"name": "Alice", ".yamlover/settings.yamlover": "…"}). Preferred over copying an
 *  example when the test only needs a small, explicit shape — it can't break when the
 *  examples evolve. Cleaned up after the test. */
export function tmpTree(files: Record<string, string>): string {
  const root = tmpDir();
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}
