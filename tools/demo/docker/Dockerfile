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

FROM node:22-slim

# The runtime is pure `node` (the prod bundle is self-contained) — npm is never
# invoked here. Drop npm + its bundled node_modules: that's where Docker Scout's
# CVEs live (picomatch / tar / ip-address / brace-expansion are npm's own deps),
# and removing it clears them all without touching anything we run.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Replicate the published package's runtime shape: package.json + bin + dist only
# (no src, no node_modules — the prod bundle is self-contained).
WORKDIR /app/tools/server
COPY tools/server/package.json ./package.json
COPY tools/server/bin ./bin
COPY tools/server/dist ./dist

# The content each demo serves. Read-only template; yamlover writes its index under
# /examples/.yamlover in the container's writable layer, gone when the container stops.
# Owned by the unprivileged `node` user so it can write that index while running non-root.
COPY --chown=node:node examples /examples

ENV BASE_PATH=""
EXPOSE 5173

# Run unprivileged (the node image ships a uid-1000 `node` user). Nothing here needs
# root: it binds 5173 (>1024) and only writes under /examples, which `node` owns.
USER node

# --headless binds 0.0.0.0 inside the container (the demo server publishes it to a
# loopback host port). --base-path is per-demo, injected via `-e BASE_PATH`.
# `exec` makes node PID 1 so it receives SIGTERM directly — `docker stop` is then
# fast (no 10s grace fallthrough that a non-forwarding `sh` PID 1 would cause).
CMD ["sh", "-c", "exec node /app/tools/server/bin/yamlover.js /examples --prod --headless --port 5173 --no-gitignore --base-path \"$BASE_PATH\""]
