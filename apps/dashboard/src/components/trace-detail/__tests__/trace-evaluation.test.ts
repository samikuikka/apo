import { describe, expect, it } from "vitest";
import type { TraceObservation } from "../contexts";
import {
  findEvaluationGroup,
  isEvaluationRoot,
  judgmentFacts,
  parseVerdict,
  partitionEvaluation,
  type PartitionableRow,
} from "../trace-evaluation";

function call(id: string, name: string, parent: string | null = null): TraceObservation {
  return {
    id,
    step_name: name,
    parent_call_id: parent,
  } as TraceObservation;
}

function row(id: string, name: string, parent: string | null = null): PartitionableRow {
  return { node: { id, call: call(id, name, parent) } };
}

describe("isEvaluationRoot", () => {
  it("matches judge and t.agent prefixes only", () => {
    expect(isEvaluationRoot("judge:summary-reads-well")).toBe(true);
    expect(isEvaluationRoot("t.agent:figures-supported-by-work")).toBe(true);
    expect(isEvaluationRoot("agent.generate")).toBe(false);
    expect(isEvaluationRoot("")).toBe(false);
  });
});

describe("findEvaluationGroup", () => {
  it("returns null when the trace has no judges", () => {
    const calls = [call("a", "task.turn"), call("b", "agent.generate", "a")];
    expect(findEvaluationGroup(calls)).toBeNull();
  });

  it("collects roots and their descendants transitively", () => {
    const group = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("gen", "agent.generate", "run"),
      call("j1", "judge:reads-well", "run"),
      call("ag", "t.agent:figures", "run"),
      call("t1", "tool read", "ag"),
      call("t2", "tool search", "t1"),
    ]);
    expect(group).not.toBeNull();
    expect(group!.roots.map((c) => c.id)).toEqual(["j1", "ag"]);
    expect([...group!.memberIds].sort()).toEqual(["ag", "j1", "t1", "t2"]);
  });

  it("does not absorb unrelated calls sharing a parent with a judge", () => {
    const group = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("gen", "agent.generate", "run"),
      call("j1", "judge:reads-well", "run"),
    ]);
    expect(group!.memberIds.has("gen")).toBe(false);
    expect(group!.memberIds.has("j1")).toBe(true);
  });
});

describe("parseVerdict", () => {
  it("reads pass from the tool_result object", () => {
    expect(parseVerdict({ reasoning: "ok", pass: true })).toBe(true);
    expect(parseVerdict({ reasoning: "no", pass: false })).toBe(false);
  });

  it("parses a JSON-string tool_result", () => {
    expect(parseVerdict('{"pass": true}')).toBe(true);
  });

  it("returns undefined for missing or malformed verdicts", () => {
    expect(parseVerdict({ reasoning: "no flag" })).toBeUndefined();
    expect(parseVerdict("not json")).toBeUndefined();
    expect(parseVerdict(null)).toBeUndefined();
    expect(parseVerdict(undefined)).toBeUndefined();
    expect(parseVerdict({ pass: "yes" })).toBeUndefined();
  });
});

describe("partitionEvaluation", () => {
  const group = findEvaluationGroup([
    call("run", "apo.task.run"),
    call("load", "task.load", "run"),
    call("j1", "judge:reads-well", "run"),
    call("ag", "t.agent:figures", "run"),
    call("t1", "tool read", "ag"),
  ])!;

  it("returns null when no member rows are present", () => {
    expect(partitionEvaluation([row("run", "apo.task.run")], group)).toBeNull();
  });

  it("places the group at the first judge's position (judges last)", () => {
    const rows = [row("run", "apo.task.run"), row("load", "task.load", "run"), row("j1", "judge:reads-well", "run"), row("ag", "t.agent:figures", "run"), row("t1", "tool read", "ag")];
    const split = partitionEvaluation(rows, group)!;
    expect(split.kept.map((r) => r.node.id)).toEqual(["run", "load"]);
    expect(split.insertAt).toBe(2);
  });

  it("keeps order when judges sit mid-tree", () => {
    const rows = [row("run", "apo.task.run"), row("j1", "judge:reads-well", "run"), row("load", "task.load", "run")];
    const split = partitionEvaluation(rows, group)!;
    expect(split.kept.map((r) => r.node.id)).toEqual(["run", "load"]);
    expect(split.insertAt).toBe(1);
  });

  it("handles rows without a call (the synthetic run header)", () => {
    const rows: PartitionableRow[] = [
      { node: { id: "root-run", call: null } },
      row("j1", "judge:reads-well", "run"),
    ];
    const split = partitionEvaluation(rows, group)!;
    expect(split.kept.map((r) => r.node.id)).toEqual(["root-run"]);
    expect(split.insertAt).toBe(1);
  });
});

describe("judgmentFacts", () => {
  function judgeCall(overrides: Partial<TraceObservation> = {}): TraceObservation {
    return {
      id: "j1",
      step_name: "t.agent:figures-supported-by-work",
      parent_call_id: "run",
      input: {
        messages: [
          {
            role: "system",
            content:
              '{"model":"deepseek/deepseek-v4.1-flash","instruction":"PASS if figures are supported."}',
          },
        ],
      },
      tool_result: { reasoning: "All figures match.", pass: true },
      latency_ms: 7862,
      ...overrides,
    } as TraceObservation;
  }

  it("returns null for non-judgment calls", () => {
    expect(judgmentFacts(call("gen", "agent.generate"), [])).toBeNull();
  });

  it("extracts instruction, model, verdict, kind, and latency", () => {
    const facts = judgmentFacts(judgeCall(), [call("t1", "tool read", "j1"), call("t2", "tool search", "j1"), call("x", "other", "run")]);
    expect(facts).toEqual({
      name: "figures-supported-by-work",
      kind: "t.agent",
      model: "deepseek/deepseek-v4.1-flash",
      instruction: "PASS if figures are supported.",
      reasoning: "All figures match.",
      pass: true,
      toolChildren: 2,
      latencyMs: 7862,
    });
  });

  it("strips the judge: prefix and keeps kind t.judge", () => {
    const facts = judgmentFacts(judgeCall({ step_name: "judge:summary-reads-well", tool_result: null }) as TraceObservation, []);
    expect(facts!.name).toBe("summary-reads-well");
    expect(facts!.kind).toBe("t.judge");
    expect(facts!.pass).toBeUndefined();
    expect(facts!.reasoning).toBeUndefined();
  });

  it("tolerates a non-JSON system message", () => {
    const facts = judgmentFacts(
      judgeCall({ input: { messages: [{ role: "system", content: "free-form briefing" }] } }) as TraceObservation,
      [],
    );
    expect(facts).not.toBeNull();
    expect(facts!.model).toBeUndefined();
    expect(facts!.instruction).toBeUndefined();
  });
});
