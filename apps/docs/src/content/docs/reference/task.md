---
title: Task API
description: "task(), turn(), test(), describe(): the calls that make up a .eval.ts file. Signatures, fields, and examples."
---

The calls that make up a `.eval.ts` file: `task()`, `turn()`, `steer()`, `test()`, and `describe()`. Together they define *what* to run, *what the agent sees* each turn, *what corrections arrive mid-run*, and *what good means*. For the folder convention and writing flow, see [Tasks](/concepts/tasks/) and [Define a Task](/guides/define-a-task/).

```typescript title="my-task.eval.ts"
import { task, turn, steer } from "@apo-ai/sdk/agent-task";
```

## `task(name, config)`

Register a task: its id, its adapter, and the deliverables tests assert on. `task()` returns a scope with `test(...)` and `describe(...)` for that task, typed from the adapter's `collectDeliverables()` result.

```typescript title="my-task.eval.ts"
const { test, describe } = task("extract-parties", {
  adapter: legalDocumentAdapter,
  deliverables: ["parties", "amounts", "dates"],
  maxTurns: 3,
  description: "Extract named parties from a legal document.",
  metadata: { category: "extraction" },
});
```

```typescript
function task<TTaskId, TAdapterName, TDeliverableDefs, TCollected, TSelected>(
  name: TTaskId,
  config: {
    adapter: TypedAdapterDefinition<TAdapterName, TDeliverableDefs, TCollected>;
    deliverables: TSelected;
    maxTurns?: number;
    description?: string;
    metadata?: Record<string, unknown>;
    judge?: Partial<JudgeConfig>;
  },
): TaskScope<SelectedDeliverables<TCollected, TSelected>>;

// The returned scope:
type TaskScope<TDeliverables> = {
  /** Register a check, typed to this task's selected deliverables. */
  test: TestRegistration<TDeliverables>;
  /** Register a single-level group of checks. */
  describe: DescribeRegistration;
};
```

The deliverable types in `test(...)` callbacks are inferred from the adapter's `collectDeliverables()` return, narrowed to the keys selected in `deliverables: [...]`.

### `adapter`

- **Type:** `TypedAdapterDefinition`
- **Required:** yes

The adapter that drives your agent. Must implement the lifecycle contract, see [Adapter API](/reference/adapter/).

### `deliverables`

- **Type:** `string[]`
- **Required:** yes

Names of the deliverables this task requires. Each name must exist in both the adapter's deliverable definitions and the inferred `collectDeliverables()` result. Tests see only this selected subset, with each value required.

### `maxTurns`

- **Type:** `number`
- **Default:** `10`

Cap on the turn loop. Overridden by `runTask({ maxTurnsOverride })` if passed. The run also stops early when `turn()` returns `null` or `undefined`.

### `description`

- **Type:** `string`
- **Required:** no

Human-readable summary. Shown in the dashboard and `apo task show`.

### `metadata`

- **Type:** `Record<string, unknown>`
- **Required:** no

Free-form metadata, searchable in the dashboard.

### `judgeTools`

- **Type:** `{ mcp?: McpServerConfig[] }`
- **Required:** no

MCP evidence servers for `t.agent` sessions in this task. Overrides `runTask({ judgeTools })`, is overridden per `t.agent(..., { tools: { mcp } })` call; arrays replace, never concat. See [Assertions API → MCP evidence tools](/reference/assertions/#mcp-evidence-tools).

### `mcpServers`

- **Type:** `McpServerConfig[]`
- **Required:** no

MCP servers for the **agent under test** — the adapter plane, a separate declaration from `judgeTools`. Adapters that honor it resolve `./`-relative stdio paths against the task directory and expose the tools as `mcp__<server>__<tool>`, so trace assertions can match those stable names:

```typescript title="my-task.eval.ts"
task("my-task", {
  adapter: myAdapter,
  deliverables: ["report"],
  mcpServers: [
    {
      name: "geo",
      transport: { type: "stdio", command: "node", args: ["./mcp/geo-server.mjs"] },
      tools: ["get_elevation"],          // optional allowlist (not enforced by every adapter)
      timeoutMs: 30_000,
    },
  ],
});
```

Declaring the harness's tool surface here keeps the task portable across harnesses. Custom adapters consume it through the SDK's exported `connectMcpServers(servers)` — raw namespaced tools, no budget wrapping (the agent under test is not apo's to budget).

### `judge`

- **Type:** `Partial<JudgeConfig>`
- **Required:** no

Task-level judge layer: overrides the run-level `runTask({ judge })` config and is itself overridden per `t.judge` call. Lets a task grade differently from its suite — a stronger model, or a custom briefing via `prompt` that tells the judge what it is grading. Fields: `model`, `baseURL`, `apiKey`, `prompt` (see [Assertions API → t.judge](/reference/assertions/) for the full semantics).
## `turn(fn)`

Decide what the agent sees each turn. apo calls `turn` before each `sendUserTurn`; the return value becomes the user input for that turn.

```typescript title="my-task.eval.ts"
turn(async ({ files, transcript }) => {
  if (transcript.length > 0) return null;   // stop after the first turn
  return await files.read("contract.pdf");
});
```

```typescript
type TurnFn<TUserTurn = unknown> = (
  ctx: TurnContext,
) => Promise<TUserTurn | null> | TUserTurn | null;

function turn<TUserTurn>(fn: TurnFn<TUserTurn>): void;
```

### TurnContext

| Field | Type | Purpose |
|---|---|---|
| `files` | `TaskFiles` | The task's input files. `files.read(path)` reads one. |
| `transcript` | `TurnRecord[]` | The turns so far: `{ turnNumber, input, output }`. |

:::note[Returning null or undefined ends the loop]
If `turn` returns `null` (or `undefined`), the turn loop stops. Without this, apo keeps re-sending the same input until `maxTurns` cuts it off. For a single-turn task, return your input on the first call and `null` thereafter.
:::

## `steer(spec)`

Script a mid-run correction: a user message injected into a turn that is already running, at a boundary you name. apo's scheduler counts the adapter's progress events and delivers the message through `session.steer()` when the trigger fires — the interaction every coding-agent user has daily, as a reproducible part of the specification. See [Steer a running agent](/guides/steer-a-running-agent/) for the flow.

```typescript title="my-task.eval.ts"
steer({
  when: { toolResults: 2 },
  label: "exclude-cancelled",
  message: "Correction: exclude cancelled orders from all revenue totals.",
});
```

```typescript
type SteerTrigger =
  | { toolResults: number }   // after the n-th tool result of the target turn
  | { assistantReply: number } // after the n-th assistant message
  | "runStart";               // the moment the turn starts

function steer(spec: {
  when: SteerTrigger;
  message: unknown;          // same shape a turn() return value has
  label?: string;            // shown in the trace, transcript, and failures
  turn?: number;             // 1-based scripted turn. Default 1.
}): void;
```

| Field | Type | Purpose |
|---|---|---|
| `when` | `SteerTrigger` | The boundary the steer fires at. Countable events only — never wall-clock, so runs stay reproducible. |
| `message` | `unknown` | The injected user message. |
| `label` | `string` | Human label on the `task.steer` trace event and check failures. |
| `turn` | `number` | Which scripted turn the steer belongs to (default 1). |

Each spec fires at most once per run. Triggers that never fire (the run ended first) are recorded as `undelivered` with the reason — and `t.steerDelivered` turns that red. Steers require an adapter that implements `session.steer()`; against one that cannot inject, the run fails closed before turn 1 (see [Adapter API → Steering](/reference/adapter/#steering)).

## `test(id, fn)`

Register a test with the function returned by `task()`. The callback receives `t` (the assertion surface) and `ctx` (with adapter-typed `deliverables`). See [Assertions API](/reference/assertions/) for the full `t.*` reference.

```typescript title="my-task.eval.ts"
// Deterministic
test("used-source-document", (t) => {
  t.calledTool("read_file", { input: { path: "contract.pdf" } });
});

// Judged (async: must await t.judge)
test("parties-are-complete", async (t, { deliverables }) => {
  await t.judge(deliverables.parties, "PASS when every party is captured.");
});
```

```typescript
function test(
  id: string,
  fn: (t: TestContext, ctx: CheckContext<TaskDeliverables>) => Promise<void> | void,
): void;
```

The type flows from the adapter without a manually maintained interface:

```typescript
const { test } = task("review", {
  adapter: reviewAdapter,
  deliverables: ["result"],
});

test("my-test", (t, { deliverables }) => {
  deliverables.result; // inferred from reviewAdapter.collectDeliverables()
  deliverables.stats;  // type error: this task did not select stats
});
```

:::note[Global test remains available]
The exported `test<TDeliverables>(...)` function remains available for existing task files and framework-agnostic checks. Prefer the task-scoped function for new `.eval.ts` files: it cannot drift from the task's adapter or selected deliverables.
:::

### CheckContext

The second argument to the test callback:

| Field | Type | Purpose |
|---|---|---|
| `deliverables` | `TDeliverables` | What your adapter's `collectDeliverables` returned. |
| `files?` | `unknown` | The task's auto-discovered file list (optional). `filePaths(files)` extracts relative paths. |
| `task?` | `unknown` | The task definition (optional). |

## See also

- [Tasks](/concepts/tasks/): the folder convention and how the three calls fit together.
- [Assertions API](/reference/assertions/): the full `t.*` and matcher reference.
- [Adapter API](/reference/adapter/): what the `adapter` field must implement.
- [Define a Task](/guides/define-a-task/): the writing flow, end to end.
