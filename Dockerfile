# syntax=docker/dockerfile:1
#
# freeitsm-mcp-server as a container: MCP over stdio, so run it with `docker run -i`.
# See "Docker" in README.md for the recommended (locked-down) run flags.
#
# Base images are pinned by digest; bump the tag and digest together.

# ---- build: compile TypeScript ------------------------------------------------
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency install scripts run, and `prepare` (tsc) waits for the sources
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- deps: production dependencies only ----------------------------------------
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime: distroless, no shell, no package manager, non-root ---------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
LABEL org.opencontainers.image.title="freeitsm-mcp-server" \
      org.opencontainers.image.description="MCP server for the FreeITSM REST API (stdio)" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json LICENSE ./
# Files are owned by root and the process runs as nonroot (65532), so it cannot modify its own code.
USER 65532:65532
# The distroless entrypoint is node itself.
CMD ["dist/index.js"]
