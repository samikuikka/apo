/**
 * The onboarding journey is a pure function of the server-derived
 * signals: the traces pre-step appears only when traces actually flow,
 * exactly one core step is active, and no step exists whose signal
 * cannot be detected.
 */
import { describe, it, expect } from "vitest";

import {
  buildAgentHandoffPrompt,
  buildOnboardingSteps,
  type OnboardingSignals,
} from "../onboarding-steps";

const virgin: OnboardingSignals = {
  projectId: "abc123def456",
  publicUrl: "https://test-apo.online",
  hasTraces: false,
  traceService: null,
  traceCount: 0,
  cliConnected: false,
  publishedTasks: 0,
  recordedRuns: 0,
};

describe("buildOnboardingSteps", () => {
  it("marks the CLI step active on a virgin project", () => {
    const steps = buildOnboardingSteps(virgin);

    expect(steps.map((s) => s.key)).toEqual(["cli", "publish", "run"]);
    expect(steps[0].state).toBe("active");
    expect(steps.filter((s) => s.state === "active")).toHaveLength(1);
  });

  it("derives done states from the signals, not from stored flags", () => {
    const steps = buildOnboardingSteps({
      ...virgin,
      cliConnected: true,
      publishedTasks: 6,
    });

    expect(steps[0].state).toBe("done");
    expect(steps[0].doneDetail).toBe("project key minted");
    expect(steps[1].state).toBe("done");
    expect(steps[1].doneDetail).toBe("6 tasks published");
    expect(steps[2].state).toBe("active");
  });

  it("adds the traces pre-step only when traces actually flow", () => {
    const steps = buildOnboardingSteps({
      ...virgin,
      hasTraces: true,
      traceService: "billing-api",
      traceCount: 11,
    });

    expect(steps[0]).toMatchObject({
      key: "traces",
      state: "done",
      doneDetail: "billing-api · 11 traces",
    });
    expect(steps).toHaveLength(4);
    expect(steps[1].state).toBe("active");
  });

  it("never invents a step it cannot detect", () => {
    const steps = buildOnboardingSteps(virgin);
    for (const step of steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(["traces", "cli", "publish", "run"]).toContain(step.key);
    }
  });
});

describe("buildAgentHandoffPrompt", () => {
  it("embeds the exact server, project, and login command", () => {
    const prompt = buildAgentHandoffPrompt(virgin);

    expect(prompt).toContain("My apo server: https://test-apo.online");
    expect(prompt).toContain("My project:    abc123def456");
    expect(prompt).toContain(
      "apo login --backend https://test-apo.online --project abc123def456",
    );
    expect(prompt).toContain("/start.md");
    expect(prompt).toContain("Report back");
  });

  it("quotes a shell-hostile project id safely", () => {
    const prompt = buildAgentHandoffPrompt({
      ...virgin,
      projectId: "team & co",
    });

    expect(prompt).toContain("--project 'team & co'");
  });
});
