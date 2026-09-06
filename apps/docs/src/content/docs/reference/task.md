---
title: Task API
description: "task(), turn(), test(), describe(): the calls that make up a .eval.ts file. Signatures, fields, and examples."
---

The calls that make up a `.eval.ts` file: `task()`, `turn()`, `test()`, and `describe()`. Together they define *what* to run, *what the agent sees* each turn, and *what good means*. For the folder convention and writing flow, see [Tasks](/concepts/tasks/) and [Define a Task](/guides/define-a-task/).

```typescript title="my-task.eval.ts"
import { task, turn } from "@apo-ai/sdk/agent-task";
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
    execution?: "local" | "bundled";
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
