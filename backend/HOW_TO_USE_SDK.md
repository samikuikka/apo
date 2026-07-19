# Using the apo SDK

The apo SDK (`@apo/sdk`) traces your LLM calls and agent steps so they land in
apo as structured runs, spans, and scores. For agent-task evaluation, use the
`@apo/sdk/agent-task` subpath.

> The canonical, complete reference is the
> [SDK README](../packages/sdk/README.md). This guide covers the essentials for
> backend usage.

## Install

```bash
npm install @apo/sdk
```

## Configure

`createClient` reads a config object. The same fields are available from
environment variables via `readConfig()`:

| Field       | Server env var          | Next.js (browser-safe) env var        |
|-------------|-------------------------|---------------------------------------|
| `endpoint`  | `APO_BACKEND_URL`       | `NEXT_PUBLIC_APO_BACKEND_URL`         |
| `project`   | `APO_PROJECT`           | `NEXT_PUBLIC_APO_PROJECT`             |
| `publicKey` | `APO_PUBLIC_KEY`        | `NEXT_PUBLIC_APO_PUBLIC_KEY`          |
| `secretKey` | `APO_SECRET_KEY`        | —                                     |

Keys are created in the dashboard as `pk-apo-…` / `sk-apo-…` pairs.

## Trace a run

```ts
import OpenAI from "openai";
import { createClient } from "@apo/sdk";

const client = createClient({
  project: "my-project",
  endpoint: process.env.APO_BACKEND_URL ?? "http://localhost:8000",
  publicKey: process.env.APO_PUBLIC_KEY,
  secretKey: process.env.APO_SECRET_KEY,
});

const llm = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

await client.traceRun({ flow_name: "qa" }, async (trace) => {
  const answer = await trace.step({ step_name: "answer" }, async () => {
    const res = await llm.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "What is apo?" }],
    });
    return res.choices[0]?.message?.content;
  });

  await trace.score({ name: "helpful", value: 0.8, source: "EVAL" });
  trace.endRoot({ output: { answer } });
  return answer;
});
```

## Typed observation helpers

For non-LLM work, use the typed helpers (standalone or via the `traceRun`
context as `trace.traceTool`, `trace.traceAgent`, …):

```ts
import { traceTool, traceRetriever, traceChain, traceAgent } from "@apo/sdk";
```

## Agent-task evaluation

The product's primary surface. Define tasks and adapters, then run them
against an agent and collect structured results:

```ts
import { defineTask, defineAdapter, runTask, test, expect } from "@apo/sdk/agent-task";
```

See the [SDK README → Agent-task evaluation](../packages/sdk/README.md#agent-task-evaluation--aposdkagent-task)
for the full API, and the `apo` CLI (`pnpm apo`) for end-to-end usage.

## Running the backend

```bash
cd backend && uv run uvicorn apo.api:app --reload --port 8000
```

## Examples

See [`examples/`](./examples/) for a ready-to-run minimal tracing example.
