/**
 * Claude Code session-transcript parser.
 *
 * Claude Code appends one JSON object per line to
 * ``~/.claude/projects/<project>/<session-id>.jsonl`` for every session:
 *
 *   { type: "user" | "assistant", timestamp, requestId?, sessionId?, cwd?,
 *     toolUseResult?, message: { id?, role, model?, usage?, stop_reason?,
 *     content: string | Array<text | thinking | tool_use | tool_result> } }
 *
 * Two grouping rules do the real work:
 * - Streamed assistant chunks of one API response share ``message.id``; they
 *   are one logical message, and usage is read from the most complete chunk
 *   (the first chunk's snapshot undercounts the request).
 * - A user line whose content is a ``tool_result`` block array is the harness
 *   feeding a tool result back to the model, not a new turn.
 */

import {
  asNumber,
  asRecord,
  asString,
  laterTimestamp,
  parseTranscriptLines,
  sumUsage,
  type JsonObject,
} from "./parse-shared.ts";
import type {
  ParsedTranscriptSession,
  TranscriptToolCall,
  TranscriptTurn,
  TranscriptUsage,
} from "./types.ts";

/** Assistant lines sharing one API message id — one logical model message. */
type AssistantGroup = {
  messageId: string | null;
  parts: JsonObject[];
};

export function parseClaudeCodeTranscript(content: string): ParsedTranscriptSession {
  const warnings: string[] = [];
  const events = parseTranscriptLines(content, warnings);

  let sessionId = "";
  let cwd: string | undefined;
  for (const event of events) {
    if (!sessionId) sessionId = asString(event.sessionId) ?? "";
    if (cwd === undefined) cwd = asString(event.cwd);
    if (sessionId && cwd !== undefined) break;
  }

  const turns: TranscriptTurn[] = [];
  let currentUser: JsonObject | null = null;
  let assistantGroups: AssistantGroup[] = [];
  let currentGroup: AssistantGroup | null = null;
  let toolResultLines: JsonObject[] = [];

  const commitTurn = () => {
    if (currentUser !== null && assistantGroups.length > 0) {
      turns.push(
        buildTurn(turns.length, currentUser, assistantGroups, toolResultLines),
      );
    }
  };

  for (const event of events) {
    const role = lineRole(event);
    if (role === "user") {
      if (isToolResultLine(event)) {
        toolResultLines.push(event);
        continue;
      }
      // A real user message: the previous exchange (if any) is a closed turn.
      commitTurn();
      currentUser = event;
      assistantGroups = [];
      currentGroup = null;
      toolResultLines = [];
    } else if (role === "assistant") {
      const message = asRecord(event.message);
      const messageId = message ? (asString(message.id) ?? null) : null;
      if (currentGroup && (messageId === null || currentGroup.messageId === messageId)) {
        currentGroup.parts.push(event);
      } else {
        currentGroup = { messageId, parts: [event] };
        assistantGroups.push(currentGroup);
      }
    }
    // Other line types (summary, system, …) carry no turn content — skip.
  }
  // A trailing user line with no response never produced a turn; drop it.
  commitTurn();

  return { source: "claude-code", sessionId, cwd, turns, warnings };
}

function buildTurn(
  index: number,
  userLine: JsonObject,
  groups: AssistantGroup[],
  toolResultLines: JsonObject[],
): TranscriptTurn {
  const userMessage = textOfContent(contentOf(userLine));
  const timestamps: string[] = [];
  const userTimestamp = asString(userLine.timestamp);
  if (userTimestamp !== undefined) timestamps.push(userTimestamp);

  let model: string | undefined;
  const texts: string[] = [];
  const thinking: string[] = [];
  const toolUses: TranscriptToolCall[] = [];
  let usage: TranscriptUsage | undefined;

  for (const group of groups) {
    // Usage snapshots within one message id are cumulative snapshots of the
    // same request; keep the most complete one rather than summing chunks.
    let groupUsage: { usage: TranscriptUsage; completeness: number } | undefined;
    for (const part of group.parts) {
      const timestamp = asString(part.timestamp);
      if (timestamp !== undefined) timestamps.push(timestamp);
      const message = asRecord(part.message);
      if (message === undefined) continue;

      const partModel = asString(message.model);
      if (partModel !== undefined) model = partModel;

      for (const block of contentBlocks(message.content)) {
        const blockType = asString(block.type);
        if (blockType === "text") {
          const text = asString(block.text);
          if (text !== undefined) texts.push(text);
        } else if (blockType === "thinking") {
          const text = asString(block.thinking);
          if (text !== undefined) thinking.push(text);
        } else if (blockType === "tool_use") {
          toolUses.push({
            callId: asString(block.id) ?? "",
            name: asString(block.name) ?? "unknown",
            input: block.input,
            startedAt: timestamp,
          });
        }
      }

      const partUsage = usageOf(message.usage);
      if (partUsage !== undefined) {
        const completeness = usageCompleteness(partUsage);
        if (groupUsage === undefined || completeness > groupUsage.completeness) {
          groupUsage = { usage: partUsage, completeness };
        }
      }
    }
    if (groupUsage !== undefined) usage = sumUsage(usage, groupUsage.usage);
  }

  const results = collectToolResults(toolResultLines);
  for (const call of toolUses) {
    const match = call.callId !== "" ? results.get(call.callId) : undefined;
    if (match !== undefined) {
      call.result = renderToolResult(match.content);
      call.endedAt = match.timestamp;
    }
  }

  const startedAt = userTimestamp ?? timestamps[0] ?? "";
  const endedAt = timestamps.reduce<string | undefined>(
    (latest, ts) => laterTimestamp(latest, ts),
    undefined,
  );

  const turn: TranscriptTurn = {
    index,
    startedAt,
    toolCalls: toolUses,
  };
  if (endedAt !== undefined && endedAt !== startedAt) turn.endedAt = endedAt;
  if (model !== undefined) turn.model = model;
  if (userMessage !== undefined) turn.userMessage = userMessage;
  const assistantMessage = texts.join("\n");
  if (assistantMessage !== "") turn.assistantMessage = assistantMessage;
  const thinkingText = thinking.join("\n");
  if (thinkingText !== "") turn.thinkingText = thinkingText;
  if (usage !== undefined) turn.usage = usage;
  return turn;
}

/** Map of tool_use_id → result content + timestamp from tool-result user lines. */
function collectToolResults(
  toolResultLines: JsonObject[],
): Map<string, { content: unknown; timestamp?: string }> {
  const results = new Map<string, { content: unknown; timestamp?: string }>();
  for (const line of toolResultLines) {
    const timestamp = asString(line.timestamp);
    for (const block of contentBlocks(contentOf(line))) {
      if (asString(block.type) !== "tool_result") continue;
      const toolUseId = asString(block.tool_use_id);
      if (toolUseId === undefined) continue;
      results.set(toolUseId, { content: block.content, timestamp });
    }
  }
  return results;
}

function renderToolResult(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (asRecord(item) !== undefined) {
        const block = item as JsonObject;
        const type = asString(block.type);
        if (type === "text") {
          const text = asString(block.text);
          if (text !== undefined) parts.push(text);
        } else if (type === "image") {
          parts.push("[Image output]");
        }
      }
    }
    return parts.join("\n");
  }
  return content;
}

function usageOf(raw: unknown): TranscriptUsage | undefined {
  const usage = asRecord(raw);
  if (usage === undefined) return undefined;
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  const cacheReadTokens = asNumber(usage.cache_read_input_tokens);
  const cacheWriteTokens = asNumber(usage.cache_creation_input_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

function usageCompleteness(usage: TranscriptUsage): number {
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

function lineRole(event: JsonObject): string {
  const fromType = asString(event.type);
  if (fromType !== undefined) return fromType;
  return asString(asRecord(event.message)?.role) ?? "";
}

function contentOf(event: JsonObject): unknown {
  const message = asRecord(event.message);
  return message !== undefined ? message.content : event.content;
}

function contentBlocks(content: unknown): JsonObject[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is JsonObject => asRecord(block) !== undefined);
}

function isToolResultLine(event: JsonObject): boolean {
  return contentBlocks(contentOf(event)).some(
    (block) => asString(block.type) === "tool_result",
  );
}

function textOfContent(content: unknown): string | undefined {
  if (typeof content === "string") return content === "" ? undefined : content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of contentBlocks(content)) {
    if (asString(block.type) === "text") {
      const text = asString(block.text);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
