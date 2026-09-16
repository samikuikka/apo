export type {
  TaskDefinition,
  TaskConfig,
  FileEntry,
} from "./task/types.ts";
export {
  defineTask,
  task,
  resetTaskRegistry,
  type TaskScope,
} from "./task/defineTask.ts";
export { loadTask, type LoadedTask } from "./task/loadTask.ts";
export { TaskFiles } from "./task/TaskFiles.ts";

export type {
  AdapterDefinition,
  AdapterSession,
  DeliverableDefinition,
  TypedAdapterDefinition,
  CollectedDeliverables,
  AgentTurnResult,
  AgentTaskRunConfiguration,
  InitializeContext,
  StartSessionContext,
  CollectDeliverablesContext,
  CleanupContext,
  AdapterRuntimeState,
} from "./adapter/types.ts";
export { defineAdapter } from "./adapter/defineAdapter.ts";

// ── Unified testing framework ───────────────────────────────────────────
// `test` registers a check; the callback receives `t` (flat, eve-style
// assertions over the run's Flow) and the deliverables. Matchers are the
// single way to assert values via `t.check(value, matcher)`.
export {
  defineCheck as test,
  describe,
  resetFlowChecks,
  filePaths,
} from "./checks/flow-runner.ts";

// ── File Artifacts ───────────────────────────────────────────
// Declare a file Deliverable from a local path; the runner streams it to the
// backend rather than buffering bytes in the result body.
export {
  fileArtifact,
  isFileArtifact,
  type FileArtifact,
  type FileArtifactOptions,
} from "./deliverables/artifact.ts";
export {
  persistFileArtifacts,
  type ArtifactUploadConfig,
  type DeliverableSummary,
  type PreparedTaskResult,
} from "./deliverables/upload.ts";
export type {
  CheckContext,
  TestRegistration,
  CheckGroup,
  DescribeRegistration,
} from "./checks/flow-runner.ts";
export {
  includes,
  equals,
  matches,
  satisfies,
  similarity,
  matchValue,
  type Matcher,
  type ValueMatcher,
} from "./checks/matchers.ts";
export type {
  TestContext,
  NameMatcher,
  ToolCallOptions,
  JudgeConfig,
  JudgeScope,
} from "./checks/t.ts";
export type {
  JudgeContext,
  JudgePromptBuilder,
} from "./checks/judge.ts";
export { TEST_METHOD_NAMES } from "./checks/t.ts";
export {
  type AgentBudget,
  type AgentEvidence,
  type AgentJudgeOptions,
} from "./checks/agent-session.ts";
export type {
  AgentJudgeSession,
  AgentJudgeStep,
  AgentJudgeOutcome,
  EvidenceFingerprint,
} from "./run/types.ts";
export {
  compactChecksForSubmission,
  RECEIVED_VALUE_LIMIT,
  JUDGE_SEGMENT_LIMIT,
  type CheckCompaction,
} from "./checks/compact.ts";
export type { Flow, FlowEvent, ToolCallStatus } from "./flow/types.ts";
export { FlowView } from "./flow/view.ts";
export {
  fromOpenAIMessages,
  fromAnthropicMessages,
  fromAISDK,
  type OpenAIMessage,
  type AnthropicMessage,
  type AISDKResult,
} from "./flow/sources.ts";


export type {
  TaskEvaluationResult,
  TaskRunResult,
  TaskTranscript,
  TaskTranscriptTurn,
} from "./run/types.ts";
export { runTask, AgentTaskRunError, type RunTaskOptions } from "./run/runTask.ts";
export {
  rejudgeTaskRun,
  RejudgeError,
  type RejudgeCheckStability,
  type RejudgeEndpoints,
  type RejudgeOptions,
  type RejudgeOutcome,
} from "./run/rejudge.ts";
export {
  parseAgentTaskCliArgs,
  runAgentTaskCli,
  type AgentTaskCliOptions,
} from "./cli.ts";
export { discoverAgentTaskDirs } from "./discovery.ts";
export {
  loadTaskRuntime,
  runTaskDir,
  type AgentTaskRuntime,
  type AgentTaskRunSummary,
} from "./task-runtime.ts";
export type {
  AgentTaskTraceContext,
  AgentTaskTraceOptions,
} from "./tracing.ts";

export {
  turn,
  getTaskTurn,
  resetTaskTurn,
  resolveTurn,
  type TurnFn,
  type TurnContext,
  type TurnRecord,
} from "./turn.ts";

export type { DeliverableValidationResult } from "./deliverables/types.ts";

// ── Vercel AI SDK tracing integration ───────────────────────────────────
// `createApoTracer` returns an `experimental_telemetry` shape for the AI
// SDK's `generateText` / `streamText`. Tool calls and generations are traced
// automatically — no manual span code in the adapter.
export {
  createApoTracer,
  type CreateApoTracerOptions,
} from "./integrations/ai-sdk.ts";

// ── OpenAI JS SDK tracing integration ───────────────────────────────────
// `createApoOpenAI` wraps an OpenAI client so `chat.completions.create()`
// is traced automatically. Works with any OpenAI-compatible endpoint
// (OpenRouter, Azure OpenAI, local servers, etc.).
export {
  createApoOpenAI,
  type CreateApoOpenAIOptions,
} from "./integrations/openai.ts";

// ── Anthropic JS SDK tracing integration ────────────────────────────────
// `createApoAnthropic` wraps an Anthropic client so `messages.create()` is
// traced automatically.
export {
  createApoAnthropic,
  type CreateApoAnthropicOptions,
} from "./integrations/anthropic.ts";

// ── OTel-native tracing (SpanProcessor) ─────────────────────────────────
// Register once, and any OTel-emitting SDK (Vercel AI SDK, OpenAI Agents
// SDK, etc.) is traced automatically during a run — no per-SDK wrapper.
export {
  registerApoTracing,
  type RegisterApoTracingOptions,
  resetApoTracing,
} from "./integrations/register.ts";
export { ApoSpanProcessor } from "./integrations/otel-processor.ts";
export {
  withApoRun,
  withApoRunSync,
  getActiveApoRun,
  type ApoRunContext,
} from "./integrations/run-context.ts";

// ── Task Revision manifest ────────────────────────────────────
// Pure canonicalizer shared with the Python twin. The CLI filesystem walker
// consumes this to produce a content-addressed identity for a caller's
// workspace; both runtimes must agree byte-for-byte on the canonical JSON and
// digest over the shared corpus at specs/contracts/task-revision/v1/cases/.
export {
  buildManifest,
  canonicalManifestJson,
  contentSha256,
  normalizeManifestPath,
  sha256Hex,
  type ManifestFile,
  type ManifestFileInput,
  type ModeClass,
  type TaskRevisionManifestV1,
} from "./task-revision-manifest.ts";
