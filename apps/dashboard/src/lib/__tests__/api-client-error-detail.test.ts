/**
 * Error-detail parsing: structured FastAPI refusals must reach callers as a
 * readable message plus the raw `{kind, msg}` object on `ApiError.detail`,
 * so kind-branching callers never match message substrings.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api-client";
import { ApiError, errorDetailKind, isApiError } from "../api-error";

async function failingCall(status: number, body: string, statusText = "") {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(body, { status, statusText }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return apiClient("/v1/x").catch((error: unknown) => error);
}

describe("apiClient error detail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads {kind, msg} details as the message and exposes the kind", async () => {
    const error = (await failingCall(
      409,
      JSON.stringify({
        detail: { kind: "execution_owner_unavailable", msg: "schedule is hard-paused" },
      }),
    )) as unknown;

    expect(isApiError(error)).toBe(true);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.message).toBe("schedule is hard-paused");
    expect(apiError.detail).toEqual({
      kind: "execution_owner_unavailable",
      msg: "schedule is hard-paused",
    });
    expect(errorDetailKind(apiError)).toBe("execution_owner_unavailable");
  });

  it("keeps plain-string details as the message", async () => {
    const error = (await failingCall(
      409,
      JSON.stringify({ detail: "pool or selection conflict" }),
    )) as unknown;

    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).message).toBe("pool or selection conflict");
    expect((error as ApiError).detail).toBe("pool or selection conflict");
    expect(errorDetailKind(error)).toBeNull();
  });

  it("returns the raw text for non-JSON bodies with no detail", async () => {
    const error = (await failingCall(502, "Bad Gateway")) as unknown;

    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).message).toBe("Bad Gateway");
    expect((error as ApiError).detail).toBeUndefined();
  });
});
