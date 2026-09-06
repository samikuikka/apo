---
title: Alpha Topology
description: The single-node self-hosted topology supported for alpha.
---

The agent-testing platform has exactly **one supported self-host topology for alpha**:
one node with separate frontend and Control Plane (backend) processes. Task
execution is Source-Owned: Tasks run on the user's machine via `apo task run`
or `apo connect`, never on the server.

## Supported shape

```
   ┌───────────────────────────────────────────┐
   │  User machine (separate, trusted)         │
   │  `apo task run` / `apo connect`           │
   │  runs Task code locally (Source-Owned)    │
   └──────────────────┬────────────────────────┘
                      │ HTTPS / OTLP
                      ▼
                  ┌────────────────────────┐
                  │  Reverse proxy / TLS    │
                  │  (Caddy, nginx, Traefik)│
                  └──────────┬─────────────┘
                             │ HTTPS
                             ▼
         ┌───────────────────────────────────────────┐
         │  One host (VM or bare metal)              │
         │                                           │
         │  ┌─────────────┐    ┌──────────────────┐  │
         │  │  frontend   │◀──▶│ Control Plane    │  │
         │  │  dashboard  │    │ API + scheduler  │  │
         │  └─────────────┘    └──────────────────┘  │
         │  ┌────────────┐  ┌─────────────────────┐ │
         │  │ SQLite or  │  │ persistent data +  │ │
         │  │ Postgres   │  │ artifacts          │ │
         │  └────────────┘  └─────────────────────┘ │
         └───────────────────────────────────────────┘
```

| Component | Alpha role |
|-----------|-----------|
| Reverse proxy | TLS termination and one public ingress. The Server Profile includes Caddy. |
| Frontend dashboard (Next.js) | One container, one replica. |
| Control Plane (FastAPI) | One container, **one replica**. Owns Projects, schedules, durable queue/leases, Runs, and authorization. It never executes Task code. |
| User machine (Source-Owned Execution) | Runs Task code locally via `apo task run` or `apo connect`, then sends traces and results back to the Control Plane over HTTPS. |
| Database | SQLite is the supported default. Postgres is an explicit opt-in for longer-lived shared installations or heavier concurrent writes. |
| Persistent volumes | Database data and Artifacts must survive container restarts. |

## What is explicitly unsupported in alpha

- Two or more backend replicas (the in-memory rate limiter and SSE broadcaster require a single process; multi-replica needs Redis, which is out of scope).
- Stateless / horizontally scaled managed execution.
- Kubernetes manifests and multi-region deploys.
- Queue brokers (Redis, RabbitMQ, SQS, etc).

:::caution
If you need any of the above, you are outside the alpha contract. apo will break in subtle ways (duplicate dispatch, lost SSE events, stale rate-limit state) on a multi-replica backend.
:::

## Choose a deployment profile

| Profile | Reachability | Start command |
|---|---|---|
| Local | This machine only on `127.0.0.1:3000` | `docker compose up -d --build` |
| Server | Public HTTPS domain through Caddy | `docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build` |

Upgrades that touch `deploy/self-host/Caddyfile` need one more command —
`up -d --build` never recreates caddy on a config-file change, and the
single-file bind mount pins the old inode:

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --force-recreate caddy
```

See [Publish Apo on Your Domain](/self-hosting/public-server/) for why and
the post-recreate verification.

Use [Publish Apo on Your Domain](/self-hosting/public-server/) for the complete Server Profile procedure and external smoke test.

## Local deploy path

This is the canonical alpha deploy path. It assumes Docker and Docker Compose on a single host.

1. **Create an env file** with strong secrets:

   ```bash
   cat > .env <<EOF
   AUTH_SECRET=$(openssl rand -hex 32)
   APO_DEPLOYMENT_PROFILE=local
   APO_PUBLIC_URL=http://localhost:3000
   SCHEDULER_ENABLED=true
   EOF
   ```

   The unquoted `EOF` is intentional: it evaluates `openssl` and writes the
   generated secret, not the literal command.

2. **Bring up the default SQLite stack:**

   ```bash
   docker compose up -d --build
   ```

   Expect `frontend` and `backend` only, there is no server-side executor
   service. Task execution is Source-Owned: you run Tasks on your own machine
   with `apo task run` or `apo connect`.

   SQLite data is persisted in the `apo_db` Docker volume. Use the
   [Postgres profile](/self-hosting/configuration/#choose-a-database) when you
   want Postgres; it is not required to try apo or run a small alpha team.

3. **Wait for readiness**: the backend healthcheck verifies Control Plane
   prerequisites (database, artifact store, auth secret).

   ```bash
   curl -fsS http://localhost:8000/health/ready | jq
   ```

   Expect `{"ok": true, "checks": {...}}`. The API is ready once these pass —
   Task execution readiness is determined on your machine when you run
   `apo task run` or `apo connect`.

4. **Create the first admin user.** Either visit the dashboard and walk the account-creation flow, or (for headless first boot only) set `INIT_USER_EMAIL` / `INIT_USER_PASSWORD` / `INIT_USER_NAME` env vars on the backend. The bootstrap runs once (idempotent: no-op when any users exist).

After the first user exists, all further onboarding goes through normal account creation + project invite. See [Configuration](/self-hosting/configuration/) for env vars and email delivery.

:::caution[Source-Owned Execution boundary]
Task code runs on the user's machine, not on the server. `apo task run` and
`apo connect` execute locally with whatever credentials and network access the
user has, the server only stores results and traces. Treat Task repositories
as trusted code, since they run in the developer's own environment.
:::
