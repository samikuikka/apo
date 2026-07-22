---
title: Configuration
description: Env vars, databases, scheduler, email, and troubleshooting for self-hosting.
---

## Choose a database

The default Docker stack uses SQLite in a persistent `apo_db` volume. It is the
supported alpha default: no separate database service, credentials, or backup
tooling is required to get a trial or small team running.

Choose Postgres when the installation is long-lived, several users will write
concurrently, or your operations already standardize on Postgres. This changes
the database, not apo's topology: both database choices still run exactly one backend
and one scheduler owner.

| Database | Use it for | Start command |
|---|---|---|
| SQLite (default) | Trials and small single-node alpha teams | `docker compose up -d --build` |
| Postgres (optional) | Longer-lived shared installations, heavier concurrent writes, existing Postgres operations | `docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build` |

To enable Postgres, add its credentials to `.env` without printing the secret:

```bash
printf '\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=apo\n' "$(openssl rand -hex 16)" >> .env
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build
```

Expected database services:

```text
SQLite:    frontend, backend
Postgres:  frontend, backend, postgres
```

The database choice composes with public ingress. To run a public Server
Profile with Postgres, apply both overrides:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.server.yml up -d --build
```

Expected public services:

```text
frontend, backend, postgres, caddy
```

:::caution[Database profiles are not scaling profiles]
Postgres does not make multiple apo backend replicas safe. The scheduler,
rate limiter, and live trace broadcaster still require one backend process in
the alpha topology.
:::

## Readiness endpoint

`GET /health/ready` is the operator-grade probe. It returns 200 when the deployment is actually usable and 503 otherwise. Checks include:

- **database**: can the backend reach the configured `DATABASE_URL`?
- **task_source_cache**: is `TASK_SOURCE_CACHE_DIR` writable?
- **auth_secret**: present, non-placeholder, and at least 16 characters when not in dev mode.
- **task_runtime**: agent-task subprocess runtime is installed.

This endpoint is intentionally separate from the basic `/health` liveness probe, which only confirms the process booted.

## Scheduler ownership

Alpha assumes **one backend process owns the scheduler**. The in-process dispatcher starts in the FastAPI lifespan and is controlled by `SCHEDULER_ENABLED`:

- `SCHEDULER_ENABLED=true` (default): schedules dispatch normally.
- `SCHEDULER_ENABLED=false`: schedules remain visible but do not fire.

:::caution[Scheduler ownership]
Never run two backend processes with `SCHEDULER_ENABLED=true` against the same database. The scheduler is in-process and single-owner, so two instances will both dispatch every due schedule, producing duplicate batch runs.
:::

## Email delivery (optional)

Email is **off by default** (log-only). The platform works fully without it, with no provider, credentials, or DNS setup required to get started.

**Without email configured:**

- **Signup is instant**: email verification is off by default.
- **Invitations are copy-link**: the dashboard hands you a join link to paste to a teammate.
- **Password reset is admin-assisted**: reset a forgotten password via `scripts/reset_password.py` until email is on.

**To enable delivery** (fully optional, provider-agnostic) set two env vars and restart the backend:

```bash
EMAIL_TRANSPORT_URL=smtp://USER:PASS@smtp.provider.com:587
EMAIL_FROM_ADDRESS=noreply@yourdomain.com
# optional:
EMAIL_FROM_NAME=apo
```

- `smtp://…` works with **any** SMTP provider (Resend, Brevo, Mailgun, Gmail, …).
- `ses://us-east-1` uses **AWS SES** (boto3). Both transports are built in.
- Port `465` = implicit TLS, `587` = STARTTLS (auto-detected).

## Cost-aware defaults

apo never forces an expensive model. Every hardcoded default is a deliberately cheap one (`google/gemini-2.5-flash-lite`), and stronger models are always an opt-in — by env var, by `runTask({ judge })`, or per `t.judge(...)` call. You will never see an unexpected charge because apo silently swapped your judge onto a frontier model.

Alpha defaults are intentionally cheap across the rest of the stack too:

- **One node.** Do not provision extra capacity unless you see real pressure.
- **SQLite first.** Start with the default and move to Postgres when concurrent
  writes or your operational requirements justify the extra service.
- **Cheap default model** for agent tasks (`google/gemini-2.5-flash-lite` via OpenRouter by default; override with `AGENT_TASK_OPENROUTER_MODEL`).
- **Per-call judge escalation.** Escalate a single finicky criterion without switching the whole run: `t.judge(value, instruction, { judge: { model: "anthropic/claude-sonnet-4.5" } })`. Every other call stays on the cheap default. See [Assertions → Overriding the judge model per call](/reference/assertions/#overriding-the-judge-model-per-call).
- **Conservative schedules**: adaptive cadence defaults to ≥ 1 day between runs.
- **Log rotation** is configured in every Compose service (`max-size: 10m`, `max-file: 3`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `/health/ready` returns 503 with `task_source_cache` failing | The cache dir is inside the container rootfs or read-only. | Mount the `task_source_cache` volume and set `TASK_SOURCE_CACHE_DIR=/var/lib/apo/task-sources`. |
| `/health/ready` returns 503 with `auth_secret` failing | `AUTH_SECRET` is the placeholder or unset in non-dev mode. | Generate a strong secret with `openssl rand -hex 32`. |
| Schedules visible but never fire | `SCHEDULER_ENABLED=false`. | Set it to `true` (one backend process only). |
| Tasks fail with "agent-task runtime not installed" | The backend image is missing the packaged runtime. | Rebuild the backend image. |
| SQLite shows sustained lock contention or write latency | The installation has outgrown the default database profile. | Back up the installation, configure the Postgres override, and migrate the data deliberately. Do not use `docker compose down -v`; it deletes volumes. |

## Operator checklist

Before declaring an internal alpha instance production-ready for coworkers:

- [ ] One host, one backend container, one scheduler owner.
- [ ] `AUTH_SECRET` is a strong random value (not the placeholder).
- [ ] The chosen database profile matches the expected write load; SQLite is
      supported for a small alpha, while Postgres is preferred for sustained
      shared use.
- [ ] `task_source_cache` is on a persistent volume.
- [ ] The [Server Profile smoke test](/self-hosting/public-server/#3-prove-the-public-route) passes from outside the host.
- [ ] `/health/ready` returns 200 from outside the host.
- [ ] At least one end-to-end task run has been completed successfully.
