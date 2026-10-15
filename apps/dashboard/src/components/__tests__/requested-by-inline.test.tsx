/**
 * The run and batch headers name who asked for the run, from the backend's
 * server-resolved requester; older rows without one render nothing.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RequestedByInline, TriggerInline } from "../trigger-badge";

describe("RequestedByInline", () => {
  it("names the requester", () => {
    render(<RequestedByInline label="runner@test.com" />);
    expect(screen.getByText("Requested by").parentElement?.textContent).toBe(
      "Requested by runner@test.com",
    );
  });

  it("renders nothing without a requester", () => {
    const { container } = render(<RequestedByInline label={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("TriggerInline actor labelling", () => {
  it("labels the free-text actor so it cannot pass for the verified line", () => {
    // A caller-chosen --actor that mimics the "Requested by" wording must
    // still read as unverified free text next to RequestedByInline.
    render(
      <TriggerInline
        trigger={{
          source: "cli",
          actor: "Requested by: ceo@corp",
          hostname: null,
          user_agent: null,
          entrypoint: null,
          initiated_at: null,
          ci_system: null,
          ci_run_id: null,
          ci_run_url: null,
          repository: null,
          branch: null,
          commit_sha: null,
          pr_number: null,
          schedule_id: null,
          schedule_name: null,
        }}
      />,
    );
    expect(screen.getByText("cli · actor: Requested by: ceo@corp")).toBeInTheDocument();
  });
});
