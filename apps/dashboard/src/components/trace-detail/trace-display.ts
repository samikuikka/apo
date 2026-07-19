import type { LoggedCall } from "./contexts";
import { getEventType } from "./trace-utils";

/**
 * Shared display-name helpers for trace observations.
 *
 * Span names differ per agent SDK, but the UI should show a consistent,
 * readable label everywhere (tree, gantt, graph, detail panel). This module
 * is the single source of truth for that mapping.
 *
 * Conventions handled:
 *  - Vercel AI SDK:   ``ai.generateText.doGenerate`` → ``generateText`` / GENERATION
 *  - OpenAI/GenAI:    ``chat <model>`` / ``gen_ai.*`` → ``generate`` (GENERATION branch)
 *  - Claude Code SDK: ``claude_code.llm_request`` → ``generate`` (GENERATION);
 *                     ``claude_code.tool`` → tool name (TOOL branch);
 *                     ``claude_code.interaction`` → ``agent turn``; others mapped below.
 *  - Adapter/task lifecycle names (``adapter.*``, ``task.*``) are already
 *    readable and pass through unchanged.
 *
 * When a new agent SDK arrives, extend ``cleanSpanName`` (prefix strip) and/or
 * ``SUFFIX_LABELS`` (curated suffix) here — every view picks it up at once.
 */

/** Claude Code suffix → readable label. Keys are suffixes after ``claude_code.``. */
const SUFFIX_LABELS: Record<string, string> = {
  interaction: "agent turn",
  "tool.blocked_on_user": "permission prompt",
  "subagent.spawn": "subagent",
};

/** True when ``step_name`` is a raw SDK span name the UI should summarize
 *  rather than show verbatim. */
function isRawSdkName(step: string): boolean {
  return (
    step.startsWith("ai.") ||
    step.startsWith("gen_ai.") ||
    step.startsWith("claude_code.")
  );
}

/** Map a known ``claude_code.<suffix>`` to a readable label, or null if the
 *  suffix should be left for the caller's type-driven branch (e.g. ``llm_request``
 *  is rendered as ``generate`` by the GENERATION branch, ``tool`` uses tool_name). */
function labelClaudeSuffix(suffix: string): string | null {
  if (suffix in SUFFIX_LABELS) return SUFFIX_LABELS[suffix];
  // Tool/LLM suffixes are named by their observation type — no static label.
  if (suffix === "llm_request" || suffix === "tool" || suffix === "tool.execution") {
    return null;
  }
  return null;
}

export function getDisplayName(call: LoggedCall): string {
  // A structured output summary wins when present (keeps curated labels).
  const outputSummary =
    call.output &&
    typeof call.output === "object" &&
    "summary" in call.output &&
    typeof call.output.summary === "string"
      ? call.output.summary
      : null;
  const eventType = getEventType(call);
  if (
    (eventType === "tool_use" ||
      eventType === "assistant_reasoning" ||
      eventType === "assistant_message" ||
      eventType === "result") &&
    outputSummary
  ) {
    return outputSummary;
  }

  const type = (call.observation_type ?? call.call_type ?? "").toUpperCase();

  if (type === "TOOL") {
    const name = call.tool_name?.trim();
    if (name) return name;
    // No tool_name — clean the raw span name rather than leaking the SDK prefix.
    const cleaned = cleanSpanName(call.step_name);
    if (cleaned) return cleaned;
  }

  if (type === "GENERATION") {
    // Prefer a curated step_name if the adapter set one; otherwise summarize
    // the raw SDK span name. Never show "ai.generateText.doGenerate" or
    // "claude_code.llm_request" verbatim.
    const step = call.step_name?.trim();
    if (step && !isRawSdkName(step)) {
      return step;
    }
    return "generate";
  }

  // AGENT / SPAN / other: prefer a curated Claude suffix label, else clean the
  // raw span name, else fall back to a positional label.
  const step = call.step_name?.trim();
  if (step && step.startsWith("claude_code.")) {
    const suffix = step.slice("claude_code.".length);
    const label = labelClaudeSuffix(suffix);
    if (label) return label;
  }

  const cleaned = cleanSpanName(call.step_name);
  if (cleaned) return cleaned;

  return `Step ${call.step_index || "?"}`;
}

/** Turn a raw OTel/AI-SDK span name into something readable.
 *  "ai.generateText"            -> "generateText"
 *  "ai.generateText.doGenerate" -> "generateText"
 *  "ai.toolCall"                -> "toolCall"
 *  "claude_code.llm_request"    -> "llm_request"
 *  "claude_code.subagent.spawn" -> "subagent.spawn"
 *  Adapter/task lifecycle names ("adapter.initialize", "task.load") and any
 *  other prefix are returned unchanged — they're already readable. */
export function cleanSpanName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Strip the noisy SDK prefixes and the .do{Generate,Stream} suffix.
  const stripped = trimmed
    .replace(/^(ai|gen_ai|claude_code)\./, "")
    .replace(/\.do(Generate|Stream)$/, "");
  return stripped || null;
}
