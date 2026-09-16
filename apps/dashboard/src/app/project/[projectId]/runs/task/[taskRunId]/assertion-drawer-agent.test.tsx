import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AssertionDrawer } from "./assertion-drawer";
import type { AgentJudgeSession } from "@/lib/agent-task-api";

const agentSession: AgentJudgeSession = {
  tools: ["read_deliverable", "search_deliverable", "finish_verdict"],
  briefing: { system: "You are an agentic evaluation judge…", rubric: "PASS if grounded" },
  steps: [
    {
      index: 0,
      tool_calls: [
        { name: "read_deliverable", input: '{"name":"summary"}', result: "…", result_sha256: "a".repeat(64), result_bytes: 2100 },
        { name: "read_deliverable", input: '{"name":"log"}', result: "…", result_sha256: "b".repeat(64), result_bytes: 8100 },
      ],
      tokens: { input: 900, output: 40 },
    },
    {
      index: 1,
      tool_calls: [{ name: "finish_verdict", input: '{"reasoning":"grounded","pass":true}' }],
      tokens: { input: 1200, output: 60 },
    },
  ],
  outcome: "verdict",
  evidence: [
    { step: 0, tool: "read_deliverable", result_sha256: "a".repeat(64), result_bytes: 2100 },
    { step: 0, tool: "read_deliverable", result_sha256: "b".repeat(64), result_bytes: 8100 },
  ],
  usage: { steps: 2, input_tokens: 2100, output_tokens: 100 },
};

it("renders the investigation timeline for an agentic assertion", () => {
  render(
    <AssertionDrawer
      onClose={vi.fn()}
      assertion={{
        id: "agent-check",
        pass: true,
        reasoning: "grounded in the invoice",
        evaluator_type: "agent",
        judge: { model: "z-ai/glm-5.3-flash", temperature: 0, session: agentSession },
      }}
    />,
  );
  // Tool names appear per step, in order.
  expect(screen.getAllByText("read_deliverable").length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText(/finish_verdict/)).toBeInTheDocument();
  // Outcome badge + summary line with manifest count and usage.
  // Exact match: the outcome badge reads just "verdict" (finish_verdict
  // tool rows are longer strings, so exact getByText disambiguates).
  expect(screen.getByText("verdict")).toBeInTheDocument();
  expect(screen.getByText(/2 evidence reads/i)).toBeInTheDocument();
});

it("collapsed by default: the timeline is a non-open details element", () => {
  const { container } = render(
    <AssertionDrawer
      onClose={vi.fn()}
      assertion={{
        id: "agent-check",
        pass: false,
        reasoning: "budget exhausted",
        evaluator_type: "agent",
        judge: { model: "z-ai/glm-5.3-flash", session: agentSession },
      }}
    />,
  );
  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  expect(details!.hasAttribute("open")).toBe(false);
});
