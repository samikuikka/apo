---
title: Adapter API
description: "The exact interface an adapter implements — lifecycle methods, session shape, context fields, and required vs optional."
---

The adapter interface — every lifecycle method, the session shape, and the context fields. For *why* adapters exist and how to think about them, see [Adapters](/concepts/adapters/).

```typescript title="adapter.ts"
import { defineAdapter } from "@apo/sdk/agent-task";

defineAdapter({
  name: "my-agent",
  deliverables: { /* name → schema */ },
  initialize: async (ctx) => { /* ... */ },
  startSession: async (ctx) => { /* ... */ },
  collectDeliverables: async (ctx) => { /* ... */ },
  cleanup: async (ctx) => { /* ... */ },
});
```

`defineAdapter()` is an identity helper: it takes the adapter object, types it, and returns it unchanged. The adapter implements the lifecycle below.

## The lifecycle

apo drives every adapter through the same sequence:

```text
initialize(ctx)          optional — set up state, load inputs
  ↓
startSession(ctx)        required — return a session with sendUserTurn
  ↓
turn loop                apo calls sendUserTurn once per turn
  ↓                       (your turn() fn decides when to stop)
collectDeliverables(ctx) required — return the structured deliverables
  ↓
cleanup(ctx)             optional — tear down
```

The `state` object you return from `initialize` flows through every subsequent step, so you can accumulate tool calls, responses, and anything the tests will need.

## A complete adapter

The four lifecycle methods wired together — a minimal adapter you can copy and adapt:

```typescript title="adapter.ts"
import { defineAdapter } from "@apo/sdk/agent-task";
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

`sendUserTurn` is where your real agent runs — thread `trace` and `parentSpanId` in (see [Tracing integrations](/reference/tracing-integrations/) for the wrappers that do this automatically). `collectDeliverables` shapes the raw response into the structured deliverables tests assert on.

## Fields

### `name`

- **Type:** `string`
- **Required:** yes

Identity. Recorded on the task and every run.

### `deliverables`

- **Type:** `Record<string, DeliverableDefinition>`
- **Required:** yes

Name → schema (Zod or anything with `safeParse`). Declares what `collectDeliverables` returns. apo validates against these.

`DeliverableDefinition` accepts three forms — all reduce to "something with `safeParse`":

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

A default turn function for this adapter. Used when the task doesn't register its own `turn()` — the task-level `turn()` takes precedence. See [Task API: `turn(fn)`](/reference/task/#turnfn) for the signature.

## `sendUserTurn` — the bridge to your agent

The session returned by `startSession` has one required method. This is where your real agent runs:

```typescript
type AdapterSession = {
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

apo calls `sendUserTurn` once per turn. Inside it, you invoke your real agent — the LLM, the tools, the same code path you ship. **Thread the `trace` and `parentSpanId` into your agent call**, or tool-call assertions (`t.calledTool`, `t.toolOrder`) won't have anything to read. See [Tracing integrations](/reference/tracing-integrations/) for the wrappers that do this automatically.

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

- [Adapters](/concepts/adapters/) — the concept: why you write one, the three "bridges," where adapters live.
- [Task API](/reference/task/) — how `task()` wires an adapter into a task.
- [Assertions API](/reference/assertions/) — what asserts against the deliverables you return.
- [Tracing integrations](/reference/tracing-integrations/) — `createApoTracer` and friends that auto-trace `sendUserTurn`.
