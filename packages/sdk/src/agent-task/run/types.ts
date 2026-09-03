import type { FileEntry, TaskDefinition } from "../task/types.ts";
import type { AgentTaskRunConfiguration } from "../adapter/types.ts";

/**
 * The outcome of a single assertion.
 *
 * - ``"pass"`` → ``pass=true``
 * - ``"fail"`` → ``pass=false``
 * - ``"unsupported"`` → ``pass=false``. The trace projection lacked the
 *   evidence this assertion needed (e.g. timing, error status). An unsupported
 *   trace assertion fails closed and explains which evidence was unavailable;
 *   it must never silently pass. Value assertions (``t.check``) and LLM
 *   assertions (``t.judge``) do not consult trace capabilities and retain
 *   their existing pass/fail behavior.
 */
export type AssertionOutcome = "pass" | "fail" | "unsupported";

/**
 * Metadata about an LLM judge call. Populated by evaluators that use an
 * LLM to make their pass/fail decision. All fields optional so code-only
 * evaluators can leave this undefined.
 */
export type JudgeMetadata = {
  /** Model identifier, e.g. ``"google/gemini-2.5-flash-lite"``. */
  model?: string;
  /**
   * Which response contract elicited this judgment (#163): reasoning-first
   * (the default) or the legacy verdict-first (``pass`` before
   * ``reasoning``, via ``APO_JUDGE_VERDICT_FIRST``). Group comparisons
   * across the default flip on this field, not on time.
   */
  contract?: "verdict-first" | "reasoning-first";
  /** The messages sent to the judge LLM. */
  prompt?: {
    system?: string;
    user?: string;
  };
  /** Raw LLM response text before parsing into {pass, reasoning}. */
  response?: string;
  /** Token usage if available from the provider. */
  tokens?: { input: number; output: number; cache_creation?: number; cache_read?: number };
  /** Estimated cost in USD, if available. */
  cost?: number;
  /** Wall-clock latency of the judge call in milliseconds. */
  latency_ms?: number;
  /** Temperature or other sampling parameters, if relevant. */
  temperature?: number;
};

/**
 * A source location for a failed code check — lets the dashboard render the
 * failure inline, editor-style. ``file`` is a display name (e.g. the checks
 * filename); ``line``/``column`` are 1-indexed into that file.
 */
export type CheckLocation = {
  file: string;
  line: number;
  column?: number;
};

/**
 * A single assertion within a code check (the recorder collects many per
 * check). Carries structured Expected/Received so the dashboard can render
 * testing-framework-style failures instead of a flattened prose string.
 *
 * - ``expected`` — what the assertion wanted (matcher label, or "≥1 read_file
 *   call" for trace asserts). Absent when not meaningful.
 * - ``received`` — the actual value/count the run produced. Serialized scalar
 *   for code assertions; the raw evaluated value for LLM judges (see field).
 * - ``location`` — where in the checks source this assertion lives.
 */
export type AssertionResult = {
  id: string;
  pass: boolean;
  reasoning: string;
  /**
   * The outcome category. ``"unsupported"`` means the trace
   * projection lacked the evidence this assertion needed (e.g. timing,
   * errors) — it fails closed (``pass=false``) with an explanatory reason
   * rather than vacuously passing. Absent on legacy results.
   */
  outcome?: AssertionOutcome;
  expected?: string;
  /**
   * The actual value the assertion observed. For code assertions this is a
   * short serialized scalar (`"3"`, `"read_file → write_file"`); for LLM
   * judges it is the **raw value passed to `t.judge`** — an arbitrary JSON
   * value (string, object, array, primitive), so the dashboard can render it
   * with a structured viewer instead of a truncated string.
   */
  received?: unknown;
  location?: CheckLocation;
  evaluator_type?: "llm" | "code";
  judge?: JudgeMetadata;
};

/**
 * Result of evaluating a single check.
 *
 * The three required fields ({@link id}, {@link pass}, {@link reasoning})
 * have been here since the beginning. The optional fields below are
 * enriched metadata that lets the dashboard show *what* was evaluated,
 * *how* it was evaluated, and — for LLM judges — exactly what the judge
 * was asked and what it answered.
 *
 * Evaluators that don't populate the optional fields still work; the
 * dashboard gracefully falls back to the legacy three-field display.
 */
export type EvaluationItemResult = {
  id: string;
  pass: boolean;
  reasoning: string;

  // ── Enriched metadata (all optional, backward compatible) ──────────

  /** The rubric instruction from the task definition ("PASS if …"). */
  instruction?: string;
  /** Name of the deliverable this check was evaluated against. */
  deliverable?: string;
  /**
   * What kind of evaluator produced this result.
   * Registered checks use ``"code"``. LLM-backed assertions inside a check
   * carry ``evaluator_type: "llm"`` in {@link assertions}.
   * - ``"regex"`` — pattern matching
   * Older persisted results may still use ``"llm"`` at this level.
   */
  evaluator_type?: "llm" | "code" | "regex";
  /**
   * If this check was judged by an LLM, details about the judge call
   * (model, prompt, response, tokens, cost, latency). Populated by the
   * evaluator author; absent for code-only evaluators.
   */
  judge?: JudgeMetadata;
  /**
   * For code checks: the source location of the failure (parsed from the
   * thrown error / failed assertion stack). Lets the dashboard highlight the
   * failing line. Absent when not a code check, when the check passed, or
   * when no frame could be resolved to the checks module.
   */
  location?: CheckLocation;
  /**
   * For code checks: the source filename the result came from (normally
   * the ``*.eval.ts`` file; ``"checks.ts"`` for legacy tasks), so the dashboard can show it even
   * when no line was resolved.
   */
  source_file?: string;
  /**
   * For code checks: the per-assertion breakdown (Expected/Received/location
   * each). Lets the dashboard mark every failing assertion at its own line,
   * testing-framework-style. Absent for non-code evaluators and old runs.
   */
  assertions?: AssertionResult[];
  /**
   * the snapshot source the checks ran against. ``"local"`` marks locally
   * recorded snapshots; ``"legacy-flow"`` survives only on results recorded
   * by the removed Flow-path loader. Absent on projection-first results
   * (the default).
   */
  source?: "canonical" | "local" | "legacy-flow";
  /**
   * the id of the `describe()` group this check was declared
   * inside. Absent for checks declared at the top level (no enclosing
   * describe) and for old results. The dashboard groups checks by this field.
   */
  group_id?: string;
  /**
   * the display name of the enclosing `describe()` group.
   * Defaults to the group id when the group was declared without a name.
   * Absent when {@link group_id} is absent.
   */
  group_name?: string;
};

export type TaskEvaluationResult = {
  checks: EvaluationItemResult[];
  pass: boolean;
};

export type TaskTranscript = {
  turns: TaskTranscriptTurn[];
};

export type TaskTranscriptTurn = {
  turnNumber: number;
  userAction: unknown;
  agentResponse: unknown;
};

export type TaskRunResult = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  traceRunId?: string;
  result: TaskEvaluationResult;
  deliverables: Record<string, unknown>;
  transcript: TaskTranscript;
  /**
   * The adapter's resolved model/effort for this run. Captured and
   * normalized from `AdapterSession.runConfiguration` immediately after the
   * session opens. Absent for adapters that do not report configuration.
   */
  runConfiguration?: AgentTaskRunConfiguration;
};
