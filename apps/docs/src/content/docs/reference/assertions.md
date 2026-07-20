---
title: Assertions API
description: "The t.* assertion methods and matcher helpers — every method, every signature, one quick-reference table."
---

Every test receives `t` (the assertion surface) and `ctx` (with `deliverables`). This page is the complete method reference — every method has its own heading, so jump via the right-side contents. For *how tests work* conceptually, see [Tests](/concepts/tests/).

```typescript title="my-task.eval.ts"
test("my-check", (t, { deliverables }) => {
  t.calledTool("read_file");
  t.check(deliverables.answer, includes("correct"));
});
```

## Trace assertions

These read the run's trace — what the agent *did*. Fast, deterministic, free.

| Method | Asserts |
|---|---|
| [`t.calledTool(name, opts?)`](#tcalledtoolname-opts) | A matching tool was called. `{ count }` for an exact count. |
| [`t.notCalledTool(name, opts?)`](#tnotcalledtoolname-opts) | No tool call matched the name and field constraints. |
| [`t.toolOrder(names)`](#ttoolordernames) | The named tools appear, in this order (subsequence). |
| [`t.usedNoTools()`](#tusednotools) | No tool calls happened at all. |
| [`t.maxToolCalls(n)`](#tmaxtoolcallsn) | At most `n` tool calls — anti-flail. |
| [`t.noFailedActions()`](#tnofailedactions) | No tool or subagent call reported an error — anti-flail. |
| [`t.loadedSkill(skill)`](#tloadedskillskill) | A skill was loaded. |
| [`t.calledSubagent(agent)`](#tcalledsubagentagent) | A subagent delegation happened. |
| [`t.messageIncludes(token)`](#tmessageincludestoken) | The agent's reply contains a substring or matches the RegExp. |
| [`t.maxTurns(n)`](#tmaxturnsn) | The run took at most `n` turns — anti-flail. |
| [`t.maxDurationMs(n)`](#tmaxdurationmsn) | The run took at most `n` milliseconds — anti-flail. |
| [`t.assert(label, predicate)`](#tassertlabel-predicate) | Escape hatch: a named predicate over the full normalized run. |

### `t.calledTool(name, opts?)`

- **Signature:** `(name: NameMatcher, opts?: ToolCallOptions) → void`
- **Asserts:** a matching tool was called. Pass `{ count }` for an exact count.

### `t.notCalledTool(name, opts?)`

- **Signature:** `(name: NameMatcher, opts?: Omit<ToolCallOptions, "count">) → void`
- **Asserts:** no tool call matched the name and field constraints. (`count` is not accepted — meaningless for a negative assertion.)

### `t.toolOrder(names)`

- **Signature:** `(names: string[]) → void`
- **Asserts:** the named tools appear, in this order (as a subsequence).

### `t.usedNoTools()`

- **Signature:** `() → void`
- **Asserts:** no tool calls happened at all.

### `t.maxToolCalls(n)`

- **Signature:** `(n: number) → void`
- **Asserts:** at most `n` tool calls — anti-flail.

### `t.noFailedActions()`

- **Signature:** `() → void`
- **Asserts:** no tool or subagent call reported an error — anti-flail.

### `t.loadedSkill(skill)`

- **Signature:** `(skill: string) → void`
- **Asserts:** a skill was loaded.

### `t.calledSubagent(agent)`

- **Signature:** `(agent: string) → void`
- **Asserts:** a subagent delegation happened.

### `t.messageIncludes(token)`

- **Signature:** `(token: string | RegExp) → void`
- **Asserts:** the agent's reply contains a substring or matches the RegExp.

### `t.maxTurns(n)`

- **Signature:** `(n: number) → void`
- **Asserts:** the run took at most `n` turns — anti-flail.

### `t.maxDurationMs(n)`

- **Signature:** `(n: number) → void`
- **Asserts:** the run took at most `n` milliseconds — anti-flail.

### `t.assert(label, predicate)`

- **Signature:** `(label: string, predicate: (view: TraceView) => boolean) → void`
- **Asserts:** escape hatch — a named predicate over the run's trace projection view (`TraceView`). This is the same read-model the other `t.*` methods query, built from the run's projection snapshot.

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

### `t.judge(value, instruction, opts?)` — async

- **Signature:** `(value: unknown | unknown[], instruction: string, opts?: { label?: string; judge?: Partial<JudgeConfig> }) → Promise<void>`
- **Asserts:** the configured judge model grades `value` against `instruction` (a natural-language rubric). **Must be awaited** — the check function must be `async`.

```typescript title="my-task.eval.ts"
test("answer-is-correct", async (t, { deliverables }) => {
  await t.judge(
    deliverables.answer,
    "PASS when the answer is accurate, cites the source, and adds nothing false.",
  );
});
```

Records a single assertion tagged `evaluator_type: "llm"` with the judge's model, prompt, response, tokens, and latency attached — inspectable in the breakdown, not an opaque score. `value` accepts a single value or an array (the judge sees all of it).

:::tip[Facts are `t.check`, taste is `t.judge`]
A purely factual criterion — "every `Finland` was replaced by `Sweden`", "the JSON has these keys", "the answer contains `acme-corp`" — is cheaper and more reliable as a code matcher (`t.check` with `includes` / `matches` / `equals`). Reserve `t.judge` for taste, scoping, and quality. And when you do judge, pass only what the criterion actually grades — handing the judge both before *and* after text invites before/after confusion.
:::

#### Overriding the judge model per call

`opts.judge` overrides the run's judge config for **this call only**, merging field-by-field — use it to escalate one finicky criterion to a stronger model without switching the whole run onto an expensive default.

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

Absent fields inherit from the run's judge config (`runTask({ judge })`, or the `OPENROUTER_MODEL` / `AGENT_TASK_JUDGE_MODEL` env defaults), so `{ model }` alone is usually enough — `baseURL` and `apiKey` flow through unchanged. The overridden model is stamped on the assertion metadata and shown in the dashboard breakdown.

## Matchers

Imported from `@apo/sdk/agent-task` and passed to `t.check(value, matcher)`:

```typescript title="my-task.eval.ts"
import { includes, equals, matches, satisfies, similarity } from "@apo/sdk/agent-task";
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

Every `t.*` assertion is gated by an **evidence capability** — whether the trace projection can actually answer the question. Each capability is `available`, `partial`, or `unavailable`:

| Capability | `available` | `partial` | `unavailable` |
|---|---|---|---|
| Positive (`calledTool`, `loadedSkill`, `calledSubagent`, `messageIncludes`) | normal evaluation | pass if a match is found; otherwise `unsupported` | `unsupported` |
| Negative / upper-bound (`notCalledTool`, `usedNoTools`, `maxToolCalls`, `maxTurns`, `maxDurationMs`) | normal evaluation | `unsupported` (absence is inconclusive) | `unsupported` |
| `noFailedActions` | normal evaluation | fail if a known error exists; otherwise `unsupported` | `unsupported` |

An `unsupported` outcome records `pass: false` — it is never a silent pass. This is why a complete `apo-agent-task-v1` run with zero tools still has `tools = available`: the projection can *prove* `usedNoTools()`, not just fail to find tools.

:::note[Transparent wrappers]
The trace projection suppresses lifecycle wrappers (`ai.generateText`, `ai.streamText`) — assertions read the effective graph where children are reparented to the nearest retained ancestor. You never see a synthetic container row in `toolOrder` or `subagentCalls`.
:::

## See also

- [Tests](/concepts/tests/) — the concept: two kinds of test, one shape; how the verdict is computed.
- [Adapter API](/reference/adapter/) — where `deliverables` (the values you check) comes from.
- [Task API](/reference/task/) — where `test(...)` sits in the `.eval.ts` file.
