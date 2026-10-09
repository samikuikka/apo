import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * Calculator-batching acceptance demo — the test defines wanted behaviour
 * the agent does not have yet. The stub replays the current behaviour from
 * a real finding: given an order sheet that needs twenty separate
 * calculations to reach the final figure, the agent walked them one
 * calculator call at a time — every call a fresh cache read, twenty round
 * trips for one number.
 *
 *   apo task run ./tasks/t-calculator-batching
 *   (from apps/example-service/e2e/agent-task-demo — see START-HERE.md)
 *
 * No model is called: the stub records the calculator calls straight into
 * the run's trace, and the check grades the trace. It is meant to fail —
 * a failing acceptance test is the work order, not a regression.
 */

const CALCULATIONS: ReadonlyArray<readonly [expression: string, value: number]> = [
  ["4*25", 100],
  ["8*12.5", 100],
  ["15*40", 600],
  ["3*199", 597],
  ["22*7.5", 165],
  ["9*32", 288],
  ["6*84", 504],
  ["11*11", 121],
  ["14*17.25", 241.5],
  ["5*129", 645],
  ["100+100+600", 800],
  ["597+165+288+504", 1554],
  ["121+241.5+645", 1007.5],
  ["800+1554+1007.5", 3361.5],
  ["3361.5*0.9", 3025.35],
  ["3025.35*0.21", 635.3235],
  ["3025.35+635.3235", 3660.6735],
  ["3660.6735*0.02", 73.21347],
  ["3660.6735-73.21347", 3587.46003],
  ["3587.46003/12", 298.9550025],
];

const REPORT = `# Q4 Order-Sheet Totals

Ten line items in three categories, 10% bundle discount, 21% VAT, 2%
early-payment discount, split into 12 monthly payments of 298.96.`;

const stubAdapter = defineAdapter({
  name: "calc-stub",
  deliverables: { report: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "work out the order-sheet totals" : null),
  startSession: async () => ({
    sendUserTurn: async (_turn, ctx) => {
      // Current behaviour, recorded verbatim: one calculator call per
      // expression — twenty cache reads and twenty round trips.
      for (const [expression, value] of CALCULATIONS) {
        await ctx.trace.traceTool("calculator", { expression }, async () => ({ value }));
      }
      return { response: "done" };
    },
  }),
  collectDeliverables: async () => ({ report: REPORT }),
});

const { test } = task("t-calculator-batching", {
  adapter: stubAdapter,
  description:
    "Acceptance test for wanted behaviour the agent does not have yet: batch the order sheet's twenty calculations into a few calculator calls.",
  metadata: { category: "demo", probe: "calculator" },
  deliverables: ["report"],
});

// Wanted behaviour: twenty calculations, at most five calculator calls —
// batched expressions, not one round trip per line.
test("calculator-calls-batched", (t) => {
  t.assert(
    "at most 5 calculator calls",
    (flow) => flow.toolCalls.filter((call) => call.name === "calculator").length <= 5,
  );
});
