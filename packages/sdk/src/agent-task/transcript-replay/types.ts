/**
 * Normalized transcript model — the common shape every harness transcript
 * parser produces, and the input to the OTLP translator.
 *
 * The model is deliberately lossy-but-sufficient for trace reconstruction:
 * per turn it keeps the user/assistant text, thinking, tool calls with their
 * results, model identity, and token usage. Anything the projection cannot
 * use (streaming chunk boundaries, harness housekeeping) is folded away.
 */

export type TranscriptSource = "claude-code" | "codex";

export type TranscriptUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

export type TranscriptToolCall = {
  callId: string;
  name: string;
  /** Arguments exactly as recorded — parsed object when the harness allows, raw string otherwise. */
  input: unknown;
  /** Rendered result text or the raw output payload; absent when the transcript never recorded one. */
  result?: unknown;
  /** ISO timestamp of the call, when the transcript carries one. */
  startedAt?: string;
  /** ISO timestamp of the matching result, when the transcript carries one. */
  endedAt?: string;
};

export type TranscriptTurn = {
  /** Zero-based position of the turn within the session. */
  index: number;
  /** ISO timestamp of the user message that opened the turn. */
  startedAt: string;
  /** ISO timestamp of the last observed event in the turn, when known. */
  endedAt?: string;
  model?: string;
  userMessage?: string;
  assistantMessage?: string;
  /** Extended-thinking text (Claude) or reasoning summaries (Codex). */
  thinkingText?: string;
  /** Codex commentary-phase messages (progress narration, not reasoning). */
  commentary?: string[];
  toolCalls: TranscriptToolCall[];
  usage?: TranscriptUsage;
};

export type ParsedTranscriptSession = {
  source: TranscriptSource;
  sessionId: string;
  cwd?: string;
  turns: TranscriptTurn[];
  /** Non-fatal parse issues: torn lines, unterminated turns, unmatched outputs. */
  warnings: string[];
};
