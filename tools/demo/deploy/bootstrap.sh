#!/usr/bin/env bash
# Idempotent bootstrap + redeploy for the yamlover demo server on a single VM.
#
# ASSUMES Node >= 22, Docker, and Caddy are already installed and on PATH (the
# script does NOT install them). It only wires up *our* pieces and is safe to
# re-run — a second run is the redeploy: it git-pulls and restarts the service.
#
#   First run (provision):   sudo REPO_URL=<git-url> bash tools/demo/deploy/bootstrap.sh
#   Later runs (redeploy):   sudo bash /opt/yamlover/tools/demo/deploy/bootstrap.sh
#
# What it does:
#   1. clone-or-pull the repo into $DEST            (DEST=/opt/yamlover)
#   2. install the systemd unit + env file          (/etc/yamlover-demo.env, kept if present)
#   3. install the Caddyfile                         (/etc/caddy/Caddyfile)
#   4. enable + (re)start yamlover-demo, reload Caddy
#
# The demo server itself runs as bare `node` (zero npm deps) — no build step here.
# Per-visitor yamlover instances run as Docker containers it pulls from Docker Hub.
set -euo pipefail

DEST="${DEST:-/opt/yamlover}"
ENV_FILE="${ENV_FILE:-/etc/yamlover-demo.env}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
BRANCH="${BRANCH:-main}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run as root (sudo): needs to write /etc, /opt, and manage systemd"

# Sanity-check the assumed prerequisites are actually present.
for bin in git node docker caddy systemctl; do
  command -v "$bin" >/dev/null 2>&1 || die "missing prerequisite: '$bin' not on PATH (install Node>=22, Docker, Caddy first)"
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || die "Node >= 22 required (found $(node -v))"

# ── 1. clone-or-pull the repo ────────────────────────────────────────────────
if [ -d "$DEST/.git" ]; then
  log "updating repo at $DEST"
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" checkout -q "$BRANCH"
  git -C "$DEST" reset --hard "origin/$BRANCH"   # deploy = exact tracked state, no local drift
else
  # Derive the clone URL from this checkout's origin when not given explicitly.
  SRC_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)"
  REPO_URL="${REPO_URL:-$(git -C "$SRC_ROOT" config --get remote.origin.url 2>/dev/null || true)}"
  [ -n "$REPO_URL" ] || die "no checkout at $DEST and REPO_URL unset — pass REPO_URL=<git-url>"
  log "cloning $REPO_URL → $DEST (branch $BRANCH, no submodules)"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$DEST"
fi

DEPLOY_DIR="$DEST/tools/demo/deploy"
[ -f "$DEPLOY_DIR/yamlover-demo.service" ] || die "deploy artifacts not found under $DEPLOY_DIR — wrong DEST?"

# ── 2. systemd unit + env file ───────────────────────────────────────────────
log "installing systemd unit → /etc/systemd/system/yamlover-demo.service"
install -m 0644 "$DEPLOY_DIR/yamlover-demo.service" /etc/systemd/system/yamlover-demo.service

if [ -f "$ENV_FILE" ]; then
  log "keeping existing $ENV_FILE (contains your secrets)"
else
  log "seeding $ENV_FILE from example — EDIT IT to set RESEND_API_KEY before email works"
  install -m 0600 "$DEPLOY_DIR/yamlover-demo.env.example" "$ENV_FILE"
fi

# ── 3. Caddyfile ─────────────────────────────────────────────────────────────
log "installing Caddyfile → $CADDYFILE"
install -d "$(dirname "$CADDYFILE")"
if [ -f "$CADDYFILE" ] && ! cmp -s "$DEPLOY_DIR/Caddyfile" "$CADDYFILE"; then
  cp -a "$CADDYFILE" "$CADDYFILE.bak"   # don't silently clobber a hand-edited Caddyfile
  log "backed up previous Caddyfile → $CADDYFILE.bak"
fi
install -m 0644 "$DEPLOY_DIR/Caddyfile" "$CADDYFILE"

# ── 4. (re)start services ────────────────────────────────────────────────────
log "reloading systemd + (re)starting yamlover-demo"
systemctl daemon-reload
systemctl enable yamlover-demo >/dev/null
systemctl restart yamlover-demo

log "reloading Caddy"
systemctl reload caddy 2>/dev/null || systemctl restart caddy

log "done. status:"
systemctl --no-pager --lines=0 status yamlover-demo || true
echo
log "tail logs with:  journalctl -u yamlover-demo -f"
