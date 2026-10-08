import { describe, it, expect } from "vitest";

import {
  conversationProbeOrder,
  deriveConversationFromTrace,
} from "../conversation-from-trace";
import type { LoggedCall, TraceDetail } from "@/components/trace-detail/contexts";

function makeCall(overrides: Partial<LoggedCall> = {}): LoggedCall {
  return {
    id: "call-1",
    step_index: null,
    step_name: "generation",
    model: "claude-sonnet-4-6",
    created_at: "2026-07-27T10:00:00Z",
    task_id: "t",
    observation_type: "GENERATION",
    input: {},
    output: {},
    ...overrides,
  };
}

function makeTrace(calls: LoggedCall[]): TraceDetail {
  return {
    run: {
      id: "trace-1",
      project: "p",
      scopeKey: null,
      environment: "default",
      created_at: "2026-07-27T10:00:00Z",
      call_count: calls.length,
    },
    metrics: [],
    calls,
  };
}

describe("conversationProbeOrder", () => {
  it("probes agent-named generations only, newest first, ignoring trailing judges (issue #412)", () => {
    const order = conversationProbeOrder([
      makeCall({ id: "gen-1", step_name: "agent.generate", step_index: 0 }),
      makeCall({ id: "gen-judge-a", step_name: "judge:first", step_index: 1 }),
      makeCall({ id: "gen-2", step_name: "ai.generateText", step_index: 2 }),
      makeCall({ id: "gen-judge-b", step_name: "judge:second", step_index: 3 }),
    ]);
    expect(order.map((c) => c.id)).toEqual(["gen-2", "gen-1"]);
  });

  it("reaches an agent generation however many judged checks trail it", () => {
    const calls = [
      makeCall({ id: "gen-agent", step_name: "agent.generate", step_index: 0 }),
      ...Array.from({ length: 10 }, (_, i) =>
        makeCall({ id: `judge-${i}`, step_name: `judge:criterion-${i}`, step_index: i + 1 }),
      ),
    ];
    expect(conversationProbeOrder(calls).map((c) => c.id)).toEqual(["gen-agent"]);
  });

  it("falls back to the trailing window with harness names skipped for foreign traces", () => {
    const order = conversationProbeOrder([
      makeCall({ id: "gen-1", step_name: "gen_ai.chat", step_index: 0 }),
      makeCall({ id: "gen-2", step_name: "chatCompletion", step_index: 1 }),
      makeCall({ id: "judge-1", step_name: "judge:quality", step_index: 2 }),
    ]);
    expect(order.map((c) => c.id)).toEqual(["gen-2", "gen-1"]);
  });
});

describe("deriveConversationFromTrace", () => {
  describe("native SDK traces (messages arrays)", () => {
    it("reads the last generation's input+output messages", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          input: {
            messages: [
              { role: "system", content: "You are helpful." },
              { role: "user", content: "What is 2+2?" },
            ],
          },
          output: {
            messages: [{ role: "assistant", content: "It's 4." }],
          },
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      expect(result.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
        "system:You are helpful.",
        "user:What is 2+2?",
        "assistant:It's 4.",
      ]);
    });

    it("skips trailing harness generations that carry no messages array", () => {
      // A task harness traces its own scaffolding into the same trace: a
      // simulated-user turn and a "is the conversation finished?" check, both
      // after the agent's last chat completion. Reading only the final
      // generation found no messages there and fell back to reconstructing a
      // far poorer transcript from raw call I/O.
      const trace = makeTrace([
        makeCall({
          id: "gen-agent",
          step_name: "gen_ai.chat",
          created_at: "2026-07-27T10:00:00Z",
          input: {
            messages: [
              { role: "user", content: "Add a rule to the Payment Schedule." },
              { role: "tool", content: '{"results":[{"status":"applied"}]}' },
            ],
          },
          output: { messages: [{ role: "assistant", content: "Added the rule." }] },
        }),
        makeCall({
          id: "gen-sim-user",
          step_name: "sim-user",
          model: "google/gemini-3.1-flash",
          created_at: "2026-07-27T10:00:10Z",
          input: { systemPrompt: "You are simulating a user…", model: "x" },
          output: { response: "Confirmed." },
        }),
        makeCall({
          id: "gen-finished-check",
          step_name: "finished-check",
          model: "google/gemini-3.6-flash",
          created_at: "2026-07-27T10:00:20Z",
          input: { systemPrompt: "You're evaluating a conversation…", model: "x" },
          output: { isFinished: false },
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      expect(result.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
        "user:Add a rule to the Payment Schedule.",
        'tool:{"results":[{"status":"applied"}]}',
        "assistant:Added the rule.",
      ]);
      // The harness's own prompts are not conversation turns.
      expect(
        result.messages.some((m) => m.content.includes("simulating a user")),
      ).toBe(false);
    });

    it("prefers the agent's generation over trailing judges that carry messages (issue #412)", () => {
      // Judges run after the agent's last turn and are traced as GENERATION
      // spans; the OTel client wraps their {model, instruction} input into a
      // fake system message and their verdict into a fake assistant message.
      // A judge call therefore carries a 2-message "conversation", and the
      // newest-generation-wins rule showed it instead of the agent's real one.
      const agentConversation = [
        { role: "system", content: "You are a project kickoff agent." },
        { role: "user", content: "Create the shared progress tracker." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { type: "function", function: { name: "createDoc", arguments: "{}" } },
          ],
        },
        { role: "tool", content: '{"id":"doc-1"}', name: "createDoc" },
        { role: "assistant", content: "Tracker created." },
      ];
      const trace = makeTrace([
        makeCall({
          id: "gen-agent",
          step_name: "agent.generate",
          created_at: "2026-07-27T10:00:00Z",
          input: { messages: agentConversation },
          output: { messages: [{ role: "assistant", content: "All set." }] },
        }),
        makeCall({
          id: "gen-judge-1",
          step_name: "judge:tracker-created",
          model: "deepseek/deepseek-v4.1-flash",
          created_at: "2026-07-27T10:00:30Z",
          input: {
            messages: [
              {
                role: "system",
                content:
                  '{"model":"deepseek/deepseek-v4.1-flash","instruction":"The tracker exists and lists the kickoff decisions."}',
              },
            ],
          },
          output: {
            messages: [
              { role: "assistant", content: '{"reasoning":"It does.","pass":true}' },
            ],
          },
        }),
        makeCall({
          id: "gen-judge-2",
          step_name: "judge:tracker-shared",
          model: "deepseek/deepseek-v4.1-flash",
          created_at: "2026-07-27T10:00:45Z",
          input: {
            messages: [
              {
                role: "system",
                content:
                  '{"model":"deepseek/deepseek-v4.1-flash","instruction":"The tracker is shared with the team."}',
              },
            ],
          },
          output: {
            messages: [
              { role: "assistant", content: '{"reasoning":"Shared.","pass":true}' },
            ],
          },
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      expect(result.messages.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
        "assistant",
        "assistant",
      ]);
      // The agent's conversation is what shows; the judges' prompts and
      // verdicts are not conversation turns.
      expect(result.messages.some((m) => m.content.includes("progress tracker"))).toBe(true);
      expect(result.messages.some((m) => m.content.includes('"instruction"'))).toBe(false);
      expect(result.messages.some((m) => m.content.includes('"pass"'))).toBe(false);
    });

    it("keeps adjacent tool results with different call identities", () => {
      const trace = makeTrace([
        makeCall({
          input: {
            messages: [
              {
                role: "tool",
                content: '{"ok":true}',
                name: "firstTool",
                tool_call_id: "call-1",
              },
              {
                role: "tool",
                content: '{"ok":true}',
                name: "secondTool",
                tool_call_id: "call-2",
              },
            ],
          },
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      expect(result.messages.map((message) => message.name)).toEqual([
        "firstTool",
        "secondTool",
      ]);
    });
  });

  describe("imported traces with provider content blocks (issue #47)", () => {
    it("reconstructs conversation from content-block outputs when messages are absent", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          step_index: 0,
          input: "What plans do you offer?",
          output: [{ type: "text", text: "We offer Starter and Business plans." }],
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      expect(result.messages.length).toBeGreaterThan(0);
      const assistant = result.messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toContain("Starter and Business");
    });

    it("walks multiple generations in order, extracting user input + assistant output", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          step_index: 0,
          input: "What is the Starter price?",
          output: [{ type: "text", text: "Starter is €108/month." }],
        }),
        makeCall({
          id: "gen-2",
          step_index: 1,
          input: { tool_results: [{ tool_use_id: "t1", preview: "Pricing data loaded" }] },
          output: [{ type: "text", text: "Business is €600/month." }],
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      const contents = result.messages.map((m) => m.content);

      // Both assistant responses should appear
      expect(contents).toContain("Starter is €108/month.");
      expect(contents).toContain("Business is €600/month.");
      // The tool result should surface as context
      expect(result.messages.some((m) => m.content.includes("Pricing data loaded"))).toBe(true);
    });

    it("joins multiple text blocks in a single output into one message", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          step_index: 0,
          input: "Tell me about your plans",
          output: [
            { type: "reasoning", text: "The user wants pricing info." },
            { type: "text", text: "We have three plans available." },
          ],
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      const assistant = result.messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toContain("three plans");
    });
  });

  describe("tool spans in the reconstruction fallback", () => {
    const toolCall = (overrides: Partial<LoggedCall>) =>
      makeCall({
        model: "",
        observation_type: "TOOL",
        step_name: "gen_ai.execute_tool docxGetTemplatePrimitives",
        tool_name: "docxGetTemplatePrimitives",
        ...overrides,
      });

    // A generation whose payload carries no messages array, so the primary
    // path finds nothing and the raw-call reconstruction runs.
    const rawGeneration = () =>
      makeCall({
        id: "gen-1",
        step_index: 1,
        input: "Add a rule.",
        output: [{ type: "text", text: "Added the rule." }],
      });

    it("reads arguments from the span input when tool_parameters is unset", () => {
      // tool_parameters is only populated from gen_ai.tool.call.arguments /
      // ai.toolCall.args. Emitters that record the arguments as the span's
      // input leave it null, and the tool call then rendered as an empty {}.
      const trace = makeTrace([
        toolCall({
          id: "tool-1",
          step_index: 0,
          tool_parameters: null,
          input: { templateId: "NAE1Bolh" },
          output: { content: [{ type: "text", text: '{"rules":[]}' }] },
        }),
        rawGeneration(),
      ]);

      const result = deriveConversationFromTrace(trace);
      const call = result.messages.find((m) => m.tool_calls?.length);
      expect(call?.tool_calls?.[0]?.function?.name).toBe("docxGetTemplatePrimitives");
      expect(call?.tool_calls?.[0]?.function?.arguments).toBe(
        '{"templateId":"NAE1Bolh"}',
      );
    });

    it("reads arguments from the span input when tool_parameters is empty", () => {
      const trace = makeTrace([
        toolCall({
          id: "tool-1",
          step_index: 0,
          tool_parameters: {},
          input: { templateId: "NAE1Bolh" },
          output: { content: [{ type: "text", text: '{"rules":[]}' }] },
        }),
        rawGeneration(),
      ]);

      const result = deriveConversationFromTrace(trace);
      const call = result.messages.find((message) => message.tool_calls?.length);
      expect(call?.tool_calls?.[0]?.function?.arguments).toBe(
        '{"templateId":"NAE1Bolh"}',
      );
    });

    it("names the tool result after the tool that produced it", () => {
      const trace = makeTrace([
        toolCall({
          id: "tool-1",
          step_index: 0,
          input: { templateId: "NAE1Bolh" },
          output: { content: [{ type: "text", text: '{"rules":[]}' }] },
        }),
        rawGeneration(),
      ]);

      const result = deriveConversationFromTrace(trace);
      const toolResult = result.messages.find((m) => m.role === "tool");
      expect(toolResult?.name).toBe("docxGetTemplatePrimitives");
    });

    it("unwraps the MCP {content:[…]} result envelope instead of serializing it", () => {
      const trace = makeTrace([
        toolCall({
          id: "tool-1",
          step_index: 0,
          input: { templateId: "NAE1Bolh" },
          output: {
            content: [{ type: "text", text: '{"rules":[{"ruleText":"Net 45 max"}]}' }],
            details: { rules: [{ ruleText: "Net 45 max" }] },
          },
        }),
        rawGeneration(),
      ]);

      const result = deriveConversationFromTrace(trace);
      const toolResult = result.messages.find((m) => m.role === "tool");
      expect(toolResult?.content).toBe('{"rules":[{"ruleText":"Net 45 max"}]}');
    });

    it("unwraps a {text: …} result envelope", () => {
      const trace = makeTrace([
        toolCall({
          id: "tool-1",
          step_index: 0,
          tool_name: "read",
          input: { path: "/SKILL.md" },
          output: { text: "# Skill\nBody." },
        }),
        rawGeneration(),
      ]);

      const result = deriveConversationFromTrace(trace);
      const toolResult = result.messages.find((m) => m.role === "tool");
      expect(toolResult?.content).toBe("# Skill\nBody.");
    });
  });

  describe("edge cases", () => {
    it("returns empty for a null trace", () => {
      expect(deriveConversationFromTrace(null).messages).toEqual([]);
    });

    it("returns empty when there are no calls", () => {
      expect(deriveConversationFromTrace(makeTrace([])).messages).toEqual([]);
    });

    it("returns empty when no calls have any extractable content", () => {
      const trace = makeTrace([
        makeCall({ id: "gen-1", input: {}, output: {} }),
      ]);
      expect(deriveConversationFromTrace(trace).messages).toEqual([]);
    });

    it("prefers messages arrays over raw content blocks when both exist", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          input: {
            messages: [
              { role: "user", content: "From messages array" },
            ],
          },
          output: [{ type: "text", text: "From content blocks" }],
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      // The messages-array path should win
      expect(result.messages.some((m) => m.content === "From messages array")).toBe(true);
      expect(result.messages.some((m) => m.content === "From content blocks")).toBe(false);
    });
  });
});
