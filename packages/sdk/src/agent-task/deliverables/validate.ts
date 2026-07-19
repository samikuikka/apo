import type {
  CollectedDeliverables,
  DeliverableDefinition,
  ValidatableSchemaLike,
} from "../adapter/types.ts";
import type { TaskDefinition } from "../task/types.ts";
import type { DeliverableValidationResult } from "./types.ts";

function isZodSchema(value: unknown): value is ValidatableSchemaLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as Record<string, unknown>).safeParse === "function"
  );
}

export function validateDeliverables(
  task: TaskDefinition,
  collected: CollectedDeliverables,
  deliverableDefs?: Record<string, DeliverableDefinition>,
): DeliverableValidationResult {
  const results: DeliverableValidationResult["results"] = [];
  const brokenDeliverables: Record<string, string> = {};

  for (const deliverableName of task.deliverables) {
    const value = collected[deliverableName];

    if (value === undefined || value === null) {
      const reason = `Deliverable '${deliverableName}' is missing`;
      results.push({
        id: `deliverable:${deliverableName}`,
        pass: false,
        reasoning: reason,
      });
      brokenDeliverables[deliverableName] = reason;
      continue;
    }

    const schema = resolveDeliverableSchema(
      deliverableDefs?.[deliverableName],
    );
    if (schema && isZodSchema(schema)) {
      const result = schema.safeParse(value);
      if (!result.success) {
        const reason = `Deliverable '${deliverableName}' failed schema validation: ${result.error?.message ?? "Unknown error"}`;
        results.push({
          id: `deliverable:${deliverableName}`,
          pass: false,
          reasoning: reason,
        });
        brokenDeliverables[deliverableName] = reason;
      }
    }
  }

  return { results, brokenDeliverables };
}

function resolveDeliverableSchema(
  definition: DeliverableDefinition | undefined,
): ValidatableSchemaLike | undefined {
  if (!definition) {
    return undefined;
  }

  if (isZodSchema(definition)) {
    return definition;
  }

  if (
    typeof definition === "object" &&
    definition !== null &&
    "schema" in definition &&
    isZodSchema(definition.schema)
  ) {
    return definition.schema;
  }

  return undefined;
}
