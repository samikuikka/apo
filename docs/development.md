# Development Guide

This guide covers the technical standards and coding patterns used in the codebase. The dashboard product direction is centered on agent testing rather than prompt optimization.

---

## Coding Standards

### Tech Stack

- **Backend**: FastAPI (Python 3.10+), SQLModel (Pydantic + SQLAlchemy), SQLite/Alembic
- **SDK**: TypeScript, Effect-TS, Zod
- **Dashboard**: Next.js 14 (App Router), React, Tailwind CSS

### SDK Auth Env Vars

The SDK now supports the two-key auth model directly from environment variables.

- Preferred server-side setup:
  - `APO_PUBLIC_KEY=pk-apo-...`
  - `APO_SECRET_KEY=sk-apo-...`
- Preferred browser/public-ingest setup:
  - `NEXT_PUBLIC_APO_PUBLIC_KEY=pk-apo-...`
- Legacy backward-compatible setup:
  - `APO_API_KEY=sk-...`

Important:

- `sk-apo-...` is a secret half of the new key pair, not a legacy Bearer token by itself.
- If you only set a `sk-apo-...` value without the matching public key, backend writes will 401.

### Core Schema Overview

The system centers around the following models (defined in `backend/apo/models/db.py`):

- **LoggedCall**: Records of LLM inputs, outputs, and metadata
- **PromptSlot**: Stable identifiers for prompt locations in code
- **PromptVariant**: Specific versions of a prompt for a given slot
- **EvalSet**: Collections of inputs for testing prompts

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

Add migrations to `_apply_lightweight_migrations()` in `db.py` to run automatically on app startup.

```python
# Pattern for adding columns to existing tables
def _apply_lightweight_migrations():
    with engine.begin() as conn:
        columns = conn.exec_driver_sql("PRAGMA table_info('table_name')").fetchall()
        column_names = {col[1] for col in columns}

        if "new_column" not in column_names:
            conn.exec_driver_sql("ALTER TABLE table_name ADD COLUMN new_column TYPE;")

        # Create index
        conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_table_column ON table_name(column);")
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

### Agent Task Service Auth

Do not use user-session cookies for backend-owned task subprocesses.

- Browser and dashboard auth should stay session-based.
- Backend-launched jobs should use short-lived service bearer tokens.
- For agent-task tracing, the backend runner passes `APO_AUTH_TOKEN` into the subprocess env.
- The SDK trace client uses that token for:
  - `POST /api/v1/ingestion`
  - `PATCH /v1/runs/{id}`

If you add new backend-owned workers or subprocesses, follow the same rule:

- mint a scoped short-lived token in the backend
- pass it through env or an equivalent internal channel
- validate it narrowly on the backend routes it is allowed to call

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

### CLI Project Task Sources

The CLI should be able to drive the same project-scoped agent-task model as the dashboard instead of assuming a local `taskRoot`.

- Preferred setup path:
  - `apo project init-tasks --repo owner/repo --branch main --subpath e2e/tasks`
  - This configures the Git task source, attempts sync immediately, and only falls back to GitHub OAuth when a GitHub-hosted repo needs authentication.
- Preferred maintenance path:
  - `apo project sync-tasks`
  - `apo task list`
  - `apo task run <task-id>`
- Use `apo project source show --project <id>` to inspect the configured task source.
- Use `apo project source set --project <id> --type git --repo <url> --ref <branch-or-tag> [--subpath <path>]` to point a project at a Git-backed task tree.
- Use `apo project source set --project <id> --type filesystem --path <server-path> [--subpath <path>]` for self-hosted or local-server task roots.
- Use `apo project source sync --project <id>` to refresh the persisted task inventory after changing source config or repo contents.
- When `--project` is present, `apo task list`, `apo task show`, `apo task run`, `apo task files`, and `apo task read` should prefer the project-scoped backend APIs over ad hoc local discovery.

This keeps agents, dashboard users, and backend execution on the same source-of-truth task inventory.

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
- Legacy optimization should stay reachable by direct route only when needed; do not keep it in the main shell navigation once agent-testing replacements exist.
- For staged cleanup and git safety before larger removals, follow [Legacy Archive And Removal Plan](./legacy-archive-removal-plan.md).

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
- Use the `backend.ts` helper for API calls

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

- Use the `normalizeError` pattern in `packages/sdk/src/errors.ts` to provide consistent error reporting
- Prefer `Effect` for internal logic to handle complex flows and retries, but expose a clean Promise-based API for end-users

### Dependencies

- Keep dependencies minimal
- Use **Effect-TS** for complex logic and error handling
- Ensure type safety for all prompt contexts using **Zod**

### Agent Task Runtime Bundle (SPEC-125)

The backend executes agent tasks by spawning `node /app/agent-task-runtime/runner.mjs`. In local dev that path is a fallback to the repo's `tsx` binary against the live TypeScript entrypoint (`packages/sdk/src/agent-task/runner-entry.ts`); in the container image it is the packaged ESM bundle produced by `packages/sdk/scripts/build-agent-task-runtime.mjs`.

When you change anything under `packages/sdk/src/agent-task/`, rebuild the bundle so the runtime matches the source:

```bash
pnpm --filter @apo/sdk build:agent-task-runtime
```

The Dockerfile runs this for you during `docker compose build`. Locally, you only need to rebuild when you want to test the packaged path (set `AGENT_TASK_RUNTIME_DIR=packages/sdk/dist/agent-task-runtime` before starting the backend).

Task modules load the SDK outside the bundled runner, so
cross-module runtime state must use `Symbol.for(...)` keys on `globalThis`
rather than module-local singleton arrays. Also keep imported SDK modules free
of `import.meta.url` self-execution guards: bundling changes their apparent
entrypoint and can accidentally execute library code as a second CLI.

---

## Development Workflows

### Local Development

1. Start the backend: `cd backend && venv/bin/python -m apo.api`
2. Start the dashboard: `cd apps/dashboard && pnpm dev`
3. Run the example service (OpenRouter/Gemini by default): `cd apps/example-service && pnpm dev` (configure `.env.local` from `.env.example`)

### Verification Guidelines

- **Unit Tests**: Always run `pytest` in the backend and `pnpm test` in the packages/apps
- **Integration**: Use the `example-service` to verify that SDK changes correctly log to the backend
- **Linting**: Ensure all TypeScript code passes `eslint`
- **Alpha release gate**: `pnpm test:alpha` combines focused backend tests with the structural Playwright alpha specs. Run `pnpm test:alpha:smoke` for the deploy-shaped Compose smoke test.
- **Public ingress contract**: `pnpm test:public-ingress` renders the Server
  Profile and asserts Caddy is the only public ingress, runtime URLs agree, and
  frontend/backend diagnostic ports remain loopback-only. Probe a deployed
  domain from another machine with `scripts/public-ingress-smoke.sh https://apo.example.com`.

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

The GEPA optimizer uses SSE for real-time updates. When working with SSE:

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
