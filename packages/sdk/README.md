# apo SDK

TypeScript/JavaScript SDK for the [apo](.) backend — an agent testing and
observability platform. The SDK has two entry points:

- **`@apo/sdk`** — tracing. Wrap your LLM calls and agent steps so they land in
  apo as structured traces (runs → spans → events) and scores.
- **`@apo/sdk/agent-task`** — the agent-task evaluation framework. Define tasks,
  adapters, and checks; run them against an agent and collect structured
  results.

## Installation

```bash
npm install @apo/sdk
```

Requires Node.js ≥ 20. Peer deps: `zod` ^3.22, optionally `next` ^13–^15.

## Configuration

`createClient` takes a config object directly. The same values can be sourced
from environment variables via `readConfig()`.

| Field       | Env var (server)            | Env var (Next.js, browser-safe)      | Required |
|-------------|-----------------------------|--------------------------------------|----------|
| `endpoint`  | `APO_BACKEND_URL`           | `NEXT_PUBLIC_APO_BACKEND_URL`        | yes      |
| `project`   | `APO_PROJECT`               | `NEXT_PUBLIC_APO_PROJECT`            | yes      |
| `publicKey` | `APO_PUBLIC_KEY`            | `NEXT_PUBLIC_APO_PUBLIC_KEY`         | two-key  |
| `secretKey` | `APO_SECRET_KEY`            | —                                    | two-key  |
| `apiKey`    | `APO_API_KEY`               | —                                    | legacy   |

The Next.js (`NEXT_PUBLIC_*`) variants are read first, then the plain server
variants. `apiKey` is the legacy single-key format (`sk-…`); prefer the
two-key model (`publicKey` + `secretKey`, generated as `pk-apo-…` / `sk-apo-…`
in the dashboard).

```ts
import { createClient } from "@apo/sdk";

const client = createClient({
  project: "my-project",
  endpoint: "http://localhost:8000",
  publicKey: process.env.APO_PUBLIC_KEY,
  secretKey: process.env.APO_SECRET_KEY,
});
```

## Tracing

### `traceRun` — trace a whole run

`traceRun` opens a run, gives you a context to record spans/events under it,
ends the root span, marks the run complete, and flushes. Steps can be nested.

```ts
const result = await client.traceRun(
  { flow_name: "analyze-doc" },
  async (trace) => {
    const summary = await trace.step(
      { step_name: "summarize", summarize: (v) => ({ value: v }) },
      async () => "the summary",
    );

    trace.recordEvent({
      parent_call_id: trace.rootSpanId,
      step_name: "tool.lookup",
      observation_type: "TOOL",
      input: { query: "x" },
    });

    trace.endRoot({ output: { ok: true } });
    return summary;
  },
);
```

### Typed observation helpers

For non-LLM work (tools, retrievers, chains, agents, guardrails, embeddings),
use the typed helpers — either standalone or inside a `traceRun` via the
context (`trace.traceTool`, `trace.traceAgent`, …). Each sets the correct
`observation_type`.

```ts
import { traceTool, traceAgent, traceRetriever } from "@apo/sdk";

const docs = await traceRetriever("what is apo?", async () => [...]);
const out  = await traceAgent("research-agent", async () => ({ ... }));
```

### Manual span control

For full control, drive a `TraceTracker` (or the client's passthrough methods)
directly: `createTrace` → `createSpan` → `endSpan` → `completeRun` → `flush`.

```ts
const runId = client.createTrace({ project: "my-project", flow_name: "manual" });
const spanId = client.createSpan({ project: "my-project", task_id: "manual", run_id: runId, step_name: "work" });
client.endSpan({ id: spanId, latency_ms: 12, output: { done: true } });
await client.completeRun({ runId, project: "my-project", callCount: 1 });
```

### Scoring

Attach scores (numeric / categorical / boolean) to a run or observation.

```ts
await client.traceRun({ flow_name: "qa" }, async (trace) => {
  // …your work…
  await trace.score({ name: "correctness", value: 0.92, source: "EVAL" });
});
```

## API reference — `@apo/sdk`

### `createClient(config, options?)`

Returns a client with: `createTrace`, `createSpan`, `endSpan`, `completeRun`,
`traceRun`, `flush`, and `_traceTracker`.

- **`config: ClientConfig`** — `project`, `endpoint`, optional `publicKey` /
  `secretKey` / `apiKey` / `version`.
- **`options?: ClientOptions`** — `parameterOverrides`, `runEvals`.

### Trace helpers

`traceTool`, `traceRetriever`, `traceChain`, `traceAgent`, `traceGuardrail`,
`traceEmbedding`, `resolveObservationType`.

### `TraceTracker`

Low-level tracker. Methods: `createTrace`, `createSpan`, `endSpan`,
`completeRun`, `enqueueEvent`, `flush`. Use when you need manual control
outside the `createClient` surface.

### Errors

`ClientError` (Effect `Data.TaggedError`), `ConfigurationError`,
`ClientErrorCode`. `TracePersistenceError` from `./trace` for flush/complete
failures (carries a category: `auth` | `flush` | `network`).

### `readConfig(): EnvConfig`

Read endpoint/project/keys from environment variables (table above).

## Agent-task evaluation — `@apo/sdk/agent-task`

The product's primary surface: define an agent task and its checks, wire an
adapter to the agent under test, then run it and collect structured results.
Import from the subpath:

```ts
import {
  task,
  defineAdapter,
  runTask,
  test,
  turn,
  includes,
} from "@apo/sdk/agent-task";
```

### Core building blocks

- **`task(id, { adapter, deliverables, … })`** — register the task definition.
- **`defineAdapter({ initialize, startSession, collectDeliverables, cleanup })`**
  — the contract between apo and the agent under test (init, run a session,
  collect deliverables, tear down).
- **`turn(fn)`** — optionally define task-specific single- or multi-turn input.
- **`test(id, fn)`** — register a check in the `*.eval.ts` file. The `fn`
  receives `t` (flat, eve-style assertions over the run's flow) and the
  deliverables. See [Testing](#testing-evalts) below.
- **`runTask(task, adapter, options?)`** — execute a single task and return a
  `TaskRunResult` (transcript + evaluation).
- **`loadTask(dir)` / `discoverAgentTaskDirs()`** — load tasks from disk.
- **`createAgentTaskTraceClient(config)`** — the adapter-side trace client
  passed into runs; the auth token is supplied by the backend runner via
  `APO_AUTH_TOKEN`.

### Testing (`*.eval.ts`)

One `<task-id>.eval.ts` file holds the task definition, optional turn behavior, and code or
LLM-backed checks. Checks read both the run's **flow** (what the agent did) and
its **deliverables** (what it produced).
Checks are written with a flat `t` context and value matchers — the single way
to assert. Every assertion is recorded (no die-on-first), so each check reports
all of its failures.

```ts
import { test, includes, satisfies } from "@apo/sdk/agent-task";

test("used-the-right-tools", (t) => {
  t.calledTool("read_file");                       // did it call this tool
  t.notCalledTool(/delete_/);                      // did it avoid this tool
  t.toolOrder(["read_file", "search_content"]);    // tools ran in this order
  t.maxToolCalls(30);                              // didn't flail
  t.noFailedActions();                             // nothing errored
});

test("output-correct", (t, { deliverables }) => {
  t.check(deliverables.result, includes("finding"));
  t.check(deliverables.stats, satisfies((s: { turn_count: number }) => s.turn_count > 0, "has turns"));
});
```

**`t` — flow assertions** (read the run's trace, automatically captured):
`calledTool(name, opts?)`, `notCalledTool(name, opts?)`, `toolOrder([...])`,
`usedNoTools()`, `maxToolCalls(n)`, `noFailedActions()`, `loadedSkill(skill)`,
`calledSubagent(agent)`, `messageIncludes(token)`, `maxTurns(n)`,
`maxDurationMs(n)`, `assert(label, predicate)`.

`calledTool` / `notCalledTool` take optional constraints to match a call's
**input**, **output**, and **status** (and `count` for an exact number). Each
constraint accepts a literal (partial-deep for objects), a RegExp, or a
predicate:

```ts
t.calledTool("read_file", { input: { path: "source.py" } });        // exact arg
t.calledTool("read_file", { input: { path: /^src\// }, count: 2 }); // regex + count
t.calledTool("compute", { output: (v) => v === 42 });               // predicate on output
t.calledTool("flakey_tool", { status: "error" });                    // a failed call
```

`t.assert(label, predicate)` is the escape hatch — assert any predicate over the
typed flow view when the named methods don't cover your case:

```ts
t.assert("read before write", (flow) =>
  flow.toolNamesInOrder.indexOf("read_file") < flow.toolNamesInOrder.indexOf("write_file"),
);
```

**`t.check(value, matcher)` — value assertions** (deliverables, parsed JSON,
anything). Matchers: `includes(substring|RegExp)`, `equals(value)` (deep),
`matches(standardSchema)` (Zod/Valibot — anything with `safeParse`),
`satisfies(predicate, label)`, `similarity(expected, threshold = 0.8)` (fuzzy,
normalized Levenshtein).

For apo tasks the flow is built automatically from the run's trace (via
`createFlowTee`) — no extra wiring.

**`t.judge(value, instruction)` — LLM-backed assertions.** Configure the judge
with `runTask(dir, { judge: { model, apiKey?, baseURL? } })`, or set
`OPENROUTER_MODEL`/`OPENAI_MODEL` for the CLI runtime. Judge verdicts use the
same recorder and result format as code assertions, including model, prompt,
response, token usage, and latency metadata.

**Testing agents not built on apo's adapter.** Build a `Flow` from the
framework's own output with a normalizer, then run the same checks:

```ts
import { runFlowChecks, test } from "@apo/sdk/agent-task";
import { fromAISDK } from "@apo/sdk/agent-task";        // or fromOpenAIMessages / fromAnthropicMessages

const flow = fromAISDK(myGenerateTextResult);          // their framework → Flow
test("used-tools", (t) => { t.calledTool("read_file"); });
const results = await runFlowChecks({ flow, deliverables: { reply: myGenerateTextResult.text } });
```

`fromOpenAIMessages(messages)`, `fromAnthropicMessages(messages)`, and
`fromAISDK(result)` each convert one source into the neutral `Flow` the checks
read — the plugs that make the testing framework reusable across agent stacks.

### CLI / runtime

`parseAgentTaskCliArgs`, `runAgentTaskCli`, `loadTaskRuntime`, `runTaskDir`,
`AgentTaskRuntime` — used by the `apo` CLI and the backend's agent-task runner.

See the `apo` CLI (`pnpm apo`) and the agent-task specs for end-to-end usage.

## License

MIT
