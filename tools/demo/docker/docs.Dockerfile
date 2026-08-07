# yamlover docs image — the ALWAYS-ON, READ-ONLY instance serving the repo's docs/.
#
# Same shape as ./Dockerfile (the per-visitor demo image), with two differences: the
# baked content is docs/ instead of examples/, and the server runs with `--read-only`
# so no visitor can change the published documentation. Build from the REPO ROOT:
#
#   npm --prefix tools/server run build        # produce tools/server/dist
#   docker build -f tools/demo/docker/docs.Dockerfile -t yamlover-docs .
#
# The demo server keeps exactly one of these running and proxies /docs/ to it:
#   docker run -d --rm -e BASE_PATH=/docs -p 127.0.0.1::5173 yamlover-docs

# Distroless: just glibc + the node runtime — see ./Dockerfile for the full rationale.
FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /app/tools/server
COPY tools/server/package.json ./package.json
COPY tools/server/bin ./bin
COPY tools/server/dist ./dist

# The published documentation. `--read-only` freezes the USER data only — yamlover still
# maintains its own index under /docs/.yo, which lands in the container's writable layer
# (gone when the container stops), so the dir must be owned by the unprivileged user.
COPY --chown=nonroot:nonroot docs /docs

# The URL prefix, injected via env (distroless has no shell to expand a flag). The demo
# server passes its own DOCS_BASE_PATH; this default keeps a bare `docker run` working.
ENV BASE_PATH="/docs"
EXPOSE 5173

USER nonroot

# `--read-only` is a FLAG, not $YAMLOVER_READ_ONLY: baked into the image, it cannot be
# switched off by whatever environment the container is started with.
CMD ["/app/tools/server/bin/yamlover.js", "/docs", "--prod", "--headless", "--read-only", "--port", "5173", "--no-gitignore"]
