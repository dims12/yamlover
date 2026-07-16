import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGitIgnore } from "../src/server/gitignore";
import { loadEntity, toPlain, setIgnoreFilter } from "../src/server/yamlover";

/** A throwaway git repo with a root and a nested .gitignore. */
function tmpRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yamlover-gi-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n*.log\n");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "x"), "1");
  fs.writeFileSync(path.join(root, "keep.txt"), "hi");
  fs.writeFileSync(path.join(root, "debug.log"), "x");
  fs.writeFileSync(path.join(root, "secret"), "x"); // not ignored at the root
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", ".gitignore"), "secret\n");
  fs.writeFileSync(path.join(root, "sub", "secret"), "x");
  fs.writeFileSync(path.join(root, "sub", "ok"), "x");
  return root;
}

afterEach(() => setIgnoreFilter(() => false));

describe("gitignore predicate", () => {
  it("ignores directories (trailing slash), globs, and .git", () => {
    const root = tmpRepo();
    const ig = buildGitIgnore(root);
    expect(ig(path.join(root, "node_modules"))).toBe(true); // dir matched by `node_modules/`
    // a file INSIDE the ignored dir: the relative path crosses a separator — on Windows a
    // backslash, which the `ignore` package's win32 patch converts itself
    expect(ig(path.join(root, "node_modules", "x"))).toBe(true);
    expect(ig(path.join(root, "debug.log"))).toBe(true);
    expect(ig(path.join(root, "keep.txt"))).toBe(false);
    expect(ig(path.join(root, ".git"))).toBe(true);
  });

  it("honors nested .gitignore scoped to its directory", () => {
    const root = tmpRepo();
    const ig = buildGitIgnore(root);
    expect(ig(path.join(root, "sub", "secret"))).toBe(true);
    expect(ig(path.join(root, "secret"))).toBe(false); // root `secret` is not ignored
    expect(ig(path.join(root, "sub", "ok"))).toBe(false);
  });
});

describe("gitignore + materialization", () => {
  it("hides ignored stray entries from the tree", () => {
    const root = tmpRepo();
    setIgnoreFilter(buildGitIgnore(root));
    const v = toPlain(loadEntity(root)) as Record<string, unknown>;
    expect(Object.keys(v).sort()).toEqual(["keep.txt", "secret", "sub"]);
    expect((v.sub as Record<string, unknown>)).toEqual({ ok: "x" }); // nested secret hidden
  });
});
