import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * t.agent demo — a REAL agent on a cheap model (deepseek by default): the
 * model decides which billing queries to run, then writes the summary from
 * what it actually retrieved. work_log records the real tool calls; the
 * judges (t.judge + t.agent) verify the summary against the agent's own
 * work. Model via T_AGENT_DEMO_MODEL / OPENROUTER_API_KEY.
 */

const BILLING: Record<string, Record<string, number>> = {
  "2026-Q2": { revenue: 3885017, churn: 0.024, enterprise_share: 0.61 },
  "2026-Q3": { revenue: 4003112, churn: 0.029, enterprise_share: 0.61 },
};

const MODEL = process.env.T_AGENT_DEMO_MODEL ?? "deepseek/deepseek-v4.1-flash";
const API_KEY = process.env.OPENROUTER_API_KEY ?? "";

type WorkCall = { tool: string; input: Record<string, unknown>; result: unknown };

// Session-scoped: written by sendUserTurn, read by collectDeliverables.
let runSummary = "";
let runWork: WorkCall[] = [];

type TraceCtx = {
  traceTool<T>(name: string, params: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  step(options: Record<string, unknown>, fn: () => Promise<unknown>): Promise<unknown>;
};

const realAgentAdapter = defineAdapter({
  name: "billing-analyst",
  deliverables: { summary: null, work_log: null },
  turn: (ctx) =>
    ctx.transcript.length === 0
      ? "Write the Q3 revenue summary. Query the billing data first; use only figures you actually retrieved."
      : null,
  startSession: async () => ({
    sendUserTurn: async (turn: unknown, { trace }: { trace: TraceCtx }) => {
      const messages: Array<Record<string, unknown>> = [
        { role: "system", content: "You are a revenue analyst. Use the query_billing tool to get figures before writing anything. Report exactly what the data says." },
        { role: "user", content: String(turn) },
      ];
      const tools = [{
        type: "function",
        function: {
          name: "query_billing",
          description: "Get revenue, churn, and enterprise share for a quarter",
          parameters: {
            type: "object",
            properties: { quarter: { type: "string", description: "e.g. 2026-Q3" } },
            required: ["quarter"],
          },
        },
      }];

      for (let round = 0; round < 6; round++) {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL, temperature: 0, messages, tools }),
        }).then((r) => r.json());
        const msg = res.choices?.[0]?.message as Record<string, unknown> | undefined;
        const calls = (msg?.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
        if (!calls.length) {
          runSummary = String(msg?.content ?? "");
          await trace.step({ step_name: "agent.generate", observation_type: "GENERATION" }, async () => ({ text: runSummary }));
          break;
        }
        messages.push(msg as Record<string, unknown>);
        for (const call of calls) {
          const fn = call.function as unknown as { name: string; arguments: string };
          const args = JSON.parse(fn.arguments || "{}") as Record<string, string>;
          const result = await trace.traceTool("query_billing", args, async () =>
            BILLING[args.quarter] ?? { error: "unknown quarter" });
          runWork.push({ tool: "query_billing", input: args, result });
          messages.push({ role: "tool", tool_call_id: (call as { id: string }).id, content: JSON.stringify(result) });
        }
      }
      return { response: runSummary || "done" };
    },
  }),
  collectDeliverables: async () => ({
    summary: runSummary,
    work_log: JSON.stringify(runWork, null, 2),
  }),
});

const { test } = task("t-agent-demo", {
  adapter: realAgentAdapter,
  description: "Real cheap-model agent queries billing, writes the summary; judges verify it against its own work.",
  metadata: { category: "demo", agent: "real-cheap-model" },
  deliverables: ["summary", "work_log"],
});

test("summary-reads-well", async (t, { deliverables }) => {
  await t.judge(
    deliverables.summary,
    "PASS if the summary reads like a coherent, well-formed revenue report with concrete figures. FAIL only if incoherent, vague, or missing numbers.",
  );
});

test("figures-supported-by-work", async (t) => {
  await t.agent(
    "PASS only if every figure in the summary deliverable is supported by this run's work_log deliverable (the agent's own tool calls and their results). FAIL if any figure disagrees with the queried data or appears nowhere in it. Investigate the deliverables before deciding.",
    { label: "agentic-consistency" },
  );
});
