---
title: Adapter API
description: "The exact interface an adapter implements, lifecycle methods, session shape, context fields, and required vs optional."
---

The adapter interface, every lifecycle method, the session shape, and the context fields. For *why* adapters exist and how to think about them, see [Adapters](/concepts/adapters/).

```typescript title="adapter.ts"
import { defineAdapter } from "@apo-ai/sdk/agent-task";

defineAdapter({
  name: "my-agent",
  deliverables: { /* name → schema */ },
  initialize: async (ctx) => { /* ... */ },
  startSession: async (ctx) => { /* ... */ },
  collectDeliverables: async (ctx) => { /* ... */ },
  cleanup: async (ctx) => { /* ... */ },
});
```

`defineAdapter()` is an identity helper: it takes the adapter object, preserves the inferred `collectDeliverables()` return type, and returns it unchanged. The task-scoped `test` function uses that return type, so tests do not need a separate deliverables interface.

## The lifecycle

apo drives every adapter through the same sequence:

```text
initialize(ctx)          optional: set up state, load inputs
  ↓
startSession(ctx)        required: return a session with sendUserTurn
  ↓
turn loop                apo calls sendUserTurn once per turn
  ↓                       (your turn() fn decides when to stop)
collectDeliverables(ctx) required: return the structured deliverables
  ↓
cleanup(ctx)             optional: tear down
```

The `state` object you return from `initialize` flows through every subsequent step, so you can accumulate tool calls, responses, and anything the tests will need.

## A complete adapter

The four lifecycle methods wired together, a minimal adapter you can copy and adapt:

```typescript title="adapter.ts"
import { defineAdapter } from "@apo-ai/sdk/agent-task";
import { z } from "zod";

export const myAdapter = defineAdapter({
  name: "my-agent",
  deliverables: { result: z.string() },
  async startSession(ctx) {
    return {
      async sendUserTurn(turn, { trace, parentSpanId }) {
        const response = await runMyAgent(String(turn), { trace, parentSpanId });
        return { response };
      },
    };
  },
  async collectDeliverables(ctx) {
    return { result: /* mine the session state */ "" };
  },
});
```

`sendUserTurn` is where your real agent runs, thread `trace` and `parentSpanId` in (see [Tracing integrations](/reference/tracing-integrations/) for the wrappers that do this automatically). `collectDeliverables` shapes the raw response into the structured deliverables tests assert on.

## Fields

### `name`

- **Type:** `string`
- **Required:** yes

Identity. Recorded on the task and every run.

### `deliverables`

- **Type:** `Record<string, DeliverableDefinition>`
- **Required:** yes

Name → schema (Zod or anything with `safeParse`). Declares what `collectDeliverables` returns. apo validates against these.

`DeliverableDefinition` accepts three forms, all reduce to "something with `safeParse`":

```typescript
type DeliverableDefinition =
  | ValidatableSchemaLike          // a Zod schema, Valibot schema, etc. directly
  | { schema?: ValidatableSchemaLike }  // wrapped
  | null;                          // no validation (escape hatch)

type ValidatableSchemaLike = {
  safeParse: (data: unknown) => { success: boolean; error?: { message: string } };
};
```

### `startSession`

- **Type:** `(ctx) => Promise<AdapterSession>`
- **Required:** yes

Return a session whose `sendUserTurn` drives your agent.

### `collectDeliverables`

- **Type:** `(ctx) => Promise<CollectedDeliverables>`
- **Required:** yes

Return the structured deliverables, keyed to match `deliverables`.

Let TypeScript infer this method's return type. `task()` carries it into the scoped `test` callback and narrows it to the deliverable names that task selected. An explicit `Promise<Record<string, unknown>>` annotation intentionally widens the values back to `unknown`.

#### File artifacts

A deliverable can be a file instead of a JSON value. Use `fileArtifact()` to declare it:

```typescript
import { fileArtifact } from "@apo-ai/sdk/agent-task";

async collectDeliverables(ctx) {
  return {
    score: { value: 0.92 },                          // JSON: tested inline
    report: fileArtifact(ctx.state.reportPath, {     // file: uploaded + downloadable
      displayFilename: "final-report.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  };
}
```

`fileArtifact(path, options?)` validates the path points to a regular file (no symlinks, no directories). `displayFilename` and `mediaType` are optional with sensible defaults (`basename(path)` and `application/octet-stream`).

After checks finish, apo uploads the file automatically and submits only the JSON deliverables in the result body. The executor-local path never reaches the backend. Both `apo connect` and recorded `apo task run` handle the upload, no extra code needed.

Failed checks still upload artifacts, a failing run's files are evidence for understanding the failure.

The file is **not** available as a `deliverables.report` value inside `test()`, tests see the descriptor, not the file content. Assert on JSON deliverables or trace-based assertions instead. After the run, download the file with `apo runs deliverable <run-id> report --output report.docx` or from the dashboard's Deliverables tab.

### `initialize`

- **Type:** `(ctx) => Promise<AdapterRuntimeState | void>`
- **Required:** no

Set up state before the first turn. Read inputs, open connections.

### `cleanup`

- **Type:** `(ctx) => Promise<void>`
- **Required:** no

Tear down after the run. Errors are logged, not thrown.

### `turn`

- **Type:** `TurnFn`
- **Required:** no

A default turn function for this adapter. Used when the task doesn't register its own `turn()`, the task-level `turn()` takes precedence. See [Task API: `turn(fn)`](/reference/task/#turnfn) for the signature.

## `sendUserTurn`, the bridge to your agent

The session returned by `startSession` has one required method. This is where your real agent runs:

```typescript
type AdapterSession = {
  runConfiguration?: {
    model: string;
    effort?: string;
  };
  sendUserTurn: (
    turn: unknown,
    context: {
      trace: AgentTaskTraceContext;
      turnNumber: number;
      parentSpanId?: string;
    },
  ) => Promise<AgentTurnResult>;
  close?: () => Promise<void>;
};
```

apo calls `sendUserTurn` once per turn. Inside it, you invoke your real agent, the LLM, the tools, the same code path you ship. **Thread the `trace` and `parentSpanId` into your agent call**, or tool-call assertions (`t.calledTool`, `t.toolOrder`) won't have anything to read. See [Tracing integrations](/reference/tracing-integrations/) for the wrappers that do this automatically.

`runConfiguration` is optional descriptive metadata. `model` is the exact
runtime model identifier. Include `effort` only when the selected model/provider
actually applies that control; omit defaults or accepted-but-ignored values.
See [Report the run's model and effort](/concepts/adapters/#report-the-runs-model-and-effort)
for the reporting rules and examples.

## Context fields

Every lifecycle method receives a context object. All four share these base fields:

| Field | Type | Present in | Purpose |
|---|---|---|---|
| `task` | `TaskDefinition` | all | The task being run (id, deliverables, maxTurns, metadata). |
| `taskDir` | `string` | all | Absolute path to the task folder. |
| `files` | `FileEntry[]` | all | Task input files (`{ relativePath, absolutePath }`). |
| `trace` | `AgentTaskTraceContext` | all | The trace client for this run. Thread into agent calls. |
| `state` | `AdapterRuntimeState` | startSession, collectDeliverables, cleanup | The object `initialize` returned. `undefined` if `initialize` is absent. |
| `session` | `AdapterSession` | collectDeliverables, cleanup | The session from `startSession`. Optional in cleanup. |

## See also

- [Adapters](/concepts/adapters/): the concept: why you write one, the three "bridges," where adapters live.
- [Task API](/reference/task/): how `task()` wires an adapter into a task.
- [Assertions API](/reference/assertions/): what asserts against the deliverables you return.
- [Tracing integrations](/reference/tracing-integrations/): `createApoTracer` and friends that auto-trace `sendUserTurn`.
- [`apo runs deliverable`](/cli/runs-deliverable/): download file artifacts from a completed run.
