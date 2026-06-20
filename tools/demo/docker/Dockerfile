# yamlover demo image — ONE throwaway yamlover instance with examples/ baked in.
#
# Built from the LOCAL repo (not the npm package) so the --base-path feature works
# before it's published. Build from the REPO ROOT (so the context sees examples/):
#
#   npm --prefix tools/server run build        # produce tools/server/dist
#   docker build -f tools/demo/docker/Dockerfile -t yamlover-demo .
#
# The demo server runs one container per hash:
#   docker run -d --rm -e BASE_PATH=/demo/<hash> -p 127.0.0.1::5173 yamlover-demo
# `--rm` discards the writable layer (incl. yamlover's index) on stop → no cleanup.

# Distroless: just glibc + the node runtime — no shell, no package manager, no npm.
# The runtime is pure `node` (the prod bundle is self-contained), so we need nothing
# else. This is strictly leaner and Scout-cleaner than node:*-slim (npm and its CVE-
# bearing deps — picomatch / tar / ip-address / brace-expansion — aren't even present
# to remove), and it ships a `nonroot` user, so we drop privileges by construction.
# The image's ENTRYPOINT is already `/usr/bin/node`, so CMD below is just node's args.
FROM gcr.io/distroless/nodejs22-debian12:nonroot

# Replicate the published package's runtime shape: package.json + bin + dist only
# (no src, no node_modules — the prod bundle is self-contained).
WORKDIR /app/tools/server
COPY tools/server/package.json ./package.json
COPY tools/server/bin ./bin
COPY tools/server/dist ./dist

# The content each demo serves. Read-only template; yamlover writes its index under
# /examples/.yamlover in the container's writable layer, gone when the container stops.
# Owned by the unprivileged `nonroot` user (uid 65532) so it can write that index.
COPY --chown=nonroot:nonroot examples /examples

# --base-path is per-demo; the server reads it from $BASE_PATH (no shell needed to
# expand it into a flag — distroless has no shell). Empty = served at the document root.
ENV BASE_PATH=""
EXPOSE 5173

# distroless ships /etc/passwd with a uid-65532 `nonroot` user; the :nonroot tag already
# defaults USER to it. Stated explicitly so the intent survives a base-tag change.
USER nonroot

# --headless binds 0.0.0.0 inside the container (the demo server publishes it to a
# loopback host port). Exec-form CMD (no shell) → node is PID 1 and gets SIGTERM
# directly, so `docker stop` is fast (no 10s grace fallthrough).
CMD ["/app/tools/server/bin/yamlover.js", "/examples", "--prod", "--headless", "--port", "5173", "--no-gitignore"]
