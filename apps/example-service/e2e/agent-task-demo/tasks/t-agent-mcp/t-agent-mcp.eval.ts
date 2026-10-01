/**
 * t-agent-mcp — MCP tools on BOTH planes of an apo run.
 *
 * The task declares a stdio MCP server (`mcp/geo-server.mjs`, zero deps,
 * hand-rolled JSON-RPC) for the AGENT UNDER TEST via `mcpServers`, and the
 * same declaration feeds the JUDGE via `judgeTools` — the agentic `t.agent`
 * check verifies the report by querying the service itself instead of
 * trusting the deliverable text. "./"-relative stdio paths resolve against
 * the task directory on BOTH planes (adapter contract; runTask applies the
 * same resolution to layered judgeTools).
 *
 * The trajectory check is what proves tool use: the elevation table also
 * exists in the server's source next to the task (the agent COULD read it),
 * so a run that skips mcp__geo__get_elevation fails Layer 1 regardless of
 * how correct its report reads.
 *
 * Runs entirely on cheap OpenRouter models — agent and judge both come from
 * OPENROUTER_MODEL (deepseek/deepseek-v4.1-flash by default). Never point
 * this demo at Anthropic models; the claude-adapter MCP path exists as a
 * second reference but is not the demo default.
 *
 *   apo task run --dir apps/example-service/e2e agent-task-demo/tasks/t-agent-mcp
 */
import { task, includes, satisfies } from "@apo-ai/sdk/agent-task";
import { aiSdkAdapter } from "../../ai-sdk-adapter.ts";

/** Task-declared MCP server — one declaration, consumed by the adapter. */
const GEO_MCP = {
  name: "geo",
  transport: {
    type: "stdio" as const,
    command: "node",
    // Relative path-like args resolve against the task directory (adapter
    // contract) — the eval never needs to know its own absolute location.
    args: ["./mcp/geo-server.mjs"],
  },
};

const { test: check } = task("t-agent-mcp", {
  adapter: aiSdkAdapter,
  description:
    "MCP demo: the agent must fetch authoritative elevations from a task-declared MCP server, and the judge verifies through its own copy of the server.",
  metadata: { category: "demo", probe: "mcp" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
  mcpServers: [GEO_MCP],
  // Judge-plane config (Track A): the agentic judge below gets the same
  // server and must call it before verdicting.
  judgeTools: { mcp: [GEO_MCP] },
});

// ── Layer 1: trajectory — the custom tool was actually used ───────────────
check("used-geo-mcp-tool", (t) => {
  t.calledTool("mcp__geo__get_elevation");
  t.maxToolCalls(12);
  t.noFailedActions();
});

// ── Layer 2: the report carries the server-owned numbers ──────────────────
// Digit-boundary lookarounds with a unit requirement: matches "26", "26m",
// "26 m", "26 meters"; rejects "126" or a latitude like "60.17" for the 17
// check. Attribution (which city owns which number) is Layer 3's job — the
// agentic judge compares per-city against its own MCP queries.
check("report-carries-server-figures", (t, { deliverables }) => {
  const text = String(deliverables.result.summary);

  t.check(text, includes("Helsinki"), "names Helsinki");
  t.check(text, includes("Tallinn"), "names Tallinn");
  t.check(text, satisfies(() => /(?<!\d)26\s*m/i.test(text), "carries Helsinki's 26 m"));
  t.check(text, satisfies(() => /(?<!\d)9\s*m/i.test(text), "carries Tallinn's 9 m"));
  t.check(
    text,
    satisfies(() => /(?<!\d)17\s*m/i.test(text), "states the 17 m difference"),
  );
});

// ── Layer 3: the agentic judge verifies THROUGH its own MCP server ────────
check("judge-verifies-via-geo", async (t) => {
  await t.agent(
    "PASS only if the geo service confirms BOTH elevation values cited in the " +
      "report deliverable: call mcp__geo__get_elevation for Helsinki and for " +
      "Tallinn yourself, then compare the returned elevations to the figures in " +
      "the report. FAIL if either figure disagrees with the service, if the " +
      "difference is wrong, or if the report cites no figures.",
    { label: "agentic-geo-verify" },
  );
});
