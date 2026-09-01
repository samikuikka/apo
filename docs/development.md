# Development Guide

This guide covers the technical standards and coding patterns used in the codebase. The dashboard product direction is centered on agent testing rather than prompt optimization.

---

## Coding Standards

### Tech Stack

- **Backend**: FastAPI (Python 3.13+), SQLModel (Pydantic + SQLAlchemy), SQLite
- **SDK**: TypeScript, OpenTelemetry-native, Zod
- **Dashboard**: Next.js 16 (App Router), React, Tailwind CSS

### SDK Auth Env Vars

The SDK supports the two-key auth model directly from environment variables.

- Server-side setup (telemetry producers, CLI, management clients):
  - `APO_PUBLIC_KEY=pk-apo-...`
  - `APO_SECRET_KEY=sk-apo-...`
- Legacy backward-compatible setup:
  - `APO_API_KEY=sk-...`
- Short-lived Bearer tokens (task-run / attempt tokens, secret-bearing
  legacy keys):
  - `APO_AUTH_TOKEN=...`

Important:

- The two halves are sent together as HTTP Basic
  (`base64("pk-apo-…:sk-apo-…")`). `NEXT_PUBLIC_APO_PUBLIC_KEY` and the public-key-only Bearer path were removed: a
  `pk-apo-…` value alone is not a credential and is rejected with the same
  generic `401` as any unknown token. There is no supported browser-public
  ingestion credential.
- New dashboard-minted keys default to the least-privileged `ingest` scope.
  Requesting `full` is an explicit administrative choice.
- Revocation and rotation invalidate the positive Basic-auth cache entry
  before the DB mutation commits, so the old credential fails on its next
  request rather than riding the cache TTL.

### Core Schema Overview

The system centers around the following models (defined in `backend/apo/models/`):

- **LoggedCallDB**: Records of LLM inputs, outputs, metadata, and frozen cost breakdowns
- **Agent task models** (`execution.py`): Tasks, Task Runs, Batch Runs, Schedules, Attempts, Executor Pools, Task Revisions
- **Trace models** (`trace_ingestion.py`, `trace_projection.py`): Canonical OTLP spans and projected run/call views
- **Pricing models** (`pricing.py`): Model eras, pricing tiers, and per-key prices

---

## Backend (Python/FastAPI)

### Models & Schemas

We separate database models from API request/response schemas to avoid tight coupling and potential data leakage.

- **`backend/apo/models/db.py`**: Contains `SQLModel` classes with `table=True`. These represent the database structure.
- **`backend/apo/models/schemas.py`**: Contains `SQLModel` classes used for API validation and responses.
- **`backend/apo/models/__init__.py`**: Exports both DB models and schemas for convenient importing.

**Rule**: Never return a DB model directly from an API route. Always use a schema (response model) to control exactly what data is exposed.

### Routing

Keep routes focused and modular.

- Group related endpoints into separate files in `backend/apo/routes/`
- Use dependency injection for database sessions: `session: Session = Depends(get_session)`

### Datetime Handling

Always use timezone-aware UTC datetimes.

- **Correct**: `from datetime import datetime, timezone; datetime.now(timezone.utc)`
- **Incorrect**: `datetime.utcnow()` (Deprecated)

### Database Migrations

Add a new, immutable version to `_SCHEMA_MIGRATIONS` in `db.py` and bump
`LATEST_SCHEMA_VERSION`. Migrations run automatically on app startup. Never add
new schema work to a version that an existing installation may already have
recorded.

```python
# Define the idempotent schema change against a supplied connection.
def _migrate_feature_schema(conn: Connection) -> None:
    _add_column_if_missing(conn, "table_name", "new_column", "TYPE")


# Give it a new version. Do not edit an already-released migration.
def _migrate_to_v21() -> None:
    with engine.begin() as conn:
        _migrate_feature_schema(conn)


LATEST_SCHEMA_VERSION = 21
_SCHEMA_MIGRATIONS[21] = _migrate_to_v21
```

### JSON Fields Pattern

Use `Field(default_factory=list, sa_column=Column("tags", JSON))` for list/dict fields.

**Warning**: Don't use `metadata` as a field name in SQLModel - it's reserved. Use `run_metadata`, `dataset_metadata`, etc. instead.

### Agent Task Run Metadata

Agent task batch runs persist caller-origin information inside `run_metadata.trigger`.

- `source`: where the run was initiated from, such as `dashboard`, `cli`, or `api`
- `actor`: optional human or automation identity
- `hostname`: optional machine name for CLI or worker-triggered runs
- `entrypoint`: caller surface, for example `/agent-tasks` or `apo task run`

Backend routes should expose this information as first-class `trigger` fields on batch-run and task-run responses. Callers should send it when they create runs instead of forcing consumers to parse raw JSON ad hoc.

### Executor and Attempt Auth

The Control Plane never launches Task subprocesses. Keep the three credential
classes separate:

- browser/dashboard requests use user sessions;
- an Executor uses a long-lived hashed credential only for heartbeat and claim;
- a Task child uses a short-lived Attempt JWT for its current Run, Bundle,
  Trace, Artifacts, heartbeat, and finalization.

Every Attempt route must validate the JWT identity, permission, live status,
lease owner, expiry, and generation against the database. JWT expiry alone is
not a sufficient fence. The child environment must exclude the Executor
credential, enrollment token, `AUTH_SECRET`, database/source/storage
credentials, and every non-allow-listed provider variable.

### Example Agent Task Layout

The example-service agent-task demo groups tasks by filesystem path, not by adapter name inferred in the UI.

- Put each task in its own folder containing one `<task-id>.eval.ts` (e.g. `code-review.eval.ts`) plus optional task-local `files/`
- Register the task, optional `turn(...)`, and every deterministic or LLM-backed `test(...)` in the `.eval.ts` file
- Use trace-backed `t` assertions for behavior (tool calls, ordering, failures, turns) and `t.check`/`t.judge` for produced values
- Use parent folders to express the structure you want to see in the dashboard
- Keep different adapters or task/scope families in different folder branches when they should appear as separate groups

Current example layout:

```text
apps/example-service/e2e/agent-task-demo/tasks/
  demo-agent/
    meeting-summary/
  real-agent/
    documents/
      document-qa/
      data-extraction/
    engineering/
      api-testing/
      bug-triage/
      code-review/
      config-generator/
      migration-planner/
    operations/
      log-analyzer/
    research/
      research-synthesis/
    security/
      security-audit/
```

This keeps dashboard grouping aligned with real product areas instead of flattening everything into one task bucket.

### CLI Task Catalog

Tasks are published to a project via `apo task publish`, which sends bounded
metadata (not full source) to the backend. Execution stays in the source-owning
environment via `apo task run` (one-shot) or `apo connect` (persistent).

- `apo task publish --dir <task-root>` — publish task definitions to the catalog.
- `apo task list` — list published tasks.
- `apo task run <task-id> --dir <task-root>` — run a task locally, record the result.
- `apo connect --dir <task-root>` — connect as a persistent executor for dashboard/schedule dispatch.

### Published CLI Task Child

`apo connect` executes each assignment in an isolated Task child. The parent
spawns that child by filesystem path, so both pieces are explicit entries in
`packages/cli/tsup.config.ts`; a path-only child is invisible to bundler graph
discovery and otherwise disappears from the npm tarball.

The child uses `tsx` to load source-owned `*.eval.ts` definitions. Keep `tsx`
as an `@apo-ai/cli` runtime dependency and resolve its import hook relative to
the installed CLI module. A bare `node --import tsx` resolves from the caller's
working directory and makes global or clean installs depend accidentally on
the application having its own `tsx` dependency.

`pnpm --filter @apo-ai/cli package:check` must install the packed tarball into
a clean consumer and invoke the real `runTaskChild` parent path. Starting the
compiled child directly does not cover loader resolution, environment setup,
or the fd-3 IPC boundary used by Connected Executors.

### Execution placement

- Dashboard and schedule entry points submit durable pooled work. They never
  call the Task runner directly.
- Explicit Pool wins; otherwise resolve the Project default. A missing,
  disabled, archived, or cross-Project Pool is an error, never a fallback.
- A schedule persists its exact Pool ID and queue TTL. Changing the Project
  default does not retarget it.
- Caller CLI execution attests local source identity and records through the
  same Attempt protocol. `--no-record` is the only intentional unrecorded path.

### Dashboard Information Architecture

The dashboard is now centered on agent testing, not prompt optimization.

Primary product surfaces:

- `Tasks`
- `Task Runs`
- `Batch Runs`
- `Schedules`
- `Traces` (`/traces`) / canonical trace inspection

Supporting surfaces:

- `Sessions`
- `Settings`

Legacy surfaces:

- deleted prompt-optimization UI routes and components
- backend/domain prompt-optimization compatibility that still survives behind
  dashboard API helpers

Rules for dashboard IA:

- New top-level product work should attach to the agent-testing model first.
- Shared run/trace inspection should live under `/traces` and reusable trace-detail components.
- In dashboard trace code, prefer the `traces-api.ts` boundary for list, detail, eval, export, delete, and trace-to-dataset flows. Active trace UI should read `scopeKey` from normalized trace data; keep raw `flow_name` and `/v1/runs/*` transport details only inside that helper layer.
- In canonical `/traces` route code, prefer trace-oriented helper and prop names like `getTraceFacets`, `getAdjacentTraces`, `traces`, and `traceFacets`. Do not add new run-named aliases to the active trace helper layer.
- In shared trace-detail code that powers the canonical `/traces` experience, use trace-oriented names like `TraceDataProvider`, `useTraceData`, `TraceDetail`, and `TraceObservation`. Do not add new `Run*` naming in shared trace modules.
- The same rule applies to shared trace-detail component names: use `TraceDetailTabs`, `AddTraceToDatasetDialog`, and `TracesPageLayout` in the active `/traces` path.
- The same rule applies to the canonical trace explorer filter layer: use `TraceFilterControls`, `TraceActiveFilters`, and `TraceFilterOptions` for `/traces`.
- The same rule applies one layer deeper for trace explorer select helpers: use `TraceProjectSelect`, `TraceScopeSelect`, `TraceTaskSelect`, `TraceModelMultiSelect`, and `TraceMetricFilter`.
- The canonical `/traces` import graph should use trace-named module paths such as `trace-filter-controls.tsx`, `trace-active-filters.tsx`, and `trace-select-filters.tsx`; do not reintroduce `run-*` wrappers into the active trace route.
- In the active agent-task surfaces, prefer task-run-specific shared module paths and exports like `task-run-list.tsx`, `TaskRunRow`, `TaskRunListHeader`, and `task-run-detail-body.tsx`. Do not reintroduce generic `run-detail-body.tsx` wrappers into the active task-run path.
- For shared execution UI that spans both task runs and batch runs, prefer a neutral `components/agent-task-execution/*` namespace instead of putting canonical code under `components/agent-task-run/*`.
- In active dashboard navigation and cross-links, prefer the label `Traces` for the canonical `/traces` home. Reserve `shared trace` phrasing for the relationship between a specific task run and its attached trace, not for the product-surface label.
- The same module-path rule applies inside `components/trace-detail`: for the active `/traces` path, import trace-named files and the shared trace barrel, not deleted run-named wrappers.
- When a dataset flow is launched from `/traces`, component names and props should use trace/scope terminology too, not legacy run/flow names.
- The shell navigation and home-page product sections should be driven from one shared IA definition instead of duplicating group/item structure in multiple files.
- Prefer `Scope` as the user-facing label when the underlying backend/domain field is still `flow_name`.
- Dataset and evaluation support surfaces should describe reusable cases/examples, not prompt artifacts, even when older API contracts still use `prompts`.
- In dashboard session code, prefer the `sessions-api.ts` boundary and trace-oriented names like `traceCount`, `traces`, and `scopeKey` instead of exposing backend-shaped run records directly in UI components. Normalize backend fields like `run_count` at that helper boundary rather than leaking them into session tables or detail views.
- In dashboard session filters and copy, prefer trace-oriented names like `minTraceCount`, `maxTraceCount`, and `trace count`; keep `run_count` or `min_run_count` only as backend/query compatibility details.
- Legacy-only settings or callback-secret configuration should not occupy first-class active-product IA. Keep them hidden from the main navigation and label them explicitly as compatibility support when they still exist.
- Deleted prompt optimization routes should stay deleted; do not recreate a parallel optimizer-first dashboard surface.

Current route grouping:

- Primary:
  - `/agent-tasks`
  - `/agent-task-runs`
  - `/agent-task-batch-runs`
  - `/agent-task-schedules`
  - `/traces`
- Supporting:
  - `/datasets`
  - `/evals`
  - `/sessions`
  - `/versions`
  - `/settings`
  - `/admin`
- Legacy:
  - `/optimization`

Task IDs are hierarchical and use FastAPI's `{task_id:path}` converter. Treat
that catch-all detail route as terminal: task-run collections belong at
`/agent-task-runs?task_id=...`, not at a suffix such as
`/agent-tasks/{task_id:path}/runs`, which collides with the detail route.

Page-level content should reinforce the same grouping:

- `Traces` should be the canonical route and label for the shared trace inspector.
- `/runs` may remain available as a compatibility redirect, but it should not be the primary IA label.
- Canonical trace page implementations should live under `app/traces/**`; `app/runs/**` should only exist for compatibility redirects or thin wrappers.
- `Sessions` should be described as supporting grouping/context, not the main debugging surface.
- Supporting surfaces like `Datasets`, `Evaluations`, and `Sessions` should explain how they support tasks, runs, traces, or schedules instead of presenting themselves as independent product centers.
- If `Settings` only exposes legacy callback or optimizer-era configuration, it should explicitly label that state as legacy support rather than sounding like a core agent-testing control surface.
- `Optimization` should self-identify as legacy whenever shown in the product.
- Legacy optimization should stay reachable by direct route only when needed; do not keep it in the main shell navigation once agent-testing replacements exist. The optimizer-era code has already been removed from source; these references document the historical cleanup intent.

### SQLite JSON Filtering

For JSON array fields, use `json_extract()`:

```python
from sqlalchemy import text, or_

if tags:
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    tag_conditions = []
    for tag in tag_list:
        tag_conditions.append(
            f"json_extract(tags, '$') LIKE '%\"{tag}\"%'"
        )
    if tag_conditions:
        statement = statement.where(
            or_(*[text(cond) for cond in tag_conditions])
        )
```

---

## Frontend (Next.js/React)

- Use **Tailwind CSS** for all styling
- Prefer **Server Components** by default
- Use the `backend-fetch.ts` / `backend-fetch.server.ts` bridge for API calls, plus per-domain `*-api.ts` helpers (e.g. `traces-api.ts`, `agent-task-api.ts`)

### Suspense Boundary for useSearchParams

In Next.js 16+, any client component using `useSearchParams` must be wrapped in a Suspense boundary:

```typescript
function FilterContent() {
  const [filters, actions] = useFilters();
  return <FilterControls filters={filters} actions={actions} />;
}

export function FilterClient() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <FilterContent />
    </Suspense>
  );
}
```

### TanStack Table Column Preferences

The dashboard's main list surfaces (`Traces`, `Sessions`) use `@tanstack/react-table` with three dimensions of client-local column state (visibility, sizing, pinning) that persist per table. Reuse the unified `usePersistentTablePreferences` hook from `apps/dashboard/src/hooks/` and the shared primitives under `apps/dashboard/src/components/table/` instead of inlining another one-off implementation.

`usePersistentTablePreferences({ storageKey, defaults })` owns all three dimensions behind a single `localStorage` key and returns `preferences` plus per-dimension setters (`setColumnVisibility`, `setColumnSizing`, `setColumnPinning`) and a `resetPreferences` that clears every dimension at once. Wire the setters straight into `useReactTable`:

- **Sizing**: configure `columnResizeMode: "onChange"`, pass `onColumnSizingChange: setColumnSizing` (reading `preferences.columnSizing`), and render `<ColumnResizeHandle header={header} />` inside each resizable `TableHead`.
- **Pinning**: pass `onColumnPinningChange: setColumnPinning` (reading `preferences.columnPinning`) to keep identity columns visible during horizontal scroll.
- **Visibility**: pass `onColumnVisibilityChange: setColumnVisibility` (reading `preferences.columnVisibility`) for show/hide from a columns dropdown.
- Expose a single "Reset preferences" action that calls `resetPreferences()`; do not add per-dimension reset controls.

Rules:

- Each table must use its own `storageKey` so preferences do not leak across surfaces.
- Declare explicit `size`, `minSize`, and (where needed) `maxSize` on column defs rather than relying on TanStack defaults. Identity columns (`name`, `id`, task/session identifiers) start wider; utility columns (checkbox, bookmark, status) stay narrow and may set `enableColumnResizing: false`.
- The hook validates stored JSON and falls back to declared `defaults` on corruption, so invalid `localStorage` must never crash the table.
- When total width exceeds the viewport, the table scroll container must allow horizontal scrolling rather than collapsing columns into wrapping behavior.

### Hierarchy Building (Parent-Child Relationships)

Two-pass algorithm for building trees:

```typescript
function buildHierarchy(items: Item[]): Item[] {
  const map = new Map<string, Item & { children: Item[] }>();

  // First pass: create map with empty children arrays
  items.forEach((item) => {
    map.set(item.id, { ...item, children: [] });
  });

  // Second pass: build tree by assigning children to parents
  const roots: Item[] = [];
  map.forEach((item) => {
    if (item.parentId && map.has(item.parentId)) {
      map.get(item.parentId)!.children.push(item);
    } else {
      roots.push(item);
    }
  });

  return roots;
}
```

---

## SDK (TypeScript)

### Type Safety

- All shared interfaces and types should be defined in `packages/sdk/src/types.ts`
- Use TypeScript interfaces for all public API configurations and metadata

### Error Handling

- Define explicit error classes extending `Error` (e.g. `AgentTaskRunError` in `packages/sdk/src/agent-task/run/runTask.ts`); preserve the original failure on `cause`
- Plain `async/await` throughout; retries are small bounded-backoff loops (see `trace-projection/remote-capture.ts`), not framework schedules

### Dependencies

- Keep dependencies minimal
- No Effect-TS — the SDK is a published package; the `effect` dependency was dead weight and removed. Plain `async/await` and explicit error classes instead
- Ensure type safety for all prompt contexts using **Zod**

### Agent Task Runtime Bundle

Under Source-Owned Execution, the CLI (`apo task run` / `apo connect`) spawns
the task runner in the source-owning environment. The runner imports the SDK
and executes the task's adapter lifecycle. When you change anything under
`packages/sdk/src/agent-task/`, rebuild the SDK so the runtime matches source:

```bash
pnpm --filter @apo-ai/sdk build
```

The backend Docker image also runs the regular `@apo-ai/sdk` build before
assembling the runner for compatibility, but the primary execution path is
the CLI-spawned child, not a server-side process. Install the copied SDK
package's production dependencies at its final `/app/_sdk-source` location
before installing it into the bundled demo workspace. Without this, the runner
would start successfully but fail as soon as it loads a task definition. Local
npm installs link back to that real path, so dependencies installed only
beside the demo task tree are invisible to ESM resolution.
The image also copies `apps/example-service/app/lib/agent`, because the demo
adapters drive that real agent implementation. Its parent
`apps/example-service/node_modules` is linked to the demo workspace's installed
dependencies so imports resolve from both the adapter and agent source paths.

The output is ESM, but some bundled Node dependencies (including
OpenTelemetry) still load built-ins through CommonJS `require`. Keep the
`createRequire(import.meta.url)` bridge in the generated banner; without it,
the image builds successfully but every remote task exits before loading with
`Dynamic require of "util" is not supported`. A packaged-runtime smoke check
should reach the runner's own `AGENT_TASK_DIR is required` validation instead.

Task modules load the SDK outside the bundled runner, so
cross-module runtime state must use `Symbol.for(...)` keys on `globalThis`
rather than module-local singleton arrays. Also keep imported SDK modules free
of `import.meta.url` self-execution guards: bundling changes their apparent
entrypoint and can accidentally execute library code as a second CLI.

---

## Development Workflows

### Local Development

The fastest path is the root `pnpm dev`, which starts all five services concurrently (dashboard, backend, executor, example-service, example-service-py) and frees ports 3000–8000 first:

1. **Start everything**: `pnpm dev` (from the repo root)
2. **Individual services** (if needed):
   - Backend: `pnpm --filter backend dev` (runs `uvicorn apo.api:app --reload --port 8000` via `uv`)
   - Dashboard: `pnpm --filter dashboard dev`
   - Example service: `pnpm --filter example-service dev` (configure `.env.local` from `.env.example`)
3. **Installing dependencies**: `pnpm i` after `package.json` changes; `cd backend && uv sync` after backend dependency changes.

### Verification Guidelines

- **Unit Tests**: Always run `pytest` in the backend and `pnpm test` in the packages/apps
- **Integration**: Use the `example-service` to verify that SDK changes correctly log to the backend
- **Linting**: Ensure all TypeScript code passes `oxlint` (`pnpm lint`) and Python passes `basedpyright`
- **React Doctor**: `pnpm doctor` scans every React/Astro workspace project for
  correctness, performance, security, and maintainability issues. Every PR is
  also scanned automatically by `.github/workflows/react-doctor.yml`: it
  reports only the issues a PR introduces (changed-file scope), fails the
  check on new error-level findings, and posts a summary comment plus inline
  review comments with the health score.
- **Alpha release gate**: `pnpm test:alpha` combines focused backend tests with the structural Playwright alpha specs.
- **Public ingress contract**: `pnpm test:public-ingress` renders the Server
  Profile and asserts Caddy is the only public ingress, runtime URLs agree, and
  frontend/backend diagnostic ports remain loopback-only. Probe a deployed
  domain from another machine with `scripts/public-ingress-smoke.sh https://apo.example.com`.
- **Public docs publication + deployment contract**: `pnpm --filter docs build`
  builds the Astro site, publishes the versioned Task Revision schemas, and runs
  the publication verifier (no retired `apo.dev` origin, every `start.md` link
  resolves, Copy Prompt uses the live origin, schema `$id`s map to built paths).
  `pnpm test:public-docs` renders the tunnel + public-docs Compose stack and
  asserts the docs service is hardened (read-only, no caps, no secrets, no host
  port), Caddy routes the docs host terminally, and the Cloudflare Tunnel
  publishes both hostnames. Probe a live docs origin with
  `scripts/public-docs-smoke.sh https://docs.test-apo.online`.

### API Documentation

- Ensure all new endpoints are documented with docstrings for FastAPI's Swagger UI

---

## Common Pitfalls

### Pydantic v2

- **Datetime serialization**: Always use `.model_dump(mode='json')` when passing Pydantic models to JSON APIs (serializes datetime to ISO format)

### SQLAlchemy 2.0

- **Raw SQL**: Must use `text()` wrapper, not plain strings
- **Session merge()**: Great for upserts but requires primary key to be set

### TypeScript

- **Optional fields**: In TypeScript, optional fields are `undefined` not `null` - tests should expect `undefined`
- **Event queue on flush**: Always copy queue before flushing (`[...this.queue]`) and clear original to prevent race conditions
- **Dashboard auth to backend**: browser-side code must not call protected FastAPI routes on `localhost:8000` directly when auth depends on the dashboard session cookie. Use same-origin dashboard proxy routes or server-side forwarding so the Auth.js cookie can be attached on the Next.js side.
- **Auth bypass flags**: `NEXT_PUBLIC_AUTH_DISABLED` is a development-only escape hatch for page auth. Do not enable it in production, and do not rely on it to make backend API auth behave differently.

### Server-Sent Events (SSE)

The backend pushes real-time updates to the dashboard over Server-Sent Events. Both live event streams are built on the same generic in-memory broadcaster (see the SSE section of [Architecture](architecture.md#real-time-updates-with-server-sent-events-sse) for the full design).

**Backend:**
- Use `asyncio.Queue.put_nowait()` for non-blocking event publishing
- Always clean up listeners in `finally` blocks to prevent memory leaks
- Check `request.is_disconnected()` before yielding events
- Use `StreamingResponse` with `text/event-stream` media type

**Frontend:**
- Wrap event handlers in `useCallback` to prevent unnecessary re-renders
- Always clean up EventSource connections in `useEffect` return functions
- Use `requestAnimationFrame` for scroll preservation during updates
- Limit rendered events (e.g., last 50 events) to prevent performance issues
- Store events in state array but display only slice (`events.slice(-maxEvents)`)

---

## Additional Resources

- **Architecture**: See [`docs/architecture.md`](architecture.md)
