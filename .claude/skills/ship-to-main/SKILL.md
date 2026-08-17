---
name: ship-to-main
description: Commit the working tree, land it on devel, push devel to forgejo, then fast-forward main and push main to both remotes (origin and forgejo). Use when the user says to "ship", "commit and push to devel and main", or otherwise asks to land current work through devel into main across both remotes.
---

Land the current work through `devel` into `main`, on both remotes (`origin` = GitHub, `forgejo`).

## Steps

1. **Check state.** `git status` and `git branch --show-current`. If there are uncommitted changes, they belong on `devel`:
   - If already on `devel`, commit directly there.
   - If on some other branch, finish/commit the work on that branch first, then `git checkout devel && git merge <branch> --no-edit` (or fast-forward if possible).
   - If nothing is uncommitted and `devel` already holds the intended commit(s), skip to step 3.

2. **Commit.** Review the diff (`git diff --stat`, then enough of the actual diff to understand *what* changed) and write a commit message in this repo's style — look at `git log --oneline -5` for tone. Stage explicitly (`git add <files>` or `git add -A` after checking `git status` for anything unexpected), then commit. Do not invent scope beyond what the diff shows.

3. **Run the relevant test suites** for whatever packages changed (this repo has independent `npm test` in `tools/engine/ts`, `tools/parser/ts`, `tools/server`, `tools/yed`, etc.) before pushing anything. Don't push red.

4. **Push devel to forgejo:**
   ```
   git push forgejo devel
   ```

5. **Merge devel into main and push everywhere:**
   ```
   git checkout main
   git merge devel --no-edit
   git push origin main
   git push forgejo main
   ```
   This should normally fast-forward (devel is expected to be ahead of main with no divergent main-only commits). If it isn't a fast-forward, stop and surface the conflict/divergence to the user instead of force-resolving it.

6. **Return to devel** (`git checkout devel`) so the working branch is where the user left off, and confirm the final state (`git status`, `git log --oneline -3` on both branches).

## Notes

- Remotes in this repo: `origin` → `git@github.com:dims12/yamlover.git`, `forgejo` → `ssh://forgejo@forgejo.inthemoon.net:2222/dims/yamlover.git`.
- `devel` is pushed to forgejo only, not origin — origin's `devel` may legitimately lag behind. Don't "fix" that unless asked.
- Never `--force` push. If a push is rejected (non-fast-forward), stop and ask rather than force-pushing.
- Only run this when the user has actually asked to ship — don't push proactively after every edit, and don't commit UI-affecting changes before the user has checked them by hand.
