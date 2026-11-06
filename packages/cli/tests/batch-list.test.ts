import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/batch-list.ts";
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
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return { errors, restore: () => { console.error = original; } };
}

function makeBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "batch-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "completed",
    total_tasks: 3,
    passed_tasks: 2,
    failed_tasks: 1,
    errored_tasks: 0,
    total_cost: 0.042,
    created_at: "2026-08-14T12:00:00Z",
    started_at: "2026-08-14T12:00:01Z",
    completed_at: "2026-08-14T12:00:09Z",
    ...overrides,
  };
}

describe("batch list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders rows from the backend's paginated {data: [...]} payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse({
          data: [makeBatch()],
          total_count: 1,
          page: 0,
          page_size: 20,
          total_pages: 1,
          model_facets: [],
        }),
      ),
    );
    const { logs, restore } = captureLog();
    try {
      const code = await run([]);
      expect(code).toBe(0);
      const out = stripAnsi(logs.join("\n"));
      expect(out).toContain("batch-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(out).toContain("completed");
    } finally {
      restore();
    }
  });

  it("still accepts a legacy bare-array response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse([makeBatch({ id: "batch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })])),
    );
    const { logs, restore } = captureLog();
    try {
      const code = await run([]);
      expect(code).toBe(0);
      expect(stripAnsi(logs.join("\n"))).toContain("batch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    } finally {
      restore();
    }
  });

  it("prints 'No batch runs found' for an empty page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse({
          data: [],
          total_count: 0,
          page: 0,
          page_size: 20,
          total_pages: 0,
          model_facets: [],
        }),
      ),
    );
    const { logs, restore } = captureLog();
    try {
      const code = await run([]);
      expect(code).toBe(0);
      expect(stripAnsi(logs.join("\n"))).toContain("No batch runs found");
    } finally {
      restore();
    }
  });

  it("exits 2 with the backend error on a denied request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ detail: "You are not a member of this project" }, 403)),
    );
    const { errors, restore } = captureError();
    try {
      const code = await run([]);
      expect(code).toBe(2);
      expect(stripAnsi(errors.join("\n"))).toContain("403");
    } finally {
      restore();
    }
  });

  it("joins repeated --environment with commas and sends each --label as its own param", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({
        data: [],
        total_count: 0,
        page: 0,
        page_size: 20,
        total_pages: 0,
        model_facets: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { restore } = captureLog();
    try {
      const code = await run([
        "--backend", "http://backend.test",
        "--environment", "staging",
        "--environment", "prod",
        "--label", "customer:acme",
        "--label", "customer:globex",
      ]);
      expect(code).toBe(0);
    } finally {
      restore();
    }

    const url = String(fetchMock.mock.calls[0]?.[0]);
    // apiGet builds the query with URLSearchParams: ',' and ':' arrive encoded.
    expect(url).toContain("environment=staging%2Cprod");
    expect(url).toContain("label=customer%3Aacme");
    expect(url).toContain("label=customer%3Aglobex");
  });

  it("exits 2 on a malformed --label before making the request", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { errors, restore } = captureError();
    try {
      const code = await run([
        "--backend", "http://backend.test",
        "--label", "nocolon",
      ]);
      expect(code).toBe(2);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(stripAnsi(errors.join("\n"))).toContain("--label must be <key>:<id>");
    } finally {
      restore();
    }
  });
});
