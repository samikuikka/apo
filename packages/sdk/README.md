# apo SDK

TypeScript/JavaScript SDK for the [apo](.) backend — an agent testing and
observability platform. The SDK has three entry points:

- **`@apo/sdk`** — config + error types shared across the surface.
- **`@apo/sdk/otel`** — OpenTelemetry-native tracing. Wrap your LLM calls and
  agent steps so they land in apo as structured spans, then attach scores.
- **`@apo/sdk/agent-task`** — the agent-task evaluation framework. Define tasks,
  adapters, and checks; run them against an agent and collect structured
  results.

## Installation

```bash
npm install @apo/sdk
```

Requires Node.js ≥ 20. The package ships compiled ESM + `.d.ts` (built via
`tsup`), so no TypeScript-transpiling runtime and no `allowImportingTsExtensions`
tsconfig flag are required on the consumer side.

### Consuming outside the monorepo

The package is not yet on npm. Install it from git:

```bash
# pnpm (subdir install via the #path: prefix)
pnpm add 'samikuikka/apo#path:packages/sdk'

# or npm/yarn equivalent
npm install 'samikuikka/apo#path:packages/sdk'
```

The git install resolves to the same compiled `dist/` and works under plain
`node` + plain `tsc --noEmit` — verified against a clean consumer with no
special tsconfig.

## Configuration

`readConfig()` reads backend/project/credentials from environment variables.

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
import { readConfig, type EnvConfig } from "@apo/sdk";

const config: EnvConfig = readConfig();
```

## API reference — `@apo/sdk`

The root entry is intentionally thin: shared types + config + errors. The
actual tracing surface lives at `@apo/sdk/otel`.

### Types

The trace/observation parameter types used by the OTel helpers:
`CreateTraceParams`, `CreateSpanParams`, `EndSpanParams`, `TraceRunContext`,
`TraceRunOptions`, `TraceStepOptions`, `TraceEventOptions`, `IngestionEvent`,
`CreateScoreParams`, `ClientOptions`, `ParameterOverrides`, `ObserveOptions`,
`ObservationContext`.

### `readConfig(): EnvConfig`

Read endpoint/project/keys from environment variables (table above).

### Errors

`ClientError` (Effect `Data.TaggedError`), `ConfigurationError`,
`ClientErrorCode`. `ClientError` carries a `code` field for categorising
failures.

## Tracing — `@apo/sdk/otel`

The canonical tracing path is OpenTelemetry via `@apo/sdk/otel`. The old
`TraceTracker` / `createClient` custom protocol has been removed (SPEC-129
complete).

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
} from "@apo/sdk/otel";
```

### `configureApoTelemetry(options)`

Sets up an OTel tracer provider with an OTLP exporter pointing at apo. Requires
`takeOwnership: true` (explicit permission to own the OTel lifecycle — don't
call this if your app already configures OTel itself).

```ts
const handle = await configureApoTelemetry({
  takeOwnership: true,
  endpoint: process.env.APO_OTLP_ENDPOINT ?? "http://localhost:8000/v1/otlp",
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
