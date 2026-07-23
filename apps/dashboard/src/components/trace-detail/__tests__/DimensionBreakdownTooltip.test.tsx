import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  CallCostBreakdownTooltip,
  RunCostBreakdownTooltip,
} from "../DimensionBreakdownTooltip";

// Critical regression guard (SPEC-136 ticket 11): the tooltip must NOT fetch
// pricing client-side. If anything imports the deleted model-pricing module,
// this test file would fail to load.
vi.mock("@/lib/model-pricing", () => {
  throw new Error("model-pricing.ts must be deleted; tooltip must not fetch pricing");
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CallCostBreakdownTooltip", () => {
  it("renders stored breakdown grouped by family, sorted by magnitude", async () => {
    const user = userEvent.setup();
    const breakdown = {
      input: 1_000_000,
      output: 5_000_000,
      cache_read: 500_000,
      reasoning: 2_000_000,
    };
    render(
      <CallCostBreakdownTooltip
        breakdown={breakdown}
        rawUsage={{ input: 1000, output: 1000, cache_read: 500, reasoning: 300 }}
        modelName="gpt-4o"
        provenance="computed"
        cost={8_500_000}
      >
        <span>$8.50</span>
      </CallCostBreakdownTooltip>,
    );

    await user.hover(screen.getByText("$8.50"));

    // Model header + total above the rule.
    expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0);
    // Total in USD (8_500_000 micro -> $8.5000).
    expect(screen.getAllByText(/Total/).length).toBeGreaterThan(0);
    // Family group labels (uppercase headers).
    expect(screen.getAllByText("Input").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Output").length).toBeGreaterThan(0);
    // Dimensions present.
    expect(screen.getAllByText(/Input/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Output/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Reasoning/).length).toBeGreaterThan(0);
  });

  it("hides zero-cost dimensions", async () => {
    const user = userEvent.setup();
    render(
      <CallCostBreakdownTooltip
        breakdown={{ input: 1_000_000 }} // only input has cost
        rawUsage={{ input: 1000, cache_read: 0 }}
        modelName="gpt-4o"
        provenance="computed"
        cost={1_000_000}
      >
        <span>$1</span>
      </CallCostBreakdownTooltip>,
    );
    await user.hover(screen.getByText("$1"));
    // Cache read (0 cost, in usage as 0) should not appear as a priced row.
    expect(screen.queryAllByText(/Cache read/)).toHaveLength(0);
  });

  it("surfaces unpriced dimensions in amber", async () => {
    const user = userEvent.setup();
    // reasoning is in raw_usage but not priced (absent from breakdown).
    render(
      <CallCostBreakdownTooltip
        breakdown={{ input: 1_000_000 }}
        rawUsage={{ input: 1000, reasoning: 999 }}
        modelName="gpt-4o"
        provenance="computed"
        cost={1_000_000}
      >
        <span>$1</span>
      </CallCostBreakdownTooltip>,
    );
    await user.hover(screen.getByText("$1"));
    // Reasoning appears as unpriced (amber).
    const reasoning = screen.getAllByText(/Reasoning/);
    expect(reasoning.length).toBeGreaterThan(0);
  });

  it("shows a quiet provenance footer for computed calls", async () => {
    const user = userEvent.setup();
    render(
      <CallCostBreakdownTooltip
        breakdown={{ input: 1_000_000 }}
        rawUsage={{ input: 1000 }}
        modelName="gpt-4o"
        provenance="computed"
        cost={1_000_000}
      >
        <span>$1</span>
      </CallCostBreakdownTooltip>,
    );
    await user.hover(screen.getByText("$1"));
    expect(screen.getAllByText(/computed/).length).toBeGreaterThan(0);
  });

  it("shows a provided-by-SDK footer with no breakdown", async () => {
    const user = userEvent.setup();
    render(
      <CallCostBreakdownTooltip
        breakdown={null}
        rawUsage={null}
        modelName="gpt-4o"
        provenance="provided"
        cost={1_000_000}
      >
        <span>$1</span>
      </CallCostBreakdownTooltip>,
    );
    await user.hover(screen.getByText("$1"));
    expect(screen.getAllByText(/provided by SDK/).length).toBeGreaterThan(0);
  });

  it("shows a legacy footer for pre-migration calls", async () => {
    const user = userEvent.setup();
    render(
      <CallCostBreakdownTooltip
        breakdown={null}
        rawUsage={null}
        modelName="gpt-4o"
        provenance={null}
        cost={750}
      >
        <span>$0.00075</span>
      </CallCostBreakdownTooltip>,
    );
    await user.hover(screen.getByText("$0.00075"));
    expect(screen.getAllByText(/legacy call/).length).toBeGreaterThan(0);
  });
});

describe("RunCostBreakdownTooltip", () => {
  it("groups calls by model and sums micro-USD cost", async () => {
    const user = userEvent.setup();
    render(
      <RunCostBreakdownTooltip
        calls={[
          { model: "gpt-4o", cost: 1_000_000 },
          { model: "gpt-4o", cost: 500_000 },
          { model: "claude-3", cost: 2_000_000 },
        ]}
      >
        <span>$3.50</span>
      </RunCostBreakdownTooltip>,
    );
    await user.hover(screen.getByText("$3.50"));
    // gpt-4o: 1_500_000 micro -> $1.50, 2 calls.
    expect(screen.getAllByText(/gpt-4o/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/claude-3/).length).toBeGreaterThan(0);
  });
});
