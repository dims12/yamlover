#!/usr/bin/env bash
# One-time host setup for the demo server on design-vm. Run as the deploying user
# (dims) FROM the deploy dir of a synced checkout — i.e. after the code is present at
# ~/Design/www/yamlover-demo (the Forgejo deploy job rsyncs it; for a cold start, rsync
# tools/demo there yourself first, then run this).
#
#   bash ~/Design/www/yamlover-demo/deploy/bootstrap.sh
#
# ASSUMES Node>=22, Docker (user in the `docker` group), and Caddy are already installed
# (it does NOT install them). It is idempotent and only wires up *our* pieces:
#   1. user systemd unit  → ~/.config/systemd/user/yamlover-demo.service
#   2. env file (secrets) → ~/.config/yamlover-demo.env   (seeded once, then left alone)
#   3. Caddy site block   → appended to /etc/caddy/Caddyfile (needs sudo; never clobbered)
#   4. enable-linger + enable/start the user service
#
# Ongoing code deploys are the Forgejo `deploy-demo` workflow (rsync + `systemctl --user
# restart`) — this script is just the once-per-host plumbing.
set -euo pipefail

DEST="${DEST:-$HOME/Design/www/yamlover-demo}"
ENV_FILE="${ENV_FILE:-$HOME/.config/yamlover-demo.env}"
UNIT_DIR="${UNIT_DIR:-$HOME/.config/systemd/user}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

for bin in node docker caddy systemctl loginctl; do
  command -v "$bin" >/dev/null 2>&1 || die "missing prerequisite: '$bin' (install Node>=22, Docker, Caddy first)"
done
id -nG | tr ' ' '\n' | grep -qx docker || die "$(whoami) is not in the 'docker' group"
[ -f "$DEPLOY_DIR/yamlover-demo.service" ] || die "run me from a synced deploy dir (no unit at $DEPLOY_DIR)"

# ── 1. user systemd unit ─────────────────────────────────────────────────────
log "installing user unit → $UNIT_DIR/yamlover-demo.service"
mkdir -p "$UNIT_DIR"
install -m 0644 "$DEPLOY_DIR/yamlover-demo.service" "$UNIT_DIR/yamlover-demo.service"

# ── 2. env file (kept if present so secrets survive) ─────────────────────────
mkdir -p "$(dirname "$ENV_FILE")" "$DEST/.data"
if [ -f "$ENV_FILE" ]; then
  log "keeping existing $ENV_FILE"
else
  log "seeding $ENV_FILE from example (edit EMAIL_FROM / EMAIL_PROVIDER as needed)"
  install -m 0600 "$DEPLOY_DIR/yamlover-demo.env.example" "$ENV_FILE"
fi

# ── 2b. let this user service read the root-only Resend key ──────────────────
if [ -f /etc/resend.env ]; then
  log "granting $(whoami) read on /etc/resend.env (root:$(id -gn) 0640)"
  sudo chown "root:$(id -gn)" /etc/resend.env
  sudo chmod 640 /etc/resend.env
else
  log "no /etc/resend.env — email stays console until you create it (RESEND_API_KEY=…)"
fi

# ── 3. Caddy site block (append once; never clobber other sites) ─────────────
if sudo grep -q 'yamlover\.inthemoon\.net' "$CADDYFILE" 2>/dev/null; then
  log "Caddy already has the yamlover.inthemoon.net block"
else
  log "appending the yamlover.inthemoon.net block to $CADDYFILE"
  printf '\n' | sudo tee -a "$CADDYFILE" >/dev/null
  sudo tee -a "$CADDYFILE" < "$DEPLOY_DIR/Caddyfile" >/dev/null
fi
log "validating + reloading Caddy"
sudo caddy validate --config "$CADDYFILE" --adapter caddyfile
sudo systemctl reload caddy

# ── 4. linger + enable/start the user service ────────────────────────────────
log "enabling linger for $(whoami) (service runs without an active login + survives reboot)"
sudo loginctl enable-linger "$(whoami)"
log "enabling + starting the user service"
systemctl --user daemon-reload
systemctl --user enable --now yamlover-demo

log "done. status:"
systemctl --user --no-pager --lines=0 status yamlover-demo || true
echo
log "logs:  journalctl --user -u yamlover-demo -f"
