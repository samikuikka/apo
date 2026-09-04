---
title: Configuration
description: "Every environment variable across backend, CLI, SDK, and the task runner."
---

apo is configured through environment variables — no config files. This page is the complete reference. For operator guidance (databases, scheduler ownership, email, troubleshooting), see [Self-Hosting: Configuration](/self-hosting/configuration/).

## Backend

The backend reads these on start. Set them in `backend/.env` (or your container env).

### Required for non-dev

| Variable | Purpose |
|---|---|
| `AUTH_SECRET` | Session signing secret. **Required for any non-dev deploy.** Empty in dev → open-dev mode (auth bypassed). Generate with `openssl rand -hex 32`. Must be ≥16 chars, not a placeholder. |
| `DATABASE_URL` | Database DSN. When unset, apo uses its persistent SQLite file; this is the supported default for trials and small single-node alpha teams. The optional Compose Postgres profile sets a `postgresql://...` DSN for longer-lived shared installations or heavier concurrent writes — best-effort, as the test suite runs against SQLite. |

### LLM (agent-task runs)

Where apo picks a model at all, it picks a deliberately cheap one (`google/gemini-2.5-flash`) —
stronger models are opt-in only. Under Source-Owned Execution, Tasks run on
the user's machine via `apo task run` or `apo connect`, so provider
credentials are read from the local environment:

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | OpenRouter API key. Required for LLM-judge checks and adapter LLM calls. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter-compatible base URL. |
| `OPENROUTER_MODEL` | — | Judge model for local runs (`apo task run`, `apo connect`) — the model the local runner reads, with `OPENAI_MODEL` as the alternative. When both are unset, `t.judge` records a setup error instead of guessing. |
| `AGENT_TASK_OPENROUTER_MODEL` | — | Judge model for the packaged task runtime (backend-spawned runs). Consulted after `AGENT_TASK_JUDGE_MODEL`; the final fallback is `google/gemini-2.5-flash`. Not read by local CLI runs. |
| `OPENAI_API_KEY` | — | OpenAI API key. Alternative to OpenRouter for local/dev judge calls. |
| `OPENAI_BASE_URL` | — | OpenAI-compatible base URL. |
| `OPENAI_MODEL` | — | OpenAI model for local/dev judge calls. Read when `OPENROUTER_MODEL` is unset. |

### Scheduler

| Variable | Default | Purpose |
|---|---|---|
| `SCHEDULER_ENABLED` | `true` | Set `false` to disable schedule dispatch. Schedules stay visible but don't fire. **Never run two backends with this `true` against the same database** — the scheduler is in-process and single-owner. |

### Task source

| Variable | Default | Purpose |
|---|---|---|
| `TASK_SOURCE_CACHE_DIR` | `<repo>/.cache/task-sources` | Writable dir for cloned Git task sources. Mount a persistent volume in container deploys. |
| `TASK_SOURCE_GIT_TIMEOUT_SECONDS` | `60` | Per-clone/fetch timeout. |

### Deployment profile and public origin

| Variable | Default | Purpose |
|---|---|---|
| `APO_DEPLOYMENT_PROFILE` | (unset → `development`) | One of `development`, `local`, `server`. Release profiles (`local`, `server`) enable production auth behavior; unset/`development` is the only profile where dev conveniences (see `DEV_SIGNIN_ENABLED`) default on. |
| `APO_PUBLIC_URL` | — | The origin people and agents use to reach this installation (e.g. `https://apo.example.com`). Must be a single origin without a path. The dashboard's first-run onboarding builds its copy-paste `apo login` command from it. |
| `DEV_SIGNIN_ENABLED` | on only when profile is unset/`development` | One-click "Sign in as dev" button that provisions a seeded demo workspace (`dev@apo.local` + the `agent-demo` project). Release profiles must set `true` explicitly to enable it; any other value disables it. |
| `APO_DEV_PROJECT_ID` | `agent-demo` | Id of the seeded dev workspace project. |
| `APO_DEV_SEED_MODEL` | `deepseek/deepseek-v4-flash-0731` | Model label used for the seeded demo runs. |

### URLs

| Variable | Default | Purpose |
|---|---|---|
| `BACKEND_URL` | `http://127.0.0.1:8000` | Backend URL for CORS, redirects, and runtime config; the frontend also uses it for direct server-rendered requests. In Compose this is the internal service URL (`http://backend:8000`), not the public dashboard origin. |
| `FRONTEND_URL` | `http://localhost:3000` | Frontend URL (CORS, redirects). |

### Email (optional)

Off by default. The platform works fully without email. To enable delivery:

| Variable | Purpose |
|---|---|
| `EMAIL_TRANSPORT_URL` | `smtp://USER:PASS@smtp.provider.com:587` (any SMTP) or `ses://us-east-1` (AWS SES). |
| `EMAIL_FROM_ADDRESS` | From address. |
| `EMAIL_FROM_NAME` | From name (optional, defaults to "apo"). |
| `EMAIL_SMTP_TLS` | Override TLS auto-detection: unset = auto (465 implicit TLS, 587 STARTTLS, other ports plain), `true` = force on, `false` = disable. |
| `EMAIL_SMTP_TIMEOUT` | SMTP timeout in seconds (default 30). |

## CLI

The `apo` CLI reads these. Precedence: flag > env > stored credentials (`~/.apo/credentials`).

| Variable | Purpose |
|---|---|
| `APO_TASK_ROOT` | Directory to scan for tasks (default `./e2e`). |
| `APO_BACKEND_URL` | Backend URL (default `http://localhost:8000`). |
| `APO_PROJECT_ID` | Active project id. |
| `APO_ACTOR` | Actor name for runs (who triggered them). |
| `APO_API_KEY` | API key for backend auth. |

### Langfuse connector (`apo traces import langfuse`)

:::caution
These variables are read **only** by the CLI for the [`traces import langfuse`](/cli/traces-import-langfuse/) command. They are never sent to apo, logged, persisted to `~/.apo/credentials`, or attached to the imported trace. There is intentionally no `--langfuse-secret-key` flag.
:::

| Variable | Required | Purpose |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | yes | Langfuse project public key for the source trace. |
| `LANGFUSE_SECRET_KEY` | yes | Langfuse project secret key for the source trace. |
| `LANGFUSE_HOST` | no | Source Langfuse deployment (default `https://cloud.langfuse.com`). Overrideable with `--langfuse-host`. |

## SDK (`@apo-ai/sdk`)

The tracing SDK reads these environment variables:

| Variable | Purpose |
|---|---|
| `APO_BACKEND_URL` | Backend URL. Also `NEXT_PUBLIC_APO_BACKEND_URL`. |
| `APO_PROJECT` | Project id. Also `NEXT_PUBLIC_APO_PROJECT`. |
| `APO_PUBLIC_KEY` | Public identifier (`pk-apo-…`) for HTTP Basic auth. Server-side only — pair with `APO_SECRET_KEY`. |
| `APO_SECRET_KEY` | Secret key (`sk-apo-…`) for HTTP Basic auth. Server-side only. |
| `APO_API_KEY` | Legacy single-key auth (alternative auth). |

`APO_AUTH_TOKEN` (Bearer token for short-lived task-run/attempt tokens) is **not** read by the base SDK's `readConfig`. It is read by `@apo-ai/sdk/otel` (in `buildApoAuthHeaders`) and by the task runner when it sets up the Attempt-scoped credential.

`NEXT_PUBLIC_APO_PUBLIC_KEY` is intentionally **not** read. The
public identifier does not authorize ingestion by itself, and publishing
it in a browser bundle creates a misleading direct-browser integration.
Telemetry submission requires both halves of an API-key pair encoded as
HTTP Basic. There is no supported browser-public ingestion credential.

## Task runner

Under Source-Owned Execution these are set automatically by `apo task run`
(or `apo connect`) when running a Task on the user's machine. The Control
Plane never spawns Task subprocesses. The child receives task-scoped values
and allow-listed provider configuration, never the backend database DSN,
source OAuth token, or ArtifactStore credentials.

| Variable | Purpose |
|---|---|
| `AGENT_TASK_DIR` | The task folder being run. |
| `AGENT_TASK_PROJECT` | Project context (default `"default"`). |
| `AGENT_TASK_RUN_ID` | The run id this subprocess belongs to. |
| `AGENT_TASK_TRACE_ENDPOINT` | Where the subprocess sends trace data. |
| `AGENT_TASK_TRACE_REQUIRED` | Whether tracing is mandatory for this run. |
| `AGENT_TASK_RUN_METADATA` | JSON metadata attached to the run. |
| `AGENT_TASK_ENVIRONMENT` | The run environment label. |
| `APO_AUTH_TOKEN` | Auth token for the subprocess. |
| `AGENT_TASK_JUDGE_MODEL` | Override the judge model for this run. |
| `OPENROUTER_MODEL` | Passed through to the subprocess for LLM calls. |
| `OPENROUTER_BASE_URL` | Passed through to the subprocess. |

## Telemetry ingest limits

Caps on incoming OTLP trace traffic — request sizes, span counts, and
rate limits. These bound how much a single run or a runaway agent can
push into the store per request/minute; they do not cap total storage
(see maintenance above for that).

| Variable | Default | Purpose |
|---|---|---|
| `APO_TELEMETRY_MAX_REQUEST_BYTES` | `10485760` | Max decoded OTLP request body (10 MiB). |
| `APO_OTLP_MAX_DECOMPRESSED_BYTES` | `10485760` | Max decompressed gzip payload (10 MiB). |
| `APO_OTLP_MAX_SPANS_PER_REQUEST` | `2048` | Max spans accepted per request. |
| `APO_TELEMETRY_BYTES_PER_MINUTE` | `31457280` | Per-identity ingest rate (30 MiB/min). |
| `APO_TELEMETRY_BYTE_BURST` | `10485760` | Per-identity burst allowance (10 MiB). |
| `APO_TELEMETRY_GLOBAL_BYTES_PER_MINUTE` | `62914560` | Deployment-wide ingest rate (60 MiB/min). |
| `APO_TELEMETRY_GLOBAL_BYTE_BURST` | `20971520` | Deployment-wide burst allowance (20 MiB). |

## Auth and sessions

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | — | Session signing secret (see Backend above). |
| `AUTH_SESSION_MAX_AGE_DAYS` | `7` | How long a login session stays valid. |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Max login attempts before lockout. |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `300` | Lockout window length. |
| `AUTH_EMAIL_VERIFICATION_REQUIRED` | `false` | Require email verification before login. |
| `ADMIN_API_KEY` | — | Admin-level API key for privileged routes. |

## Bootstrap, retention, and maintenance

A daily maintenance pass always runs (at startup, then every 24 h): it
blanks raw OTLP ingest payloads past their replay window, fails artifact
uploads abandoned past their TTL, and deletes expired credential tokens.
Retention is **two-tier**: verdicts (run status, pass/fail, check counts,
costs, corrections — the regression timeline) are never deleted
automatically, while run *evidence* can expire on a window. Setting
`APO_EVIDENCE_RETENTION_DAYS` drops the evidence tier (transcripts,
traces, check reports, rejudge check evidence, deliverables, attempt
diagnostics) of old runs — bookmarked runs keep everything. Full deletion
of old runs/traces happens only under `APO_RETENTION_DAYS`, which also
purges the OTLP spans of what it deletes.

| Variable | Default | Purpose |
|---|---|---|
| `INIT_USER_EMAIL` | — | First-run admin email (seeds an account on startup). |
| `INIT_USER_PASSWORD` | — | First-run admin password. |
| `INIT_USER_NAME` | — | First-run admin display name. |
| `APO_RETENTION_DAYS` | `0` | Days to keep runs/traces entirely (verdicts and all). `0` disables automatic deletion. |
| `APO_EVIDENCE_RETENTION_DAYS` | `0` | Default days to keep run *evidence* (transcripts, traces, check reports, deliverables, attempt diagnostics). Verdicts stay forever; bookmarked runs keep their evidence. `0` keeps evidence forever. Per-project overrides live in Settings → Retention (`0` there = keep that project's evidence forever despite a shorter default). |
| `APO_INGEST_RETENTION_DAYS` | `7` | Backstop window for OTLP ingest payloads of batches that never projected. A successfully projected batch's payload is blanked the moment projection commits (the canonical span store is the source of truth). `0` keeps unprojected payloads forever. |
| `APO_INGEST_STUCK_BATCH_DAYS` | `30` | Horizon for non-terminal (queued/processing) batches: past it the payload is discarded and the batch marked failed. Guards against a dead worker holding payloads forever. Watch `ingestion_queue` in `GET /v1/admin/retention`. |
| `APO_INGEST_BATCH_ROW_RETENTION_DAYS` | `90` | Days to keep payload-blanked, terminal inbox audit rows before deleting them. |
| `APO_VACUUM_MIN_FREE_BYTES` | `10485760` | The daily maintenance pass only VACUUMs when at least this many bytes are reclaimable (freelist pages). VACUUM needs up to ~2x the database size of free space on the data volume. |
| `APO_MAX_DB_PAGES` | `0` | SQLite page cap, applied on every connection. `0` disables the cap. |
| `APO_PROJECTION_WRITE_MODE` | `slim` | How the trace projection stores call I/O. `slim` keeps full I/O only in canonical spans and writes bounded run-level previews for trace lists. Detail views resolve span-backed I/O from that canonical store. `dual` and `fat` remain temporary rollback modes for upgrades that have not completed the preview backfill. Trace lists never read full call I/O in any mode. |
| `PROJECT_INVITATION_TTL_HOURS` | `168` | How long project invitations stay valid (7 days). |
| `APO_READ_RATE_LIMIT_MAX` | `120` | Per-identity cap (per window) on the heavy list endpoints (`GET /v1/runs`, facets, task-run and batch-run lists). Generous by design — dashboard polling stays far below it; a leaking script gets 429s instead of pinning the database. `0` disables. |
| `APO_READ_RATE_LIMIT_WINDOW_SECONDS` | `60` | The window for the read rate limit above. |

See [Self-Hosting → Data Growth and Retention](/self-hosting/data-growth/)
for what accumulates, how the tiers work, and recommended settings.

## Task Run Deliverables and Artifacts

Deliverable metadata lives in the database; large JSON bodies and file
Artifacts flow through an `ArtifactStore`. The default `local` backend writes
under the existing persistent `/app/data` volume — no MinIO, Redis, or extra
container required. The optional `s3` backend keeps the same server API.

| Variable | Default | Purpose |
|---|---|---|
| `APO_ARTIFACT_STORE` | `local` | Write backend: `local` or `s3`. |
| `APO_ARTIFACT_DIR` | `<DATA_DIR>/artifacts` | Local object/staging root. |
| `APO_ARTIFACT_MAX_ITEM_BYTES` | `104857600` | 100 MiB per Artifact. |
| `APO_ARTIFACT_MAX_RUN_BYTES` | `524288000` | 500 MiB ready+pending per Task Run. |
| `APO_ARTIFACT_UPLOAD_TTL_SECONDS` | `86400` | Pending-upload expiry (orphan cleanup). |
| `APO_ARTIFACT_ORPHAN_GRACE_HOURS` | `48` | The daily pass reaps artifact-store objects no manifest row references (crash orphans). Objects younger than this grace are left alone; `staging/*.part` files are never touched. |
| `APO_DEFAULT_DAILY_SPAN_QUOTA` | `0` | Default accepted-spans/day quota applied to NEWLY MINTED API keys. `0` = unlimited. Existing keys are untouched — edit per key (Settings → API Keys) or bulk-apply there. Quota is per key (N keys = N × cap) and resets at UTC midnight; over-quota ingest gets 429. |
| `APO_USAGE_RETENTION_DAYS` | `400` | Days to keep per-key daily ingest-usage rows. `0` = keep forever. |
| `APO_S3_BUCKET` | — | Required for S3 writes. |
| `APO_S3_REGION` | — | Optional; provider default otherwise. |
| `APO_S3_ENDPOINT_URL` | — | S3-compatible endpoint (R2, MinIO, Backblaze). |
| `APO_S3_PREFIX` | `artifacts/` | Private key prefix. |
| `APO_S3_ACCESS_KEY_ID` | — | Optional; credential chain otherwise. |
| `APO_S3_SECRET_ACCESS_KEY` | — | Paired with the access key. |
| `APO_S3_FORCE_PATH_STYLE` | `false` | MinIO-like path-style compatibility. |

Readiness (`/health/ready`) fails when the selected write backend is unusable.
Rows persist `storage_backend` so changing the write backend never reinterprets
existing rows — an installation must retain configuration for every backend
referenced by live rows.

:::warning
A database-only backup is **no longer complete** once object-backed
Deliverables exist. Back up `/app/data/artifacts` (local) or the configured
S3 bucket/prefix alongside the database, as part of the same backup
generation.
:::

## See also

- [Self-Hosting: Configuration](/self-hosting/configuration/) — operator guidance: databases, scheduler ownership, email setup, troubleshooting, the readiness probe.
- [CLI overview](/cli/) — the `apo` command surface.
