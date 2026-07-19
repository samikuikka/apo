import { describe, it, expect } from "vitest";
import { extractTools, countToolInvocations } from "../tool-utils";
import { extractThinkingContent } from "../thinking-utils";

describe("extractTools", () => {
  it("returns empty array for null", () => {
    expect(extractTools(null)).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(extractTools(undefined)).toEqual([]);
  });

  it("returns empty array for primitive values", () => {
    expect(extractTools(42)).toEqual([]);
    expect(extractTools(true)).toEqual([]);
  });

  it("returns empty array when no tools field", () => {
    expect(extractTools({ messages: [] })).toEqual([]);
  });

  it("returns empty array when tools is empty", () => {
    expect(extractTools({ tools: [] })).toEqual([]);
  });

  it("extracts tools from object with tools array", () => {
    const data = {
      tools: [
        {
          function: {
            name: "search",
            description: "Search the web",
            parameters: { type: "object" },
          },
        },
        {
          function: {
            name: "calculate",
            description: "Do math",
            parameters: { type: "object" },
          },
        },
      ],
    };
    const result = extractTools(data);
    expect(result).toHaveLength(2);
    expect(result[0].function?.name).toBe("search");
    expect(result[1].function?.name).toBe("calculate");
  });

  it("filters out tools without function field", () => {
    const data = {
      tools: [
        { function: { name: "valid" } },
        { notATool: true },
        null,
        "string-value",
      ],
    };
    const result = extractTools(data);
    expect(result).toHaveLength(1);
    expect(result[0].function?.name).toBe("valid");
  });

  it("returns empty array for string input (not supported)", () => {
    const data = JSON.stringify({
      tools: [{ function: { name: "search" } }],
    });
    expect(extractTools(data)).toEqual([]);
  });

  it("returns empty array for invalid JSON string", () => {
    expect(extractTools("not json")).toEqual([]);
  });

  it("extracts tools from metadata.tools", () => {
    const data = {
      metadata: {
        tools: [{ function: { name: "metadata_tool" } }],
      },
    };
    expect(extractTools(data)).toEqual([]);
  });

  it("extracts tools only from top-level tools field", () => {
    const data = {
      tools: [{ function: { name: "top_level" } }],
      nested: {
        tools: [{ function: { name: "nested" } }],
      },
    };
    const result = extractTools(data);
    expect(result).toHaveLength(1);
    expect(result[0].function?.name).toBe("top_level");
  });
});

describe("countToolInvocations", () => {
  it("returns empty counts for empty messages", () => {
    expect(countToolInvocations([])).toEqual({});
  });

  it("returns empty counts for messages without tool_calls", () => {
    expect(countToolInvocations([{}, {}])).toEqual({});
  });

  it("counts single tool invocation", () => {
    const messages = [
      {
        tool_calls: [{ function: { name: "search" } }],
      },
    ];
    expect(countToolInvocations(messages)).toEqual({ search: 1 });
  });

  it("counts multiple invocations of same tool", () => {
    const messages = [
      {
        tool_calls: [
          { function: { name: "search" } },
          { function: { name: "search" } },
        ],
      },
    ];
    expect(countToolInvocations(messages)).toEqual({ search: 2 });
  });

  it("counts across multiple messages", () => {
    const messages = [
      {
        tool_calls: [{ function: { name: "search" } }],
      },
      {
        tool_calls: [{ function: { name: "search" } }],
      },
    ];
    expect(countToolInvocations(messages)).toEqual({ search: 2 });
  });

  it("counts multiple different tools", () => {
    const messages = [
      {
        tool_calls: [
          { function: { name: "search" } },
          { function: { name: "calculate" } },
        ],
      },
    ];
    expect(countToolInvocations(messages)).toEqual({
      search: 1,
      calculate: 1,
    });
  });

  it("skips tool_calls without function name", () => {
    const messages = [
      {
        tool_calls: [
          { function: {} },
          { function: { name: "search" } },
          {},
        ],
      },
    ];
    expect(countToolInvocations(messages)).toEqual({ search: 1 });
  });
});

describe("extractThinkingContent", () => {
  it("returns null for null input", () => {
    expect(extractThinkingContent(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractThinkingContent(undefined)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(extractThinkingContent("string")).toBeNull();
    expect(extractThinkingContent(42)).toBeNull();
  });

  it("extracts thinking field (Anthropic format)", () => {
    const msg = { thinking: "Let me reason about this..." };
    expect(extractThinkingContent(msg)).toBe("Let me reason about this...");
  });

  it("extracts reasoning_content field (DeepSeek format)", () => {
    const msg = { reasoning_content: "Step by step analysis..." };
    expect(extractThinkingContent(msg)).toBe("Step by step analysis...");
  });

  it("extracts metadata.thinking field (custom format)", () => {
    const msg = { metadata: { thinking: "Custom thinking content" } };
    expect(extractThinkingContent(msg)).toBe("Custom thinking content");
  });

  it("prefers thinking over reasoning_content", () => {
    const msg = {
      thinking: "from thinking",
      reasoning_content: "from reasoning",
    };
    expect(extractThinkingContent(msg)).toBe("from thinking");
  });

  it("returns null for empty thinking string", () => {
    expect(extractThinkingContent({ thinking: "" })).toBeNull();
  });

  it("returns null for whitespace-only thinking string", () => {
    expect(extractThinkingContent({ thinking: "   " })).toBeNull();
  });

  it("returns null when metadata is null", () => {
    expect(extractThinkingContent({ metadata: null })).toBeNull();
  });

  it("returns null when metadata.thinking is empty", () => {
    expect(
      extractThinkingContent({ metadata: { thinking: "  " } }),
    ).toBeNull();
  });

  it("returns null when no thinking fields present", () => {
    expect(
      extractThinkingContent({ role: "assistant", content: "hello" }),
    ).toBeNull();
  });

  it("handles very long thinking content", () => {
    const longThinking = "x".repeat(50000);
    expect(extractThinkingContent({ thinking: longThinking })).toBe(
      longThinking,
    );
  });
});
