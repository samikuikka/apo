import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  CallCostBreakdownTooltip,
  RunCostBreakdownTooltip,
} from "../CostBreakdownTooltip";

vi.mock("@/lib/model-pricing", () => ({
  fetchModelPricing: vi.fn(),
  computeCallBreakdown: vi.fn(),
  computeRunBreakdown: vi.fn(),
}));

import {
  fetchModelPricing,
  computeCallBreakdown,
  computeRunBreakdown,
} from "@/lib/model-pricing";

const mockedFetchModelPricing = vi.mocked(fetchModelPricing);
const mockedComputeCallBreakdown = vi.mocked(computeCallBreakdown);
const mockedComputeRunBreakdown = vi.mocked(computeRunBreakdown);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CallCostBreakdownTooltip", () => {
  const call = {
    model: "gpt-4o",
    prompt_tokens: 1200,
    completion_tokens: 300,
    cost: 0.006,
  };

  it("renders children when no breakdown available", async () => {
    mockedFetchModelPricing.mockResolvedValueOnce([]);
    mockedComputeCallBreakdown.mockReturnValueOnce({
      model: "gpt-4o",
      promptTokens: null,
      completionTokens: null,
      inputPricePer1M: null,
      outputPricePer1M: null,
      promptCost: null,
      completionCost: null,
      totalCost: null,
      providedCost: null,
      calculatedCost: null,
      hasPricing: false,
    });

    render(
      <CallCostBreakdownTooltip call={call}>
        <span>$0.006</span>
      </CallCostBreakdownTooltip>,
    );

    await act(async () => {
      await mockedFetchModelPricing.mock.results[0]?.value;
    });

    expect(screen.getByText("$0.006")).toBeInTheDocument();
  });

  it("renders tooltip with cost breakdown after hover", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown[]) => void;
    const fetchPromise = new Promise<unknown[]>((resolve) => {
      resolveFetch = resolve;
    });
    mockedFetchModelPricing.mockReturnValueOnce(fetchPromise as any);
    mockedComputeCallBreakdown.mockReturnValueOnce({
      model: "gpt-4o",
      promptTokens: 1200,
      completionTokens: 300,
      inputPricePer1M: 2.5,
      outputPricePer1M: 10.0,
      promptCost: 0.003,
      completionCost: 0.003,
      totalCost: 0.006,
      providedCost: null,
      calculatedCost: 0.006,
      hasPricing: true,
    });

    render(
      <CallCostBreakdownTooltip call={call}>
        <span>$0.006</span>
      </CallCostBreakdownTooltip>,
    );

    await act(async () => {
      resolveFetch!([]);
    });

    await user.hover(screen.getByText("$0.006"));

    expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Input:.*1,200/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Output:.*300/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$0.006/).length).toBeGreaterThan(0);
  });

  it("shows pricing not configured when no pricing", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown[]) => void;
    const fetchPromise = new Promise<unknown[]>((resolve) => {
      resolveFetch = resolve;
    });
    mockedFetchModelPricing.mockReturnValueOnce(fetchPromise as any);
    mockedComputeCallBreakdown.mockReturnValueOnce({
      model: "unknown-model",
      promptTokens: 500,
      completionTokens: 100,
      inputPricePer1M: null,
      outputPricePer1M: null,
      promptCost: null,
      completionCost: null,
      totalCost: 0.001,
      providedCost: null,
      calculatedCost: null,
      hasPricing: false,
    });

    render(
      <CallCostBreakdownTooltip call={{ model: "unknown-model", cost: 0.001 }}>
        <span>$0.001</span>
      </CallCostBreakdownTooltip>,
    );

    await act(async () => {
      resolveFetch!([]);
    });

    await user.hover(screen.getByText("$0.001"));

    expect(screen.getAllByText("Pricing not configured").length).toBeGreaterThan(0);
  });

  it("shows provided vs calculated cost when they differ", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown[]) => void;
    const fetchPromise = new Promise<unknown[]>((resolve) => {
      resolveFetch = resolve;
    });
    mockedFetchModelPricing.mockReturnValueOnce(fetchPromise as any);
    mockedComputeCallBreakdown.mockReturnValueOnce({
      model: "gpt-4o",
      promptTokens: 1200,
      completionTokens: 300,
      inputPricePer1M: 2.5,
      outputPricePer1M: 10.0,
      promptCost: 0.003,
      completionCost: 0.003,
      totalCost: 0.005,
      providedCost: 0.005,
      calculatedCost: 0.006,
      hasPricing: true,
    });

    render(
      <CallCostBreakdownTooltip call={call}>
        <span>$0.005</span>
      </CallCostBreakdownTooltip>,
    );

    await act(async () => {
      resolveFetch!([]);
    });

    await user.hover(screen.getByText("$0.005"));

    expect(screen.getAllByText(/Provided:.*\$0\.005/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Calculated:.*\$0\.006/).length).toBeGreaterThan(0);
  });

  it("skips zero token lines", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown[]) => void;
    const fetchPromise = new Promise<unknown[]>((resolve) => {
      resolveFetch = resolve;
    });
    mockedFetchModelPricing.mockReturnValueOnce(fetchPromise as any);
    mockedComputeCallBreakdown.mockReturnValueOnce({
      model: "gpt-4o",
      promptTokens: 0,
      completionTokens: 300,
      inputPricePer1M: 2.5,
      outputPricePer1M: 10.0,
      promptCost: 0,
      completionCost: 0.003,
      totalCost: 0.003,
      providedCost: null,
      calculatedCost: 0.003,
      hasPricing: true,
    });

    render(
      <CallCostBreakdownTooltip call={call}>
        <span>$0.003</span>
      </CallCostBreakdownTooltip>,
    );

    await act(async () => {
      resolveFetch!([]);
    });

    await user.hover(screen.getByText("$0.003"));

    expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Input:/)).toHaveLength(0);
    expect(screen.getAllByText(/Output:/).length).toBeGreaterThan(0);
  });
});

describe("RunCostBreakdownTooltip", () => {
  it("renders children without tooltip when no calls", () => {
    mockedComputeRunBreakdown.mockReturnValueOnce([]);

    render(
      <RunCostBreakdownTooltip calls={[]}>
        <span>$0.00</span>
      </RunCostBreakdownTooltip>,
    );

    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("renders per-model breakdown", async () => {
    const user = userEvent.setup();
    mockedComputeRunBreakdown.mockReturnValueOnce([
      { model: "gpt-4o", callCount: 5, promptTokens: 6000, completionTokens: 1500, cost: 0.48 },
      { model: "claude-3", callCount: 2, promptTokens: 2000, completionTokens: 500, cost: 0.12 },
    ]);

    render(
      <RunCostBreakdownTooltip
        calls={[
          { model: "gpt-4o", cost: 0.1 },
          { model: "claude-3", cost: 0.06 },
        ]}
      >
        <span>$0.60</span>
      </RunCostBreakdownTooltip>,
    );

    await user.hover(screen.getByText("$0.60"));

    expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0);
    expect(screen.getAllByText("claude-3").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$0\.48/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/5 calls/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2 calls/).length).toBeGreaterThan(0);
  });

  it("shows singular 'call' for single call", async () => {
    const user = userEvent.setup();
    mockedComputeRunBreakdown.mockReturnValueOnce([
      { model: "gpt-4o", callCount: 1, promptTokens: 1000, completionTokens: 200, cost: 0.01 },
    ]);

    render(
      <RunCostBreakdownTooltip calls={[{ model: "gpt-4o", cost: 0.01 }]}>
        <span>$0.01</span>
      </RunCostBreakdownTooltip>,
    );

    await user.hover(screen.getByText("$0.01"));

    expect(screen.getAllByText(/1 call[^s]/).length).toBeGreaterThan(0);
  });
});
