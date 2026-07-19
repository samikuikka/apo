import type { EvaluationItemResult, TaskEvaluationResult } from "./types.ts";

export function aggregateResult(
  checksResults: EvaluationItemResult[],
): TaskEvaluationResult {
  if (checksResults.length === 0) {
    return { checks: checksResults, pass: false };
  }
  const pass = checksResults.every((r) => r.pass);
  return { checks: checksResults, pass };
}
