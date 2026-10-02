import { describe, expect, it } from "vitest";
import {
  formatBatchExecution,
  formatRunExecution,
  shortModel,
} from "../run-configuration";
import type {
  AgentTaskBatchRunConfigurationSummary,
  AgentTaskRunConfiguration,
} from "../agent-task-api";

function cfg(model: string, effort: string | null = null): AgentTaskRunConfiguration {
  return { model, effort };
}

function batchSummary(
  state: "uniform" | "mixed" | "partial" | "unknown",
  overrides: Partial<AgentTaskBatchRunConfigurationSummary> = {},
): AgentTaskBatchRunConfigurationSummary {
  return {
    state,
    configurations: [],
    reported_task_runs: 0,
    total_task_runs: 0,
    ...overrides,
  };
}

describe("formatRunExecution", () => {
  it("renders model · effort for a full configuration", () => {
    expect(formatRunExecution(cfg("gpt-5.6-terra", "high"))).toBe("gpt-5.6-terra · high");
  });

  it("renders the bare model when effort is absent", () => {
    // Most models have no reasoning-effort control; a dangling `· —` read as
    // missing data instead of "no effort configured".
    expect(formatRunExecution(cfg("claude-opus-4.1", null))).toBe("claude-opus-4.1");
    expect(formatRunExecution(cfg("deepseek/deepseek-v4.1-flash", ""))).toBe(
      "deepseek-v4.1-flash",
    );
  });

  it("renders an em dash when no configuration was reported", () => {
    expect(formatRunExecution(null)).toBe("—");
  });

  it("drops the provider prefix for compact display", () => {
    expect(formatRunExecution(cfg("openai/gpt-5.1", "medium"))).toBe("gpt-5.1 · medium");
    expect(formatRunExecution(cfg("anthropic/claude-opus-4.1", null))).toBe(
      "claude-opus-4.1",
    );
    // No prefix → unchanged.
    expect(formatRunExecution(cfg("gpt-5.6-terra", "high"))).toBe("gpt-5.6-terra · high");
  });
});

describe("shortModel", () => {
  it("strips the provider/org prefix", () => {
    expect(shortModel("openai/gpt-5.1")).toBe("gpt-5.1");
    expect(shortModel("anthropic/claude-opus-4.1")).toBe("claude-opus-4.1");
  });
  it("leaves an un-prefixed model unchanged", () => {
    expect(shortModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
  });
});

describe("formatBatchExecution", () => {
  it("renders the single pair for a uniform batch", () => {
    expect(
      formatBatchExecution(
        batchSummary("uniform", {
          configurations: [{ model: "gpt-5.6-terra", effort: "high", task_runs: 3 }],
        }),
      ),
    ).toBe("gpt-5.6-terra · high");
  });

  it("renders the bare model for a uniform batch with no effort", () => {
    expect(
      formatBatchExecution(
        batchSummary("uniform", {
          configurations: [{ model: "claude-opus-4.1", effort: null, task_runs: 2 }],
        }),
      ),
    ).toBe("claude-opus-4.1");
  });

  it("renders Mixed · N configs for a mixed batch", () => {
    expect(
      formatBatchExecution(
        batchSummary("mixed", {
          configurations: [
            { model: "a", effort: "high", task_runs: 1 },
            { model: "b", effort: "low", task_runs: 1 },
            { model: "c", effort: null, task_runs: 1 },
          ],
        }),
      ),
    ).toBe("Mixed · 3 configs");
  });

  it("renders Partial · X/Y reported for a partial batch", () => {
    expect(
      formatBatchExecution(
        batchSummary("partial", { reported_task_runs: 7, total_task_runs: 10 }),
      ),
    ).toBe("Partial · 7/10 reported");
  });

  it("renders an em dash for an unknown batch", () => {
    expect(formatBatchExecution(batchSummary("unknown"))).toBe("—");
  });
});
