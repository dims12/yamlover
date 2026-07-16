/**
 * gitignore.ts — a predicate telling whether an absolute path is git-ignored.
 *
 * It honors `.gitignore` files from the repository root down to the file's
 * parent (nested `.gitignore`s included), plus an always-ignored `.git`. Built
 * once per server and handed to the materializer (see `setIgnoreFilter`), it only
 * filters *undescribed* (stray) entries — schema-described children are always
 * kept.
 */

import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export function buildGitIgnore(dataRoot: string): (absPath: string) => boolean {
  const gitRoot = findGitRoot(dataRoot) ?? dataRoot;
  const cache = new Map<string, Ignore | null>(); // dir → its .gitignore matcher

  const matcherFor = (dir: string): Ignore | null => {
    if (!cache.has(dir)) {
      let ig: Ignore | null = null;
      try {
        const gi = path.join(dir, ".gitignore");
        if (fs.statSync(gi).isFile()) ig = ignore().add(fs.readFileSync(gi, "utf-8"));
      } catch {
        /* no .gitignore here */
      }
      cache.set(dir, ig);
    }
    return cache.get(dir)!;
  };

  return (absPath: string): boolean => {
    const fromRoot = path.relative(gitRoot, absPath);
    if (fromRoot === ".git" || fromRoot.startsWith(".git" + path.sep)) return true;

    // A directory must be tested with a trailing slash, otherwise a `dir/`
    // pattern (e.g. `node_modules/`) does not match the bare name.
    let isDir = false;
    try {
      isDir = fs.statSync(absPath).isDirectory();
    } catch {
      /* gone */
    }

    // Test the path against every .gitignore from the repo root down to its
    // parent directory; each file's patterns are relative to its own location.
    const rel = path.relative(gitRoot, path.dirname(absPath));
    const segs = rel === "" ? [] : rel.split(path.sep);
    let dir = gitRoot;
    const dirs = [gitRoot];
    for (const s of segs) {
      dir = path.join(dir, s);
      dirs.push(dir);
    }
    for (const d of dirs) {
      const ig = matcherFor(d);
      if (!ig) continue;
      // path.relative yields backslashes on Windows; the `ignore` package converts them
      // itself (its win32 makePosix patch), so no normalization is needed here
      const relToDir = path.relative(d, absPath);
      if (!relToDir) continue;
      if (ig.ignores(relToDir) || (isDir && ig.ignores(relToDir + "/"))) return true;
    }
    return false;
  };
}

function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  // If start is a file, begin at its directory.
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    return null;
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
