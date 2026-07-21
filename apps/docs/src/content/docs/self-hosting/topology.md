---
title: Alpha Topology
description: The single-node self-hosted topology supported for alpha.
---

The agent-testing platform has exactly **one supported self-host topology for alpha**: a single node that colocates web, scheduler, and execution. This is intentional: it is cheap, observable, and supportable. Horizontal scaling is a non-goal for alpha.

## Supported shape

```
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
        │  │  frontend   │◀──▶│     backend      │  │
        │  │  dashboard  │    │  (FastAPI +      │  │
        │  │  container  │    │   scheduler +    │  │
        │  └─────────────┘    │   task runtime)  │  │
        │                     └────────┬─────────┘  │
        │                              │            │
        │             ┌────────────────┼─────────┐  │
        │             ▼                ▼         ▼  │
        │      ┌────────────┐  ┌────────────┐ ┌───┐ │
        │      │ Postgres   │  │ task-source│ │ … │ │
        │      │ (or SQLite │  │ cache vol  │ │   │ │
        │      │ for dev)   │  │            │ │   │ │
        │      └────────────┘  └────────────┘ └───┘ │
        └───────────────────────────────────────────┘
```

| Component | Alpha role |
|-----------|-----------|
| Reverse proxy | TLS termination, single ingress, no path-based routing tricks. |
| Frontend dashboard (Next.js) | One container, one replica. |
| Backend (FastAPI) | One container, **one replica**. Owns API, scheduler, task execution. |
| Postgres | Use for any shared deployment. SQLite is dev/single-user only. |
| Persistent volumes | Database data + task-source cache must survive container restarts. |

## What is explicitly unsupported in alpha

- Two or more backend replicas (the in-memory rate limiter and SSE broadcaster require a single process; multi-replica needs Redis, which is out of scope).
- Stateless / horizontally scaled task execution.
- Kubernetes manifests and multi-region deploys.
- Queue brokers (Redis, RabbitMQ, SQS, etc).

:::caution
If you need any of the above, you are outside the alpha contract. apo will break in subtle ways (duplicate dispatch, lost SSE events, stale rate-limit state) on a multi-replica backend.
:::

## Deploy path

This is the canonical alpha deploy path. It assumes Docker and Docker Compose on a single host.

1. **Create an env file** with strong secrets:

   ```bash
   cat > .env <<'EOF'
   AUTH_SECRET=$(openssl rand -hex 32)
   POSTGRES_PASSWORD=$(openssl rand -hex 16)
   POSTGRES_DB=apo
   NEXTAUTH_URL=https://your-host.example
   SCHEDULER_ENABLED=true
   EOF
   ```

   Use real values; do not copy the placeholders verbatim.

2. **Bring up the stack** with one canonical Postgres-backed compose file:

   ```bash
   docker compose up -d --build
   ```

3. **Wait for readiness**: the backend healthcheck uses `/health/ready`, which verifies the database, task-source cache, and auth secret are actually usable.

   ```bash
   curl -fsS http://localhost:8000/health/ready | jq
   ```

   Expect `{"ok": true, "checks": {...}}`. A 503 with a `checks` payload tells you exactly which prerequisite failed.

4. **Configure the reverse proxy** to terminate TLS and forward to the dashboard container on port 3000. Browsers use `/backend-proxy/*`; server-rendered pages use the internal `BACKEND_URL` directly. The public origin does not need to be reachable from inside the frontend container, so host-port remapping works without changing the container's listen port.

5. **Create the first admin user.** Either visit the dashboard and walk the account-creation flow, or (for headless first boot only) set `INIT_USER_EMAIL` / `INIT_USER_PASSWORD` / `INIT_USER_NAME` env vars on the backend. The bootstrap runs once (idempotent: no-op when any users exist).

After the first user exists, all further onboarding goes through normal account creation + project invite. See [Configuration](/self-hosting/configuration/) for env vars and email delivery.
