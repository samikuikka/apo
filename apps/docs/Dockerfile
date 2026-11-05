# Multi-stage static docs image.
#
# Build stage compiles the Astro site + publishes versioned schemas behind the
# publication gate. Runtime stage contains only the built static output and a
# pinned Caddy static-file server — no source, no Node, no package manager,
# no secrets, no repository mount.
#
# Build context is the repo root (see docker-compose.public-docs.yml).

FROM node:22-slim AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs/package.json ./apps/docs/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/cli/package.json ./packages/cli/package.json
RUN npm install -g pnpm@11.3.0 && pnpm install --frozen-lockfile

COPY apps/docs/ ./apps/docs/
COPY contracts/ ./contracts/
# verify-hosted-contracts.mjs reads these two files from outside apps/docs
# to keep hosted copy truthful against the example and the dashboard.
COPY apps/example-service/e2e/agent-task-demo/START-HERE.md ./apps/example-service/e2e/agent-task-demo/START-HERE.md
COPY apps/dashboard/src/lib/first-run.ts ./apps/dashboard/src/lib/first-run.ts

WORKDIR /app/apps/docs
# Umami beacon config for the operator's deployment. Empty by default, so
# non-operator builds carry no analytics. Both vars are consumed in
# apps/docs/src/components/Head.astro.
ARG PUBLIC_UMAMI_URL=
ARG PUBLIC_UMAMI_WEBSITE_ID=
ENV PUBLIC_UMAMI_URL=$PUBLIC_UMAMI_URL \
    PUBLIC_UMAMI_WEBSITE_ID=$PUBLIC_UMAMI_WEBSITE_ID
RUN pnpm build

# --- runtime: pinned static server, built output only ---
FROM caddy:2.10.2-alpine

# The official image sets cap_net_bind_service+ep on the binary so it can bind
# ports <1024. We bind :8080 only, and cap_drop:[ALL] empties the bounding set,
# which makes the kernel reject the exec ("operation not permitted"). Strip the
# file capability so the hardened container starts cleanly.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy

COPY --from=builder /app/apps/docs/dist /srv
COPY apps/docs/Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080
