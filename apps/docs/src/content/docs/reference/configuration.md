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
| `DATABASE_URL` | Database DSN. Defaults to `sqlite:///./apo.db`. Use Postgres (`postgresql://...`) for shared/multi-user deploys. |

### LLM (agent-task runs)

These defaults are deliberately cheap (`google/gemini-2.5-flash-lite`) — stronger models are opt-in only, never forced. See [Cost-aware defaults](/self-hosting/configuration/#cost-aware-defaults) for the full policy. Passed through to agent-task subprocesses so judge calls and adapter LLM calls reach the model:

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | OpenRouter API key. Required for LLM-judge checks and adapter LLM calls. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter-compatible base URL. |
| `OPENROUTER_MODEL` | — | OpenRouter model for local/dev runs. Read by the SDK when `AGENT_TASK_OPENROUTER_MODEL` is unset. |
| `AGENT_TASK_OPENROUTER_MODEL` | `google/gemini-2.5-flash-lite` | Default model for agent-task runs (backend → subprocess). Falls back to `OPENROUTER_MODEL`, then `google/gemini-2.5-flash`. |
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
| `TASK_INSTALL_DISABLE` | `false` | `true`/`1` skips dependency install (escape hatch for air-gapped deploys). |
| `TASK_INSTALL_TIMEOUT_SECONDS` | `180` | Per-install timeout (min 30s). |
| `TASK_INSTALL_CACHE_DIR` | `<TASK_SOURCE_CACHE_DIR>/installs` | Where install markers live. |

### URLs

| Variable | Default | Purpose |
|---|---|---|
| `BACKEND_URL` | `http://127.0.0.1:8000` | Backend URL (CORS, redirects, runtime-config descriptor). |
| `FRONTEND_URL` | `http://localhost:3000` | Frontend URL (CORS, redirects). |

### Email (optional)

Off by default. The platform works fully without email. To enable delivery:

| Variable | Purpose |
|---|---|
| `EMAIL_TRANSPORT_URL` | `smtp://USER:PASS@smtp.provider.com:587` (any SMTP) or `ses://us-east-1` (AWS SES). |
| `EMAIL_FROM_ADDRESS` | From address. |
| `EMAIL_FROM_NAME` | From name (optional, defaults to "apo"). |

### GitHub OAuth (optional)

When all four are set, projects get a "Connect GitHub" button for private-repo task sources. When any is missing, only the manual URL-paste flow is available.

| Variable | Purpose |
|---|---|
| `GITHUB_CLIENT_ID` | OAuth App client id (`iv1...`). |
| `GITHUB_CLIENT_SECRET` | OAuth App client secret. |
| `GITHUB_REDIRECT_URI` | Callback URL (e.g. `http://localhost:8000/v1/github/callback`). |
| `GITHUB_TOKEN_ENCRYPTION_KEY` | Fernet key for encrypting stored tokens. Generate: `uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. |

## CLI

The `apo` CLI reads these. Precedence: flag > env > stored credentials (`~/.apo/credentials`).

| Variable | Purpose |
|---|---|
| `APO_TASK_ROOT` | Directory to scan for tasks (default `./e2e`). |
| `APO_BACKEND_URL` | Backend URL (default `http://localhost:8000`). |
| `APO_PROJECT_ID` | Active project id. |
| `APO_ACTOR` | Actor name for runs (who triggered them). |
| `APO_API_KEY` | API key for backend auth. |

## SDK (`@apo/sdk`)

The tracing SDK reads these (or their `NEXT_PUBLIC_` variants for browser use):

| Variable | Purpose |
|---|---|
| `APO_BACKEND_URL` | Backend URL. Also `NEXT_PUBLIC_APO_BACKEND_URL`. |
| `APO_PROJECT` | Project id. Also `NEXT_PUBLIC_APO_PROJECT`. |
| `APO_PUBLIC_KEY` | Public key for browser-side tracing. Also `NEXT_PUBLIC_APO_PUBLIC_KEY`. |
| `APO_SECRET_KEY` | Secret key for server-side tracing. |
| `APO_API_KEY` | API key (alternative auth). |
| `APO_AUTH_TOKEN` | Auth token (alternative auth). |

## Task runner (subprocess)

These are set automatically by the backend when spawning agent-task subprocesses. You normally don't set them directly — documented here for completeness and debugging.

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

## Auth and sessions

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | — | Session signing secret (see Backend above). |
| `AUTH_SESSION_MAX_AGE_DAYS` | `7` | How long a login session stays valid. |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Max login attempts before lockout. |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `300` | Lockout window length. |
| `AUTH_EMAIL_VERIFICATION_REQUIRED` | `false` | Require email verification before login. |
| `ADMIN_API_KEY` | — | Admin-level API key for privileged routes. |

## Bootstrap and retention

| Variable | Default | Purpose |
|---|---|---|
| `INIT_USER_EMAIL` | — | First-run admin email (seeds an account on startup). |
| `INIT_USER_PASSWORD` | — | First-run admin password. |
| `INIT_USER_NAME` | — | First-run admin display name. |
| `APO_RETENTION_DAYS` | — | Days to keep runs/traces before deletion. Unset = keep forever. |
| `APO_MAX_DB_PAGES` | — | Soft cap on DB pages for maintenance. |
| `PROJECT_INVITATION_TTL_HOURS` | `168` | How long project invitations stay valid (7 days). |

## See also

- [Self-Hosting: Configuration](/self-hosting/configuration/) — operator guidance: databases, scheduler ownership, email setup, troubleshooting, the readiness probe.
- [CLI overview](/cli/) — the `apo` command surface.
