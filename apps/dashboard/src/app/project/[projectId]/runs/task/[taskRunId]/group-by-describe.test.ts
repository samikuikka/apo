import { describe as suite, it, expect } from "vitest";

import { groupChecksByDescribe, groupVerdict, groupCost } from "./group-by-describe";
import type { CheckResult } from "@/lib/agent-task-api";

function check(overrides: Partial<CheckResult> & { id: string }): CheckResult {
  return { pass: true, reasoning: "", ...overrides };
}

function judgedCheck(id: string, cost: number, pass = true): CheckResult {
  return check({
    id,
    pass,
    reasoning: "",
    assertions: [
      { id: `${id}-a`, pass, reasoning: "", judge: { cost, model: "gpt-4o" } },
    ],
  });
}

suite("groupChecksByDescribe", () => {
  it("returns no segments for an empty list", () => {
    expect(groupChecksByDescribe([])).toEqual([]);
  });

  it("emits a check segment per ungrouped check, in order", () => {
    const checks = [check({ id: "a" }), check({ id: "b" })];
    const segments = groupChecksByDescribe(checks);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: "check", check: { id: "a" } });
    expect(segments[1]).toMatchObject({ kind: "check", check: { id: "b" } });
  });

  it("groups all checks under one group segment", () => {
    const checks = [
      check({ id: "R-0", group_id: "rules", group_name: "Rules" }),
      check({ id: "R-1", group_id: "rules", group_name: "Rules" }),
    ];
    const segments = groupChecksByDescribe(checks);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "group",
      groupId: "rules",
      groupName: "Rules",
    });
    expect(segments[0]!.kind).toBe("group");
    expect((segments[0] as { checks: CheckResult[] }).checks.map((c) => c.id)).toEqual([
      "R-0",
      "R-1",
    ]);
  });

  it("preserves declaration order across mixed grouped and ungrouped checks", () => {
    const checks = [
      check({ id: "bare-1" }),
      check({ id: "R-0", group_id: "rules", group_name: "Rules" }),
      check({ id: "R-1", group_id: "rules", group_name: "Rules" }),
      check({ id: "bare-2" }),
    ];
    const segments = groupChecksByDescribe(checks);
    expect(segments.map((s) => s.kind)).toEqual(["check", "group", "check"]);
    expect(segments[1]!.kind).toBe("group");
  });

  it("opens sibling groups at their first member's position", () => {
    const checks = [
      check({ id: "R-0", group_id: "rules", group_name: "Rules" }),
      check({ id: "R-1", group_id: "rules", group_name: "Rules" }),
      check({ id: "S-0", group_id: "safety", group_name: "Safety" }),
      check({ id: "S-1", group_id: "safety", group_name: "Safety" }),
    ];
    const segments = groupChecksByDescribe(checks);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: "group", groupId: "rules" });
    expect(segments[1]).toMatchObject({ kind: "group", groupId: "safety" });
  });

  it("defaults groupName to groupId when group_name is absent", () => {
    const checks = [check({ id: "R-0", group_id: "rules" })];
    const segments = groupChecksByDescribe(checks);
    expect(segments[0]).toMatchObject({ kind: "group", groupId: "rules", groupName: "rules" });
  });
});

suite("groupVerdict", () => {
  it("counts passed/failed/total", () => {
    const checks = [
      check({ id: "a", pass: true }),
      check({ id: "b", pass: false }),
      check({ id: "c", pass: true }),
    ];
    expect(groupVerdict(checks)).toEqual({ passed: 2, failed: 1, total: 3 });
  });
});

suite("groupCost", () => {
  it("sums judge costs across all assertions in the group", () => {
    const checks = [judgedCheck("a", 0.1), judgedCheck("b", 0.05), check({ id: "c" })];
    expect(groupCost(checks)).toBeCloseTo(0.15, 10);
  });

  it("returns 0 when no checks have judge metadata", () => {
    expect(groupCost([check({ id: "a" })])).toBe(0);
  });

  it("does not double-count the top-level check.judge when assertions exist", () => {
    const c: CheckResult = {
      id: "a",
      pass: true,
      reasoning: "",
      judge: { cost: 0.2, model: "gpt-4o" },
      assertions: [{ id: "a-a", pass: true, reasoning: "", judge: { cost: 0.1, model: "gpt-4o" } }],
    };
    // assertions present → only the assertion's cost counts (0.1), not check.judge (0.2).
    expect(groupCost([c])).toBeCloseTo(0.1, 10);
  });

  it("falls back to check.judge.cost when assertions are absent", () => {
    const c: CheckResult = {
      id: "a",
      pass: true,
      reasoning: "",
      judge: { cost: 0.2, model: "gpt-4o" },
    };
    expect(groupCost([c])).toBeCloseTo(0.2, 10);
  });
});
