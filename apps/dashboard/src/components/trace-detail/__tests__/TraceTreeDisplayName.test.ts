import { describe, it, expect } from "vitest";
import { getDisplayName, cleanSpanName } from "../TraceTree";
import {
  getDisplayName as getDisplayNameFromShared,
  cleanSpanName as cleanSpanNameFromShared,
} from "../trace-display";
import type { TraceObservation } from "../contexts";

function makeCall(overrides: Partial<TraceObservation> & { id: string }): TraceObservation {
  return {
    step_index: 0,
    step_name: null,
    model: "unknown",
    created_at: "2026-01-01T00:00:00.000Z",
    latency_ms: 100,
    cost: null,
    input: null,
    output: null,
    task_id: null,
    parent_call_id: null,
    ...overrides,
  } as TraceObservation;
}

describe("getDisplayName (tree)", () => {
  it("uses tool_name for TOOL observations instead of the raw span name", () => {
    const call = makeCall({
      id: "1",
      observation_type: "TOOL",
      step_name: "ai.toolCall",
      tool_name: "list_files",
    });
    expect(getDisplayName(call)).toBe("list_files");
  });

  it("falls back to a cleaned span name for TOOL when tool_name is absent", () => {
    const call = makeCall({
      id: "1",
      observation_type: "TOOL",
      step_name: "ai.toolCall",
      tool_name: null,
    });
    expect(getDisplayName(call)).toBe("toolCall");
  });

  it("shows a readable 'generate' for GENERATION spans with raw AI SDK names", () => {
    const call = makeCall({
      id: "1",
      observation_type: "GENERATION",
      step_name: "ai.generateText.doGenerate",
      model: "google/gemini-2.5-flash-lite",
    });
    expect(getDisplayName(call)).toBe("generate");
  });

  it("keeps a curated step_name for GENERATION when it isn't a raw SDK name", () => {
    const call = makeCall({
      id: "1",
      observation_type: "GENERATION",
      step_name: "extract-entities",
      model: "gpt-4o",
    });
    expect(getDisplayName(call)).toBe("extract-entities");
  });

  it("leaves adapter/task lifecycle span names intact (already readable)", () => {
    const call = makeCall({
      id: "1",
      observation_type: "SPAN",
      step_name: "adapter.open-session",
    });
    expect(getDisplayName(call)).toBe("adapter.open-session");
  });

  it("returns the step fallback when nothing is meaningful", () => {
    const call = makeCall({
      id: "1",
      observation_type: "SPAN",
      step_name: null,
      step_index: 4,
    });
    expect(getDisplayName(call)).toBe("Step 4");
  });

  it("still honors a structured output summary for tool_use events", () => {
    const call = makeCall({
      id: "1",
      observation_type: "TOOL",
      step_name: "ai.toolCall",
      tool_name: "search",
      metadata: { eventType: "tool_use" },
      output: { summary: "Searched the database" },
    });
    expect(getDisplayName(call)).toBe("Searched the database");
  });

  it("summarizes a Claude Code LLM-request span as 'generate'", () => {
    const call = makeCall({
      id: "1",
      observation_type: "GENERATION",
      step_name: "claude_code.llm_request",
      model: "claude-sonnet-4",
    });
    expect(getDisplayName(call)).toBe("generate");
  });

  it("uses tool_name for a Claude Code tool span", () => {
    const call = makeCall({
      id: "1",
      observation_type: "TOOL",
      step_name: "claude_code.tool",
      tool_name: "Read",
    });
    expect(getDisplayName(call)).toBe("Read");
  });

  it("falls back to a cleaned name for a Claude Code tool span without tool_name", () => {
    const call = makeCall({
      id: "1",
      observation_type: "TOOL",
      step_name: "claude_code.tool",
      tool_name: null,
    });
    expect(getDisplayName(call)).toBe("tool");
  });

  it("labels a Claude Code interaction span as 'agent turn'", () => {
    const call = makeCall({
      id: "1",
      observation_type: "AGENT",
      step_name: "claude_code.interaction",
    });
    expect(getDisplayName(call)).toBe("agent turn");
  });

  it("labels a Claude Code permission prompt span as 'permission prompt'", () => {
    const call = makeCall({
      id: "1",
      observation_type: "SPAN",
      step_name: "claude_code.tool.blocked_on_user",
    });
    expect(getDisplayName(call)).toBe("permission prompt");
  });

  it("keeps an already-readable Claude Code suffix unchanged (compaction)", () => {
    const call = makeCall({
      id: "1",
      observation_type: "SPAN",
      step_name: "claude_code.compaction",
    });
    expect(getDisplayName(call)).toBe("compaction");
  });

  it("strips the claude_code. prefix for an unknown suffix instead of leaking it", () => {
    const call = makeCall({
      id: "1",
      observation_type: "SPAN",
      step_name: "claude_code.something_new",
    });
    expect(getDisplayName(call)).toBe("something_new");
  });
});

describe("re-export parity", () => {
  // TraceTree re-exports getDisplayName / cleanSpanName from trace-display so
  // existing importers keep working. The two must be the same function.
  it("TraceTree.getDisplayName === trace-display.getDisplayName", () => {
    expect(getDisplayName).toBe(getDisplayNameFromShared);
  });

  it("TraceTree.cleanSpanName === trace-display.cleanSpanName", () => {
    expect(cleanSpanName).toBe(cleanSpanNameFromShared);
  });
});

describe("cleanSpanName", () => {
  it("strips ai. prefix", () => {
    expect(cleanSpanName("ai.generateText")).toBe("generateText");
  });

  it("strips the .doGenerate / .doStream suffix", () => {
    expect(cleanSpanName("ai.generateText.doGenerate")).toBe("generateText");
    expect(cleanSpanName("ai.streamText.doStream")).toBe("streamText");
  });

  it("returns adapter/task names unchanged (only ai./gen_ai./claude_code. are stripped)", () => {
    expect(cleanSpanName("adapter.open-session")).toBe("adapter.open-session");
    expect(cleanSpanName("task.load")).toBe("task.load");
  });

  it("strips the claude_code. prefix", () => {
    expect(cleanSpanName("claude_code.llm_request")).toBe("llm_request");
    expect(cleanSpanName("claude_code.tool")).toBe("tool");
    expect(cleanSpanName("claude_code.subagent.spawn")).toBe("subagent.spawn");
  });

  it("returns null for empty/null", () => {
    expect(cleanSpanName(null)).toBeNull();
    expect(cleanSpanName("")).toBeNull();
    expect(cleanSpanName("   ")).toBeNull();
  });
});
