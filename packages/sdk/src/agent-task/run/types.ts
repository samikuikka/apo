import type { FileEntry, TaskDefinition } from "../task/types.ts";
import type { AgentTaskRunConfiguration } from "../adapter/types.ts";
import type { SteerTrigger } from "../steer.ts";
import type { SteerDeliveryBoundary } from "../adapter/types.ts";

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
 * - ``"error"`` → ``pass=false``. An LLM judge produced no verdict: it was
 *   unreachable, returned an HTTP error, or sent an empty or truncated reply
 *   (after one retry). The check's quality is unknown, not failed.
 */
export type AssertionOutcome = "pass" | "fail" | "unsupported" | "error";

/**
 * Metadata about an LLM judge call. Populated by evaluators that use an
 * LLM to make their pass/fail decision. All fields optional so code-only
 * evaluators can leave this undefined.
 */
export type JudgeMetadata = {
  /** Model identifier, e.g. ``"deepseek/deepseek-v4.1-flash"``. */
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
  /**
   * Agentic-judge session transcript (`t.agent`). Absent for single-shot
   * `t.judge` calls. Records every investigation step (tool calls with
   * truncated results), the session outcome, per-step usage, and the
   * content-hashed evidence manifest (replay audit backbone).
   */
  session?: AgentJudgeSession;
  /**
   * Trace span id of this judgment itself (issue #288): the span the trace
   * context opens around the judge call / agent session. Lets any surface
   * holding this metadata deep-link into the judge's span in the trace view
   * (`/traces/{trace_run_id}?observation={span_id}`) instead of re-finding
   * it by name. Absent when the run is untraced or the span id can't be
   * trusted (the noop trace context's sentinel).
   */
  span_id?: string;
  /**
   * Second-grader evidence: a typed-decision model (Jev via OpenRouter's
   * `/alpha/decisions`) graded the same deliverable + instruction alongside
   * the primary judge. Opt-in via `APO_SECOND_JUDGE_MODEL`. The primary
   * verdict is never changed by it — the point is agreement and confidence
   * as extra signals per check, not a second vote.
   */
  secondJudge?: SecondJudgeEvidence;
  /**
   * Present only when the second judge's verdict decided this check (cascade
   * mode, `judge.mode: "cascade"`): the primary LLM judge was not called.
   * Absent = the primary judge decided. The `model` field above then names
   * the decision model, and `response` carries its typed verdict.
   */
  verdict_by?: "second-judge";
};

/**
 * Evidence from the second grader. `error` is set when the decisions
 * endpoint could not be reached — a failed second opinion must never
 * affect the check's verdict. `skipped` is set when no verdict was
 * attempted or possible because the second judge could not read the
 * input — a different fact from a transport failure, and rendered
 * distinctly so a run can say "N checks had no second opinion because
 * the value was too large" without grepping error strings (issue #311).
 */
export type SecondJudgeEvidence = {
  /** Decision-model id that graded, e.g. `typesafe/jev-1.13`. */
  model: string;
  /** The typed verdict the model returned. */
  choice?: "pass" | "fail";
  /** P(pass) from the model's probability distribution over the choice. */
  passProbability?: number;
  /** The model's own confidence in its choice (0-1). */
  confidence?: number;
  /** Input tokens billed for the decision, when the provider reports usage. */
  inputTokens?: number;
  /** Cost in USD, when the provider reports it. */
  costUsd?: number;
  /** Wall-clock latency of the decision call in milliseconds. */
  latencyMs?: number;
  /**
   * Why no verdict was possible (as opposed to attempted): the input
   * exceeded the second judge model's context limit, so the provider
   * rejected it before judging.
   */
  skipped?: string;
  /** Why no verdict was recorded (transport/HTTP/parse failure). */
  error?: string;
  /**
   * True when the second judge graded a `secondJudgeValue` projection
   * instead of the full value the primary judge saw — the verdict
   * corroborates the projection, not the whole deliverable.
   */
  projected?: boolean;
};

/**
 * One investigation step of an agentic judge session. Tool results are
 * truncated text; the sha256 + byte size are always kept so the full value
 * stays recoverable from the evidence store (the transcript is an index,
 * not a copy).
 */
export type AgentJudgeStep = {
  index: number;
  tool_calls?: {
    name: string;
    input?: string;
    result?: string;
    result_sha256?: string;
    result_bytes?: number;
  }[];
  /** Assistant prose, if the model produced text alongside tool calls. */
  text?: string;
  tokens?: { input?: number; output?: number; cost?: number };
  latency_ms?: number;
};

/** How an agentic judge session ended. */
export type AgentJudgeOutcome = "verdict" | "budget_exhausted" | "error";

/**
 * A fingerprint of one piece of evidence the judge consumed — the
 * content-addressed manifest. Never truncated.
 */
export type EvidenceFingerprint = {
  step: number;
  tool: string;
  args_sha256?: string;
  result_sha256: string;
  result_bytes: number;
};

/** Transcript-shaped record of one `t.agent` session. */
export type AgentJudgeSession = {
  /** Tool names offered to the judge. */
  tools?: string[];
  /** Turn-0 context: system briefing and the rubric (user message). */
  briefing?: { system?: string; rubric?: string };
  /** Ordered investigation steps. */
  steps?: AgentJudgeStep[];
  outcome: AgentJudgeOutcome;
  /** Evidence manifest — what this session consumed, hashed. Never truncated. */
  evidence?: EvidenceFingerprint[];
  usage?: {
    steps?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
  };
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
  evaluator_type?: "llm" | "code" | "agent";
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

  /**
   * The outcome category, rolled up from this check's assertions. Set only
   * when the check failed and *every* failing assertion failed for lack of
   * a verdict: ``"error"`` — the judge never answered (unreachable, HTTP
   * error, empty reply), so the check's quality is unknown, not failed;
   * ``"unsupported"`` — the trace projection lacked the evidence. Absent
   * when the check passed or genuinely failed on evidence, so a real FAIL
   * is never masked by an incidental judge error alongside it (issue #323).
   */
  outcome?: AssertionOutcome;
  /** The rubric instruction from the task definition ("PASS if …"). */
  instruction?: string;
  /** Name of the deliverable this check was evaluated against. */
  deliverable?: string;
  /**
   * What kind of evaluator produced this result, derived from the recorded
   * assertions: ``"code"`` for purely deterministic checks, ``"llm"`` when
   * every assertion judged, ``"agent"`` for pure agentic sessions,
   * ``"mixed"`` when a check combines judged and deterministic assertions.
   * LLM-backed assertions also carry ``evaluator_type: "llm"`` in
   * {@link assertions}.
   * - ``"regex"`` — pattern matching
   * Older persisted results may still use ``"llm"`` at this level.
   */
  evaluator_type?: "llm" | "code" | "agent" | "regex" | "mixed";
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
  /**
   * Set when the run has no verdict: every failing check got no answer from
   * the judge (`outcome: "error"`) and nothing genuinely failed. `pass` stays
   * `false`; readers should report "no verdict" rather than FAIL (issue #323).
   */
  noVerdict?: true;
};

export type TaskTranscript = {
  turns: TaskTranscriptTurn[];
};

/**
 * Outcome of one scripted steer. Steers never fail the run by themselves —
 * a dropped or errored steer is recorded here and on the trace, and
 * `t.steerDelivered` is what turns it red.
 */
export type SteerRecord = {
  /** 1-based, registration order across the whole run. */
  number: number;
  /** Scripted turn the steer targeted. */
  turn: number;
  label?: string;
  trigger: SteerTrigger;
  message: unknown;
  status: "delivered" | "undelivered" | "error";
  /** ISO timestamp of successful delivery. */
  deliveredAt?: string;
  boundary?: SteerDeliveryBoundary;
  /**
   * Why undelivered ("turn ended before trigger fired", "no progress events
   * observed for this turn", "target turn never ran"), or the injection
   * error message when status === "error".
   */
  reason?: string;
};

export type TaskTranscriptTurn = {
  turnNumber: number;
  userAction: unknown;
  agentResponse: unknown;
  /** Steers that targeted this turn, in steerNumber order. */
  steers?: SteerRecord[];
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
