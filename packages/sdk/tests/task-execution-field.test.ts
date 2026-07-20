import { describe, expect, it } from "vitest";
import { defineTask } from "../src/agent-task/task/defineTask";
import { task, resetTaskRegistry, getRegisteredTask } from "../src/agent-task/task/defineTask";
import type {
  DeliverableDefinition,
  TaskDefinition,
} from "../src/agent-task/types";
import type { TaskExecutionPreference } from "../src/agent-task/task/types";

// Minimal adapter for defineTask/task — lifecycle isn't exercised here.
const stubAdapter = {
  name: "stub",
  deliverables: {} as Record<string, DeliverableDefinition>,
} as const;

describe("TaskDefinition.execution field (SPEC-136)", () => {
  it("accepts execution: 'local' | 'backend' | 'auto'", () => {
    const local: TaskDefinition = {
      id: "t-local",
      adapter: "stub",
      deliverables: [],
      execution: "local",
    };
    const backend: TaskDefinition = {
      id: "t-backend",
      adapter: "stub",
      deliverables: [],
      execution: "backend",
    };
    const auto: TaskDefinition = {
      id: "t-auto",
      adapter: "stub",
      deliverables: [],
      execution: "auto",
    };
    expect(local.execution).toBe("local");
    expect(backend.execution).toBe("backend");
    expect(auto.execution).toBe("auto");
  });

  it("is optional (backward compatibility for legacy tasks)", () => {
    const legacy: TaskDefinition = {
      id: "legacy",
      adapter: "stub",
      deliverables: [],
    };
    expect(legacy.execution).toBeUndefined();
  });

  it("is typed as TaskExecutionPreference ('local' | 'backend' | 'auto')", () => {
    // Compile-time check: assigning anything else must fail. The variable use
    // avoids the literal being narrowed away by the compiler.
    const value: TaskExecutionPreference = "local";
    const allowed: TaskExecutionPreference[] = ["local", "backend", "auto"];
    expect(allowed).toContain(value);
  });

  it("defineTask(...) round-trips execution", () => {
    const defined = defineTask(stubAdapter, {
      id: "bind-e2e",
      deliverables: [],
      execution: "local",
    });
    expect(defined.execution).toBe("local");
  });

  it("defineTask(...) omits execution when not provided", () => {
    const defined = defineTask(stubAdapter, {
      id: "plain",
      deliverables: [],
    });
    expect(defined.execution).toBeUndefined();
  });

  it("task(...) round-trips execution through the registry", () => {
    resetTaskRegistry();
    task("round-trip", {
      adapter: stubAdapter,
      deliverables: [],
      execution: "backend",
    });
    const registered = getRegisteredTask();
    expect(registered?.execution).toBe("backend");
  });
});
