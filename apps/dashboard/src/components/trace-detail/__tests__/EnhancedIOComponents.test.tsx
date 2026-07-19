import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolDefinitionsSection } from "../ToolDefinitionsSection";
import { ThinkingBlock } from "../ThinkingBlock";
import { CollapsibleHistory } from "../CollapsibleHistory";

describe("ToolDefinitionsSection", () => {
  const sampleTools = [
    {
      function: {
        name: "search",
        description: "Search the web for information",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    },
    {
      function: {
        name: "calculate",
        description: "Perform mathematical calculations",
        parameters: { type: "object", properties: { expr: { type: "string" } } },
      },
    },
    {
      function: {
        name: "lookup",
        description: "Look up data in database",
        parameters: { type: "object" },
      },
    },
  ];

  it("renders nothing when tools array is empty", () => {
    const { container } = render(
      <ToolDefinitionsSection tools={[]} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders tool definitions header", () => {
    render(<ToolDefinitionsSection tools={sampleTools} />);
    expect(screen.getByText("Tool Definitions")).toBeInTheDocument();
  });

  it("shows tool count badge", () => {
    render(<ToolDefinitionsSection tools={sampleTools} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows invocation counts when provided", () => {
    render(
      <ToolDefinitionsSection
        tools={sampleTools}
        invocationCounts={{ search: 5, calculate: 2 }}
      />,
    );
    expect(screen.getByText("5x")).toBeInTheDocument();
    expect(screen.getByText("2x")).toBeInTheDocument();
  });

  it("does not show 0x badge for unused tools", () => {
    render(
      <ToolDefinitionsSection
        tools={sampleTools}
        invocationCounts={{ search: 5 }}
      />,
    );
    expect(screen.queryByText("0x")).not.toBeInTheDocument();
  });

  it("shows tool names", () => {
    render(<ToolDefinitionsSection tools={sampleTools} />);
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("calculate")).toBeInTheDocument();
    expect(screen.getByText("lookup")).toBeInTheDocument();
  });

  it("shows tool descriptions", () => {
    render(<ToolDefinitionsSection tools={sampleTools} />);
    expect(screen.getByText("Search the web for information")).toBeInTheDocument();
    expect(screen.getByText("Perform mathematical calculations")).toBeInTheDocument();
    expect(screen.getByText("Look up data in database")).toBeInTheDocument();
  });

  it("section is open by default when <=3 tools", () => {
    render(<ToolDefinitionsSection tools={sampleTools} />);
    expect(screen.getByText("search")).toBeVisible();
  });

  it("section is collapsed by default when >3 tools", () => {
    const fourTools = [
      ...sampleTools,
      { function: { name: "extra", description: "Extra tool" } },
    ];
    render(<ToolDefinitionsSection tools={fourTools} />);
    expect(screen.getByText("Tool Definitions")).toBeInTheDocument();
  });

  it("expands parameters on click", async () => {
    const user = userEvent.setup();
    render(
      <ToolDefinitionsSection
        tools={[sampleTools[0]]}
        invocationCounts={{}}
      />,
    );

    const toggleBtn = screen.getByLabelText("Toggle search parameters");
    await user.click(toggleBtn);

    expect(screen.getByText(/"query"/)).toBeInTheDocument();
  });

  it("handles tools without descriptions", () => {
    const tools = [{ function: { name: "minimal" } }];
    render(<ToolDefinitionsSection tools={tools} />);
    expect(screen.getByText("minimal")).toBeInTheDocument();
  });

  it("handles tools without function field gracefully", () => {
    const tools = [{ function: undefined }];
    render(<ToolDefinitionsSection tools={[tools[0] as any]} />);
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });
});

describe("ThinkingBlock", () => {
  it("renders thinking label", () => {
    render(<ThinkingBlock thinking="Some reasoning content" />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("shows preview when collapsed", async () => {
    const user = userEvent.setup();
    const thinking = "A".repeat(200);
    render(<ThinkingBlock thinking={thinking} />);

    const toggleBtn = screen.getByLabelText("Toggle thinking content");
    await user.click(toggleBtn);

    expect(screen.getByText("A".repeat(100) + "...")).toBeInTheDocument();
  });

  it("shows full content when expanded", () => {
    const thinking = "Short reasoning";
    render(<ThinkingBlock thinking={thinking} />);
    expect(screen.getByText("Short reasoning")).toBeInTheDocument();
  });

  it("collapses long content by default", () => {
    const longThinking = "B".repeat(15000);
    render(<ThinkingBlock thinking={longThinking} />);

    expect(screen.getByText("B".repeat(100) + "...")).toBeInTheDocument();
  });

  it("does not add ellipsis for short content when collapsed", async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock thinking="Short text" />);

    const toggleBtn = screen.getByLabelText("Toggle thinking content");
    await user.click(toggleBtn);

    expect(screen.getByText("Short text")).toBeInTheDocument();
    expect(screen.queryByText("Short text...")).not.toBeInTheDocument();
  });

  it("toggles between expanded and collapsed", async () => {
    const user = userEvent.setup();
    const longThinking = "C".repeat(15000);
    render(<ThinkingBlock thinking={longThinking} />);

    expect(screen.getByText("C".repeat(100) + "...")).toBeInTheDocument();

    const toggleBtn = screen.getByLabelText("Toggle thinking content");
    await user.click(toggleBtn);

    expect(screen.getByText(longThinking)).toBeInTheDocument();
  });
});

describe("CollapsibleHistory", () => {
  it("renders all content when <=6 messages", () => {
    const items = [
      <div key="1">Msg 1</div>,
      <div key="2">Msg 2</div>,
      <div key="3">Msg 3</div>,
    ];
    render(
      <CollapsibleHistory
        totalMessages={3}
        visibleStart={items}
        hiddenMiddle={[]}
        visibleEnd={[]}
      />,
    );
    expect(screen.getByText("Msg 1")).toBeInTheDocument();
    expect(screen.getByText("Msg 2")).toBeInTheDocument();
    expect(screen.getByText("Msg 3")).toBeInTheDocument();
  });

  it("shows 'Show N more messages' button when >6 messages", () => {
    const firstThree = [
      <div key="1">Msg 1</div>,
      <div key="2">Msg 2</div>,
      <div key="3">Msg 3</div>,
    ];
    const middle = [<div key="4">Msg 4</div>];
    const lastThree = [
      <div key="5">Msg 5</div>,
      <div key="6">Msg 6</div>,
      <div key="7">Msg 7</div>,
    ];

    render(
      <CollapsibleHistory
        totalMessages={7}
        visibleStart={firstThree}
        hiddenMiddle={middle}
        visibleEnd={lastThree}
      />,
    );

    expect(screen.getByText("Show 1 more message...")).toBeInTheDocument();
    expect(screen.queryByText("Msg 4")).not.toBeInTheDocument();
  });

  it("uses plural for multiple hidden messages", () => {
    render(
      <CollapsibleHistory
        totalMessages={10}
        visibleStart={[<div key="1">First</div>]}
        hiddenMiddle={[
          <div key="2">M1</div>,
          <div key="3">M2</div>,
          <div key="4">M3</div>,
          <div key="5">M4</div>,
        ]}
        visibleEnd={[<div key="6">Last</div>]}
      />,
    );

    expect(screen.getByText("Show 4 more messages...")).toBeInTheDocument();
  });

  it("expands hidden messages on button click", async () => {
    const user = userEvent.setup();
    const middle = [
      <div key="4">Msg 4</div>,
      <div key="5">Msg 5</div>,
    ];

    render(
      <CollapsibleHistory
        totalMessages={8}
        visibleStart={[<div key="1">Msg 1</div>]}
        hiddenMiddle={middle}
        visibleEnd={[<div key="6">Msg 6</div>]}
      />,
    );

    expect(screen.queryByText("Msg 4")).not.toBeInTheDocument();

    await user.click(screen.getByText("Show 2 more messages..."));

    expect(screen.getByText("Msg 4")).toBeInTheDocument();
    expect(screen.getByText("Msg 5")).toBeInTheDocument();
  });

  it("hides expand button after expanding", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleHistory
        totalMessages={7}
        visibleStart={[<div key="1">Msg 1</div>]}
        hiddenMiddle={[<div key="4">Msg 4</div>]}
        visibleEnd={[<div key="7">Msg 7</div>]}
      />,
    );

    const button = screen.getByText("Show 1 more message...");
    await user.click(button);

    expect(screen.queryByText("Show 1 more message...")).not.toBeInTheDocument();
  });
});
