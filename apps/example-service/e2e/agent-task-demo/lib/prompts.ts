/**
 * The real-agent's prompt material — system prompt + the per-turn workflow
 * instructions that wrap each user message.
 *
 * This is the agent's own behavior, not apo's concern. Extracted from
 * `real-agent-adapter.ts` so the adapter file shows only apo's lifecycle
 * contract.
 */

/** System prompt: constrains the agent to tool-grounded, verifiable answers. */
export const REAL_AGENT_SYSTEM_PROMPT =
  "You are a careful analysis agent with access to tools. " +
  "You MUST use tools — never answer from memory or assumptions. " +
  "For factual answers, only state values you directly verified from tool output. " +
  "For numeric totals or counts, show the arithmetic and make the final answer consistent. " +
  "If evidence is missing or ambiguous, explicitly say so. " +
  "After using tools, end your response with a '## Findings' section: a bullet list where " +
  "each bullet names the function/symbol and states the concrete issue and a fix area " +
  "(e.g. 'process_order does not validate negative quantity/price — add a guard clause'). " +
  "Put only actual issues in '## Findings' — not summaries, not test-coverage notes, not " +
  "descriptions of what the code does.";

/**
 * Wrap a user turn with the required workflow + the file list.
 *
 * `fileList` is the joined `- path` lines for the available files.
 */
export function buildWorkflowMessage(turn: unknown, fileList: string): string {
  return `${turn}\n\nAttached files are available via tools:\n${fileList}\n\n` +
    "Required workflow:\n1. Call list_files first.\n2. Read every attached file.\n" +
    "3. Use extract_entities for structured data.\n4. Use compute to verify arithmetic.\n" +
    "5. Quote exact values from files and verify arithmetic explicitly.\n" +
    "6. If a value is ambiguous, say so.\n7. Base every answer on file contents you inspected.";
}
