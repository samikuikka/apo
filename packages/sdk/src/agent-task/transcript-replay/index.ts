/**
 * Transcript replay — reconstruct full-fidelity OTLP traces from harness
 * session transcripts (Claude Code / Codex session JSONL).
 *
 * Two consumers share this module:
 * - Adapter capture mode: a harness adapter runs the real harness without any
 *   OTel integration, then replays the session transcript into the task run's
 *   live trace (options.parentSpanId + the run's attempt token).
 * - Standalone import: an observed real-world session becomes a trace in the
 *   project (API-key auth), ready to be seeded into a task suite.
 */

export { parseClaudeCodeTranscript } from "./claude-code.ts";
export { parseCodexTranscript } from "./codex.ts";
export { detectTranscriptSource } from "./detect.ts";
export {
  transcriptSessionToOtlp,
  type OtlpAttribute,
  type OtlpAttributeValue,
  type OtlpSpan,
  type OtlpTracesPayload,
  type TranscriptReplayOptions,
} from "./otlp.ts";
export {
  TranscriptReplayError,
  exportOtlpTraces,
  resolveOtlpTracesUrl,
  type ExportOtlpTracesOptions,
} from "./export.ts";
export {
  replayAdapterTranscript,
  type ReplayAdapterTranscriptOptions,
  type TranscriptCaptureResult,
} from "./capture.ts";
export type {
  ParsedTranscriptSession,
  TranscriptSource,
  TranscriptToolCall,
  TranscriptTurn,
  TranscriptUsage,
} from "./types.ts";
