import type { EvaluationItemResult } from "../run/types.ts";

export type DeliverableValidationResult = {
  results: EvaluationItemResult[];
  brokenDeliverables: Record<string, string>;
};
