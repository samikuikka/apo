import { describe, expect, it } from "vitest";

import { formatRelativeFuture, formatRelativePast } from "./schedule-utils";

describe("schedule relative formatting", () => {
  const now = Date.UTC(2026, 5, 23, 12, 0, 0);

  it("formats past timestamps in past tense", () => {
    expect(formatRelativePast("2026-06-23T11:59:30Z", now)).toBe("just now");
    expect(formatRelativePast("2026-06-23T11:52:00Z", now)).toBe("8m ago");
    expect(formatRelativePast("2026-06-23T09:00:00Z", now)).toBe("3h ago");
  });

  it("formats future timestamps in future tense", () => {
    expect(formatRelativeFuture("2026-06-23T12:00:30Z", now)).toBe("in <1m");
    expect(formatRelativeFuture("2026-06-23T12:08:00Z", now)).toBe("in 8m");
    expect(formatRelativeFuture("2026-06-23T15:00:00Z", now)).toBe("in 3h");
  });
});
