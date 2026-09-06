FROM node:22-slim AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/cli/package.json ./packages/cli/package.json
# pnpm >=11 may resolve its standalone @pnpm/exe binary from npm, which
# needs libatomic.so.1 — absent from node slim images.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm && pnpm install --frozen-lockfile

COPY apps/dashboard/ ./apps/dashboard/
COPY packages/ ./packages/

WORKDIR /app/apps/dashboard
ARG BACKEND_URL=http://backend:8000
ENV BACKEND_URL=$BACKEND_URL
ENV NEXT_STANDALONE_OUTPUT=true
RUN pnpm build

FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
# Public static assets (logos, brand SVGs, favicon, etc.) — Next.js does
# not bundle these into .next/standalone, so they must be copied separately
# or routes that read from /public (e.g. /brand/signal-sphere.svg) will 404.
COPY --from=builder --chown=node:node /app/apps/dashboard/public ./apps/dashboard/public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# The Next.js server is the internet-reachable process; it must not run as
# root (the backend container already runs as its own non-root appuser).
USER node
CMD ["node", "apps/dashboard/server.js"]
