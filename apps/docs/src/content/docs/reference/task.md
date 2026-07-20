---
title: Task API
description: "task(), turn(), test() — the three calls that make up a .eval.ts file. Signatures, fields, and examples."
---

The three calls that make up a `.eval.ts` file: `task()`, `turn()`, `test()`. Together they define *what* to run, *what the agent sees* each turn, and *what good means*. For the folder convention and writing flow, see [Tasks](/concepts/tasks/) and [Define a Task](/guides/define-a-task/).

```typescript title="my-task.eval.ts"
import { task, test, turn } from "@apo/sdk/agent-task";
```

## `task(name, config)`

Register a task: its id, its adapter, and the deliverables tests assert on. Tests are registered via top-level `test(...)` calls in the same file.

```typescript title="my-task.eval.ts"
task("extract-parties", {
  adapter: legalDocumentAdapter,
  deliverables: ["parties", "amounts", "dates"],
  maxTurns: 3,
  description: "Extract named parties from a legal document.",
  metadata: { category: "extraction" },
});
```

```typescript
function task<TName, TDeliverableDefs>(
  name: TName,
  config: {
    adapter: TypedAdapterDefinition<TName, TDeliverableDefs>;
    deliverables: (keyof TDeliverableDefs & string)[];
    maxTurns?: number;
    description?: string;
    metadata?: Record<string, unknown>;
  },
): void;
```

### `adapter`

- **Type:** `TypedAdapterDefinition`
- **Required:** yes

The adapter that drives your agent. Must implement the lifecycle contract — see [Adapter API](/reference/adapter/).

### `deliverables`

- **Type:** `string[]`
- **Required:** yes

Names of the deliverables the adapter will collect. Must match the keys in the adapter's `deliverables` map.

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

Register a test. The callback receives `t` (the assertion surface) and `ctx` (with `deliverables`). See [Assertions API](/reference/assertions/) for the full `t.*` reference.

```typescript title="my-task.eval.ts"
// Deterministic
test("used-source-document", (t) => {
  t.calledTool("read_file", { input: { path: "contract.pdf" } });
});

// Judged (async — must await t.judge)
test("parties-are-complete", async (t, { deliverables }) => {
  await t.judge(deliverables.parties, "PASS when every party is captured.");
});
```

```typescript
function test<TDeliverables>(
  id: string,
  fn: (t: TestContext, ctx: CheckContext<TDeliverables>) => Promise<void> | void,
): void;
```

Pass a deliverables type for end-to-end type safety:

```typescript
type Deliverables = { result: ReviewResult; stats: Stats };
const check = test<Deliverables>;
check("my-check", (t, { deliverables }) => {
  deliverables.result;  // typed as ReviewResult
});
```

`test` is the public name for `defineCheck`. To avoid repeating the deliverables type on every call, alias it locally: `const check = test<MyDeliverables>`.

### CheckContext

The second argument to the test callback:

| Field | Type | Purpose |
|---|---|---|
| `deliverables` | `TDeliverables` | What your adapter's `collectDeliverables` returned. |
| `files` | `unknown` | The task's auto-discovered file list. `filePaths(files)` extracts relative paths. |
| `task` | `unknown` | The task definition. |

## See also

- [Tasks](/concepts/tasks/) — the folder convention and how the three calls fit together.
- [Assertions API](/reference/assertions/) — the full `t.*` and matcher reference.
- [Adapter API](/reference/adapter/) — what the `adapter` field must implement.
- [Define a Task](/guides/define-a-task/) — the writing flow, end to end.
