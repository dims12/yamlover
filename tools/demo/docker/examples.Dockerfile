# yamlover examples image — the ALWAYS-ON, READ-ONLY instance serving the repo's examples/.
#
# Twin of ./docs.Dockerfile: same server bundle, examples/ instead of docs/, `--read-only`
# baked in so a visitor cannot change the published tree. Build from the REPO ROOT:
#
#   npm --prefix tools/server run build        # produce tools/server/dist
#   docker build -f tools/demo/docker/examples.Dockerfile -t yamlover-examples .
#
# The demo server keeps exactly one of these running and proxies /examples/ to it:
#   docker run -d --rm -e BASE_PATH=/examples -p 127.0.0.1::5173 yamlover-examples

# Distroless: just glibc + the node runtime — see ./Dockerfile for the full rationale.
FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /app/tools/server
COPY tools/server/package.json ./package.json
COPY tools/server/bin ./bin
COPY tools/server/dist ./dist

# The published examples. `--read-only` freezes the USER data only — yamlover still
# maintains its own index under /examples/.yo, which lands in the container's writable
# layer (gone when the container stops), so the dir must be owned by the unprivileged user.
COPY --chown=nonroot:nonroot examples /examples

# The URL prefix, injected via env (distroless has no shell to expand a flag). The demo
# server passes its own EXAMPLES_SITE_BASE_PATH; this default keeps a bare `docker run` working.
ENV BASE_PATH="/examples"
EXPOSE 5173

USER nonroot

# `--read-only` is a FLAG, not $YAMLOVER_READ_ONLY: baked into the image, it cannot be
# switched off by whatever environment the container is started with.
CMD ["/app/tools/server/bin/yamlover.js", "/examples", "--prod", "--headless", "--read-only", "--port", "5173", "--no-gitignore"]
