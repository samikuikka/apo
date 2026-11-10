/**
 * The shared serving-evidence renderers (issue #307): compact cell labels,
 * the full groups table, truncation, coverage, and the null contract that
 * keeps old backends rendering nothing.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ServingSummary } from "../ServingSummary";
import { GenerationServingDetails } from "../GenerationServingDetails";
import type {
  CostCoverage,
  GenerationRates,
  ServingGroup,
  ServingIdentity,
  ServingSummary as ServingSummaryData,
} from "@/lib/serving-types";

function identity(overrides: Partial<ServingIdentity> = {}): ServingIdentity {
  return {
    model: null,
    instrumentation_provider: null,
    api_provider: null,
    serving_host: null,
    route: null,
    requested_service_tier: null,
    service_tier: null,
    request_model: null,
    response_model: null,
    evidence: null,
    ...overrides,
  };
}

function group(overrides: Partial<ServingGroup> = {}): ServingGroup {
  return {
    identity: identity(),
    calls: 0,
    errored_calls: 0,
    whole_call_rate: { median: null, samples: 0 },
    streaming_rate: { median: null, samples: 0 },
    rate_scopes: [],
    ...overrides,
  };
}

function summary(overrides: Partial<ServingSummaryData> = {}): ServingSummaryData {
  return {
    state: "uniform",
    calls: 1,
    errored_calls: 0,
    unknown_provider_calls: 0,
    unknown_host_calls: 0,
    aggregate_observations: 0,
    groups: [],
    total_groups: 0,
    groups_truncated: false,
    task_runs_with_evidence: 1,
    task_runs_total: 1,
    ...overrides,
  };
}

describe("ServingSummary", () => {
  it("renders nothing for a null summary (old backends)", () => {
    const { container } = render(<ServingSummary summary={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  describe("compact cell", () => {
    it("uniform shows the identity label, skipping null dimensions", () => {
      render(
        <ServingSummary
          compact
          summary={summary({
            state: "uniform",
            calls: 3,
            groups: [
              group({
                identity: identity({
                  model: "example-model",
                  api_provider: "fireworks",
                  service_tier: "priority",
                }),
              }),
            ],
            total_groups: 1,
          })}
        />,
      );
      expect(screen.getByText("fireworks \u00b7 priority")).toBeInTheDocument();
    });

    it("mixed counts every setup, including truncated ones", () => {
      render(
        <ServingSummary
          compact
          summary={summary({
            state: "mixed",
            calls: 12,
            groups: [group(), group()],
            total_groups: 3,
            groups_truncated: true,
          })}
        />,
      );
      expect(screen.getByText("Mixed \u00b7 3 setups")).toBeInTheDocument();
    });

    it("unknown and no_data states say so", () => {
      const { rerender } = render(<ServingSummary compact summary={summary({ state: "unknown" })} />);
      expect(screen.getByText("Unknown")).toBeInTheDocument();
      rerender(<ServingSummary compact summary={summary({ state: "no_data" })} />);
      expect(screen.getByText("No data")).toBeInTheDocument();
    });
  });

  describe("full table", () => {
    const coverage: CostCoverage = {
      reported: 1_200,
      qualified_estimate: null,
      model_only_estimate: 340,
      unpriced_calls: 2,
      ambiguous_calls: 0,
      excluded_error_calls: 0,
      aggregate_charge_observations: 0,
      partial: true,
    };

    it("renders groups with rates, samples, and scope badges", () => {
      render(
        <ServingSummary
          summary={summary({
            state: "uniform",
            calls: 9,
            errored_calls: 1,
            groups: [
              group({
                identity: identity({
                  model: "example-model",
                  api_provider: "openrouter",
                  serving_host: "baseten",
                  route: "nitro",
                }),
                calls: 7,
                errored_calls: 1,
                whole_call_rate: { median: 120, samples: 3 },
                streaming_rate: { median: null, samples: 0 },
                rate_scopes: [
                  {
                    scope: "all_output",
                    whole_call_rate: { median: 120, samples: 3 },
                    streaming_rate: { median: null, samples: 0 },
                  },
                ],
              }),
            ],
            total_groups: 1,
            cost_coverage: coverage,
          })}
        />,
      );
      expect(screen.getByText("openrouter \u00b7 baseten \u00b7 nitro")).toBeInTheDocument();
      expect(screen.getByText("example-model")).toBeInTheDocument();
      expect(screen.getByText("7")).toBeInTheDocument();
      expect(screen.getByText("120 tok/s \u00b7 3")).toBeInTheDocument();
      expect(screen.getByText("All Output")).toBeInTheDocument();
        expect(screen.getByText(/Cost coverage: reported \$0\.00/)).toBeInTheDocument();
      expect(screen.getByText(/2 unpriced/)).toBeInTheDocument();
    });

    it("shows the truncation note only when groups were cut", () => {
      const base = summary({
        state: "mixed",
        calls: 30,
        groups: [group(), group()],
        total_groups: 22,
        groups_truncated: true,
      });
      const { rerender } = render(<ServingSummary summary={base} />);
      expect(screen.getByText("+20 more setups")).toBeInTheDocument();
      rerender(
        <ServingSummary
          summary={summary({
            state: "mixed",
            calls: 4,
            groups: [group(), group()],
            total_groups: 2,
            groups_truncated: false,
          })}
        />,
      );
      expect(screen.queryByText(/more setups/)).not.toBeInTheDocument();
    });

    it("fires onSelect with the group identity when the tuple is activated", async () => {
      const onSelect = vi.fn();
      const tuple = identity({ api_provider: "fireworks", service_tier: "priority" });
      render(
        <ServingSummary
          summary={summary({ state: "uniform", calls: 2, groups: [group({ identity: tuple })], total_groups: 1 })}
          onSelect={onSelect}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "fireworks \u00b7 priority" }));
      expect(onSelect).toHaveBeenCalledWith(tuple);
    });

    it("shows the child-evidence count on batch summaries", () => {
      render(
        <ServingSummary
          summary={summary({
            state: "partial",
            calls: 10,
            task_runs_with_evidence: 4,
            task_runs_total: 6,
            groups: [group()],
            total_groups: 1,
          })}
        />,
      );
      expect(screen.getByText("4/6 task runs with evidence")).toBeInTheDocument();
    });
  });
});

describe("GenerationServingDetails", () => {
  it("renders nothing when identity and rates are both null", () => {
    const { container } = render(<GenerationServingDetails identity={null} rates={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the reported identity dimensions and hides nothing as zero", () => {
    render(
      <GenerationServingDetails
        identity={identity({
          model: "example-model",
          api_provider: "openrouter",
          serving_host: "baseten",
          route: "nitro",
          service_tier: "priority",
        })}
        rates={null}
      />,
    );
    expect(screen.getByText("openrouter \u00b7 baseten \u00b7 nitro \u00b7 priority")).toBeInTheDocument();
    expect(screen.getByText("example-model")).toBeInTheDocument();
    // Unreported tiers render as em dashes, never as fabricated values.
    const requested = screen.getByText("Requested Tier").nextElementSibling;
    expect(requested).toHaveTextContent("\u2014");
  });

  it("shows TTFT and the streaming-unavailable reason when present", () => {
    const rates: GenerationRates = {
      time_to_first_token_ms: 500,
      whole_call_output_tokens_per_second: null,
      streaming_output_tokens_per_second: null,
      output_token_scope: "all_output",
      streaming_unavailable_reason: "scope_mismatch",
    };
    render(<GenerationServingDetails identity={null} rates={rates} />);
    expect(screen.getByText("500 ms")).toBeInTheDocument();
    expect(screen.getByText("All Output")).toBeInTheDocument();
    expect(screen.getByText("token and timing scopes differ")).toBeInTheDocument();
  });
});
