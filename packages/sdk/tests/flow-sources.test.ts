import { describe, it, expect } from "vitest";
import {
  fromOpenAIMessages,
  fromAnthropicMessages,
  fromAISDK,
} from "../src/agent-task/flow/sources.ts";
import { FlowView } from "../src/agent-task/flow/view.ts";

describe("flow normalizers (cross-framework plugs)", () => {
  it("fromOpenAIMessages maps chat log → Flow", () => {
    const flow = fromOpenAIMessages([
      { role: "user", content: "what's the weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", function: { name: "get_weather", arguments: '{"city":"NYC"}' } },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "Sunny" },
      { role: "assistant", content: "It's sunny" },
    ]);
    const v = new FlowView(flow);
    expect(v.toolCalls.map((c) => c.name)).toEqual(["get_weather"]);
    expect(v.toolCalls[0]!.input).toEqual({ city: "NYC" });
    expect(v.toolCalls[0]!.output).toBe("Sunny");
    expect(v.reply).toBe("It's sunny");
  });

  it("fromAnthropicMessages maps content blocks → Flow", () => {
    const flow = fromAnthropicMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "u1", name: "lookup", input: { q: "x" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "found" }] },
    ]);
    const v = new FlowView(flow);
    expect(v.toolCalls[0]).toMatchObject({ name: "lookup", output: "found" });
    expect(v.reply).toBe("checking");
  });

  it("fromAISDK maps generateText steps → Flow", () => {
    const flow = fromAISDK({
      steps: [
        {
          text: "thinking",
          toolCalls: [{ toolName: "read_file", input: { p: "a" } }],
          toolResults: [{ toolName: "read_file", output: { ok: true } }],
        },
      ],
    });
    const v = new FlowView(flow);
    expect(v.toolNamesInOrder).toEqual(["read_file"]);
    expect(v.toolCalls[0]!.output).toEqual({ ok: true });
  });
});
