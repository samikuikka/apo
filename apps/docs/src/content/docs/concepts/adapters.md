---
title: Adapters
description: The bridge between apo and your real application. You write it. That's the point.
---

**apo never calls your agent. You do**, inside an adapter. The adapter is the only place real code runs during a task, it's the bridge between apo's lifecycle and your application.

A task says *what* to evaluate: the inputs, the deliverables, the tests. The adapter says *how* to run your agent against those inputs and turn what it produces into structured output the tests can assert on.

:::caution[Your responsibility]
There are no built-in adapters. The SDK ships the contract and the lifecycle, but it does **not** ship an adapter that knows how to talk to your application. That's the part you write, because it's the part only you understand.

If you skip this, your tests can't run. The agent under test is not a fixture; it lives behind your adapter.
:::

## The lifecycle, in one breath

apo drives every adapter through the same sequence: **`initialize`** (optional, set up state) → **`startSession`** (return an object with `sendUserTurn`) → **the turn loop** (apo calls `sendUserTurn` once per turn, inside it, you invoke your real agent) → **`collectDeliverables`** (mine the accumulated state and return the structured deliverables the tests assert on) → **`cleanup`** (optional, tear down).

## An adapter

One adapter, wired to a real agent. This is the shape, `initialize` loads inputs, `sendUserTurn` calls the LLM with tools and threads the trace, `collectDeliverables` shapes what the tests will see:

```typescript
import { readFileSync } from "fs";
import { z } from "zod";
import { defineAdapter } from "@apo-ai/sdk/agent-task";

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
- **`sendUserTurn` is the bridge to your agent.** Build your tools, call your LLM, the real thing, the same code path you ship. Threading the `trace` context is what lets tool-call assertions work. If you're using the Vercel AI SDK, pass [`createApoTracer`](/reference/tracing-integrations/) to `experimental_telemetry` and tracing is automatic, no manual span code.
- **`collectDeliverables` is the bridge to your tests.** The agent's raw output is rarely the shape a test wants. You shape it here.

That's the whole concept. An adapter is plain TypeScript, it can import your application code, your SDK client, your tool definitions, anything that runs in the task's Node process.

## Report the run's model and effort

apo never selects the model, your agent's own configuration does (an env var like `OPENROUTER_MODEL`, an app config file, an adapter override). What apo needs is the **resolved** value: the exact model and effort your runtime used after env vars, aliases, and defaults are applied.

Return it from `startSession` as `runConfiguration`. The same resolved object that constructs your agent describes the run, never guess or reconstruct a display label after the fact:

```typescript
async startSession(ctx) {
  // Resolve once. `effort` is absent unless this model/provider applies it.
  const { model, effort } = resolveAgentConfiguration();

  const agent = createAgent({ model, ...(effort ? { effort } : {}), /* … */ });

  return {
    runConfiguration: { model, ...(effort ? { effort } : {}) },
    async sendUserTurn(turn) {
      return { response: await agent.send(turn) };
    },
  };
}
```

- `model` is required when you report a configuration; `effort` is optional.
- Include `effort` only when the selected model/provider has an effective effort control and the runtime applied that value. A provider accepting but ignoring an effort parameter does not count. Neither does a default from your adapter's config schema. In both cases, omit `effort`; apo displays `model · —`.
- Omit `runConfiguration` entirely if your adapter can't truthfully report a single configuration (e.g. a multi-model agent, or a model that changes mid-run). An unreported configuration is shown as `—`, never inferred from the adapter name, env, or trace.
- apo validates the values (length and character bounds) and fails the run before the first turn if they're malformed.

:::note[Why apo does not infer effort support]
Model capabilities depend on the provider and route, not only the model name,
and they change independently of apo. The adapter is the only component that
knows what the runtime actually applied. Missing effort therefore means “no
effective effort was reported,” whether the control is unsupported or unknown.
:::

**Configured vs. observed.** `runConfiguration.model` is what the adapter *intended* to use. The trace's observed model (what the provider actually served, after routing or fallbacks) is a separate value shown as **Observed** on the run. A difference between them is useful evidence, not an error.


## Next

- [Tasks](/concepts/tasks/): how `adapter`, `deliverables`, and `turn` fit in the `.eval.ts`.
- [Tests](/concepts/tests/): what asserts against the deliverables your adapter returns.
- [Define a Task](/guides/define-a-task/): the end-to-end recipe, including the adapter step.
