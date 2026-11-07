import { describe, expect, it } from "vitest";
import {
  BATCH_LIVE_STATUSES,
  RUN_LIVE_STATUSES,
  RUN_TERMINAL_STATUSES,
  VERDICT_TERMINAL_STATUSES,
  isBatchLive,
  isRunLive,
  isRunTerminal,
  isVerdictTerminal,
  localVerdictStatus,
  verdictExitCode,
} from "../src/lib/run-status.ts";

describe("RUN_LIVE_STATUSES", () => {
  it("holds pending and running", () => {
    expect(RUN_LIVE_STATUSES.has("pending")).toBe(true);
    expect(RUN_LIVE_STATUSES.has("running")).toBe(true);
  });

  it("excludes terminal and unknown statuses", () => {
    for (const status of ["passed", "failed", "error", "completed", "", "lost"]) {
      expect(RUN_LIVE_STATUSES.has(status)).toBe(false);
    }
  });
});

describe("BATCH_LIVE_STATUSES", () => {
  it("holds queued and running", () => {
    expect(BATCH_LIVE_STATUSES.has("queued")).toBe(true);
    expect(BATCH_LIVE_STATUSES.has("running")).toBe(true);
  });

  it("excludes terminal and unknown statuses", () => {
    for (const status of ["completed", "error", "pending", "passed", ""]) {
      expect(BATCH_LIVE_STATUSES.has(status)).toBe(false);
    }
  });
});

describe("VERDICT_TERMINAL_STATUSES", () => {
  it("holds passed and failed only", () => {
    expect([...VERDICT_TERMINAL_STATUSES].sort()).toEqual(["failed", "passed"]);
    expect(VERDICT_TERMINAL_STATUSES.has("error")).toBe(false);
    expect(VERDICT_TERMINAL_STATUSES.has("pending")).toBe(false);
  });
});

describe("RUN_TERMINAL_STATUSES", () => {
  it("holds every status a run ends in", () => {
    expect([...RUN_TERMINAL_STATUSES].sort()).toEqual(["error", "failed", "passed"]);
    expect(RUN_TERMINAL_STATUSES.has("pending")).toBe(false);
    expect(RUN_TERMINAL_STATUSES.has("running")).toBe(false);
  });
});

describe("liveness predicates", () => {
  it("isRunLive matches the run live set", () => {
    expect(isRunLive("pending")).toBe(true);
    expect(isRunLive("running")).toBe(true);
    expect(isRunLive("passed")).toBe(false);
  });

  it("isBatchLive matches the batch live set", () => {
    expect(isBatchLive("queued")).toBe(true);
    expect(isBatchLive("running")).toBe(true);
    expect(isBatchLive("completed")).toBe(false);
  });
});

describe("terminality predicates", () => {
  it("isVerdictTerminal accepts passed and failed, not error", () => {
    expect(isVerdictTerminal("passed")).toBe(true);
    expect(isVerdictTerminal("failed")).toBe(true);
    expect(isVerdictTerminal("error")).toBe(false);
    expect(isVerdictTerminal("running")).toBe(false);
  });

  it("isRunTerminal accepts passed, failed, and error", () => {
    expect(isRunTerminal("passed")).toBe(true);
    expect(isRunTerminal("failed")).toBe(true);
    expect(isRunTerminal("error")).toBe(true);
    expect(isRunTerminal("pending")).toBe(false);
    expect(isRunTerminal("running")).toBe(false);
  });
});

describe("verdictExitCode", () => {
  it("maps passed to 0", () => {
    expect(verdictExitCode("passed")).toBe(0);
  });

  it("maps failed to 1", () => {
    expect(verdictExitCode("failed")).toBe(1);
  });

  it("maps error to 2", () => {
    expect(verdictExitCode("error")).toBe(2);
  });

  it("maps anything else (no verdict) to 2", () => {
    expect(verdictExitCode("")).toBe(2);
    expect(verdictExitCode("running")).toBe(2);
    expect(verdictExitCode("nonsense")).toBe(2);
  });
});

describe("localVerdictStatus", () => {
  it("maps a plain pass to passed", () => {
    expect(localVerdictStatus(true, false)).toBe("passed");
  });

  it("maps a plain fail to failed", () => {
    expect(localVerdictStatus(false, false)).toBe("failed");
  });

  it("maps a no-verdict to error", () => {
    expect(localVerdictStatus(false, true)).toBe("error");
  });

  it("lets a no-verdict outrank a pass, so the exit code stays 2", () => {
    expect(localVerdictStatus(true, true)).toBe("error");
    expect(verdictExitCode(localVerdictStatus(true, true))).toBe(2);
  });
});
