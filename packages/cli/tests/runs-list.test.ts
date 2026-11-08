import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/runs-list.ts";
import { stripAnsi } from "../src/lib/format.ts";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  return { logs, restore: () => { console.log = original; } };
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  return { errors, restore: () => { console.error = original; } };
}

const FULL_ID = "0123456789abcdef0123456789abcdef";

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FULL_ID,
    task_id: "code-review",
    batch_run_id: "batch-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "passed",
    pass_result: true,
    started_at: "2026-06-29T10:00:00Z",
    completed_at: "2026-06-29T10:00:03Z",
    total_cost: 0.01,
    total_checks: 2,
    passed_checks: 2,
    failed_checks: 0,
    adapter_name: "demoAdapter",
    ...overrides,
  };
}

describe("runs list command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the Batch column linking each run to its batch", async () => {
    // Regression: the flat runs list must show batch id so agents can group
    // task runs by their parent batch without a separate lookup.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([makeRun({ batch_run_id: "batch-1234567890abcdef" })]),
    );
    const { logs, restore } = captureLog();

    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Batch");
    // batch_run_id is truncated to 8 chars for the table column.
    expect(out).toContain("batch-12");
  });

  it("prints '-' in Started for a run that never started, not the 1970 epoch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([makeRun({ status: "error", pass_result: null, started_at: null })]),
    );
    const { logs, restore } = captureLog();
    await run(["--backend", "http://backend.test"]);
    restore();

    expect(stripAnsi(logs.join("\n"))).not.toContain("1970");
  });

  it("returns exit code 2 when the backend is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Cannot connect to backend");
  });

  it("prints 'No runs found' for an empty list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse([]));
    const { logs, restore } = captureLog();

    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(stripAnsi(logs.join("\n"))).toContain("No runs found");
  });

  it("encodes repeatable --model/--effort as repeated query params", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));
    const { logs, restore } = captureLog();

    await run([
      "--backend",
      "http://backend.test",
      "--model",
      "gpt-5.6-terra",
      "--model",
      "claude-opus-4.1",
      "--effort",
      "high",
    ]);
    restore();

    const url = String(fetchMock.mock.calls[0]?.[0]);
    // Repeatable params become repeated ?model=... entries (OR within dimension).
    expect(url).toContain("model=gpt-5.6-terra");
    expect(url).toContain("model=claude-opus-4.1");
    expect(url).toContain("effort=high");
    expect(logs.join("\n")).toContain("No runs found");
  });

  it("joins repeated --environment with commas and sends each --label as its own param", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));
    const { logs, restore } = captureLog();

    await run([
      "--backend", "http://backend.test",
      "--environment", "staging",
      "--environment", "prod",
      "--label", "customer:acme",
      "--label", "customer:globex",
    ]);
    restore();

    const url = String(fetchMock.mock.calls[0]?.[0]);
    // apiGet builds the query with URLSearchParams: ',' and ':' arrive encoded.
    expect(url).toContain("environment=staging%2Cprod");
    expect(url).toContain("label=customer%3Aacme");
    expect(url).toContain("label=customer%3Aglobex");
    expect(logs.join("\n")).toContain("No runs found");
  });

  it("exits 2 on a malformed --label before making the request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));
    const { errors, restore } = captureError();

    const code = await run([
      "--backend", "http://backend.test",
      "--label", "nocolon",
    ]);
    restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("--label must be <key>:<id>");
  });

  it("renders the Execution column from run_configuration", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([
        makeRun({
          run_configuration: { model: "gpt-5.6-terra", effort: "high" },
        }),
        makeRun({ id: "no-cfg-run-aaaaaaaaaaaaaaaaaaaaaaaa", run_configuration: null }),
      ]),
    );
    const { logs, restore } = captureLog();

    await run(["--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Execution");
    expect(out).toContain("gpt-5.6-terra · high");
    // A run with no configuration shows a dash.
    expect(out).toContain("·");
  });

  it("surfaces generation errors instead of showing an ordinary scored run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([
        makeRun({
          status: "error",
          pass_result: null,
          total_cost: 369_100,
          generation_execution: {
            total: 22,
            errored: 17,
            error_finish_reasons: { error: 17 },
          },
        }),
      ]),
    );
    const { logs, restore } = captureLog();

    await run(["--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Generations");
    expect(out).toContain("17/22 error");
    expect(out).toContain("partial");
    expect(out).not.toContain("FAIL");
  });
});

describe("runs list --limit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies --limit to --json output, not just the table", async () => {
    // Regression: the JSON branch returned before the client-side limit
    // slice, so --limit was silently ignored in machine-readable mode.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse([makeRun(), makeRun({ id: "run-2" }), makeRun({ id: "run-3" })]),
    );
    const { logs, restore } = captureLog();

    const code = await run(["--backend", "http://backend.test", "--limit", "2", "--json"]);

    restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as unknown[];
    expect(parsed).toHaveLength(2);
  });
});

// Observed-serving filters and the Serving column (issue #307): repeated
// values OR within a dimension, dimensions AND on one request.
describe("runs list serving filters and column (issue #307)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encodes the serving filters as repeated query params", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));
    const { logs, restore } = captureLog();

    await run([
      "--backend", "http://backend.test",
      "--observed-model", "glm-4.7",
      "--observed-model", "kimi-k2.5",
      "--provider", "openrouter",
      "--host", "baseten",
      "--route", "nitro",
      "--service-tier", "priority",
      "--serving-unknown", "host",
      "--serving-mode", "only",
    ]);
    restore();

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("observed_model=glm-4.7");
    expect(url).toContain("observed_model=kimi-k2.5");
    expect(url).toContain("provider=openrouter");
    expect(url).toContain("host=baseten");
    expect(url).toContain("route=nitro");
    expect(url).toContain("service_tier=priority");
    expect(url).toContain("serving_unknown=host");
    expect(url).toContain("serving_mode=only");
    expect(logs.join("\n")).toContain("No runs found");
  });

  it("splits a comma-joined --serving-unknown into repeated params", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));
    await run([
      "--backend", "http://backend.test",
      "--serving-unknown", "model,host",
    ]);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("serving_unknown=model");
    expect(url).toContain("serving_unknown=host");
  });

  it("exits 2 on an invalid --serving-unknown before making the request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test", "--serving-unknown", "tier"]);
    restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("--serving-unknown must be one of model, provider, host, route, service_tier");
  });

  it("exits 2 on an invalid --serving-mode before making the request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test", "--serving-mode", "exclusive"]);
    restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("--serving-mode must be contains or only");
  });

  it("renders the Serving column: identity for uniform, mixed count, dash when absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([
        makeRun({
          serving: {
            state: "uniform",
            calls: 4,
            errored_calls: 0,
            unknown_provider_calls: 0,
            unknown_host_calls: 0,
            aggregate_observations: 0,
            groups: [
              {
                identity: {
                  model: "glm-4.7",
                  api_provider: "fireworks",
                  serving_host: null,
                  route: null,
                  service_tier: "priority",
                },
                calls: 4,
                errored_calls: 0,
                whole_call_rate: { median: 120, samples: 4 },
                streaming_rate: { median: null, samples: 0 },
                rate_scopes: [],
              },
            ],
            total_groups: 1,
            groups_truncated: false,
            task_runs_with_evidence: 1,
            task_runs_total: 1,
            cost_coverage: {
              reported: null,
              qualified_estimate: null,
              model_only_estimate: null,
              unpriced_calls: 0,
              ambiguous_calls: 0,
              excluded_error_calls: 0,
              aggregate_charge_observations: 0,
              partial: false,
            },
          },
        }),
        makeRun({
          id: "mixed-run-00000000000000000000000a",
          serving: {
            state: "mixed",
            calls: 9,
            errored_calls: 0,
            unknown_provider_calls: 0,
            unknown_host_calls: 0,
            aggregate_observations: 0,
            groups: [],
            total_groups: 3,
            groups_truncated: false,
            task_runs_with_evidence: 1,
            task_runs_total: 1,
            cost_coverage: {
              reported: null,
              qualified_estimate: null,
              model_only_estimate: null,
              unpriced_calls: 0,
              ambiguous_calls: 0,
              excluded_error_calls: 0,
              aggregate_charge_observations: 0,
              partial: false,
            },
          },
        }),
        makeRun({ id: "legacy-run-0000000000000000000000b", serving: null }),
      ]),
    );
    const { logs, restore } = captureLog();

    await run(["--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Serving");
    expect(out).toContain("fireworks · priority");
    expect(out).toContain("mixed · 3");
  });

  it("omits the Serving column when no run carries serving data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse([makeRun()]));
    const { logs, restore } = captureLog();

    await run(["--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).not.toContain("Serving");
  });

  it("passes the serving objects through untouched in --json", async () => {
    const serving = {
      state: "partial",
      calls: 2,
      errored_calls: 0,
      unknown_provider_calls: 1,
      unknown_host_calls: 2,
      aggregate_observations: 0,
      groups: [],
      total_groups: 0,
      groups_truncated: false,
      task_runs_with_evidence: 1,
      task_runs_total: 1,
      cost_coverage: {
        reported: 1000,
        qualified_estimate: null,
        model_only_estimate: null,
        unpriced_calls: 1,
        ambiguous_calls: 0,
        excluded_error_calls: 0,
        aggregate_charge_observations: 0,
        partial: true,
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([makeRun({ serving })]),
    );
    const { logs, restore } = captureLog();

    const code = await run(["--backend", "http://backend.test", "--json"]);
    restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as { serving?: unknown }[];
    expect(parsed[0]?.serving).toEqual(serving);
  });

  it("surfaces a backend 422 (malformed filter) as an error with exit 2", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ detail: "invalid serving filter" }, 422),
    );
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test", "--host", "baseten"]);
    restore();

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Backend error 422");
  });
});
