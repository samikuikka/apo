import { describe, expect, it } from "vitest";
import {
  resolveExecutionMode,
  type ExecutionModeInput,
  type ExecutionModeResult,
} from "../src/lib/execution-mode.ts";

// Convenience builder so each parametrized row reads as a sentence.
function input(partial: Partial<ExecutionModeInput>): ExecutionModeInput {
  return {
    flagLocal: false,
    flagRemote: false,
    taskExecution: undefined,
    projectDefault: undefined,
    hasProject: false,
    ...partial,
  };
}

function expectMode(partial: Partial<ExecutionModeInput>, mode: ExecutionModeResult["mode"]): void {
  expect(resolveExecutionMode(input(partial)).mode).toBe(mode);
}

describe("resolveExecutionMode — precedence: flag > task > project > reachability", () => {
  // ── Explicit flags (highest priority) ────────────────────────────────────
  it("--local flag → local-recorded even when task says backend and project says backend", () => {
    expect(
      resolveExecutionMode(
        input({
          flagLocal: true,
          flagBackend: false,
          taskExecution: "backend",
          projectDefault: "backend",
          hasProject: true,
        }),
      ).mode,
    ).toBe("local-recorded");
  });

  it("--remote flag → backend even when task says local and project says local", () => {
    expect(
      resolveExecutionMode(
        input({
          flagLocal: false,
          flagRemote: true,
          taskExecution: "local",
          projectDefault: "local",
          hasProject: true,
        }),
      ).mode,
    ).toBe("backend");
  });

  it("reason for a flag-driven decision is 'flag'", () => {
    expect(resolveExecutionMode(input({ flagLocal: true, hasProject: true })).reason).toBe("flag");
    expect(resolveExecutionMode(input({ flagRemote: true, hasProject: true })).reason).toBe("flag");
  });

  // ── Task declaration ─────────────────────────────────────────────────────
  it("task execution='local' (no flags) → local-recorded", () => {
    expectMode({ taskExecution: "local", hasProject: true }, "local-recorded");
  });

  it("task execution='backend' (no flags) → backend", () => {
    expectMode({ taskExecution: "backend", hasProject: true }, "backend");
  });

  it("task execution='local' wins over a 'local' project default, with reason 'task'", () => {
    const result = resolveExecutionMode(
      input({ taskExecution: "local", projectDefault: "local", hasProject: true }),
    );
    expect(result.mode).toBe("local-recorded");
    expect(result.reason).toBe("task");
  });

  it("task execution='backend' wins over a 'local' project default (task knows better)", () => {
    // SPEC-136 §Behavior: "An individual task declaring execution: 'backend' wins."
    expectMode(
      { taskExecution: "backend", projectDefault: "local", hasProject: true },
      "backend",
    );
  });

  it("task execution='auto' is treated as no preference (falls through)", () => {
    // auto == omitting the field. Project default + reachability decide.
    expectMode({ taskExecution: "auto", projectDefault: "local", hasProject: true }, "local-recorded");
    expectMode({ taskExecution: "auto", hasProject: true }, "backend");
  });

  // ── Project default ──────────────────────────────────────────────────────
  it("project default='local' with no task preference → local-recorded, reason 'project'", () => {
    const result = resolveExecutionMode(input({ projectDefault: "local", hasProject: true }));
    expect(result.mode).toBe("local-recorded");
    expect(result.reason).toBe("project");
  });

  it("project default='backend' with no task preference → backend", () => {
    expectMode({ projectDefault: "backend", hasProject: true }, "backend");
  });

  // ── Default (reachability layer is consulted by run(), not here) ─────────
  it("no preference, has project → backend (reachability is checked later by run())", () => {
    const result = resolveExecutionMode(input({ hasProject: true }));
    expect(result.mode).toBe("backend");
    expect(result.reason).toBe("default");
  });

  it("no preference, no project → local-unrecorded (offline fallback shape)", () => {
    const result = resolveExecutionMode(input({ hasProject: false }));
    expect(result.mode).toBe("local-unrecorded");
    expect(result.reason).toBe("no-project");
  });

  // ── Cross-product: precedence holds for every combination ────────────────
  // Exhaustive check of the documented truth table. Each row pins the exact
  // outcome so regressions in precedence ordering surface immediately.
  type Row = {
    name: string;
    input: ExecutionModeInput;
    expected: ExecutionModeResult;
  };
  const rows: Row[] = [
    // flags dominate everything
    {
      name: "flagLocal beats task=backend + project=backend + project set",
      input: input({ flagLocal: true, taskExecution: "backend", projectDefault: "backend", hasProject: true }),
      expected: { mode: "local-recorded", reason: "flag" },
    },
    {
      name: "flagRemote beats task=local + project=local + project set",
      input: input({ flagRemote: true, taskExecution: "local", projectDefault: "local", hasProject: true }),
      expected: { mode: "backend", reason: "flag" },
    },
    // task beats project
    {
      name: "task=local beats project=backend",
      input: input({ taskExecution: "local", projectDefault: "backend", hasProject: true }),
      expected: { mode: "local-recorded", reason: "task" },
    },
    {
      name: "task=backend beats project=local",
      input: input({ taskExecution: "backend", projectDefault: "local", hasProject: true }),
      expected: { mode: "backend", reason: "task" },
    },
    // project beats default
    {
      name: "project=local with task=auto",
      input: input({ taskExecution: "auto", projectDefault: "local", hasProject: true }),
      expected: { mode: "local-recorded", reason: "project" },
    },
    {
      name: "project=backend with task=auto",
      input: input({ taskExecution: "auto", projectDefault: "backend", hasProject: true }),
      expected: { mode: "backend", reason: "project" },
    },
    // default
    {
      name: "no preferences, project set",
      input: input({ hasProject: true }),
      expected: { mode: "backend", reason: "default" },
    },
    {
      name: "no preferences, no project",
      input: input({ hasProject: false }),
      expected: { mode: "local-unrecorded", reason: "no-project" },
    },
  ];

  for (const row of rows) {
    it(`truth table: ${row.name}`, () => {
      expect(resolveExecutionMode(row.input)).toEqual(row.expected);
    });
  }

  // ── Purity (SPEC-136 §Quality Constraints) ───────────────────────────────
  it("is pure — never throws regardless of inputs (no reachability/I/O)", () => {
    // Every combination must return, not throw. Reachability is consulted
    // afterward by run(), so this function must not even know it exists.
    for (const flagLocal of [false, true]) {
      for (const flagRemote of [false, true]) {
        for (const taskExecution of [undefined, "local", "backend", "auto"] as const) {
          for (const projectDefault of [undefined, "local", "backend"] as const) {
            for (const hasProject of [false, true]) {
              const result = resolveExecutionMode(
                input({ flagLocal, flagRemote, taskExecution, projectDefault, hasProject }),
              );
              expect(result.mode).toBeTruthy();
              expect(result.reason).toBeTruthy();
            }
          }
        }
      }
    }
  });

  it("two contradictory flags: --local takes precedence over --backend (symmetric escape hatch is --local)", () => {
    // Defensive: if a caller somehow passes both, the local escape hatch wins
    // because it's the explicit "run here, no matter what" override. Documented
    // behavior so the choice is deterministic rather than silent.
    expect(
      resolveExecutionMode(input({ flagLocal: true, flagRemote: true, hasProject: true })).mode,
    ).toBe("local-recorded");
  });
});
