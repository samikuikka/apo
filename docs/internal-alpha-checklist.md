# Internal Alpha Release Checklist (SPEC-126)

This is the minimum bar coworkers should hold the product to before relying on it for real agent-testing work. It is intentionally short and operator-shaped — not a unit-test list.

## Fixture model (deterministic environment)

The release gate assumes a deterministic fixture environment so `pnpm test:alpha` and `./scripts/self-hosted-alpha-smoke.sh` are reproducible. Set these before bringing up the stack:

| Fixture | Source | Default / example |
|---------|--------|-------------------|
| Admin credentials | `INIT_USER_EMAIL` / `INIT_USER_PASSWORD` / `INIT_USER_NAME` env vars on backend startup. Bootstrap is idempotent (no-op when any users exist) and **unset by default** — operators set them explicitly for headless first boot. Normal onboarding is account creation + project invite (Settings → Members). | (none — operator sets explicitly) |
| `AUTH_SECRET` | Operator-generated strong random value (≥ 16 chars). | `openssl rand -hex 32` |
| Seed project | The bundled **demo workspace** (`DEMO_PROJECT_ID = "demo"`). Auto-seeded on first interactive login. Tasks live under `apps/example-service/e2e/agent-task-demo/tasks/real-agent/*`. | `demo` project, ready by default |
| Seed task source | The demo source uses the `demo` source type (no Git clone required). Real-task exercises can switch a project to a Git source pointing at `https://github.com/samikuikka/apo` itself (which the agent-task demo lives under). | `source_type: "demo"` |
| LLM provider key | `OPENROUTER_API_KEY` env var on the backend. Required for any real LLM-backed task; the smoke script and structural tests do NOT require it. | operator-provided |
| Compose stack | One canonical Postgres-backed `docker-compose.yml`. `docker compose up -d --build` is the supported deploy path. | postgres (only) |

The smoke script enforces these defaults itself — operators only need to override them when running against a real provider or a different stack.

## When is each layer sufficient?

| Goal | Run |
|------|-----|
| "Does the deployed shape boot and is it operator-usable?" | `pnpm test:alpha:smoke` |
| "Did I break the agent-testing contract?" | `pnpm test:alpha:backend` |
| "Did I break the operator UI surfaces?" | `pnpm test:alpha:ui` (Playwright, structural — auth-tolerant) |
| "Is this instance production-ready for coworkers?" | Walk this whole checklist manually after running all three above. |

## 1. Deployment shape

- [ ] One host, one backend container, one scheduler owner (see [`docs/self-hosted-alpha.md`](self-hosted-alpha.md)).
- [ ] `AUTH_SECRET` is a strong random value (not the placeholder).
- [ ] Postgres is used for any shared use (SQLite is dev-only).
- [ ] `task_source_cache` is on a persistent volume.
- [ ] Reverse proxy terminates TLS with a valid certificate.
- [ ] `curl $BACKEND/health/ready` returns `{"ok": true, ...}` from outside the host.

## 2. Operator surfaces

- [ ] Settings → System → **Deployment Topology** shows `single-node-alpha` with the values you expect.
- [ ] Settings → System → **Agent Task Runtime** reports `available: true` with the packaged runner path, not the dev `tsx` fallback.
- [ ] Settings → System → **Readiness** shows every check green.

## 3. Canonical operator flow

The most important path for internal users. Walk this end-to-end at least once before declaring the instance production-ready.

- [ ] Create or open a project.
- [ ] Configure a task source (Git URL or filesystem path).
- [ ] **Sync tasks** — confirm the inventory shows the expected task list and folder structure.
- [ ] Run one task.
- [ ] Observe one task run row, one batch run row, and one trace.
- [ ] From the task run, drill into the **canonical trace shell** and confirm the tree/detail renders.
- [ ] From the trace, navigate back to the task run, then back to the batch context.

## 4. Schedules

- [ ] Create one schedule (fixed cadence is fine).
- [ ] Confirm `next_run_at` shows a future timestamp, not "now".
- [ ] Trigger the schedule manually (or wait for the next dispatch).
- [ ] Confirm exactly **one** batch run was created for the dispatch — no duplicates.
- [ ] Disable the schedule and confirm no further dispatches occur.

## 5. Restart recovery

Validates the in-process scheduler is safe across unscheduled restarts.

- [ ] Start a long-running batch (or a real task with a slow adapter).
- [ ] Restart the backend mid-run (`docker compose restart backend`).
- [ ] Confirm the in-flight task run is marked `error` with a "Server restarted…" message.
- [ ] Confirm the containing batch ends in a terminal state (not stuck `running`).
- [ ] Confirm no schedule double-fires after the restart.

## 6. Project isolation

Validates two projects never see each other's data.

- [ ] Create a second fresh project with no task source.
- [ ] Confirm it shows the setup/empty state — not the other project's inventory, runs, or traces.
- [ ] Configure a different task source on the second project.
- [ ] Confirm runs in project A never appear in project B (and vice versa).

## 7. Failure visibility

Validates silent failures cannot happen during alpha.

- [ ] Force a task-source sync failure (e.g. point at a private repo without credentials) and confirm the project shows the error clearly, not an empty table.
- [ ] Force a trace-ingestion failure (e.g. stop the backend mid-run, or revoke the service token) and confirm the task run surfaces `trace_persistence_status: failed` with a readable error.

## 8. Self-hosted smoke

- [ ] Run `./scripts/self-hosted-alpha-smoke.sh` against a fresh Compose stack and confirm it exits 0.
- [ ] (Optional) Set `SMOKE_KEEP_STACK=1` and walk through section 3 against the smoke stack.

---

If every box above is checked, the instance is alpha-ready for coworkers. If any box cannot be checked, that is a release blocker — file it before inviting users.
