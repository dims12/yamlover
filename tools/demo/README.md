# yamlover demo server

Hands each visitor a **private, disposable yamlover** pre-loaded with the repo's
`examples/`. A visitor enters their email, gets a link (`https://demo.host/demo/<hash>/`),
and the first click provisions a yamlover instance served under that path prefix. Each
demo is reaped after a TTL.

It also serves two always-on, read-only trees: **documentation** at `/docs/` and
**examples** at `/examples/` (see below).

```
visitor ─▶ GET /                     registration page (email form)
        ─▶ POST /register            mint 128-bit hash, email the link (lazy: no instance yet)
        ─▶ GET /demo/<hash>/…        first hit provisions an instance, then reverse-proxies to it
        ─▶ GET /docs/…               reverse-proxied to the always-on read-only docs instance
        ─▶ GET /examples/…           reverse-proxied to the always-on read-only examples instance
reaper  ─▶ every 30 min              stop demos past their TTL; reconcile against live instances on boot
```

Routing is **path-prefix**: one domain, one TLS cert, one A record. Each yamlover
instance is launched with `--base-path /demo/<hash>` (`/docs` / `/examples` for the
read-only ones) so the whole app (assets, every `/api/*`, the SSE stream) lives under
that prefix; the proxy forwards the URL unchanged and yamlover strips the prefix itself.

## Always-on read-only sites (`/docs`, `/examples`)

Two extra instances that are **not** demos: no hash, no email, never reaped, always up.
Each runs its own image (`dimskraft/yamlover-docs` / `dimskraft/yamlover-examples`) with
yamlover's `--read-only` flag, so every mutating request is refused with 403 and the UI
shows no edit affordances. Each is kept alive by three triggers, all funnelling through
one `ensure()`:

- **at boot** — started alongside the server, but never blocking it: if a site fails, the
  registration page and the demos still come up;
- **on a hit** — a container that died (or a restarted docker daemon) self-heals on the
  next request; the proxy drops the cached port as soon as the upstream refuses;
- **every `DOCS_REFRESH_MS` / `EXAMPLES_SITE_REFRESH_MS`** (default 30 min) — re-pull the
  image and recreate the container if the tag moved. This is what makes an edit go live:
  CI pushes a new `:latest`, and the next check picks it up **without a redeploy**.

The containers carry `yamlover-docs=1` / `yamlover-examples=1`, never `yamlover-demo=1` —
so the reaper, which filters on the latter, cannot touch them. `DOCS_ENABLED=0` /
`EXAMPLES_SITE_ENABLED=0` turns a site off.

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
  shutdown; cleanup of the temp dir happens on stop. The docs and examples sites are
  children too, serving the repo's `docs/` / `examples/` **in place** (`--read-only`
  means they write no user data).

## Email

Selected with `EMAIL_PROVIDER`:

- **`console`** (default) — logs the link to stdout. Zero setup; good for dev.
- **`resend`** — posts to the Resend HTTPS API (Node's global `fetch`, no npm deps).
  GCE blocks outbound SMTP (port 25), so a hosted API over 443 is required in prod. Set
  `RESEND_API_KEY` and a verified `EMAIL_FROM` domain.

The whole tool has **zero runtime npm dependencies** (`node:http`, `node:sqlite`,
`node:crypto`, `node:child_process`, global `fetch`). Requires Node ≥ 22.

## Logging (Google Cloud Logging)

The server writes **one JSON object per line to its own stdout** and stops there
(`src/log.js`). systemd captures that into the journal, and the **Ops Agent** already on the
VM reads the journal and forwards it — see `deploy/ops-agent-config.yaml` for the config to
merge into `/etc/google-cloud-ops-agent/config.yaml`.

Nothing in this package talks to Google. That is deliberate: it keeps the zero-dependency
rule, needs no service-account credentials in the app, means a Logging outage can never slow
down or wedge a request, and leaves `journalctl --user -u yamlover-demo` working as before.
Setting `LOG_FORMAT=text` gives a readable line instead of JSON; the default follows the TTY,
so an interactive run is legible and a service run emits JSON without being told.

**The children are in the same stream.** A per-visitor container is detached and `--rm`, so
its output would die with it — the docker driver runs `docker logs -f` against each one and
relays it, and the process driver pipes its children directly. Every relayed line carries
`component` and the demo `hash`, so one instance's indexing progress stays attributable
inside the merged stream. `LOG_INSTANCES=0` turns the relay off.

**Volume is the thing to watch**, since Cloud Logging bills by it. Every SPA asset and every
SSE poll is proxied through this server, so `LOG_HTTP=all` is a firehose. The default,
`errors`, keeps the 4xx/5xx that actually need tracing and leaves the traffic questions to
analytics. Failures that a status code alone would not explain (at capacity, instance never
became ready, email send failed) are logged where the reason is known.

**Caddy logs the edge.** `deploy/Caddyfile` enables access logging as JSON to stderr, which
on a system unit means the same journal — so the agent ships it with everything else. This is
the only hop that sees requests which never reach the demo server (a wrong `Host`, a failed
TLS handshake, a client that hangs up mid-proxy) and the only one that sees the real client
address before `X-Forwarded-For`. Static assets are excluded with `log_skip`, for the same
volume reason as `LOG_HTTP`.

Fields worth filtering on in the Logs Explorer:

| field | what |
|-------|------|
| `jsonPayload.hash` | one demo, orchestrator and instance lines together |
| `jsonPayload.component` | `instance`, `docs`, or `examples` — output relayed from a child |
| `severity` | the demo server's level, lifted by the agent |
| `httpRequest` | the demo server's requests, rendered as requests (method/status/latency) |
| `jsonPayload.logger="http.log.access"` | Caddy's access log, which keeps its own shape |

Caddy spells its level `level`, not `severity`, so its entries arrive as DEFAULT severity —
see the note in `deploy/ops-agent-config.yaml`.

## Analytics (GA4)

Set **`GA4_MEASUREMENT_ID`** and the tag is injected at serve time, into the registration
page and into every yamlover instance this server spawns. Leave it unset — which is the
default, and the only possibility outside this deployment — and no third-party script is
injected anywhere. The measurement id lives in the env file rather than the repo, so the
checked-in HTML carries no tag and a fork does not report to this property.

`npx yamlover`, the desktop app and any self-hosted tree serve the same SPA shell and send
**nothing**: the shell only gets a tag when the server is handed a measurement id, and only
this deployment hands one over. A local-first viewer that phoned home by default would be a
different product.

**What each surface reports:**

| surface | reported as | why |
|---------|-------------|-----|
| `/` (registration) | `/` | a plain single-view page, nothing to hide |
| `/docs/…` | its real sub-path | published content — which chapter gets read is the point |
| `/examples/…` | its real sub-path | same: the published examples tree |
| `/demo/<hash>/…` | `/demo/<id>/`, one page | see below |

A demo hash **is** the credential for that instance — anyone holding the URL can open it — so
it must never be copied into a third-party report. Below the mount point the URL is the
yamlover data path, and in a demo the visitor may have typed those node names themselves.
So a demo instance is collapsed to a single page, and its `document.title` (which the SPA
rewrites to the node's own labels) is replaced with a constant.

The redaction is applied with `gtag("set", …)`, as **global** parameters rather than per
event, so the tag's own enhanced-measurement events report the redacted values too instead
of reading `location.href` and routing around it. There is no `anonymize_ip`: that is a
Universal Analytics parameter which GA4 ignores — GA4 truncates the address on receipt and
never stores it.

Implementation: `src/ga4.js` for the landing page, `tools/server/bin/ga4.js` for the SPA
(deliberately not shared — only `tools/demo` is rsynced to the box, `tools/server` arrives as
a Docker image, and the two are versioned apart).

## Run locally (no Docker)

```bash
npm --prefix tools/server run build          # the process driver serves the --prod build
DEMO_DRIVER=process EMAIL_PROVIDER=console \
  PORT=8099 DEMO_BASE_URL=http://127.0.0.1:8099 \
  node tools/demo/bin/demo-server.js
```

Open <http://127.0.0.1:8099/>, submit an email, copy the link printed to the console,
open it. The docs are at <http://127.0.0.1:8099/docs/> and the examples at
<http://127.0.0.1:8099/examples/> (served from the repo, read-only).

## The Docker images

Three, built from the same server production bundle by the same CI job:

| image | content | how it runs |
|-------|---------|-------------|
| `dimskraft/yamlover-demo` | `examples/` | one throwaway container per visitor |
| `dimskraft/yamlover-docs` | `docs/` | one always-on container, `--read-only` |
| `dimskraft/yamlover-examples` | `examples/` | one always-on container, `--read-only` |

In production the driver pulls all three from Docker Hub. Just run with the docker driver and it
pulls on startup:

```bash
DEMO_DRIVER=docker node tools/demo/bin/demo-server.js
```

To iterate on the images locally instead, build them and point `DEMO_IMAGE` / `DOCS_IMAGE`
/ `EXAMPLES_SITE_IMAGE` at the local tags (and skip the registry pull):

```bash
npm --prefix tools/server run build
docker build -f tools/demo/docker/Dockerfile          -t yamlover-demo .   # from the repo root
docker build -f tools/demo/docker/docs.Dockerfile     -t yamlover-docs .
docker build -f tools/demo/docker/examples.Dockerfile -t yamlover-examples .
DEMO_DRIVER=docker DEMO_IMAGE=yamlover-demo DOCS_IMAGE=yamlover-docs \
  EXAMPLES_SITE_IMAGE=yamlover-examples DEMO_IMAGE_PULL=0 \
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
| `EMAIL_FROM` / `RESEND_API_KEY` | `yamlover demo <noreply@…>` / — | Resend sender + key |
| `REGISTER_PER_HOUR` | `3` | per-IP registration rate limit |
| `DEMO_IMAGE` | `dimskraft/yamlover-demo:latest` | docker image (Docker Hub) |
| `DEMO_IMAGE_PULL` | `1` | `docker pull` the images on startup (`0` to skip) |
| `DOCKER_MEMORY` / `DOCKER_CPUS` | `512m` / `1` | per-container caps |
| `DOCS_ENABLED` | `1` | serve the always-on read-only docs instance |
| `DOCS_IMAGE` | `dimskraft/yamlover-docs:latest` | docs image (Docker Hub) |
| `DOCS_BASE_PATH` | `/docs` | URL prefix the docs are served under |
| `DOCS_REFRESH_MS` | `REAP_INTERVAL_MS` | re-pull + recreate the docs container if the tag moved |
| `EXAMPLES_SITE_ENABLED` | `1` | serve the always-on read-only examples instance |
| `EXAMPLES_SITE_IMAGE` | `dimskraft/yamlover-examples:latest` | examples image (Docker Hub) |
| `EXAMPLES_SITE_BASE_PATH` | `/examples` | URL prefix the examples are served under |
| `EXAMPLES_SITE_REFRESH_MS` | `REAP_INTERVAL_MS` | re-pull + recreate the examples container if the tag moved |
| `EXAMPLES_DIR` / `DOCS_DIR` / `YAMLOVER_BIN` / `SPOOL_DIR` | repo paths | process-driver inputs |
| `LOG_FORMAT` | `json` off a TTY, else `text` | line format on stdout |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `notice` \| `warning` \| `error` |
| `LOG_HTTP` | `errors` | which proxied exchanges are logged: `errors` \| `all` \| `off` |
| `LOG_INSTANCES` | `1` | relay each yamlover instance's own output into the stream |
| `GA4_MEASUREMENT_ID` | _(off)_ | GA4 stream; unset means no analytics anywhere |

## Deploy (design-vm)

Production runs on **design-vm** = `yamlover.inthemoon.net` = `34.71.33.48`. The demo
server runs as a **user** systemd service (as `dims`, zero npm deps) from
`~/Design/www/yamlover-demo`; only the per-visitor yamlover instances are containers.
Caddy (system service, already on the box) terminates TLS with the existing
`*.inthemoon.net` wildcard cert and reverse-proxies to `127.0.0.1:8080`.

**Prerequisites (system software, already in place on design-vm):** Node ≥ 22, Docker
(`dims` in the `docker` group), Caddy, the `*.inthemoon.net` cert, DNS pointing at
`34.71.33.48`, and that `dims` has passwordless `sudo`. Everything *yamlover-specific* —
the user unit, env file, Caddy drop-in, linger — is created by the deploy itself. The Ops
Agent, if logs should reach Google Cloud Logging, is a one-time install (see below).

**Deploy = the GitHub `publish-demo-web` workflow** (`.github/workflows/publish-demo-web.yml`),
on a push to `main` touching `tools/demo/**`, or manually via **workflow_dispatch**. There is
**no one-time bootstrap**: every step is idempotent, so a from-scratch host comes up on the
first run and re-runs only refresh what changed. The job:

1. joins the WireGuard VPN and SSHes to design-vm at its tunnel IP `10.9.0.2`;
2. rsyncs the site to `dims@design-vm:Design/www/yamlover-demo` (`--delete`, excluding
   `.data/` so live state survives);
3. seeds `~/.config/yamlover-demo.env` from the example *if absent* (then never clobbers it,
   so secrets/edits survive), installs the user unit, makes `/etc/resend.env` group-readable
   if present, enables linger, and `enable` + `restart`s the service — which re-pulls the
   latest `dimskraft/yamlover-demo`, `dimskraft/yamlover-docs`, and
   `dimskraft/yamlover-examples` images on startup;
4. ensures `/etc/caddy/conf.d` exists and is imported by `/etc/caddy/Caddyfile`, installs
   `deploy/Caddyfile` as the whole-file drop-in `/etc/caddy/conf.d/yamlover.caddy`, then
   `caddy validate` + `systemctl reload caddy`.

Steps 3–4 use `dims`'s passwordless sudo directly. It needs the `WG_CI_CONF` and
`DESIGN_VM_DEPLOY_KEY` secrets; `DEPLOY_HOST`/`DEPLOY_USER` default to `10.9.0.2` (design-vm's
WG IP)/`dims`. The `.forgejo/workflows/` twin is the disabled mirror of the same steps.

Because CI owns the Caddy drop-in, **editing `deploy/Caddyfile` and pushing updates the live
vhost** — never hand-edit the shared Caddyfile. (Migrating a host that still has an old inline
`yamlover.inthemoon.net` block: delete that block once so it doesn't collide with the drop-in.)

To enable email, edit `~/.config/yamlover-demo.env` (`EMAIL_PROVIDER=resend` and a verified
`EMAIL_FROM` — verify SPF/DKIM in Resend first) and put `RESEND_API_KEY=…` in root-only
`/etc/resend.env`, then `systemctl --user restart yamlover-demo`. With `EMAIL_PROVIDER=console`
it instead logs the link to `journalctl --user -u yamlover-demo`.

### Cloud Logging and analytics on the box

Both are **host state, not deploy state** — CI ships code, and neither of these is code, so
turning them on is a one-time manual step that survives every subsequent deploy.

Logging needs the Ops Agent installed once (it is not part of a stock GCE image):

```bash
curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
sudo bash add-google-cloud-ops-agent-repo.sh --also-install
sudo $EDITOR /etc/google-cloud-ops-agent/config.yaml   # merge deploy/ops-agent-config.yaml
sudo systemctl restart google-cloud-ops-agent
```

The VM's service account needs `roles/logging.logWriter`; the default GCE service account
already has it. Verify the pipeline end to end after a restart — a config that parses but
matches nothing looks exactly like a quiet service:

```bash
gcloud logging read 'resource.type="gce_instance" AND jsonPayload.component="instance"' \
  --limit 5 --freshness 10m
```

Analytics is one line in `~/.config/yamlover-demo.env` (`GA4_MEASUREMENT_ID=G-…`) followed by
`systemctl --user restart yamlover-demo`. Two things to check in the GA4 property itself,
because neither is controllable from here:

- create the stream for `https://yamlover.inthemoon.net`, and take the **measurement id**
  (`G-…`), not the stream id;
- in **Enhanced measurement**, the redaction holds because the tag sets its page parameters
  globally — but if you ever add a tag through Google Tag Manager instead, GTM reads
  `location.href` directly and would ship demo hashes. Keep the tag server-injected.

## Tests

```bash
npm --prefix tools/demo test     # node:test, pure-logic units (no Docker)
```
