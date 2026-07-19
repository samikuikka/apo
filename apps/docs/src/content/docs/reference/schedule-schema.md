---
title: Schedule API
description: "The fields for creating and updating a schedule — selection, cadence, adaptive window."
---

A schedule says *when* a subset of tasks runs. This page is the field reference for creating and updating schedules via the backend API. For *what schedules are and why cadence is separate from tasks*, see [Schedules](/concepts/schedules/).

Schedules are created and updated via the backend API (`POST` / `PATCH` `/v1/agent-task-schedules`). The CLI doesn't expose schedule CRUD directly — use the dashboard or the API.

## Create fields

`POST /v1/agent-task-schedules`

| Field | Type | Default | Description |
|---|---|---|---|
| `project` | `string` | (required) | Project id. |
| `name` | `string` | (required) | Display name. |
| `selection_type` | `string` | `"tasks"` | How tasks are selected: `"task"`, `"tasks"`, `"folder"`, or `"all"`. |
| `task_paths` | `string[]` | `[]` | Task ids or paths to include. Used by `task`, `tasks`, and `folder` selections. |
| `task_root` | `string` | — | Override the task root for this schedule. |
| `grep` | `string` | — | Filter tasks by a grep pattern on the id. |
| `environment` | `string` | `"default"` | Run environment label. |
| `cadence_type` | `string` | `"daily"` | Cadence kind: `"daily"`, `"weekly"`, `"monthly"`, or `"adaptive"`. |
| `timezone` | `string` | `"UTC"` | IANA timezone for the schedule. |
| `hour` | `number` | `9` | Hour of the day (0–23, in the schedule's timezone). |
| `minute` | `number` | `0` | Minute of the hour (0–59). |
| `day_of_week` | `number` | — | Day of week (0=Mon). For weekly cadences. |
| `day_of_month` | `number` | — | Day of month. For monthly cadences. |
| `min_interval_days` | `number` | `1.0` | Adaptive: minimum days between runs. |
| `max_interval_days` | `number` | `30.0` | Adaptive: maximum days before forced run. |
| `enabled` | `boolean` | `true` | Whether the schedule dispatches. |
| `run_metadata` | `object` | — | Free-form metadata attached to each run. |

## Update fields

`PATCH /v1/agent-task-schedules/{schedule_id}`

Same fields as create, except `project` and `selection_type` are not accepted. Every field is optional — only the fields you send are updated.

## Response: `AgentTaskScheduleSummary`

```typescript
{
  id: string;
  project: string;
  name: string;
  selection_type: string;
  selection_query: Record<string, unknown> | null;
  task_root: string | null;
  grep: string | null;
  environment: string;
  cadence_type: string;
  timezone: string;
  hour: number;
  minute: number;
  day_of_week: number | null;
  day_of_month: number | null;
  min_interval_days: number;
  max_interval_days: number;
  enabled: boolean;
  last_triggered_at: string | null;
  last_batch_run_id: string | null;
  last_batch: { id: string; status: string; total_tasks: number; passed_tasks: number; failed_tasks: number; errored_tasks: number } | null;
  next_run_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}
```

`consecutive_failures` is computed at read time from recent batch runs, not persisted on the schedule itself.

`AgentTaskScheduleDetail` extends this with the full `run_metadata` object.

## Adaptive cadence

The `min_interval_days` / `max_interval_days` window is the adaptive cadence — the schedule's actual next-run time slides between these bounds based on the run history. A schedule that keeps passing drifts toward `max_interval_days`; one that starts failing tightens toward `min_interval_days`. See [Schedules: adaptive cadence](/concepts/schedules/).

:::caution[One scheduler owner]
Never run two backend processes with `SCHEDULER_ENABLED=true` against the same database. The scheduler is in-process and single-owner — two instances will both dispatch every due schedule, producing duplicate batch runs.
:::

## See also

- [Schedules](/concepts/schedules/) — the concept: why cadence is policy, how subsets work, adaptive cadence.
- [Configuration reference](/reference/configuration/) — `SCHEDULER_ENABLED` and related env vars.
