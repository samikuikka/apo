/**
 * Dashboard-local copy of the SDK's ``TEST_METHOD_NAMES``.
 *
 * Kept in its own module (rather than inlined in ``t-api-highlight.ts``) so the
 * drift-guard test can import it independently of the regex helper.
 *
 * This MUST stay in sync with
 * ``packages/sdk/src/agent-task/checks/t.ts`` (the single source of truth).
 * ``__tests__/t-api-highlight.test.ts`` asserts equality with that export, so
 * any divergence fails CI instead of silently dropping a method's styling.
 */
export const TEST_METHOD_NAMES = [
  "calledTool",
  "notCalledTool",
  "toolOrder",
  "usedNoTools",
  "maxToolCalls",
  "noFailedActions",
  "loadedSkill",
  "calledSubagent",
  "messageIncludes",
  "maxTurns",
  "maxDurationMs",
  "assert",
  "check",
  "judge",
] as const;
