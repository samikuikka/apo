/**
 * Transcript source detection.
 *
 * Guesses which harness wrote a JSONL transcript from its first parseable
 * line, so `apo traces import <file>` needs no `--source` in the common case:
 *
 * - Codex rollouts are uniformly ``{ type: session_meta|turn_context|
 *   event_msg|response_item, timestamp, payload }``.
 * - Claude Code transcripts are ``{ type: "user"|"assistant", message, … }``
 *   with the session's identity fields (``sessionId``/``cwd``) on the lines.
 */

import { isRecord, type JsonObject } from "./parse-shared.ts";
import type { TranscriptSource } from "./types.ts";

export function detectTranscriptSource(content: string): TranscriptSource | undefined {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: JsonObject;
    try {
      const raw: unknown = JSON.parse(line);
      if (!isRecord(raw)) continue;
      parsed = raw;
    } catch {
      continue;
    }

    const type = typeof parsed.type === "string" ? parsed.type : undefined;
    if (type === "user" || type === "assistant") {
      if (isRecord(parsed.message) || typeof parsed.sessionId === "string") {
        return "claude-code";
      }
    }
    if (type !== undefined && type !== "user" && type !== "assistant" && isRecord(parsed.payload)) {
      return "codex";
    }
  }
  return undefined;
}
