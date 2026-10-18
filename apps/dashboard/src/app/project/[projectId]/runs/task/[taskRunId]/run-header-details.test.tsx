/**
 * The run header keeps a quiet line (path, model, trigger, when) and moves
 * the rest behind a Details disclosure. These tests pin the two halves of
 * that contract: reference facts are invisible until opened, and the
 * card's conditional rows only exist when the run actually reported them.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  RunHeaderMetadata,
  type RunHeaderFacts,
} from "./run-header-details";

function baseFacts(overrides: Partial<RunHeaderFacts> = {}): RunHeaderFacts {
  return {
    taskPathFull: "folder/ai-sdk-agent/data-extraction",
    taskPathTail: "ai-sdk-agent/data-extraction",
    adapterName: "ai-sdk-agent",
    model: "deepseek/deepseek-v4.1-flash",
    effort: "medium",
    observedModel: null,
    hosts: [{ label: "openai.chat", calls: 5 }],
    trigger: { source: "cli", actor: null, hostname: null, user_agent: null, entrypoint: null, initiated_at: null, ci_system: null, ci_run_id: null, ci_run_url: null, repository: null, branch: null, commit_sha: null, pr_number: null, schedule_id: null, schedule_name: null },
    batchRunId: "bch_3e444461acc34422708ae409",
    batchHref: "/project/p1/runs/bch_3e444461acc34422708ae409",
    startedAt: "2026-10-01T17:09:41.790657Z",
    ...overrides,
  };
}

describe("RunHeaderMetadata", () => {
  it("shows the quiet line but keeps reference facts behind Details", async () => {
    const user = userEvent.setup();
    render(<RunHeaderMetadata facts={baseFacts()} />);

    // Headline facts are visible without opening anything.
    expect(screen.getByText("ai-sdk-agent/data-extraction")).toBeInTheDocument();
    expect(screen.getByText("deepseek/deepseek-v4.1-flash")).toBeInTheDocument();
    expect(screen.getByText("cli")).toBeInTheDocument();

    // Reference material is not on the page until the disclosure opens.
    expect(screen.queryByText("bch_3e444461acc34422708ae409")).not.toBeInTheDocument();
    expect(screen.queryByText("folder/ai-sdk-agent/data-extraction")).not.toBeInTheDocument();
    expect(screen.queryByText("openai.chat")).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /details/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("folder/ai-sdk-agent/data-extraction")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();
    expect(screen.getByText(/adapter-reported/)).toBeInTheDocument();
    expect(screen.getByText(/openai.chat/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "bch_3e444461acc34422708ae409" }),
    ).toHaveAttribute("href", "/project/p1/runs/bch_3e444461acc34422708ae409");
  });

  it("renders only rows the run actually reported", async () => {
    const user = userEvent.setup();
    render(
      <RunHeaderMetadata
        facts={baseFacts({
          adapterName: null,
          effort: null,
          hosts: [],
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /details/i }));

    expect(screen.getByText("not reported")).toBeInTheDocument();
    expect(screen.queryByText("Adapter")).not.toBeInTheDocument();
    expect(screen.queryByText("Hosts")).not.toBeInTheDocument();
    expect(screen.queryByText("Observed")).not.toBeInTheDocument();
  });

  it("drops the model from the line and the Model group when unconfigured", () => {
    render(
      <RunHeaderMetadata
        facts={baseFacts({
          model: null,
          effort: null,
          observedModel: null,
          trigger: null,
        })}
      />,
    );

    expect(screen.queryByText("deepseek/deepseek-v4.1-flash")).not.toBeInTheDocument();
    // Model group caption never renders without configured-model facts.
    expect(screen.queryByRole("heading", { name: "Model" })).not.toBeInTheDocument();
    // No trigger on the run — the line falls back to "batch".
    expect(screen.getByText("batch")).toBeInTheDocument();
  });
});
