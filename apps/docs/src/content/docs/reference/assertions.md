---
title: Assertions API
description: "The t.* assertion methods and matcher helpers, every method, every signature, one quick-reference table."
---

Every test receives `t` (the assertion surface) and `ctx` (with `deliverables`). This page is the complete method reference, every method has its own heading, so jump via the right-side contents. For *how tests work* conceptually, see [Tests](/concepts/tests/).

```typescript title="my-task.eval.ts"
test("my-check", (t, { deliverables }) => {
  t.calledTool("read_file");
  t.check(deliverables.answer, includes("correct"));
});
```

## Trace assertions

These read the run's trace, what the agent *did*. Fast, deterministic, free.

| Method | Asserts |
|---|---|
| [`t.calledTool(name, opts?)`](#tcalledtoolname-opts) | A matching tool was called. `{ count }` for an exact count. |
| [`t.notCalledTool(name, opts?)`](#tnotcalledtoolname-opts) | No tool call matched the name and field constraints. |
| [`t.toolOrder(names)`](#ttoolordernames) | The named tools appear, in this order (subsequence). |
| [`t.usedNoTools()`](#tusednotools) | No tool calls happened at all. |
| [`t.maxToolCalls(n)`](#tmaxtoolcallsn) | At most `n` tool calls, anti-flail. |
| [`t.noFailedActions()`](#tnofailedactions) | No tool or subagent call reported an error, anti-flail. |
| [`t.loadedSkill(skill)`](#tloadedskillskill) | A skill was loaded. |
| [`t.calledSubagent(agent)`](#tcalledsubagentagent) | A subagent delegation happened. |
| [`t.messageIncludes(token)`](#tmessageincludestoken) | The agent's reply contains a substring or matches the RegExp. |
| [`t.maxTurns(n)`](#tmaxturnsn) | The run took at most `n` turns, anti-flail. |
| [`t.maxDurationMs(n)`](#tmaxdurationmsn) | The run took at most `n` milliseconds, anti-flail. |
| [`t.maxTokens(n, opts?)`](#tmaxtokensn-opts) | At most `n` tokens of the given kind were spent. |
| [`t.minTokens(n, opts?)`](#tmintokensn-opts) | At least `n` tokens were spent — the run did real work. |
| [`t.steerDelivered(n)`](#tsteerdeliveredn) | Steer n was delivered and consumed by a later model call. |
| [`t.afterSteer(n, fn)`](#taftersteern-fn) | Scope assertions to what the agent did after steer n. |
| [`t.assert(label, predicate)`](#tassertlabel-predicate) | Escape hatch: a named predicate over the full normalized run. |

### `t.calledTool(name, opts?)`

- **Signature:** `(name: NameMatcher, opts?: ToolCallOptions) → void`
- **Asserts:** a matching tool was called. Pass `{ count }` for an exact count.

### `t.notCalledTool(name, opts?)`

- **Signature:** `(name: NameMatcher, opts?: Omit<ToolCallOptions, "count">) → void`
- **Asserts:** no tool call matched the name and field constraints. (`count` is not accepted, meaningless for a negative assertion.)

### `t.toolOrder(names)`

- **Signature:** `(names: string[]) → void`
- **Asserts:** the named tools appear, in this order (as a subsequence).

### `t.usedNoTools()`

- **Signature:** `() → void`
- **Asserts:** no tool calls happened at all.

### `t.maxToolCalls(n)`

- **Signature:** `(n: number) → void`
- **Asserts:** at most `n` tool calls, anti-flail.

### `t.noFailedActions()`

- **Signature:** `() → void`
- **Asserts:** no tool or subagent call reported an error, anti-flail.

### `t.loadedSkill(skill)`

- **Signature:** `(skill: string) → void`
- **Asserts:** a skill was loaded.

Matches the name of a `SKILL` observation. Produce one by marking the span that reads `<skill>/SKILL.md` with `apo.observation.type: "SKILL"` and `apo.skill.name: "<skill>"` (see [tracing reference](/reference/tracing/#skill-observations)). When the trace carries no `SKILL` observation at all, the verdict is `unsupported`, check the trace's evidence capabilities (`apo traces show <id>` header) to see whether `skills` is available.

### `t.calledSubagent(agent)`

- **Signature:** `(agent: string) → void`
- **Asserts:** a subagent delegation happened.

### `t.messageIncludes(token)`

- **Signature:** `(token: string | RegExp) → void`
- **Asserts:** the agent's reply contains a substring or matches the RegExp.

### `t.maxTurns(n)`

- **Signature:** `(n: number) → void`
- **Asserts:** the run took at most `n` turns, anti-flail.

### `t.maxDurationMs(n)`

- **Signature:** `(n: number) → void`
- **Asserts:** the run took at most `n` milliseconds, anti-flail.

### `t.maxTokens(n, opts?)`

- **Signature:** `(n: number, opts?: { kind?: "input" | "output" | "total"; turn?: number }) → void`
- **Asserts:** the agent under test spent at most `n` tokens of the given kind (default `total`). `{ turn }` scopes to one scripted turn. Judge and evaluation-phase spend is never counted — only the agent's own calls inside the turn spans.

### `t.minTokens(n, opts?)`

- **Signature:** `(n: number, opts?: { kind?: "input" | "output" | "total"; turn?: number }) → void`
- **Asserts:** at least `n` tokens were spent — the run did real work rather than answering from nothing. The counterpart to `t.maxTokens` for catching runs that skipped the work entirely.

### `t.steerDelivered(n)`

- **Signature:** `(n: number) → void`
- **Asserts:** steer n was delivered **and consumed**: at least one generation observation started after the steer's `task.steer` event. This is the check that catches the silent drop — a harness that accepted the message while no model call ever saw it.

Fails closed on every gap: no steering evidence in the trace at all, no steer with that number, the steer recorded `undelivered` or `error` (with its reason), or no post-steer generation. See [Steer a running agent](/guides/steer-a-running-agent/).

### `t.afterSteer(n, fn)`

- **Signature:** `(n: number, fn: (t: TestContext) => void) → void`
- **Asserts:** nothing by itself — it scopes. `fn` receives a full `t` whose trace view is the **post-steer window**: the first generation that consumed the steer through run end. Every method works unchanged inside; a `t2.calledTool("read_file")` counts only tool calls after the steer landed.

```typescript
test("reacted-to-correction", (t) => {
  t.afterSteer(1, (t2) => {
    t2.messageIncludes(/cancelled/i);   // the reply talks about the correction
    t2.maxToolCalls(12);                // …without thrashing
  });
});
```

An undelivered steer yields an empty window: evidence-demanding assertions inside fail, but ceiling-only assertions would pass vacuously — pair `t.afterSteer` with `t.steerDelivered` in the same task.

### `t.assert(label, predicate)`

- **Signature:** `(label: string, predicate: (view: TraceView) => boolean) → void`
- **Asserts:** escape hatch, a named predicate over the run's trace projection view (`TraceView`). This is the same read-model the other `t.*` methods query, built from the run's projection snapshot.

## Name and option types

### `NameMatcher`

A tool or agent name can be matched three ways:

```typescript
type NameMatcher = string | RegExp | ((name: string) => boolean);
```

### `ToolCallOptions`

Constrain a `calledTool` / `notCalledTool` match by recorded fields:

```typescript
type ToolCallOptions = {
  count?: number;                    // exact call count
  input?: ValueMatcher<unknown>;     // match the tool's input
  output?: ValueMatcher<unknown>;    // match the tool's output
  status?: "ok" | "error";          // match the call status
};
```

## Value assertions

These read what the agent *produced*.

### `t.check(value, matcher, label?)`

- **Signature:** `(value: unknown, matcher: Matcher, label?: string) → void`
- **Asserts:** `value` passes the [matcher](#matchers).

```typescript
t.check(deliverables.parties, matches(partiesSchema));
t.check(deliverables.answer, includes("acme-corp"), "answer names acme");
```

### `t.judge(value, instruction, opts?)`, async

- **Signature:** `(value: unknown | unknown[], instruction: string, opts?: { label?: string; judge?: Partial<JudgeConfig>; expect?: "pass" | "fail" }) → Promise<void>`
- **Asserts:** the configured judge model grades `value` against `instruction` (a natural-language rubric). **Must be awaited**: the check function must be `async`.

```typescript title="my-task.eval.ts"
test("answer-is-correct", async (t, { deliverables }) => {
  await t.judge(
    deliverables.answer,
    "PASS when the answer is accurate, cites the source, and adds nothing false.",
  );
});
```

Records a single assertion tagged `evaluator_type: "llm"` with the judge's model, prompt, response, tokens, and latency attached, inspectable in the breakdown, not an opaque score. `value` accepts a single value or an array (the judge sees all of it).

:::tip[Facts are `t.check`, taste is `t.judge`]
A purely factual criterion ("every `Finland` was replaced by `Sweden`", "the JSON has these keys", "the answer contains `acme-corp`") is cheaper and more reliable as a code matcher (`t.check` with `includes` / `matches` / `equals`). Reserve `t.judge` for taste, scoping, and quality. And when you do judge, pass only what the criterion actually grades, handing the judge both before *and* after text invites before/after confusion.
:::

#### Overriding the judge model per call

apo's only built-in judge fallback is deliberately cheap (`deepseek/deepseek-v4.1-flash` in the packaged task runtime; local runs use the model you configured): stronger models are always opt-in, never a surprise (see [Cost-aware defaults](/self-hosting/configuration/#cost-aware-defaults)). `opts.judge` is the most surgical opt-in: it overrides the run's judge config for **this call only**, merging field-by-field, use it to escalate one finicky criterion without switching the whole run onto an expensive model.

```typescript title="my-task.eval.ts"
test("answer-quality", async (t, { deliverables }) => {
  // Easy criteria stay on the run's cheap default judge.
  await t.judge(deliverables.summary, "PASS when it's a single paragraph.");

  // The subtle one escalates to a stronger model, just for this call.
  await t.judge(
    deliverables.analysis,
    "PASS when the reasoning is sound and no claim is fabricated.",
    { judge: { model: "anthropic/claude-sonnet-4.5" } },
  );
});
```

Absent fields inherit from the run's judge config (`runTask({ judge })`, or a task-level `judge` layer), whose env defaults depend on the runner: `OPENROUTER_MODEL` / `OPENAI_MODEL` for local runs (`apo task run`, `apo connect`), `AGENT_TASK_JUDGE_MODEL` for backend-spawned runs. So `{ model }` alone is usually enough, `baseURL` and `apiKey` flow through unchanged. The overridden model is stamped on the assertion metadata and shown in the dashboard breakdown.

#### Ground-truth polarity: `{ expect }`

By default a check's outcome *is* the judge's verdict — which makes a case whose correct verdict is FAIL inexpressible: a fabricated figure, a claim the trace contradicts, could only ever look like a failing check, so "the judge got it right" is invisible in the run. `{ expect }` pins the author's ground truth:

```typescript title="my-task.eval.ts"
test("catches-fabricated-figures", async (t) => {
  await t.agent(
    "PASS only if every figure in the report is supported by the work log.",
    { expect: "fail" }, // the deliverable is known-bad: passing means the judge caught it
  );
});
```

```bash title="terminal"
apo task run jq-contradicted-figures

→ PASS jq-contradicted-figures
  Checks:
    PASS figures-supported
```

The judge never sees the expectation — the instruction reaches the session unchanged and it investigates and verdicts independently. What changes is the recorded outcome: the check passes only when the verdict matches the ground truth, and a disagreement records a failure whose reasoning names both sides (`judge PASSed where ground truth is FAIL — judge reasoning: …`). This is how apo tests its own judge: the `judge-quality` battery in the example service is nine stub-agent cases with verdicts fixed by construction, and a passing run there means *judge agreed with ground truth*, never that the deliverable was good.

#### Timeouts

The judge call streams, and apo judges liveness by its `data:` chunks — a reasoning model's streamed thinking counts — not by the clock alone:

| Bound | Default | Ends the attempt when |
|---|---|---|
| First data (`APO_JUDGE_TIMEOUT_MS`) | 300 s | no `data:` chunk has arrived yet. Keepalive comments don't count: a gateway sends them in front of a dead provider too. |
| Idle | 90 s | data had been streaming and stopped. |
| Runaway (`APO_JUDGE_MAX_DURATION_MS`) | 20 min | the call, retry included, is still running. |

A judge that keeps streaming its reasoning is never cut by the first-data bound, however long it thinks. A stalled or never-started attempt is retried once while the runaway budget allows; the runaway bound is not retried. A call that ends on any bound records no verdict, not a FAIL.

#### Response-contract order: reasoning-first

The judge prompt asks for the reasoning before the verdict (`{"reasoning": ..., "pass": ...}`) so the model argues from the evidence before committing to `pass`. The legacy order (`{"pass": ..., "reasoning": ...}`) had the model commit first and then justify a decision already made: on a degenerate deliverable (an agent that admitted it never read the file it was graded on), the legacy contract passed it 3/3 with the one-word reasoning `"passed"`. Reasoning-first failed it, with the correct reasoning. That measurement (every judged run on a live stack, 14 criteria × 3 samples per arm, zero flips on sound deliverables) is why reasoning-first is the default, not an option (issue #163).

`APO_JUDGE_VERDICT_FIRST=1` (or `true`) elicits the legacy arm for A/B measurement. Process-wide by design, there is deliberately no per-task or per-call knob. Judge metadata records which contract was used (`contract: "verdict-first" | "reasoning-first"`), and the parser accepts either key order regardless, so existing judgments stay readable. To measure on a fixed deliverable set:

```bash
apo runs rejudge <run-id> --samples 3 --label reasoning-first
APO_JUDGE_VERDICT_FIRST=1 apo runs rejudge <run-id> --samples 3 --label verdict-first
apo runs judgments <run-id>   # compare per-criterion flips between the labels
```

:::note[Comparing scores across the flip]
Judgments elicited before the default flip carry `contract: "verdict-first"`. When comparing scores across that boundary, group on `judge.contract`, not on time.
:::

The repo ships a probe task for this (`apps/example-service/e2e/agent-task-demo/tasks/judge-flip-probe`, a stub agent returning one fixed memo, ten calibrated criteria); on `google/gemini-2.5-flash-lite` it measured zero flips across 10 criteria × 3 samples per arm.

### `t.agent(instruction, opts?)`, async

- **Signature:** `(instruction: string, opts?: AgentJudgeOptions) → Promise<void>`
- **Asserts:** an agentic judge — a tool-using LLM session — investigates the run's own evidence with read-only tools, then verdicts via `finish_verdict` (whose reasoning must cite the evidence it relied on). **Must be awaited**: the check function must be `async`. For when to reach for this over `t.judge`, see [Tests → The agentic judge](/concepts/tests/#the-agentic-judge).

```typescript title="my-task.eval.ts"
test("claims-are-grounded", async (t) => {
  await t.agent(
    "PASS when every claim in the memorandum is supported by the source documents. Read the deliverables, search them for the cited figures, and check the trace for what the agent actually read.",
  );
});
```

Records a single assertion tagged `evaluator_type: "agent"` with the session transcript (a content-hashed manifest of what was read, not a copy) attached. Unlike `t.judge`, you state a rubric and the judge gathers its own evidence; `opts.exhibits` optionally pre-stages values into turn 0 the way `t.judge` values are staged.

The session's tool surface:

| Tool | Serves |
|---|---|
| `read_deliverable` | One deliverable by name, paginated (offset/limit, max 12,000 bytes per call) |
| `search_deliverable` | Regex search over one deliverable — up to 8 matches with surrounding context, cheaper than reading end to end |
| `get_trace` | The run's execution trace (tool calls, turns, final reply); answers `unsupported` honestly when trace evidence is missing |
| `list_runs` / `get_run` | This task's prior runs and their full check reports, human corrections included — frozen once per evaluation; present when the run is recorded against a backend |
| `get_task_definition` | The task's id, description, and deliverable names |
| `finish_verdict` | The only exit besides the budget — ends the session with the verdict |

Options: `opts.budget` overrides each ceiling (defaults: 12 turns, 24 tool calls, 300 s wall clock, 2 MiB total read); `opts.tools: { trace: false }` drops `get_trace` (deliverables are always readable); `opts.judge` overrides the judge model for this call only, merging field-by-field like `t.judge`; `opts.label` names the assertion in the breakdown; `opts.expect` pins the ground-truth verdict — [ground-truth polarity](#ground-truth-polarity-expect) works identically here.

The session is fail-closed: one that ends without a verdict records a **failure** with its explanation — `budget exhausted after N steps; last tool: …` — never a silent pass. Without a judge model configured, the check records a setup failure naming the env vars to set (`OPENROUTER_MODEL` + `OPENROUTER_API_KEY`, or `OPENAI_MODEL` + `OPENAI_API_KEY`); the model must be tool-calling capable.

#### MCP evidence tools

The judge's tool surface is not closed. `opts.tools.mcp` attaches your own MCP servers, so a rubric can be verified against your systems, not just the run's artifacts:

```typescript title="my-task.eval.ts"
test("deploy-actually-live", async (t) => {
  await t.agent(
    "PASS when the ops tools confirm the service endpoint returns 200 and the reported version matches the deliverable.",
    {
      tools: {
        mcp: [
          {
            name: "ops",
            transport: { type: "http", url: "https://ops.internal/mcp", headers: { Authorization: "Bearer ${OPS_TOKEN}" } },
            tools: ["check_endpoint", "get_version"],   // allowlist
          },
        ],
      },
    },
  );
});
```

Exposed as `mcp__<server>__<tool>` — stable names your trace assertions can also match. Config layers like the judge model: file/env ← `runTask({ judgeTools })` ← task `judgeTools` ← per-call `tools.mcp`, most specific wins. `APO_JUDGE_MCP=/path/to/mcp.json` points at the industry `.mcp.json` shape (`{"mcpServers": {"<name>": {command, args, env} | {url, headers}}}`), so an existing file works as-is.

| Field | Meaning |
|---|---|
| `name` | Unique; prefixes the tool names. |
| `transport` | `{ type: "stdio", command, args?, env? }` or `{ type: "http", url, headers? }`. |
| `tools` / `excludeTools` | Allowlist then denylist of raw server tool names. |
| `timeoutMs` | Per-tool-call timeout (default 30 s; connect gets its own 10 s budget). |

MCP calls draw down the **same session budget** as `read_deliverable` (tool calls, read bytes — one result serves at most 64 KiB to the model; the manifest fingerprints the full payload), and every result lands in the content-hashed evidence manifest like any other read.

:::caution[Trust and secrets]
A stdio server is a process the eval file told apo to spawn — the same trust as any adapter code. Secret-bearing values (`env`, `headers`) expand `${VAR}` from the environment at connect time; an unset variable is a visible load error, and the values themselves never appear in the recorded session. A configured server that fails to connect fails the check closed, naming the server.
:::

## Matchers

Imported from `@apo-ai/sdk/agent-task` and passed to `t.check(value, matcher)`:

```typescript title="my-task.eval.ts"
import { includes, equals, matches, satisfies, similarity } from "@apo-ai/sdk/agent-task";
```

| Matcher | Signature | Passes when |
|---|---|---|
| `includes` | `(needle: string \| RegExp)` | The value, coerced to string, contains the substring or matches the RegExp. |
| `equals` | `<T>(expected: T)` | Deep structural equality with `expected`. |
| `matches` | `(schema: { safeParse })` | The schema validates the value. Works with Zod, Valibot, anything exposing `safeParse`. |
| `satisfies` | `<T>(predicate: (value: T) => boolean, label: string)` | The custom predicate returns true. `label` is shown in the breakdown. |
| `similarity` | `(expected: string, threshold = 0.8)` | Normalized Levenshtein similarity ≥ `threshold`. |

:::tip[Chain matchers before a judge call]
Chain a fast matcher (`matches(schema)`) before a slow one (`t.judge`) so a schema failure short-circuits before you spend a model call.
:::

## Evidence availability

Every `t.*` assertion is gated by an **evidence capability**: whether the trace projection can actually answer the question. Each capability is `available`, `partial`, or `unavailable`:

| Capability | `available` | `partial` | `unavailable` |
|---|---|---|---|
| Positive (`calledTool`, `loadedSkill`, `calledSubagent`, `messageIncludes`) | normal evaluation | `unsupported` (inconclusive) | `unsupported` |
| Negative / upper-bound (`notCalledTool`, `usedNoTools`, `maxToolCalls`, `maxTurns`, `maxDurationMs`) | normal evaluation | `unsupported` (absence is inconclusive) | `unsupported` |
| `noFailedActions` | normal evaluation | `unsupported` (inconclusive) | `unsupported` |

When a capability is `partial` or `unavailable`, the assertion immediately records `unsupported` without scanning for matches, a partial projection cannot prove a positive or a negative.

An `unsupported` outcome records `pass: false`, it is never a silent pass. This is why a complete `apo-agent-task-v1` run with zero tools still has `tools = available`: the projection can *prove* `usedNoTools()`, not just fail to find tools.

:::note[One generation per wrapper]
The Vercel AI SDK emits a wrapper span (`ai.generateText` / `ai.streamText`) plus per-step children (`ai.generateText.doGenerate`). apo's translation keeps the wrapper — it carries the complete picture: the final assembled text and the total usage — as the single GENERATION row, and ignores the per-step children. Assertions never see a duplicated per-step row, and `toolOrder` reads the effective call graph.
:::

## See also

- [Tests](/concepts/tests/): the concept: two kinds of test, one shape; how the verdict is computed.
- [Adapter API](/reference/adapter/): where `deliverables` (the values you check) comes from.
- [Task API](/reference/task/): where `test(...)` sits in the `.eval.ts` file.
