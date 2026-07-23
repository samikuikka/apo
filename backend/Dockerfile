# syntax=docker/dockerfile:1.7
#
# Backend image for the self-hosted alpha topology (SPEC-124 / SPEC-125).
#
# Build context MUST be the repo root so we can:
#   1. Build the agent-task runtime bundle from packages/sdk.
#   2. Copy that bundle into /app/agent-task-runtime so the backend can
#      run agent tasks without depending on dev-only tsx or live .ts
#      source imports.
#   3. Bundle the example-service demo task tree so the demo workspace
#      fixture works in the container without mounting the repo.
#
# Compose invocation:
#   docker compose build
# (the compose files set context: .. and dockerfile: backend/Dockerfile)

# ---- Node builder: emit the agent-task runtime bundle (SPEC-125) ----
FROM node:22-slim AS agent-task-builder

WORKDIR /workspace

# Install only the SDK package + its dev deps so esbuild is available.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN npm install -g pnpm && pnpm install --frozen-lockfile --filter @apo/sdk...

# Copy SDK source, build its published entry points for task imports, then
# build the standalone runner. The demo task package resolves
# `@apo/sdk/agent-task` through the package's default `dist` export; building
# only runner.mjs leaves that export dangling inside the backend image.
COPY packages/sdk/ ./packages/sdk/
RUN pnpm --filter @apo/sdk build \
    && pnpm --filter @apo/sdk build:agent-task-runtime

# ---- Python builder: compile C extensions, install deps ----
FROM python:3.13-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libpq-dev && rm -rf /var/lib/apt/lists/*

# Install dependencies directly into the system Python so the install
# paths are stable across builder and runner stages. A venv built on the
# host (or in a prior layer) would carry absolute symlinks pointing at
# host-specific paths and break when copied into the runner stage.
COPY backend/pyproject.toml backend/uv.lock ./
RUN pip install --no-cache-dir uv \
    && uv export --frozen --no-dev --no-editable -o /tmp/requirements.txt \
    && pip install --no-cache-dir --prefix=/install -r /tmp/requirements.txt

# ---- Runner stage: minimal runtime image ----
FROM python:3.13-slim AS runner

# Copy Node 22 from the agent-task-builder stage so the runner gets
# --experimental-strip-types support (Node 20.x lacks it). Without that
# flag, plain node cannot load the .ts task files that real task sources
# ship. npm comes along for the ride.
COPY --from=agent-task-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=agent-task-builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# SPEC-125 / SPEC-126 hardening: the runtime needs:
#   - curl, dumb-init, libpq5: process + DB client
#   - git: required so synced Git task sources can clone/fetch
#   - jq: used by the operator smoke script
#   - the demo task tree must be inside the image for the demo fixture
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl dumb-init libpq5 git jq \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 appuser

# Install pnpm + yarn directly via npm (avoids corepack version-pinning
# issues across Node releases). npm itself shipped with Node above; pip
# ships with Python.
RUN npm install -g pnpm@9.15.0 yarn

# Install uv standalone so the installer policy can satisfy uv.lock
# workspaces. The Astral standalone installer keeps the image smaller
# than `pip install uv` and pins to a single version.
#
# The installer itself and the uv binary MUST succeed — if either fails,
# the build fails loudly (no `|| true`). uvx is best-effort because
# older installer versions don't ship it.
RUN curl -LsSf https://astral.sh/uv/0.7.8/install.sh | sh \
    && test -x /root/.local/bin/uv \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && if [ -f /root/.local/bin/uvx ]; then mv /root/.local/bin/uvx /usr/local/bin/uvx; fi

# Install Poetry so the installer policy can satisfy poetry.lock
# workspaces. Pure-Python install via pip keeps the image bloat minimal.
RUN pip install --no-cache-dir poetry==1.8.5

WORKDIR /app

# Copy the installed Python packages from the builder into the system
# site-packages. Both stages use python:3.13-slim, so the install prefix
# is compatible.
COPY --from=builder /install /usr/local
COPY backend/ ./

# SPEC-125: agent-task runtime bundle built in the first stage.
COPY --from=agent-task-builder \
    /workspace/packages/sdk/dist/agent-task-runtime /app/agent-task-runtime

# SPEC-126 fixture: bundle the example-service demo task tree so the
# demo workspace works in the container without mounting the repo.
COPY apps/example-service/e2e/agent-task-demo /app/apps/example-service/e2e/agent-task-demo

# Make the demo task tree self-contained so its tasks can run without the
# monorepo's node_modules. Demo files import:
#   - @apo/sdk/agent-task  (install the locally built SDK package)
#   - zod, ai, @ai-sdk/openai (real npm deps the demo adapters use)
# Installing these here (rather than relying on the task-dependency installer)
# bakes them into the image so first-run latency is zero and there's no
# committed lockfile to keep in sync with the monorepo. Installing the local
# SDK package also installs its runtime dependencies beside the task tree.
#
# Versions are pinned exactly (not ^ranges) because the demo tree intentionally
# has no lockfile: a fresh build re-resolves from npm, and a caret range lets
# an upstream release break the build with no warning. zod is on the 4.x line
# because @anthropic-ai/claude-agent-sdk (declared by the demo's package.json)
# has a hard peer dependency on zod ^4.0.0; installing zod 3.x makes npm abort
# with ERESOLVE. ai@^6 and @ai-sdk/openai@^3 both accept zod 3 or 4.
COPY --from=agent-task-builder /workspace/packages/sdk /app/_sdk-source
RUN rm -rf /app/_sdk-source/node_modules \
    && cd /app/_sdk-source \
    && npm install --omit=dev --no-audit --no-fund --package-lock=false
RUN cd /app/apps/example-service/e2e/agent-task-demo \
    && npm install --no-save --no-audit --no-fund \
        zod@4.4.3 ai@6.0.230 @ai-sdk/openai@3.0.86 /app/_sdk-source

RUN mkdir -p /app/data \
        /var/lib/apo/task-sources \
    && chown -R appuser:appuser /app/data /app/agent-task-runtime /app/apps /var/lib/apo

# Pin the runtime location so the backend status probe and the task runner
# agree on the path.
ENV AGENT_TASK_RUNTIME_DIR=/app/agent-task-runtime
# Point the demo workspace at the bundled task tree. The discovery root is the
# directory that directly contains the per-agent task folders; pointing it one
# level higher leaks the ``tasks/`` segment into every task id and breaks
# dashboard routing.
ENV DEMO_TASK_ROOT=/app/apps/example-service/e2e/agent-task-demo/tasks

USER appuser

EXPOSE 8000

ENTRYPOINT ["dumb-init", "--"]
CMD ["uvicorn", "apo.api:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
