/**
 * Scene tests: the run notices strip (issue #410).
 *
 * 1. Corrections and drift render as chips; detail expands inline on click
 *    (check id, verdict transition, actor, reason quote; per-model drift
 *    rows with cost).
 * 2. Drift loudness tiers: a small same-family fallback is a quiet gray
 *    chip, a material fraction or a different model is amber.
 * 3. No notices → no strip.
 */

import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ModelDriftSummary } from "@/lib/agent-task-api";
import { RunNotices } from "./run-notices";
import { driftSeverity, type CorrectedCheckNotice } from "./run-notices-model";

function correctedNotice(overrides: Partial<CorrectedCheckNotice> = {}): CorrectedCheckNotice {
  return {
    id: "report-is-complete",
    recordedPass: false,
    effectivePass: true,
    reason: "Retention is present in the KPI table",
    byLabel: "u1@test.com",
    via: "api_key",
    createdAt: "2026-08-25T12:00:00Z",
    ...overrides,
  };
}

function drift(overrides: Partial<ModelDriftSummary> = {}): ModelDriftSummary {
  return {
    configured_model: "deepseek/deepseek-v4.1-flash",
    total_agent_generations: 64,
    pairs: [
      {
        model: "deepseek/deepseek-v4.1-flash-modal",
        provider: "litellm",
        route: "litellm-fallback",
        calls: 5,
        total_tokens: 921_600,
        cost_micro: 180_000,
      },
    ],
    ...overrides,
  };
}

function chipByName(name: RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("RunNotices", () => {
  it("renders chips and expands corrections + drift detail inline", () => {
    render(<RunNotices correctedChecks={[correctedNotice()]} drift={drift()} />);

    const correctedChip = chipByName(/1 check corrected/i);
    const driftChip = chipByName(/model drift — 5\/64 gens/i);
    expect(correctedChip).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(correctedChip);
    expect(screen.getByText("report-is-complete")).toBeInTheDocument();
    expect(screen.getByText(/FAIL/)).toBeInTheDocument();
    expect(screen.getByText(/u1@test.com via api key/)).toBeInTheDocument();
    expect(screen.getByText(/Retention is present in the KPI table/)).toBeInTheDocument();
    expect(
      screen.getByText(/Recorded evidence is unchanged/i),
    ).toBeInTheDocument();

    fireEvent.click(driftChip);
    expect(
      screen.getByText(/served by a model other than/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/deepseek-v4.1-flash-modal/)).toBeInTheDocument();
    expect(screen.getByText(/×5/)).toBeInTheDocument();
    // switching disclosures is exclusive: corrections close again
    expect(correctedChip).toHaveAttribute("aria-expanded", "false");
    expect(driftChip).toHaveAttribute("aria-expanded", "true");
  });

  it("tones material drift amber and small same-family drift gray", () => {
    const small: ModelDriftSummary = {
      configured_model: "deepseek/deepseek-v4.1-flash",
      total_agent_generations: 42,
      pairs: [{ ...drift().pairs[0]!, calls: 1, cost_micro: 41_300 }],
    };
    expect(driftSeverity(small)).toBe("quiet");
    expect(driftSeverity(drift())).toBe("loud"); // 5/64 crosses the fraction bar

    const { unmount } = render(<RunNotices correctedChecks={[]} drift={small} />);
    expect(chipByName(/model drift — 1\/42 gens/i).className).toContain("muted");
    unmount();

    render(<RunNotices correctedChecks={[]} drift={drift()} />);
    expect(chipByName(/model drift — 5\/64 gens/i).className).toContain("warning");
  });

  it("flags a fallback to a different model family as loud regardless of size", () => {
    const pricier: ModelDriftSummary = {
      configured_model: "deepseek/deepseek-v4.1-flash",
      total_agent_generations: 42,
      pairs: [
        {
          model: "anthropic/claude-opus-4.6",
          provider: "litellm",
          route: null,
          calls: 1,
          total_tokens: null,
          cost_micro: null,
        },
      ],
    };
    expect(driftSeverity(pricier)).toBe("loud");
  });

  it("flags a suffixed variant model as loud — only known host suffixes are quiet", () => {
    // -lite is a materially weaker model, not the configured model on
    // another host; a prefix match would quietly excuse it.
    const lite: ModelDriftSummary = {
      configured_model: "deepseek/deepseek-v4.1-flash",
      total_agent_generations: 42,
      pairs: [
        {
          model: "deepseek/deepseek-v4.1-flash-lite",
          provider: null,
          route: null,
          calls: 1,
          total_tokens: null,
          cost_micro: null,
        },
      ],
    };
    expect(driftSeverity(lite)).toBe("loud");
  });

  it("renders nothing when the run has no notices", () => {
    const { container } = render(<RunNotices correctedChecks={[]} drift={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
