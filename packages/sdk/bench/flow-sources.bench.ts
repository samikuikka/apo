/**
 * Benchmarks for the cross-framework Flow normalizers.
 *
 * These run once per agent run for every non-adapter integration (OpenAI,
 * Anthropic, Vercel AI SDK), walking the full provider message log twice —
 * once to index tool results, once to emit events.
 */

import { bench, describe } from "vitest";

import {
  fromAISDK,
  fromAnthropicMessages,
  fromOpenAIMessages,
} from "../src/agent-task/flow/sources.ts";
import { buildAnthropicMessages, buildOpenAIMessages } from "./fixtures.ts";

const TURNS = 80;
const OPENAI_MESSAGES = buildOpenAIMessages(TURNS);
const ANTHROPIC_MESSAGES = buildAnthropicMessages(TURNS);
const AI_SDK_RESULT = {
  steps: Array.from({ length: TURNS }, (_, i) => ({
    text: `assistant reply number ${i}`,
    toolCalls: [
      { toolName: `search_invoices_${i % 5}`, input: { customerId: i, limit: 25 } },
    ],
    toolResults: [
      { toolName: `search_invoices_${i % 5}`, output: { rows: [{ id: i }] } },
    ],
  })),
};

describe("flow-sources", () => {
  bench(`fromOpenAIMessages over ${TURNS} turns`, () => {
    fromOpenAIMessages(OPENAI_MESSAGES);
  });

  bench(`fromAnthropicMessages over ${TURNS} turns`, () => {
    fromAnthropicMessages(ANTHROPIC_MESSAGES);
  });

  bench(`fromAISDK over ${TURNS} steps`, () => {
    fromAISDK(AI_SDK_RESULT);
  });
});
