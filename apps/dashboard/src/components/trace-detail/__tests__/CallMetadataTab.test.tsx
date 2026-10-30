import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CallMetadataTab } from "../CallMetadataTab";
import type { LoggedCall } from "../contexts/TraceDataContext";

function call(overrides: Partial<LoggedCall>): LoggedCall {
  return {
    id: "3614930b53dda67a",
    step_index: null,
    step_name: "generate",
    model: "claude-opus-5-5",
    created_at: "2026-10-30T10:31:20.000Z",
    input: null,
    output: null,
    task_id: null,
    ...overrides,
  } as LoggedCall;
}

describe("CallMetadataTab tokens", () => {
  it("names the cached share of the call's input, with the full split on hover", () => {
    render(
      <CallMetadataTab
        run={null}
        call={call({
          prompt_tokens: 47_740,
          completion_tokens: 2_467,
          total_tokens: 50_207,
          raw_usage: { input: 2, cache_read: 25_729, cache_write_5m: 22_009, cache_write_1h: 0 },
        })}
      />,
    );

    const tokens = screen.getByText("47.7k (25.7k cached)→2.5k tok");
    expect(tokens.getAttribute("title")).toBe(
      "Input 47.7k: 25.7k read from cache, 22.0k written to cache, 2 uncached",
    );
  });
});
