/**
 * Benchmarks for the value matchers behind `t.check(...)`.
 *
 * `similarity` is the only super-linear matcher in the SDK (a full Levenshtein
 * matrix over the two strings), so it is the one that turns a long agent reply
 * into real CPU time. The structural matchers are here as the cheap baseline
 * a regression would show up against.
 */

import { bench, describe } from "vitest";

import {
  equals,
  includes,
  matchValue,
  similarity,
} from "../src/agent-task/checks/matchers.ts";

const REPLY =
  "The invoice for customer 4711 was refunded in full on 2026-08-14; " +
  "the remaining balance is now zero and no further action is required.";
const NEAR_REPLY =
  "The invoice for customer 4711 was refunded in full on 2026-08-15; " +
  "the remaining balance is zero and no further action is needed.";

const SIMILAR = similarity(NEAR_REPLY, 0.8);
const INCLUDES = includes("no further action");
const TOOL_OUTPUT = {
  rows: Array.from({ length: 40 }, (_, i) => ({
    id: i,
    total: i * 12.5,
    currency: "EUR",
    tags: ["invoice", "refund"],
  })),
  cursor: null,
};
const EXPECTED_OUTPUT = structuredClone(TOOL_OUTPUT);
const EQUALS = equals(EXPECTED_OUTPUT);

const REPLIES = Array.from({ length: 200 }, (_, i) => `${REPLY} (attempt ${i})`);

describe("matchers", () => {
  bench("similarity (Levenshtein) on a ~135-char reply", () => {
    SIMILAR.test(REPLY);
  });

  bench("includes over 200 replies", () => {
    for (const reply of REPLIES) {
      INCLUDES.test(reply);
    }
  });

  bench("equals deep-compare on a 40-row tool output", () => {
    EQUALS.test(TOOL_OUTPUT);
  });

  bench("matchValue partial-deep on a 40-row tool output", () => {
    matchValue(TOOL_OUTPUT, { cursor: null, rows: EXPECTED_OUTPUT.rows });
  });
});
