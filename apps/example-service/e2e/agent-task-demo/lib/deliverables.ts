/**
 * Deliverable schemas + parsers for the in-process adapters.
 *
 * Two concerns live here:
 *  1. Zod schemas describing the deliverable shapes (`task.deliverables`).
 *  2. Functions that turn accumulated `AgentState` into those deliverables.
 *
 * Both are agent behavior, not apo concerns. Extracted from `agent/types.ts`
 * and `real-agent-adapter.ts` so the adapter files show only the lifecycle.
 */
import { z } from "zod";
import type { AgentState, TrackedToolCall } from "../agent/types.ts";

// ── Shared schemas (used by the ai-sdk adapter) ───────────────────────────

/** Schemas shared across in-process adapters. Used by `ai-sdk-adapter.ts`. */
export const deliverableSchemas = {
  result: z.object({ summary: z.string(), findings: z.array(z.string()) }),
  tool_log: z.object({
    total_calls: z.number(),
    tools_used: z.array(z.string()),
    details: z.array(z.any()),
  }),
  stats: z.object({
    turn_count: z.number(),
    file_count: z.number(),
    total_tool_calls: z.number(),
    unique_tools: z.array(z.string()),
  }),
} as const;

/**
 * Build the deliverable payload from accumulated state (ai-sdk adapter).
 *
 * Findings fall back to a flat dump of every tool call if no
 * `extract_entities` result was captured — same behavior as before extraction.
 */
export function collectDeliverablesFromState(state: AgentState) {
  const summary =
    state.agentResponses[state.agentResponses.length - 1]?.slice(0, 500) ??
    "No response.";
  const findings = state.allToolCalls
    .filter((tc) => tc.tool === "extract_entities")
    .map((tc) => JSON.stringify(tc.result));
  if (findings.length === 0) {
    findings.push(
      ...state.allToolCalls.map((tc) => `${tc.tool}: ${JSON.stringify(tc.result)}`),
    );
  }

  return {
    result: { summary, findings },
    tool_log: {
      total_calls: state.allToolCalls.length,
      tools_used: [...new Set(state.allToolCalls.map((t) => t.tool))],
      details: state.allToolCalls,
    },
    stats: {
      turn_count: state.turnCount,
      file_count: Object.keys(state.fileContents).length,
      total_tool_calls: state.allToolCalls.length,
      unique_tools: [...new Set(state.allToolCalls.map((t) => t.tool))],
    },
  };
}

// ── real-agent schemas (richer, with .describe()) ─────────────────────────

const resultSchema = z.object({ summary: z.string(), findings: z.array(z.string()) });
const toolLogSchema = z.object({
  total_calls: z.number(),
  tools_used: z.array(z.string()),
  details: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()), result: z.unknown() })),
});
const statsSchema = z.object({
  turn_count: z.number(),
  file_count: z.number(),
  total_tool_calls: z.number(),
  unique_tools: z.array(z.string()),
});

/** Schemas for the real-agent adapter — typed details, not z.any(). */
export const realAgentDeliverableSchemas = {
  result: resultSchema.describe("Main structured result from the agent."),
  tool_log: toolLogSchema.describe("Log of all tool calls the agent made."),
  stats: statsSchema.describe("Execution stats."),
};

// ── real-agent findings parser ────────────────────────────────────────────

/**
 * Pull structured findings out of the agent's accumulated responses.
 *
 * Prefers the model's explicit `## Findings` section. Filters bullet lines
 * to those that name a symbol (backticked or snake_case) AND describe an
 * issue — drops prose descriptions and headers that sneak in. Falls back to
 * `extract_entities` tool-call results if no findings section was produced.
 */
export function parseFindings(state: AgentState): string[] {
  const allResponses = state.agentResponses.join("\n").trim();
  const findings: string[] = [];
  if (allResponses) {
    const sectionMatch = allResponses.match(/^##\s*Findings\s*$/im);
    const findingsText = sectionMatch
      ? allResponses.slice(sectionMatch.index! + sectionMatch[0].length)
          .split(/^##\s/m)[0] ?? ""
      : allResponses;
    const lines = findingsText.split("\n").map((l) => l.trim()).filter(Boolean);
    const bulletLines = lines.filter((l) => /^[-*•]/.test(l) || /^\d+[.)]/.test(l))
      .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim());
    const real = bulletLines.filter(looksLikeFinding);
    findings.push(...(real.length > 0 ? real : bulletLines));
  }
  if (findings.length === 0) {
    for (const tc of state.allToolCalls) {
      if (tc.tool === "extract_entities") {
        const entities = (tc.result as { entities?: Record<string, string[]> })?.entities;
        if (entities) for (const [etype, values] of Object.entries(entities))
          if (Array.isArray(values) && values.length > 0) findings.push(`${etype}: ${values.join(", ")}`);
      }
    }
  }
  return findings;
}

/** A real finding names a symbol AND describes an issue. */
function looksLikeFinding(text: string): boolean {
  if (/^(summary|assessment|covers|well-covered|test coverage|potential issues)/i.test(text)) {
    return false;
  }
  const namesSymbol = /`[a-zA-Z_][\w]*`/.test(text) || /\b[a-z][a-zA-Z_]*_[a-z][a-zA-Z_]*\b/.test(text);
  return namesSymbol;
}

/**
 * Build the full real-agent deliverable payload from state.
 *
 * Combines `parseFindings` with the counters + last-response summary.
 */
export function collectRealAgentDeliverables(state: AgentState, fileCount: number) {
  const lastResponse = state.agentResponses[state.agentResponses.length - 1] ?? "";
  const uniqueTools = [...new Set(state.allToolCalls.map((tc) => tc.tool))];
  return {
    result: {
      summary: lastResponse.slice(0, 500) || "Agent completed task",
      findings: parseFindings(state),
    },
    tool_log: {
      total_calls: state.allToolCalls.length,
      tools_used: uniqueTools,
      details: state.allToolCalls as TrackedToolCall[],
    },
    stats: {
      turn_count: state.turnCount,
      file_count: fileCount,
      total_tool_calls: state.allToolCalls.length,
      unique_tools: uniqueTools,
    },
  };
}
