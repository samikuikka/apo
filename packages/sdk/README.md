# apo SDK

TypeScript/JavaScript SDK for the [apo](.) backend — an agent testing and
observability platform. The SDK's entry points:

- **`@apo-ai/sdk/otel`** — OpenTelemetry-native tracing. Wrap your LLM calls and
  agent steps so they land in apo as structured spans, then attach scores.
- **`@apo-ai/sdk/agent-task`** — the agent-task evaluation framework. Define tasks,
  adapters, and checks; run them against an agent and collect structured
  results.
- **`@apo-ai/sdk/agent-task/integrations/{ai-sdk,openai,anthropic}`** —
  per-framework tracing wrappers re-exported for direct import.

## Installation

```bash
pnpm add @apo-ai/sdk
# or: npm install @apo-ai/sdk / yarn add @apo-ai/sdk
```

Requires Node.js ≥ 20. The package ships compiled ESM + `.d.ts` (built via
`tsup`), so no TypeScript-transpiling runtime and no `allowImportingTsExtensions`
tsconfig flag are required on the consumer side.

For TypeScript consumers, also install `@types/node` (the SDK's emitted
declarations reference Node globals like `Buffer`):

```bash
pnpm add -D @types/node
```

## Releases

See [RELEASING.md](./RELEASING.md) for the maintainer runbook. The package
is published to npm via GitHub OIDC trusted publishing from `sdk-v*` tags —
no long-lived npm token is stored in the repository.

## Configuration

The tracing surface (`@apo-ai/sdk/otel`) reads credentials from environment
variables when they are not passed explicitly:

| Purpose                  | Env var             | Used for                                   |
|--------------------------|---------------------|--------------------------------------------|
| OTLP traces endpoint     | `APO_OTLP_ENDPOINT` | Where spans are exported                   |
| Project (diagnostic)     | `APO_PROJECT`       | Resource attribute only — auth owns tenancy |
| Two-key auth (Basic)     | `APO_PUBLIC_KEY` + `APO_SECRET_KEY` | `Authorization: Basic base64(pk:sk)` |
| Bearer token             | `APO_AUTH_TOKEN`    | Short-lived task-run tokens; used only when the key pair is absent |

Telemetry submission always requires both halves of an API-key pair sent as
HTTP Basic (`base64("pk-apo-…:sk-apo-…")`); the SDK never synthesizes partial
Basic credentials from only one half. There is deliberately no
`NEXT_PUBLIC_*` browser variant — a public identifier alone does not
authorize ingestion, and exposing it in a browser bundle creates a misleading
direct-browser integration. Use `buildApoAuthHeaders` (exported from
`@apo-ai/sdk/otel`) to build the headers explicitly.

## Tracing — `@apo-ai/sdk/otel`

The canonical tracing path is OpenTelemetry via `@apo-ai/sdk/otel`. The old
`TraceTracker` / `createClient` custom protocol has been removed.

```ts
import {
  configureApoTelemetry,
  withApoTrace,
  traceTool,
  traceAgent,
  traceRetriever,
  score,
  injectTraceparent,
  extractTraceparent,
} from "@apo-ai/sdk/otel";
```

### `configureApoTelemetry(options)`

Sets up an OTel tracer provider with an OTLP exporter pointing at apo. Requires
`takeOwnership: true` (explicit permission to own the OTel lifecycle — don't
call this if your app already configures OTel itself).

```ts
const handle = await configureApoTelemetry({
  takeOwnership: true,
  endpoint: process.env.APO_OTLP_ENDPOINT ?? "http://localhost:8000/api/public/otel/v1/traces",
  // headers, resource attributes, batch/simple processor, etc.
});

// …your traced work…

await handle.shutdown();  // flush + tear down
```

### `withApoTrace(name, fn, options?)`

Open a root span, run `fn` inside it, end the span, and return the result.

```ts
const summary = await withApoTrace("analyze-doc", async (span) => {
  span.setAttribute("apo.flow.name", "analyze-doc");
  return runAnalysis();
});
```

### Typed observation helpers

For non-LLM work (tools, retrievers, chains, agents), each helper emits a
correctly-typed GenAI span:

```ts
const docs = await traceRetriever("what is apo?", async () => [...]);
const out  = await traceAgent("research-agent", async () => ({ ... }));
const tool = await traceTool("search", async () => ({ hits: 3 }));
```

Available: `traceTool`, `traceAgent`, `traceRetriever`, `traceChain`.

### Scoring

Attach scores (numeric / categorical / boolean) to a run or observation:

```ts
await score(
  { traceId: runId, name: "correctness", value: 0.92, source: "EVAL" },
  { endpoint: config.endpoint, headers: { Authorization: `Bearer ${token}` } },
);
```

### Trace-context propagation

`injectTraceparent(carrier, fields)` / `extractTraceparent(carrier)` use the W3C
Trace Context propagator (correctly handles `traceparent`/`tracestate` parsing,
versioning, and edge cases) — for bridging spans across service boundaries.

### Other exports

`createApoTraceExporter`, `createApoSpanProcessor`, `buildApoAuthHeaders`,
`ApoSpanProcessor`, plus the option types (`ConfigureApoTelemetryOptions`,
`ApoTelemetryHandle`, `ApoTraceExporterOptions`, `ApoSpanProcessorOptions`,
`ApoTraceOptions`, `ScoreOptions`).

## Agent-task evaluation — `@apo-ai/sdk/agent-task`

The product's primary surface: define an agent task and its checks, wire an
adapter to the agent under test, then run it and collect structured results.
Import from the subpath:

```ts
import {
  task,
  defineAdapter,
  runTask,
  turn,
  includes,
} from "@apo-ai/sdk/agent-task";
```

### Core building blocks

- **`task(id, { adapter, deliverables, … })`** — register the task definition
  and return its adapter-typed `test`.
- **`defineAdapter({ initialize, startSession, collectDeliverables, cleanup })`**
  — the contract between apo and the agent under test (init, run a session,
  collect deliverables, tear down).
- **`turn(fn)`** — optionally define task-specific single- or multi-turn input.
- **`test(id, fn)`** — register a test through the scope returned by `task()`.
  The callback receives `t` (flat, eve-style assertions over the run's flow)
  and the task-selected deliverables, inferred from the adapter.
- **`runTask(taskDir, options?)`** — execute a task and return a
  `TaskRunResult` (transcript + evaluation). The adapter comes from the task
  definition.
- **`loadTask(dir)` / `discoverAgentTaskDirs()`** — load tasks from disk.

### Testing (`*.eval.ts`)

One `<task-id>.eval.ts` file holds the task definition, optional turn behavior, and code or
LLM-backed checks. Checks read both the run's **flow** (what the agent did) and
its **deliverables** (what it produced).
Checks are written with a flat `t` context and value matchers — the single way
to assert. Every assertion is recorded (no die-on-first), so each check reports
all of its failures.

```ts
import { task, includes, satisfies } from "@apo-ai/sdk/agent-task";
import { myAdapter } from "./adapter";

const { test } = task("review-output", {
  adapter: myAdapter,
  deliverables: ["result", "stats"],
});

test("used-the-right-tools", (t) => {
  t.calledTool("read_file");                       // did it call this tool
  t.notCalledTool(/delete_/);                      // did it avoid this tool
  t.toolOrder(["read_file", "search_content"]);    // tools ran in this order
  t.maxToolCalls(30);                              // didn't flail
  t.noFailedActions();                             // nothing errored
});

test("output-correct", (t, { deliverables }) => {
  // result and stats are inferred from myAdapter.collectDeliverables().
  t.check(deliverables.result, includes("finding"));
  t.check(deliverables.stats, satisfies((s: { turn_count: number }) => s.turn_count > 0, "has turns"));
});
```

The global `test<TDeliverables>(...)` export remains available for
framework-agnostic checks and existing task files. Prefer the `test` returned
by `task()` for new task files: it requires no manual generic or cast and
exposes only the deliverables selected by that task.

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

For apo tasks the flow is built automatically from the run's trace
projection — no extra wiring.

**`t.judge(value, instruction)` — LLM-backed assertions.** Configure the judge
with `runTask(dir, { judge: { model, apiKey?, baseURL? } })`, or set
`OPENROUTER_MODEL`/`OPENAI_MODEL` for the CLI runtime. Judge verdicts use the
same recorder and result format as code assertions, including model, prompt,
response, token usage, and latency metadata.

A task can also set its own judge layer (`task("id", { judge: { model?, prompt? } })`)
that overrides the run-level config and is itself overridden per `t.judge`
call — resolution is `run-level ← task-level ← per-call`, field by field.
`prompt` is a builder `(ctx) => ({ system?, user? })` that receives what the
judge is grading (`taskId`, `taskDescription?`, `checkName`, `instruction`,
`deliverableNames?`) so the briefing can say what a bare deliverable + rubric
never revealed. The SDK appends its JSON response contract to any custom
`system` — a builder customizes the briefing, never the response format. Keep
`system` constant per task and vary only `user` to preserve the cached prompt
prefix across a task's criteria (issue #161).

**Agents not built on apo's adapter.** `fromOpenAIMessages(messages)`,
`fromAnthropicMessages(messages)`, and `fromAISDK(result)` convert another
framework's output into the neutral `Flow` format so it can be inspected with
`FlowView`:

```ts
import { fromAISDK, FlowView } from "@apo-ai/sdk/agent-task";

const view = new FlowView(fromAISDK(myGenerateTextResult));
view.toolNamesInOrder; // e.g. ["read_file", "search_content"]
view.reply;            // last assistant message text
```

These normalizers are **deprecated** compatibility adapters — the canonical
path emits standard OTel spans (see the tracing integrations above), which
apo projects into the same view without a Flow intermediary.

### CLI / runtime

`parseAgentTaskCliArgs`, `runAgentTaskCli`, `loadTaskRuntime`, `runTaskDir`,
`AgentTaskRuntime` — used by the `apo` CLI and the backend's agent-task runner.

See the `apo` CLI (`pnpm apo`) and the agent-task specs for end-to-end usage.

## License

MIT
