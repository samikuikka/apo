import { describe, expect, it } from "vitest";

import { detailTitle, taskName, traceTitle } from "../page-title";

describe("taskName", () => {
  it("keeps the last segment of a hierarchical id", () => {
    expect(taskName("drafting/nda/redline-basic")).toBe("redline-basic");
    expect(taskName("redline-basic")).toBe("redline-basic");
  });

  it("falls back to the whole id when it ends in a slash", () => {
    expect(taskName("drafting/")).toBe("drafting/");
  });
});

describe("detailTitle", () => {
  it("puts the name before the kind", () => {
    expect(detailTitle("Nightly", "Schedule")).toBe("Nightly · Schedule");
  });

  it("is just the kind when the name is missing or blank", () => {
    expect(detailTitle(null, "Task")).toBe("Task");
    expect(detailTitle("  ", "Task")).toBe("Task");
  });
});

describe("traceTitle", () => {
  const id = "69cdf0793a1b2c3d";

  it("names an agent task trace after its task", () => {
    expect(
      traceTitle({ id, task_id: "drafting/redline-basic", scopeKey: "drafting/redline-basic" }),
    ).toBe("redline-basic · Trace");
  });

  it("keeps a trace name that differs from the task id", () => {
    expect(traceTitle({ id, task_id: "drafting/redline-basic", scopeKey: "chat turn" })).toBe(
      "chat turn · Trace",
    );
  });

  it("uses the task when the trace has no name", () => {
    expect(traceTitle({ id, task_id: "drafting/redline-basic", scopeKey: null })).toBe(
      "redline-basic · Trace",
    );
  });

  it("falls back to a short id only when there is no name at all", () => {
    expect(traceTitle({ id, task_id: "", scopeKey: null })).toBe("Trace 69cdf079");
  });
});
