---
title: Running tasks
description: "runTask, loadTask, discoverAgentTaskDirs, runTaskDir — execute tasks from code."
---

The CLI isn't the only way to run a task. The SDK exposes the same runner the CLI uses, so you can execute tasks from code: custom harnesses, embedding in your own tooling, programmatic test loops.

## `runTask(taskDir, options?)`

Run a task from its directory through the full lifecycle (adapter → turns → tests → result). `runTask` loads the task for you — pass the folder path, not a loaded task object.

```typescript
import { runTask } from "@apo/sdk/agent-task";

const result = await runTask("./e2e/tasks/extract-parties", {
  judge: { model: "google/gemini-2.5-flash-lite" },
});
console.log(result.result.pass);  // true | false
```

```typescript
function runTask(taskDir: string, options?: RunTaskOptions): Promise<TaskRunResult>;

type RunTaskOptions = {
  /** Cap on the turn loop (overrides the task's maxTurns). */
  maxTurnsOverride?: number;
  /** LLM judge config for `t.judge(...)` calls. */
  judge?: JudgeConfig;
  /** Trace this run to the apo backend. Omit for an untraced run. */
  tracing?: AgentTaskTraceOptions;
  /** Called after each turn with the turn number, input, and response. */
  onTurn?: (turnNumber: number, userAction: unknown, agentResponse: unknown) => void;
};
```

`runTask` returns a `TaskRunResult`:

| Field | Type | What it is |
|---|---|---|
| `result` | `TaskEvaluationResult` | The evaluation: `{ pass: boolean, checks: EvaluationItemResult[] }`. Read `result.pass` for the verdict. |
| `deliverables` | `Record<string, unknown>` | What `collectDeliverables` returned. |
| `transcript` | `{ turns: TaskTranscriptTurn[] }` | The turn-by-turn record (`{ turnNumber, userAction, agentResponse }`). |
| `task` | `TaskDefinition` | The task definition that ran. |
| `taskDir` | `string` | The absolute path the task loaded from. |
| `files` | `FileEntry[]` | The task's input files. |
| `traceRunId?` | `string` | The trace run id, if `tracing` was set. |

## `loadTask(dir)`

Load a `.eval.ts` task definition from a folder path without running it. Returns a `LoadedTask` (the task config + the adapter object) — useful when you want to inspect the definition before running.

```typescript
import { loadTask } from "@apo/sdk/agent-task";

const loaded = await loadTask("./e2e/tasks/extract-parties");
console.log(loaded.task.id, loaded.adapter.name);
```

Note: `runTask(dir)` calls `loadTask` internally, so you don't need to load first unless you want to inspect.

## `discoverAgentTaskDirs(root)`

Find task directories under a root path. This is the same discovery the CLI uses. Returns a sorted array of directory paths.

```typescript
import { discoverAgentTaskDirs, runTask } from "@apo/sdk/agent-task";

const dirs = discoverAgentTaskDirs("./e2e/tasks");  // synchronous
for (const dir of dirs) {
  const result = await runTask(dir);
  console.log(dir, result.result.pass ? "✓" : "✗");
}
```

## `runTaskDir(dir)`

The thinnest wrapper: load + run in one call. The judge model is resolved from environment variables (`OPENROUTER_MODEL` / `OPENAI_MODEL`), not from options — this is the entry point the backend subprocess uses.

```typescript
import { runTaskDir } from "@apo/sdk/agent-task";

const summary = await runTaskDir("./e2e/tasks/extract-parties");
console.log(summary.pass ? "✓" : "✗");
```

`runTaskDir` returns an `AgentTaskRunSummary`:

| Field | Type | What it is |
|---|---|---|
| `pass` | `boolean` | The run verdict. |
| `taskId` | `string` | The task id. |
| `taskDir` | `string` | The task directory. |
| `checks` | `EvaluationItemResult[]` | The per-test results. |

## Lower-level entry points

| Export | Purpose |
|---|---|
| `loadTaskRuntime` | Resolve the judge config from env (no run). |
| `runAgentTaskCli` | Embed the standalone E2E runner in your own CLI entry point. |
| `parseAgentTaskCliArgs` | Parse CLI args for the embedded runner. |

## See also

- [Task API](/reference/task/) — the `task()`, `test()`, `turn()` calls that define what to run.
- [Assertions API](/reference/assertions/) — what the verdict is computed from.
- [Loop engineering](/guides/loop-engineering/) — using the CLI runner in an agent-driven TDD loop.
