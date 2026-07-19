---
title: Adapters
description: The bridge between apo and your real application. You write it. That's the point.
---

**apo never calls your agent. You do**, inside an adapter. The adapter is the only place real code runs during a task — it's the bridge between apo's lifecycle and your application.

A task says *what* to evaluate: the inputs, the deliverables, the tests. The adapter says *how* to run your agent against those inputs and turn what it produces into structured output the tests can assert on.

:::caution[Your responsibility]
There are no built-in adapters. The SDK ships the contract and the lifecycle, but it does **not** ship an adapter that knows how to talk to your application. That's the part you write, because it's the part only you understand.

If you skip this, your tests can't run. The agent under test is not a fixture; it lives behind your adapter.
:::

## The lifecycle, in one breath

apo drives every adapter through the same sequence: **`initialize`** (optional, set up state) → **`startSession`** (return an object with `sendUserTurn`) → **the turn loop** (apo calls `sendUserTurn` once per turn — inside it, you invoke your real agent) → **`collectDeliverables`** (mine the accumulated state and return the structured deliverables the tests assert on) → **`cleanup`** (optional, tear down).

## An adapter

One adapter, wired to a real agent. This is the shape — `initialize` loads inputs, `sendUserTurn` calls the LLM with tools and threads the trace, `collectDeliverables` shapes what the tests will see:

```typescript
import { readFileSync } from "fs";
import { z } from "zod";
import { defineAdapter } from "@apo/sdk/agent-task";

export const realAgentAdapter = defineAdapter({
  name: "real-agent",
  deliverables: {
    result: z.object({ summary: z.string() }),
    stats: z.object({ turn_count: z.number(), tool_calls: z.number() }),
  },

  // Load task inputs once, before the first turn.
  async initialize(ctx) {
    const fileContents: Record<string, string> = {};
    for (const f of ctx.files) {
      fileContents[f.relativePath] = readFileSync(f.absolutePath, "utf-8");
    }
    return { turnCount: 0, toolCalls: [], fileContents };
  },

  async startSession(ctx) {
    const state = ctx.state as AgentState;
    return {
      // apo calls this once per turn. Here you call your real agent.
      async sendUserTurn(turn, { trace, turnNumber, parentSpanId }) {
        state.turnCount++;
        const tools = buildTaskTools(state.fileContents, (tc) => state.toolCalls.push(tc));
        const result = await runAgentTurn(
          [{ role: "user", content: String(turn) }],
          { system: SYSTEM_PROMPT, tools, maxSteps: 8 },
          { trace, parentSpanId, turnNumber },  // thread the trace so tool calls are captured
        );
        return { response: result.response };
      },
    };
  },

  // Shape accumulated state into the deliverables the tests assert on.
  async collectDeliverables(ctx) {
    const state = ctx.state as AgentState;
    return {
      result: { summary: state.agentResponses.join("\n") },
      stats: { turn_count: state.turnCount, tool_calls: state.toolCalls.length },
    };
  },
});
```

Three things to notice:

- **`initialize` is the bridge to your file system.** Read task inputs into state once, here.
- **`sendUserTurn` is the bridge to your agent.** Build your tools, call your LLM — the real thing, the same code path you ship. Threading the `trace` context is what lets tool-call assertions work. If you're using the Vercel AI SDK, pass [`createApoTracer`](/reference/tracing-integrations/) to `experimental_telemetry` and tracing is automatic — no manual span code.
- **`collectDeliverables` is the bridge to your tests.** The agent's raw output is rarely the shape a test wants. You shape it here.

That's the whole concept. An adapter is plain TypeScript — it can import your application code, your SDK client, your tool definitions, anything that runs in the task's Node process.

## Next

- [Tasks](/concepts/tasks/): how `adapter`, `deliverables`, and `turn` fit in the `.eval.ts`.
- [Tests](/concepts/tests/): what asserts against the deliverables your adapter returns.
- [Define a Task](/guides/define-a-task/): the end-to-end recipe, including the adapter step.
