#!/usr/bin/env bash
# Delete every yamlover index database (`.yamlover/index.db{,-wal,-shm}`) under a tree,
# so the next serve/walk rebuilds the index from scratch. These are derived caches —
# safe to remove; the engine regenerates them on the next index pass.
#
# Scoped on purpose: it matches only `index.db*` that sits directly inside a `.yamlover/`
# directory, and skips `node_modules`. It does NOT touch the demo server's `demos.db`
# (tools/demo/.data) or any other `*.db` in the tree.
#
#   tools/clean-index.sh            # clean the repo (the script's own root)
#   tools/clean-index.sh /tmp/foo   # clean another tree (e.g. a detached copy)
#   tools/clean-index.sh -n         # dry run — list what would be deleted, delete nothing
set -euo pipefail

dry=0
root=""
for a in "$@"; do
  case "$a" in
    -n|--dry-run) dry=1 ;;
    *) root="$a" ;;
  esac
done
# Default to the repo root (the dir holding tools/), not $PWD, so it is location-independent.
root="${root:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [ ! -d "$root" ]; then
  echo "clean-index: no such directory: $root" >&2
  exit 1
fi

mapfile -d '' files < <(
  find "$root" -type d -name node_modules -prune -o \
       -type f -path '*/.yamlover/index.db*' -print0
)

if [ "${#files[@]}" -eq 0 ]; then
  echo "clean-index: no index databases under $root"
  exit 0
fi

for f in "${files[@]}"; do
  if [ "$dry" -eq 1 ]; then
    echo "would delete: $f"
  else
    rm -f "$f"
    echo "deleted: $f"
  fi
done

[ "$dry" -eq 1 ] && echo "(dry run — nothing removed)" || echo "removed ${#files[@]} file(s)"
