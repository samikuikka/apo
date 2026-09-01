import { describe, expect, it, vi, beforeEach } from "vitest";

// `apo traces list` maps span-search flags onto GET /v1/runs
// params, compiling --attr expressions into the span_filter JSON array.

const getMock = vi.fn();

vi.mock("../src/lib/api.ts", () => ({
  apiGet: (...args: unknown[]) => getMock(...args),
}));

vi.mock("../src/lib/config.ts", () => ({
  resolveConfig: () => ({
    backendUrl: "http://localhost:8000",
    projectId: "p1",
    json: false,
  }),
}));

vi.mock("../src/lib/prefix.ts", () => ({
  highlightIds: (ids: string[]) => ids,
}));

const { run } = await import("../src/commands/traces-list.ts");

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue({ data: [], total_count: 0, page: 0, page_size: 20 });
});

describe("traces list span search", () => {
  it("passes service, operation, and span-text params", async () => {
    const code = await run([
      "--service", "billing-api",
      "--operation", "psql.query",
      "--span-text", "timeout",
    ]);
    expect(code).toBe(0);
    const [, path, params] = getMock.mock.calls[0];
    expect(path).toBe("/v1/runs");
    expect(params.service).toBe("billing-api");
    expect(params.operation).toBe("psql.query");
    expect(params.span_text).toBe("timeout");
  });

  it("compiles --attr forms into span_filter predicates", async () => {
    await run([
      "--attr", "customer.tier=enterprise",
      "--attr", "customer.tier in enterprise,pro",
      "--attr", "http.response.status_code>=500",
      "--attr", "db.statement~=invoices",
      "--attr", "feature.flag?",
      "--attr", "http.route!=/health",
    ]);
    const [, , params] = getMock.mock.calls[0];
    const preds = JSON.parse(params.span_filter);
    expect(preds).toEqual([
      { field: "attribute:customer.tier", op: "eq", value: "enterprise" },
      { field: "attribute:customer.tier", op: "in", value: ["enterprise", "pro"] },
      { field: "attribute:http.response.status_code", op: "gte", value: 500 },
      { field: "attribute:db.statement", op: "contains", value: "invoices" },
      { field: "attribute:feature.flag", op: "exists" },
      { field: "attribute:http.route", op: "neq", value: "/health" },
    ]);
  });

  it("drops malformed --attr values with an error line", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["--attr", "no-separator"]);
    expect(code).toBe(0); // still lists; the bad predicate is skipped
    expect(errorSpy).toHaveBeenCalled();
    const [, , params] = getMock.mock.calls[0];
    expect(params.span_filter).toBeUndefined();
    errorSpy.mockRestore();
  });
});
