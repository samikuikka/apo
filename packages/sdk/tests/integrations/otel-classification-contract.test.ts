import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { translateOtelSpan } from "../../src/agent-task/integrations/otel-translate.ts";

interface ContractCase {
  name: string;
  spanName: string;
  attributes: Record<string, unknown>;
  expected: {
    observationType: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    text?: string;
    toolName?: string;
    toolParameters?: Record<string, unknown>;
    toolResult?: unknown;
  };
}

const cases = JSON.parse(readFileSync(
  new URL("../../../../test-fixtures/otel-classification.json", import.meta.url),
  "utf8",
)) as ContractCase[];

describe("shared OTel classification contract", () => {
  for (const contract of cases) {
    it(contract.name, () => {
      const translated = translateOtelSpan(contract.spanName, {
        attributes: contract.attributes,
        status: { code: 0 },
      });

      expect(translated).not.toBeNull();
      expect(translated?.observationType).toBe(contract.expected.observationType);
      if (contract.expected.model !== undefined) {
        expect(translated?.model).toBe(contract.expected.model);
      }
      if (contract.expected.promptTokens !== undefined) {
        expect(translated?.promptTokens).toBe(contract.expected.promptTokens);
      }
      if (contract.expected.completionTokens !== undefined) {
        expect(translated?.completionTokens).toBe(contract.expected.completionTokens);
      }
      if (contract.expected.text !== undefined) {
        expect(translated?.text).toBe(contract.expected.text);
      }
      if (contract.expected.toolName !== undefined) {
        expect(translated?.stepName).toBe(contract.expected.toolName);
        expect(translated?.input).toEqual(contract.expected.toolParameters);
        expect(translated?.output).toEqual(contract.expected.toolResult);
      }
    });
  }
});
