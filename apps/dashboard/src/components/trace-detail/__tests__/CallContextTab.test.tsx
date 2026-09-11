import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CallContextTab } from "../CallContextTab";
import { CallDetailView } from "../CallDetailView";
import { SelectionProvider } from "../contexts/SelectionContext";
import { TraceDataProvider, type LoggedCall, type TraceDetail } from "../contexts/TraceDataContext";
import { extractCallContext } from "../tool-utils";

// The OTel GenAI semconv shapes apo stores under call metadata.
const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "docxExtractMarkdown",
    description: "Extract a DOCX file as markdown.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
  { type: "function", name: "docxApplyEdits", description: "Apply edits." },
];
const SYSTEM_INSTRUCTIONS = [
  { type: "text", content: "You are an AI assistant for document workflows." },
  { type: "text", content: "Answer in English." },
];

function makeCall(metadata: Record<string, unknown> | null): LoggedCall {
  return {
    id: "call-1",
    run_id: "run-1",
    task_id: "",
    step_index: 0,
    step_name: "chat gpt-4o",
    created_at: "2026-01-01T00:00:00Z",
    observation_type: "GENERATION",
    model: "gpt-4o",
    input: {},
    output: {},
    metadata,
  } as LoggedCall;
}

describe("extractCallContext", () => {
  it("maps semconv tool definitions and joins system instruction parts", () => {
    const context = extractCallContext({
      tool_definitions: TOOL_DEFINITIONS,
      system_instructions: SYSTEM_INSTRUCTIONS,
    });
    expect(context.tools.map((t) => t.function?.name)).toEqual([
      "docxExtractMarkdown",
      "docxApplyEdits",
    ]);
    expect(context.tools[0].function?.parameters).toEqual(TOOL_DEFINITIONS[0].parameters);
    expect(context.systemInstructions).toBe(
      "You are an AI assistant for document workflows.\n\nAnswer in English.",
    );
  });

  it("accepts a bare-string system prompt and OpenAI-shaped tools", () => {
    const context = extractCallContext({
      tool_definitions: [{ type: "function", function: { name: "search" } }],
      system_instructions: "Be concise.",
    });
    expect(context.tools.map((t) => t.function?.name)).toEqual(["search"]);
    expect(context.systemInstructions).toBe("Be concise.");
  });

  it("is empty when the call carries no context", () => {
    expect(extractCallContext(null)).toEqual({ tools: [], systemInstructions: null });
    expect(extractCallContext({ other: 1 })).toEqual({ tools: [], systemInstructions: null });
  });
});

describe("CallContextTab", () => {
  it("shows the system instructions and each tool, expandable to its parameters", async () => {
    render(
      <CallContextTab
        call={makeCall({
          tool_definitions: TOOL_DEFINITIONS,
          system_instructions: SYSTEM_INSTRUCTIONS,
        })}
      />,
    );

    expect(screen.getByText("System instructions")).toBeInTheDocument();
    expect(screen.getByText(/You are an AI assistant for document workflows\./)).toBeInTheDocument();
    expect(screen.getByText("docxExtractMarkdown")).toBeInTheDocument();
    expect(screen.getByText("docxApplyEdits")).toBeInTheDocument();
    expect(screen.getByText("Extract a DOCX file as markdown.")).toBeInTheDocument();
    expect(screen.queryByText(/"properties"/)).toBeNull();

    await userEvent.click(screen.getByLabelText("Toggle docxExtractMarkdown parameters"));
    expect(screen.getByText(/"properties"/)).toBeInTheDocument();
  });

  it("collapses long system instructions behind a toggle", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Rule ${i + 1}.`).join("\n");
    render(<CallContextTab call={makeCall({ system_instructions: long })} />);

    expect(screen.queryByText(/Rule 60\./)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(screen.getByText(/Rule 60\./)).toBeInTheDocument();
  });
});

describe("CallDetailView Context tab", () => {
  function renderView(call: LoggedCall) {
    const run = { run: { id: "run-1", project: "p1" }, calls: [call] } as unknown as TraceDetail;
    return render(
      <SelectionProvider>
        <TraceDataProvider run={run} isLoading={false} error={null}>
          <CallDetailView call={call} />
        </TraceDataProvider>
      </SelectionProvider>,
    );
  }

  it("offers a Context tab when the call carries tool definitions or instructions", () => {
    renderView(makeCall({ system_instructions: SYSTEM_INSTRUCTIONS }));
    expect(screen.getByRole("tab", { name: "Context" })).toBeInTheDocument();
  });

  it("has no Context tab when the call carries neither", () => {
    renderView(makeCall(null));
    expect(screen.queryByRole("tab", { name: "Context" })).toBeNull();
  });
});
