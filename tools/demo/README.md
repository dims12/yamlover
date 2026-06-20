# yamlover demo server

Hands each visitor a **private, disposable yamlover** pre-loaded with the repo's
`examples/`. A visitor enters their email, gets a link (`https://demo.host/demo/<hash>/`),
and the first click provisions a yamlover instance served under that path prefix. Each
demo is reaped after a TTL.

```
visitor ─▶ GET /                     registration page (email form)
        ─▶ POST /register            mint 128-bit hash, email the link (lazy: no instance yet)
        ─▶ GET /demo/<hash>/…        first hit provisions an instance, then reverse-proxies to it
reaper  ─▶ every 30 min              stop demos past their TTL; reconcile against live instances on boot
```

Routing is **path-prefix**: one domain, one TLS cert, one A record. Each yamlover
instance is launched with `--base-path /demo/<hash>` so the whole app (assets, every
`/api/*`, the SSE stream) lives under that prefix; the proxy forwards the URL unchanged
and yamlover strips the prefix itself.

## Drivers (isolation)

Selected with `DEMO_DRIVER`:

- **`docker`** (production) — one container per hash from the `dimskraft/yamlover-demo`
  image (published on Docker Hub by CI), with `examples/` baked in. The image is pulled
  once at startup (`DEMO_IMAGE_PULL`), so restarting the demo server picks up a freshly
  pushed `:latest`. `--rm` makes cleanup automatic: stopping the container discards its
  writable layer (including yamlover's index), so there are no host temp dirs to reap.
  Memory/CPU capped per container. Survives a demo-server restart (containers are labeled
  and adopted by `reconcile()`).
- **`process`** (local dev) — one `node yamlover.js` child per hash serving a fresh copy
  of `examples/` in a temp dir. No Docker needed. Children are killed on graceful
  shutdown; cleanup of the temp dir happens on stop.

## Email

Selected with `EMAIL_PROVIDER`:

- **`console`** (default) — logs the link to stdout. Zero setup; good for dev.
- **`resend`** — posts to the Resend HTTPS API (Node's global `fetch`, no npm deps).
  GCE blocks outbound SMTP (port 25), so a hosted API over 443 is required in prod. Set
  `RESEND_API_KEY` and a verified `EMAIL_FROM` domain.

The whole tool has **zero runtime npm dependencies** (`node:http`, `node:sqlite`,
`node:crypto`, `node:child_process`, global `fetch`). Requires Node ≥ 22.

## Run locally (no Docker)

```bash
npm --prefix tools/server run build          # the process driver serves the --prod build
DEMO_DRIVER=process EMAIL_PROVIDER=console \
  PORT=8099 DEMO_BASE_URL=http://127.0.0.1:8099 \
  node tools/demo/bin/demo-server.js
```

Open <http://127.0.0.1:8099/>, submit an email, copy the link printed to the console,
open it.

## The Docker image

In production the driver pulls **`dimskraft/yamlover-demo:latest`** from Docker Hub (CI
builds and pushes it on every change). Just run with the docker driver and it pulls on
startup:

```bash
DEMO_DRIVER=docker node tools/demo/bin/demo-server.js
```

To iterate on the image locally instead, build it and point `DEMO_IMAGE` at the local
tag (and skip the registry pull):

```bash
npm --prefix tools/server run build
docker build -f tools/demo/docker/Dockerfile -t yamlover-demo .   # from the repo root
DEMO_DRIVER=docker DEMO_IMAGE=yamlover-demo DEMO_IMAGE_PULL=0 \
  node tools/demo/bin/demo-server.js
```

## Configuration (environment)

| var | default | meaning |
|-----|---------|---------|
| `DEMO_DRIVER` | `process` | `docker` (prod) or `process` (dev) |
| `DEMO_BASE_URL` | `http://localhost:<PORT>` | public origin the emailed links use |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | demo-server bind (behind Caddy in prod) |
| `TTL_DAYS` | `3` | hard demo lifetime |
| `IDLE_HOURS` | _(off)_ | also reclaim demos idle this long |
| `MAX_DEMOS` | `50` | global concurrent-running cap |
| `DB_PATH` | `tools/demo/.data/demos.db` | sqlite registry |
| `EMAIL_PROVIDER` | `console` | `console` or `resend` |
| `EMAIL_FROM` / `RESEND_API_KEY` | — | Resend sender + key |
| `REGISTER_PER_HOUR` | `3` | per-IP registration rate limit |
| `DEMO_IMAGE` | `dimskraft/yamlover-demo:latest` | docker image (Docker Hub) |
| `DEMO_IMAGE_PULL` | `1` | `docker pull` the image on startup (`0` to skip) |
| `DOCKER_MEMORY` / `DOCKER_CPUS` | `512m` / `1` | per-container caps |
| `EXAMPLES_DIR` / `YAMLOVER_BIN` / `SPOOL_DIR` | repo paths | process-driver inputs |

## Deploy (single Compute Engine VM)

Cloud Run is unsuitable (request-scoped, stateless — we need long-lived child
containers, held ports, multi-day state). Production runs on one VM:
`yamlover.inthemoon.net` (`34.71.33.48`). The demo server itself runs as bare `node`
via systemd (zero npm deps); only the per-visitor yamlover instances are containers.

**Prerequisites (install once, not scripted):** Node ≥ 22, Docker, and Caddy on the
VM; a static external IP; firewall allowing 80/443 only (child container ports stay on
`127.0.0.1`); and DNS `yamlover.inthemoon.net A 34.71.33.48`.

**Provision + every redeploy** — `deploy/bootstrap.sh` (idempotent; assumes the
prerequisites above):

```bash
# first time (clones the repo to /opt/yamlover, installs unit + env + Caddyfile):
sudo REPO_URL=<git-url> bash tools/demo/deploy/bootstrap.sh
# thereafter, to ship the latest main (git-pull + restart):
sudo bash /opt/yamlover/tools/demo/deploy/bootstrap.sh
```

It installs `deploy/yamlover-demo.service`, seeds `/etc/yamlover-demo.env` from the
example (kept on re-runs — your secrets survive), installs `deploy/Caddyfile` as
`/etc/caddy/Caddyfile`, then enables/restarts `yamlover-demo` and reloads Caddy.
Restarting picks up a freshly-pushed `:latest` (the docker driver pulls on startup).

After the first run, **edit `/etc/yamlover-demo.env`** to set `RESEND_API_KEY` (verify
the sending domain's SPF/DKIM in Resend first), then `sudo systemctl restart
yamlover-demo`. No image to build — the driver pulls `dimskraft/yamlover-demo` from
Docker Hub (`docker login` first only if the repo is private).

## Tests

```bash
npm --prefix tools/demo test     # node:test, pure-logic units (no Docker)
```
