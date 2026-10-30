# Self-Hosted Alpha Topology

The agent-testing platform has exactly **one supported self-hosted topology for
alpha**: a single node with separate frontend and Control Plane (backend)
processes. Task execution is Source-Owned: Tasks run on the user's machine via
`apo task run` or `apo connect`, never on the server.

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

Components:

| Component | Alpha role |
|-----------|-----------|
| Reverse proxy | TLS termination, single ingress, no path-based routing tricks. |
| Frontend dashboard (Next.js) | One container, one replica. |
| Backend / Control Plane | One container, **one replica**. Owns API, scheduler, queue/leases, Runs, and authorization. Never executes Task code. |
| User machine (Source-Owned Execution) | Runs Task code locally via `apo task run` or `apo connect`, then sends traces and results back to the Control Plane over HTTPS. |
| Database | SQLite is the supported default. Postgres is an explicit opt-in for longer-lived shared installations or heavier concurrent writes. |
| Persistent volumes | Database data and Artifacts must survive container restarts. |

## What is explicitly unsupported in alpha

- Two or more backend replicas (the in-memory rate limiter and SSE broadcaster require a single process; multi-replica needs Redis, which is out of scope).
- Stateless / horizontally scaled managed execution.
- Kubernetes manifests and multi-region deploys.
- Queue brokers (Redis, RabbitMQ, SQS, etc).

If you need any of the above, you are outside the alpha contract.

## Deployment profiles

| Profile | Reachability | Start command |
|---|---|---|
| Local | This machine only; ports bind to `127.0.0.1` | `docker compose up -d --build` |
| Server | Public HTTPS domain through Caddy | `docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build` |

The Server Profile makes one installation reachable by browsers, the CLI, and
sandboxed agents. Caddy is the included reference ingress; an existing nginx,
Traefik, tunnel, or load balancer can replace it by forwarding to the frontend.

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

   SQLite data is persisted in the `apo_db` Docker volume. Use the Postgres
   override below when you want Postgres; it is not required to try apo or run
   a small alpha team.

3. **Wait for readiness** — the backend healthcheck uses `/health/ready`, which verifies the database, artifact store, and auth secret are actually usable:

   ```bash
   curl -fsS http://localhost:8000/health/ready | jq
   ```

   Expect `{"ok": true, "checks": {...}}`. A 503 with a `checks` payload tells you exactly which prerequisite failed.

4. **Create the first admin user.** Either visit the dashboard and walk the account-creation flow, or — for headless first boot only — set `INIT_USER_EMAIL` / `INIT_USER_PASSWORD` / `INIT_USER_NAME` env vars on the backend. The bootstrap runs once (idempotent — no-op when any users exist). **These env vars are unset by default**; operators set them explicitly when they want a headless first boot, never as a baked-in default.

After the first user exists, all further onboarding goes through normal account creation + project invite (see Settings → Members). Invitations are copy-link by default — no email setup needed (see [Email delivery](#email-delivery-optional)). Do not rotate `INIT_USER_*` to provision additional users — that path is closed by the idempotency check.

## Publish the Server Profile

Point a hostname such as `apo.example.com` at the Docker host, allow inbound
TCP 80/443, and set the public profile in `.env`:

```bash
APO_DEPLOYMENT_PROFILE=server
APO_PUBLIC_URL=https://apo.example.com
```

Start the base stack with the Caddy override:

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
```

Caddy obtains and renews HTTPS automatically. The frontend and backend keep
their loopback-only diagnostic ports; only Caddy accepts internet traffic.
From a different machine, prove all three public routes:

```bash
scripts/public-ingress-smoke.sh https://apo.example.com
```

```text
public ingress: ok
  dashboard: https://apo.example.com/
  API:       https://apo.example.com/backend-proxy
  OTLP:      https://apo.example.com/api/public/otel/v1/traces
```

Configure the CLI with
`APO_BACKEND_URL=https://apo.example.com/backend-proxy` and telemetry exporters
with `APO_OTLP_ENDPOINT=https://apo.example.com/api/public/otel/v1/traces`.

## Email delivery (optional)

Email is **off by default** (log-only). The platform works fully without it — no provider, no credentials, no DNS setup required to get started.

**Without email configured:**

- **Signup is instant** — email verification is off by default (`AUTH_EMAIL_VERIFICATION_REQUIRED=false`), so new accounts are active immediately.
- **Invitations are copy-link** — the dashboard hands you a join link to paste to a teammate (Slack, email, whatever). They accept at `/accept-invitation?token=…` and join, or create an account if they don't have one yet.
- **Password reset is admin-assisted** — ask the user to submit the **Forgot
  password** form, then read the generated link from the backend logs:

  ```bash
  docker compose logs backend | grep 'Reset URL:'
  ```

  ```text
  backend-1 | ... Reset URL: https://apo.example.com/reset-password?token=...
  ```

  Send the one-hour link to the user privately.

**To enable delivery** (fully optional, provider-agnostic) set two env vars and restart the backend:

```bash
EMAIL_TRANSPORT_URL=smtp://USER:PASS@smtp.provider.com:587
EMAIL_FROM_ADDRESS=noreply@yourdomain.com
# optional:
EMAIL_FROM_NAME=apo
```

- `smtp://…` works with **any** SMTP provider (Resend, Brevo, Mailgun, Gmail, …).
- `ses://us-east-1` uses **AWS SES** (boto3). Both transports are built in.
- Port `465` = implicit TLS, `587` = STARTTLS (auto-detected; override with `EMAIL_SMTP_TLS=true/false`).

Turning it on instantly lights up all senders: invitation emails, verification codes (set `AUTH_EMAIL_VERIFICATION_REQUIRED=true` if you want to require them), password-reset links, and hosted-access admission emails. Without email configured, hosted-access invitations still work — the admin settings page shows a one-time copyable `/join` link to share privately.

**Deliverability:** to land in inboxes rather than spam, send from a domain you own and add the SPF/DKIM/DMARC records your provider generates. A quick free option is [Resend](https://resend.com) (3,000 emails/month, 100/day free) — sign up, verify your domain, and point `EMAIL_TRANSPORT_URL` at its SMTP relay.

## Readiness endpoint

`GET /health/ready` is the operator-grade probe. It returns 200 when the deployment is actually usable and 503 otherwise. Checks include:

- **database** — can the backend reach the configured `DATABASE_URL`?
- **auth_secret** — present, non-placeholder, and at least 16 characters when not in dev mode.
- **artifact_store** — Revision Bundles and Artifacts can be persisted.

This endpoint is intentionally separate from the basic `/health` liveness probe, which only confirms the process booted.

## Runtime config endpoint

`GET /v1/system/runtime-config` (admin-only) returns:

```json
{
  "backend_url": "http://backend:8000",
  "frontend_url": "http://frontend:3000",
  "database": {
    "engine": "sqlite",
    "host": null,
    "name": "//app/data/apo.db",
    "credentials_configured": false,
    "shared_use_recommended": false
  },
  "task_execution_mode": "source_owned",
  "scheduler_enabled": true,
  "supported_topology": "single-node-alpha"
}
```

The `database` field is a sanitized descriptor — credentials are never
exposed through this endpoint, even to admins. This is surfaced in the
dashboard at **Settings → System → Deployment Topology**.

## Task execution dependencies

Under Source-Owned Execution, Tasks run from your own checkout via
`apo task run` or `apo connect`, so dependency installation happens in your
local environment — the server never clones sources or installs packages.

### Optional: GitHub-token encryption for automations

`AUTOMATION_TOKEN_ENCRYPTION_KEY` enables `github_issue` automations (rules
that open an issue when runs fail). Generate a Fernet key and set it in the
backend environment:

```
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Without it, webhook automations work fine; creating a `github_issue`
automation that supplies a token returns 503 instead of storing a
plaintext PAT.

### Operator notes

- Install dependencies in your Task repository before running (`pnpm install`,
  `npm install`, `uv sync`, etc.). `apo task run` executes against your local
  workspace as-is.
- If a source repo intentionally ships without a lockfile (e.g. the bundled
  example-service tasks that rely on the SDK resolved via the monorepo), no
  install is needed and execution proceeds normally.

## Choose a database

The default Docker stack uses SQLite in the persistent `apo_db` volume. It is
the supported default for trials and small single-node alpha teams.

Choose Postgres for a longer-lived shared installation, heavier concurrent
writes, or when your operations already standardize on Postgres:

```bash
printf '\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=apo\n' "$(openssl rand -hex 16)" >> .env
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build
```

The Postgres override changes only the database. It does not make multiple apo
backend replicas safe; both database choices retain one backend and one scheduler owner.

## Scheduler ownership

Alpha assumes **one backend process owns the scheduler**. The in-process dispatcher starts in the FastAPI lifespan and is controlled by `SCHEDULER_ENABLED`:

- `SCHEDULER_ENABLED=true` (default) — schedules dispatch normally.
- `SCHEDULER_ENABLED=false` — schedules remain visible but do not fire. The system settings page reflects this clearly.

Never run two backend processes with `SCHEDULER_ENABLED=true` against the same database; you will get duplicate dispatch.

## Cost-aware defaults

Alpha defaults are intentionally cheap:

- **One node.** Do not provision extra capacity unless you see real pressure.
- **SQLite first.** Move to Postgres when sustained concurrent writes or your
  operational requirements justify the extra service.
- **Cheap default model** for agent tasks (`deepseek/deepseek-v4.1-flash` via OpenRouter by default; override with `AGENT_TASK_OPENROUTER_MODEL`).
- **Conservative schedules** — adaptive cadence defaults to ≥ 1 day between runs.
- **Log rotation** is already configured in every Compose service (`max-size: 10m`, `max-file: 3`). Add cache pruning via cron if you sync many large Git sources.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| The backend still behaves like an older checkout after `docker compose up --build` | The source checkout was stale, the image build did not complete, or the existing backend container was not recreated. A container restart alone reuses its old image. | From the repository root, update the checkout, run `docker compose build backend`, then `docker compose up -d --no-deps --force-recreate backend`. Confirm the image and container creation times with `docker compose images backend` and `docker compose ps backend`. Preserve the database volume; never use `down -v` for an application update. |
| `/health/ready` returns 503 with `auth_secret` failing | You left `AUTH_SECRET` set to the placeholder or unset in non-dev mode. | Generate a strong secret with `openssl rand -hex 32`. |
| Schedules visible but never fire | `SCHEDULER_ENABLED=false`. | Either set it to `true` (one backend process only) or run an external dispatcher. |
| `apo task run` fails to import the Task module | Your local checkout is missing its dependencies. | Run the matching install command in your Task repo (`pnpm install`, `npm install`, `uv sync`, etc.) before running the Task. |
| SQLite shows sustained lock contention or write latency | The installation has outgrown the default database profile. | Back up the installation, configure the Postgres override, and migrate the data deliberately. Do not use `docker compose down -v`; it deletes volumes. |

## Operator checklist

Before declaring an internal alpha instance production-ready for coworkers:

- [ ] One host, one backend container, one scheduler owner.
- [ ] `AUTH_SECRET` is a strong random value (not the placeholder).
- [ ] The chosen database profile matches the expected write load; SQLite is
      supported for a small alpha, while Postgres is preferred for sustained
      shared use.
- [ ] The artifact volume (`/app/data`) is persistent.
- [ ] Reverse proxy terminates TLS with a valid certificate.
- [ ] `/health/ready` returns 200 from outside the host.
- [ ] System settings → Deployment Topology shows the values you expect.
- [ ] At least one end-to-end task run has been completed successfully.
