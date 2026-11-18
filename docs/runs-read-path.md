# How run lists load

An explanation of the read path behind task-run lists, and why it is shaped
the way it is. Written for an engineer joining the project after the
2026-11-18 slowness fixes (PRs #636, #637, #638).

## The problem

A task page shows a table of runs, newest first, up to 200 rows. Every
row displays a serving badge, which model and host served the run, how
many calls it made, the median speed. The badge must come from somewhere.
The raw facts live in `logged_calls`, about 95 rows per run in the worst
project, and the runs in the table are finished, so their badges can never
change. The design question is where the badge math runs. The constraints:

- One SQLite database file, one node, one backend worker. Slow work on
  the request path delays every other request, `/health` included.
- Traces arrive asynchronously. A run can finalize before its last spans
  land, so anything computed "when the run ends" can still be wrong a
  minute later.
- The same badge data must also support same-request serving filters
  (filter runs by provider or host), which is a per-call question, not a
  per-run summary.

## What the caller sees

The route handler does not think about call rows at all anymore.

```python
# routes/agent_task_runs.py, list route, no serving filter engaged
task_runs = session.exec(query.limit(limit)).all()
serving_by_trace = _stored_or_computed_servings(session, task_runs)
# { trace_id: ServingSummary } for every run in the page
```

Each run row carries its answer as a column:

```python
run = session.get(AgentTaskRunDB, "run_793fb7...")
summary = stored_serving_summary(run)   # ServingSummary, parsed from JSON
```

And the shape of what is stored, one real row from production (trimmed):

```json
{
  "state": "partial",
  "calls": 65,
  "unknown_provider_calls": 18,
  "groups": [
    { "model": "deepseek-v4.1-flash", "api_provider": "litellm",
      "serving_host": "api.fireworks.ai", "calls": 47 }
  ]
}
```

About 2 KB per run. The frontend is unchanged, it fetches the same
endpoint and renders the same fields.

## The shape

### Data structures first

```
agent_task_runs                     logged_calls
+---------------------------+      +---------------------------+
| id                        |      | id                        |
| task_id                   |      | run_id  (trace id)        |  ~95 rows
| trace_run_id  -------------+---->| model, api_provider,      |  per trace
| status, started_at, ...   |      | serving_host, route, ...  |
| transcript_json (deferred)|      +---------------------------+
| model_providers_json      |
| serving_summary_json  <-- the badge, ~2 KB, written once
+---------------------------+
```

The summary is a column on the run, exactly like `model_providers_json`
beside it. It is not a cache with a TTL, not a separate table, and not
rebuildable-only-by-job. It is part of the run's persisted facts.

On the write side the raw facts are read through `ServingCall`, a
NamedTuple of exactly the 22 columns the math needs. No ORM entity is
built per call row on this path.

### Write path, when the answer is born

```
executor sends spans (OTLP)
        |
        v
TraceProjector.project  (every path funnels here: OTLP, replay, import)
        |
        v
_refresh_task_run_total -> NativeTraceBackend.aggregate_costs
        |   reads the trace's call rows ONCE as ServingCall tuples
        |   computes cost, tokens, model providers, and now
        v   summarize_calls(...)  ->  serving_summary_json on the run
run row updated in one transaction

(same function also runs at run finalize; late spans re-run it,
 so the stored summary can never go stale, it is just never
 recomputed for no reason)
```

### Read path, what a page view costs now

```
GET /v1/agent-task-runs?task_id=...&limit=200
        |
        v
load <=200 run rows, transcript blob deferred
        |
        v
for each row: parse serving_summary_json (2 KB)     <-- no logged_calls
        |            |
        |            +-- null or corrupt? fall back:
        |                load that run's calls, compute, same answer
        v
respond with runs + badges

GET with a serving filter (?provider=...):
        candidates loaded WITHOUT limit
        -> per-run call rows loaded (the filter is a per-call question)
        -> predicate in Python, limit applied last
        (this branch keeps reading calls; the stored summary is
         display data, not a predicate)
```

Deliberate boundary: the serving-filter branch does not use the stored
summary even for display, because the call rows are already loaded for
the predicate.

### Where the work runs

Sync `def` routes run in FastAPI's threadpool, off the event loop. The
facet and run-stats routes are plain `def` for this reason. `async def`
is reserved for routes that actually await something (the run detail
awaits the artifact store). One worker, one loop, so anything blocking
the loop blocks everything, the loop watchdog names it if it happens.

## Tradeoffs accepted

- We accept ~2 KB per run row in exchange for O(runs) list reads instead
  of O(calls). At 4,000 runs that is about 8 MB in a 5.9 GB database.
- We accept a migration and a backfill (v72, resumable, batched) in
  exchange for old runs getting the same speed.
- We accept a null-fallback branch in readers in exchange for never
  breaking a page when a summary is missing or corrupt. A corrupt value
  warns once per run and computes instead.
- We accept that filtered lists still scan call rows, because the filter
  is a per-call predicate. Filters are rarer than plain page views.

## Alternatives considered

- Compute at read time (the old design). Lost on measurement: 5,783 call
  rows and 2.07 s of CPU for one page view on production data, 3.4 to
  5.0 s per request under the four-way refresh pile-up that stalled the
  loop. Now 0.17 s warm single, 0.31 to 0.46 s under the same burst,
  measured on the server before and after the deploy.
- Lazy-load the badge on click. Still recomputes per open, and turns a
  table into a row-by-row pop-in. Worse product, smaller win.
- SQL GROUP BY per request. Moves the scan into SQLite but still rescans
  all calls on every page view, and the groups and medians do not reduce
  to portable SQL without contortions.
- Langfuse-style columnar store (ClickHouse) for trace data. Right at
  their scale, wrong for a single-node SQLite product. Their real
  transferable lesson was the same one applied here: compute per-call
  facts once at ingestion, never rescan for display.

## Open questions

- Should the batch-level serving summary (medians over a whole batch's
  calls) also become a stored rollup on `agent_task_batch_runs`? Batch
  listings still compute it from call rows.
- If the loop watchdog ever fires again after these changes, is the
  multi-worker refactor (broadcasting events across workers, one
  singleton job runner) justified then?
