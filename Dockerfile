# syntax=docker/dockerfile:1
#
# freeitsm-mcp-server as a container: MCP over stdio, so run it with `docker run -i`.
# See "Docker" in README.md for the recommended (locked-down) run flags.
#
# Base images are pinned by digest, so a plain rebuild never picks up their security
# updates. Build with `npm run docker:build`: it moves each pin to the digest its tag
# points to now, audits the dependencies, builds and scans. Dependabot proposes the
# same digest updates as pull requests.

# ---- build: compile TypeScript ------------------------------------------------
FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency install scripts run, and `prepare` (tsc) waits for the sources
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- deps: production dependencies only ----------------------------------------
FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime: distroless, no shell, no package manager, non-root ---------------
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:39c66687298417dbf3ff2fb8b6012c20554494e16414ef7afd07b9abbb45b501
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
