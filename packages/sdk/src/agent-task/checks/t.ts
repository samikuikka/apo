/**
 * The assertion surface — `t`. Flat and eve-style: reads the trace (via
 * {@link TraceView}) for behavioural checks and grades explicit values via
 * `t.check`. Everything records (never throws), so a check reports all of its
 * failures, not just the first.
 *
 * Every assertion records structured ``expected`` / ``received`` values so
 * the dashboard can render testing-framework-style failures (Expected /
 * Received) instead of only a prose message.
 */

import { TraceView } from "../trace-projection/view.ts";
import type { TraceProjectionCapabilities } from "../trace-projection/types.ts";
import type { AssertionOutcome } from "../run/types.ts";
import type { Recorder } from "./recorder.ts";
import type { Matcher, ValueMatcher } from "./matchers.ts";
import { describeValue, matchValue } from "./matchers.ts";
import { callJudge } from "./judge.ts";

/** A tool/agent name matcher: literal (exact), RegExp, or predicate. */
export type NameMatcher = string | RegExp | ((name: string) => boolean);

/** Options for matching tool calls by count and recorded fields. */
export type ToolCallOptions = {
  count?: number;
  input?: ValueMatcher<unknown>;
  output?: ValueMatcher<unknown>;
  status?: "ok" | "error";
};

/**
 * LLM judge model config for `t.judge(...)` calls in checks.ts. Threaded
 * through `runTask({ judge })` from the caller — the runner has no opinion
 * about which model grades a deliverable.
 */
export type JudgeConfig = {
  /** Model id, e.g. ``"google/gemini-2.5-flash-lite"``. */
  model: string;
  /** Override the OpenRouter/OpenAI-compatible base URL. */
  baseURL?: string;
  /** Override the API key (defaults to env). */
  apiKey?: string;
};

export interface TestContext {
  // ── trace / "did it run well" ──────────────────────────────────────────
  /** Asserts a matching tool was called. Pass `{ count }` for an exact count. */
  calledTool(name: NameMatcher, opts?: ToolCallOptions): void;
  /** Asserts no tool call matches the supplied name and field constraints. */
  notCalledTool(name: NameMatcher, opts?: Omit<ToolCallOptions, "count">): void;
  /** Asserts the named tools appear, in this order (as a subsequence). */
  toolOrder(names: string[]): void;
  /** Asserts no tool calls happened at all. */
  usedNoTools(): void;
  /** Asserts at most `n` tool calls — anti-flail. */
  maxToolCalls(n: number): void;
  /** Asserts no tool/subagent call reported an error — anti-flail. */
  noFailedActions(): void;
  /** Asserts a skill was loaded. */
  loadedSkill(skill: string): void;
  /** Asserts a subagent delegation happened. */
  calledSubagent(agent: string): void;
  /** Asserts the agent's reply contains a substring or RegExp. */
  messageIncludes(token: string | RegExp): void;
  /** Asserts the run took at most `n` turns — anti-flail. */
  maxTurns(n: number): void;
  /** Asserts the run took at most `n` milliseconds — anti-flail. */
  maxDurationMs(n: number): void;
  /** Escape hatch for a named predicate over the complete normalized run. */
  assert(label: string, predicate: (flow: TraceView) => boolean): void;

  // ── values / deliverables ──────────────────────────────────────────────
  /** Grades any value (a deliverable, parsed JSON, anything) with a matcher. */
  check<T>(value: T, matcher: Matcher<T>, label?: string): void;
  /**
   * LLM-as-judge: asks the configured judge model to grade ``value`` against
   * ``instruction`` (a natural-language rubric). Async — the check function
   * must `await` it. Records a single assertion tagged
   * ``evaluator_type: "llm"`` with judge metadata (model, prompt, response,
   * tokens, latency) attached.
   */
  judge(values: unknown | unknown[], instruction: string, opts?: { label?: string }): Promise<void>;
}

/**
 * Canonical names of every assertion method on {@link TestContext}.
 *
 * Single source of truth for "what is a ``t.<method>`` call?" — consumers that
 * highlight, lint, or otherwise detect `t.*` usage in check source read this
 * array instead of keeping their own copy (which historically drifted out of
 * sync with the interface, leaving methods like ``t.maxTurns`` unstyled).
 *
 * The literal below is compile-time-checked against ``keyof TestContext``:
 * adding a method to the interface without registering it here is a type
 * error, and vice versa. See ``tests/test-context-methods.test.ts``.
 */
export const TEST_METHOD_NAMES = [
  "calledTool",
  "notCalledTool",
  "toolOrder",
  "usedNoTools",
  "maxToolCalls",
  "noFailedActions",
  "loadedSkill",
  "calledSubagent",
  "messageIncludes",
  "maxTurns",
  "maxDurationMs",
  "assert",
  "check",
  "judge",
] as const satisfies readonly (keyof TestContext)[];

/**
 * Compile-time exhaustiveness guard: errors if any {@link TestContext} method
 * is missing from {@link TEST_METHOD_NAMES}. A method on the interface with no
 * matching array entry makes the conditional type resolve to the offending
 * key instead of ``never``, which fails to assign to ``TEST_METHOD_NAMES``.
 * Kept out of the public type surface (no export) — it's a build-time check.
 */
type _TestMethodNamesComplete<T = keyof TestContext> =
  Exclude<T, (typeof TEST_METHOD_NAMES)[number]> extends never ? true : never;
// If this line errors, a TestContext method is not listed in TEST_METHOD_NAMES.
const _testMethodNamesComplete: _TestMethodNamesComplete = true;

function describeName(m: NameMatcher): string {
  if (typeof m === "string") return `"${m}"`;
  if (m instanceof RegExp) return m.source;
  return "<predicate>";
}

function matchName(name: string, m: NameMatcher): boolean {
  if (typeof m === "string") return name === m;
  if (m instanceof RegExp) return m.test(name);
  return m(name);
}

export function createTestContext(
  view: TraceView,
  rec: Recorder,
  judgeConfig?: JudgeConfig,
): TestContext {
  return {
    calledTool(name, opts) {
      const count = view.toolCalls.filter((call) =>
        matchesToolCall(call, name, opts),
      ).length;
      const want = opts?.count;
      const pass = want === undefined ? count > 0 : count === want;
      rec.record(
        `calledTool(${describeName(name)})`,
        pass,
        pass
          ? ""
          : want === undefined
            ? `expected at least one ${describeName(name)} call, got ${count}`
            : `expected exactly ${want} ${describeName(name)} calls, got ${count}`,
        {
          expected:
            want === undefined
              ? `≥1 ${describeName(name)} call`
              : `exactly ${want} ${describeName(name)} calls`,
          received: `${count}`,
        },
      );
    },

    notCalledTool(name, opts) {
      const count = view.toolCalls.filter((call) =>
        matchesToolCall(call, name, opts),
      ).length;
      rec.record(
        `notCalledTool(${describeName(name)})`,
        count === 0,
        count === 0 ? "" : `expected no ${describeName(name)} calls, got ${count}`,
        { expected: `0 ${describeName(name)} calls`, received: `${count}` },
      );
    },

    toolOrder(names) {
      const order = view.toolNamesInOrder;
      let cursor = 0;
      let missingIdx = -1;
      for (let i = 0; i < names.length; i++) {
        const found = order.indexOf(names[i], cursor);
        if (found === -1) {
          missingIdx = i;
          break;
        }
        cursor = found + 1;
      }
      const ok = missingIdx === -1;
      // Arrow separators read better than commas, and "expected X after Y"
      // pinpoints WHICH tool broke the order — clearer than dumping both lists
      // and asking the reader to do the visual diff.
      const expectedStr = names.join(" → ");
      const actualStr = order.length > 0 ? order.join(" → ") : "(no tools)";
      const message = ok
        ? ""
        : missingIdx === 0
          ? `expected "${names[0]}" first; actual order ${actualStr}`
          : `expected "${names[missingIdx]}" after "${names[missingIdx - 1]}"; actual order ${actualStr}`;
      rec.record(`toolOrder(${expectedStr})`, ok, message, {
        expected: expectedStr,
        received: actualStr,
      });
    },

    usedNoTools() {
      const count = view.toolCalls.length;
      rec.record("usedNoTools", count === 0, count === 0 ? "" : `expected no tool calls, got ${count}`, {
        expected: "0 tool calls",
        received: `${count}`,
      });
    },

    maxToolCalls(n) {
      const count = view.toolCalls.length;
      rec.record(`maxToolCalls(${n})`, count <= n, count <= n ? "" : `expected ≤ ${n} tool calls, got ${count}`, {
        expected: `≤ ${n} tool calls`,
        received: `${count}`,
      });
    },

    noFailedActions() {
      const failed = view.failedActions;
      rec.record("noFailedActions", failed === 0, failed === 0 ? "" : `${failed} failed action(s)`, {
        expected: "0 failed actions",
        received: `${failed}`,
      });
    },

    loadedSkill(skill) {
      const ok = view.skillLoads.some((s) => s.skill === skill);
      rec.record(`loadedSkill("${skill}")`, ok, ok ? "" : `skill "${skill}" was not loaded`, {
        expected: `skill "${skill}" loaded`,
        received: view.skillLoads.map((s) => s.skill).join(", ") || "none",
      });
    },

    calledSubagent(agent) {
      const ok = view.subagentCalls.some((s) => s.agent === agent);
      rec.record(`calledSubagent("${agent}")`, ok, ok ? "" : `subagent "${agent}" was not called`, {
        expected: `subagent "${agent}" called`,
        received: view.subagentCalls.map((s) => s.agent).join(", ") || "none",
      });
    },

    messageIncludes(token) {
      const re = typeof token === "string" ? new RegExp(token) : token;
      const ok = re.test(view.reply);
      rec.record(`messageIncludes(${token instanceof RegExp ? token.source : token})`, ok, ok ? "" : `reply did not include ${token}`, {
        expected: `reply includes ${token instanceof RegExp ? token.source : token}`,
        received: describeValue(view.reply).slice(0, 200),
      });
    },

    maxTurns(n) {
      const turns = view.turnCount;
      const pass = turns !== undefined && turns <= n;
      rec.record(`maxTurns(${n})`, pass, pass ? "" : `expected ≤ ${n} turns, got ${turns}`, {
        expected: `≤ ${n} turns`,
        received: `${turns}`,
      });
    },

    maxDurationMs(n) {
      const ms = view.durationMs;
      const pass = ms !== undefined && ms <= n;
      rec.record(`maxDurationMs(${n})`, pass, pass ? "" : `expected ≤ ${n}ms, took ${ms}ms`, {
        expected: `≤ ${n}ms`,
        received: `${ms}ms`,
      });
    },

    check(value, matcher, label) {
      const pass = matcher.test(value);
      rec.record(
        label ?? "check",
        pass,
        pass ? "" : `expected ${label ?? "value"} ${matcher.label}`,
        // Expected = the matcher's own description; received = the actual value.
        { expected: matcher.label, received: describeValue(value) },
      );
    },

    assert(label, predicate) {
      const pass = predicate(view);
      rec.record(label, pass, pass ? "" : `assertion "${label}" failed`, {
        expected: label,
        received: pass ? "true" : "false",
      });
    },

    async judge(values, instruction, opts) {
      const label = opts?.label ?? "judge";
      // Capture the call site BEFORE any await. After `await callJudge` resumes,
      // V8 reports this caller's frame at an unreliable line (often the
      // statement's closing `});`), which placed the failure marker on the
      // wrong line. Pinning it here lands the marker on `await t.judge(`.
      const location = rec.captureLocation();
      const valueArray = Array.isArray(values) ? values : [values];
      if (!judgeConfig) {
        rec.record(
          label,
          false,
          "No judge model configured. Set one of:\n" +
          "• OPENROUTER_MODEL + OPENROUTER_API_KEY (OpenRouter — works with 200+ models, one account)\n" +
          "• OPENAI_MODEL + OPENAI_API_KEY (OpenAI direct)\n" +
          "Or pass { judge } to runTask() programmatically.",
          { evaluator_type: "llm", location },
        );
        return;
      }
      try {
        const { pass, reasoning, judge } = await callJudge({
          values: valueArray,
          instruction,
          model: judgeConfig.model,
          baseURL: judgeConfig.baseURL,
          apiKey: judgeConfig.apiKey,
        });
        rec.record(label, pass, reasoning, {
          evaluator_type: "llm",
          judge,
          expected: instruction,
          // Store the raw evaluated value (not a truncated string) so the
          // dashboard can render it with the right viewer — Markdown for
          // prose, a JSON tree for structured objects.
          received: valueArray.length === 1 ? valueArray[0] : valueArray,
          location,
        });
      } catch (error) {
        rec.record(
          label,
          false,
          `judge failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            evaluator_type: "llm",
            expected: instruction,
            received: valueArray.length === 1 ? valueArray[0] : valueArray,
            location,
          },
        );
      }
    },
  };
}

/**
 * Capability key → human description, for unsupported-outcome reasoning.
 */
const CAPABILITY_LABELS: Record<keyof TraceProjectionCapabilities, string> = {
  messages: "message",
  tools: "tool",
  errors: "error",
  timing: "timing",
  skills: "skill",
  subagents: "subagent",
} as const;

/**
 * Create a projection-first test context from a {@link TraceView} (SPEC-130
 * Track C). Mirrors {@link createTestContext} but gates trace-dependent
 * assertions on capabilities: when the projection declares a capability
 * ``unavailable``, the assertion records ``outcome="unsupported"`` (pass=false)
 * instead of vacuously passing against fabricated zero/empty evidence.
 *
 * Value assertions (``t.check``) and LLM assertions (``t.judge``) do not
 * consult capabilities and retain their existing behavior.
 */
export function createTraceTestContext(
  view: TraceView,
  rec: Recorder,
  judgeConfig?: JudgeConfig,
): TestContext {
  const unsupported = (
    id: string,
    capability: keyof TraceProjectionCapabilities,
  ): void => {
    const label = CAPABILITY_LABELS[capability];
    rec.record(id, false, `${label} evidence is unavailable in this trace projection`, {
      outcome: "unsupported" as AssertionOutcome,
      expected: `${label} evidence available`,
      received: view.requireCapability(capability),
    });
  };

  const isAvailable = (c: keyof TraceProjectionCapabilities): boolean =>
    view.requireCapability(c) === "available";

  return {
    calledTool(name, opts) {
      if (!isAvailable("tools")) {
        unsupported(`calledTool(${describeName(name)})`, "tools");
        return;
      }
      // Matching by { status } additionally requires errors evidence.
      if (opts?.status !== undefined && !isAvailable("errors")) {
        unsupported(`calledTool(${describeName(name)}, { status })`, "errors");
        return;
      }
      const count = view.toolCalls.filter((call) =>
        matchesTraceToolCall(call, name, opts),
      ).length;
      const want = opts?.count;
      const pass = want === undefined ? count > 0 : count === want;
      rec.record(
        `calledTool(${describeName(name)})`,
        pass,
        pass
          ? ""
          : want === undefined
            ? `expected at least one ${describeName(name)} call, got ${count}`
            : `expected exactly ${want} ${describeName(name)} calls, got ${count}`,
        {
          expected:
            want === undefined
              ? `≥1 ${describeName(name)} call`
              : `exactly ${want} ${describeName(name)} calls`,
          received: `${count}`,
        },
      );
    },

    notCalledTool(name, opts) {
      if (!isAvailable("tools")) {
        unsupported(`notCalledTool(${describeName(name)})`, "tools");
        return;
      }
      const count = view.toolCalls.filter((call) =>
        matchesTraceToolCall(call, name, opts),
      ).length;
      rec.record(
        `notCalledTool(${describeName(name)})`,
        count === 0,
        count === 0 ? "" : `expected no ${describeName(name)} calls, got ${count}`,
        { expected: `0 ${describeName(name)} calls`, received: `${count}` },
      );
    },

    toolOrder(names) {
      if (!isAvailable("tools")) {
        unsupported(`toolOrder(${names.join(" → ")})`, "tools");
        return;
      }
      const order = view.toolNamesInOrder;
      let cursor = 0;
      let missingIdx = -1;
      for (let i = 0; i < names.length; i++) {
        const found = order.indexOf(names[i], cursor);
        if (found === -1) {
          missingIdx = i;
          break;
        }
        cursor = found + 1;
      }
      const ok = missingIdx === -1;
      const expectedStr = names.join(" → ");
      const actualStr = order.length > 0 ? order.join(" → ") : "(no tools)";
      const message = ok
        ? ""
        : missingIdx === 0
          ? `expected "${names[0]}" first; actual order ${actualStr}`
          : `expected "${names[missingIdx]}" after "${names[missingIdx - 1]}"; actual order ${actualStr}`;
      rec.record(`toolOrder(${expectedStr})`, ok, message, {
        expected: expectedStr,
        received: actualStr,
      });
    },

    usedNoTools() {
      if (!isAvailable("tools")) {
        unsupported("usedNoTools", "tools");
        return;
      }
      const count = view.toolCalls.length;
      rec.record("usedNoTools", count === 0, count === 0 ? "" : `expected no tool calls, got ${count}`, {
        expected: "0 tool calls",
        received: `${count}`,
      });
    },

    maxToolCalls(n) {
      if (!isAvailable("tools")) {
        unsupported(`maxToolCalls(${n})`, "tools");
        return;
      }
      const count = view.toolCalls.length;
      rec.record(`maxToolCalls(${n})`, count <= n, count <= n ? "" : `expected ≤ ${n} tool calls, got ${count}`, {
        expected: `≤ ${n} tool calls`,
        received: `${count}`,
      });
    },

    noFailedActions() {
      if (!isAvailable("errors")) {
        unsupported("noFailedActions", "errors");
        return;
      }
      const failed = view.failedActions ?? 0;
      rec.record("noFailedActions", failed === 0, failed === 0 ? "" : `${failed} failed action(s)`, {
        expected: "0 failed actions",
        received: `${failed}`,
      });
    },

    loadedSkill(skill) {
      if (!isAvailable("skills")) {
        unsupported(`loadedSkill("${skill}")`, "skills");
        return;
      }
      const ok = view.skillLoads.some((s) => s.skill === skill);
      rec.record(`loadedSkill("${skill}")`, ok, ok ? "" : `skill "${skill}" was not loaded`, {
        expected: `skill "${skill}" loaded`,
        received: view.skillLoads.map((s) => s.skill).join(", ") || "none",
      });
    },

    calledSubagent(agent) {
      if (!isAvailable("subagents")) {
        unsupported(`calledSubagent("${agent}")`, "subagents");
        return;
      }
      const ok = view.subagentCalls.some((s) => s.agent === agent);
      rec.record(`calledSubagent("${agent}")`, ok, ok ? "" : `subagent "${agent}" was not called`, {
        expected: `subagent "${agent}" called`,
        received: view.subagentCalls.map((s) => s.agent).join(", ") || "none",
      });
    },

    messageIncludes(token) {
      if (!isAvailable("messages")) {
        unsupported(`messageIncludes(${token instanceof RegExp ? token.source : token})`, "messages");
        return;
      }
      const re = typeof token === "string" ? new RegExp(token) : token;
      const ok = re.test(view.reply);
      rec.record(`messageIncludes(${token instanceof RegExp ? token.source : token})`, ok, ok ? "" : `reply did not include ${token}`, {
        expected: `reply includes ${token instanceof RegExp ? token.source : token}`,
        received: describeValue(view.reply).slice(0, 200),
      });
    },

    maxTurns(n) {
      if (!isAvailable("messages")) {
        unsupported(`maxTurns(${n})`, "messages");
        return;
      }
      const turns = view.turnCount ?? 0;
      rec.record(`maxTurns(${n})`, turns <= n, turns <= n ? "" : `expected ≤ ${n} turns, got ${turns}`, {
        expected: `≤ ${n} turns`,
        received: `${turns}`,
      });
    },

    maxDurationMs(n) {
      if (!isAvailable("timing")) {
        unsupported(`maxDurationMs(${n})`, "timing");
        return;
      }
      const ms = view.durationMs;
      if (ms === undefined) {
        unsupported(`maxDurationMs(${n})`, "timing");
        return;
      }
      rec.record(`maxDurationMs(${n})`, ms <= n, ms <= n ? "" : `expected ≤ ${n}ms, took ${ms}ms`, {
        expected: `≤ ${n}ms`,
        received: `${ms}ms`,
      });
    },

    assert(label, predicate) {
      // The author is responsible for checking capabilities inside the predicate.
      const pass = predicate(view as unknown as TraceView);
      rec.record(label, pass, pass ? "" : `assertion "${label}" failed`, {
        expected: label,
        received: pass ? "true" : "false",
      });
    },

    check(value, matcher, label) {
      const pass = matcher.test(value);
      rec.record(
        label ?? "check",
        pass,
        pass ? "" : `expected ${label ?? "value"} ${matcher.label}`,
        { expected: matcher.label, received: describeValue(value) },
      );
    },

    async judge(values, instruction, opts) {
      // judge does not consult trace capabilities.
      const label = opts?.label ?? "judge";
      const location = rec.captureLocation();
      const valueArray = Array.isArray(values) ? values : [values];
      if (!judgeConfig) {
        rec.record(
          label,
          false,
          "No judge model configured. Set one of:\n" +
          "• OPENROUTER_MODEL + OPENROUTER_API_KEY (OpenRouter — works with 200+ models, one account)\n" +
          "• OPENAI_MODEL + OPENAI_API_KEY (OpenAI direct)\n" +
          "Or pass { judge } to runTask() programmatically.",
          { evaluator_type: "llm", location },
        );
        return;
      }
      try {
        const { pass, reasoning, judge } = await callJudge({
          values: valueArray,
          instruction,
          model: judgeConfig.model,
          baseURL: judgeConfig.baseURL,
          apiKey: judgeConfig.apiKey,
        });
        rec.record(label, pass, reasoning, {
          evaluator_type: "llm",
          judge,
          expected: instruction,
          received: valueArray.length === 1 ? valueArray[0] : valueArray,
          location,
        });
      } catch (error) {
        rec.record(
          label,
          false,
          `judge failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            evaluator_type: "llm",
            expected: instruction,
            received: valueArray.length === 1 ? valueArray[0] : valueArray,
            location,
          },
        );
      }
    },
  };
}

function matchesTraceToolCall(
  call: { name: string; input?: unknown; output?: unknown; status?: string },
  name: NameMatcher,
  opts?: Omit<ToolCallOptions, "count">,
): boolean {
  if (!matchName(call.name, name)) return false;
  if (opts?.input !== undefined && !matchValue(call.input, opts.input)) {
    return false;
  }
  if (opts?.output !== undefined && !matchValue(call.output, opts.output)) {
    return false;
  }
  if (opts?.status !== undefined && call.status !== opts.status) {
    return false;
  }
  return true;
}

function matchesToolCall(
  call: TraceView["toolCalls"][number],
  name: NameMatcher,
  opts?: Omit<ToolCallOptions, "count">,
): boolean {
  if (!matchName(call.name, name)) return false;
  if (opts?.input !== undefined && !matchValue(call.input, opts.input)) {
    return false;
  }
  if (opts?.output !== undefined && !matchValue(call.output, opts.output)) {
    return false;
  }
  if (opts?.status !== undefined && call.status !== opts.status) {
    return false;
  }
  return true;
}
