import { describe, it, expect } from "vitest";

import { ApiError, isApiError, isForbidden, isNotFoundStatus } from "@/lib/api-error";

describe("ApiError", () => {
  it("carries the status code separately from the message", () => {
    const err = new ApiError(403, "You are not a member of this project");
    expect(err.status).toBe(403);
    expect(err.message).toBe("You are not a member of this project");
    expect(err.name).toBe("ApiError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("classifiers", () => {
  it("recognizes an ApiError", () => {
    expect(isApiError(new ApiError(500, "boom"))).toBe(true);
  });

  it("rejects plain Errors and non-errors", () => {
    expect(isApiError(new Error("plain"))).toBe(false);
    expect(isApiError({ status: 403 })).toBe(false);
    expect(isApiError(null)).toBe(false);
  });

  it("treats only 403 as forbidden", () => {
    expect(isForbidden(new ApiError(403, "nope"))).toBe(true);
    expect(isForbidden(new ApiError(404, "missing"))).toBe(false);
    expect(isForbidden(new Error("Error: 403 Forbidden"))).toBe(false);
  });

  it("treats only 404 as not found", () => {
    expect(isNotFoundStatus(new ApiError(404, "missing"))).toBe(true);
    expect(isNotFoundStatus(new ApiError(403, "nope"))).toBe(false);
    expect(isNotFoundStatus(new Error("Error: 404"))).toBe(false);
  });
});
