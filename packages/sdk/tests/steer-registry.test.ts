import { beforeEach, describe, expect, it } from "vitest";
import {
  getTaskSteers,
  resetTaskSteers,
  steer,
} from "../src/agent-task/steer.ts";

describe("steer() registration registry", () => {
  beforeEach(() => {
    resetTaskSteers();
  });

  it("registers steers in call order", () => {
    steer({ when: "runStart", message: "hi" });
    steer({ when: { toolResults: 2 }, message: "b", turn: 2, label: "second" });

    const steers = getTaskSteers();
    expect(steers).toHaveLength(2);
    // The spec is stored as registered — turn/label defaulting happens in
    // the scheduler (turn: spec.turn ?? 1), not in the registry.
    expect(steers[0]).toEqual({ when: "runStart", message: "hi" });
    expect(steers[1]?.turn).toBe(2);
    expect(steers[1]?.label).toBe("second");
    expect(steers[1]?.when).toEqual({ toolResults: 2 });
  });

  it("getTaskSteers returns a copy — mutating it does not touch the registry", () => {
    steer({ when: "runStart", message: "only" });
    getTaskSteers().pop();
    expect(getTaskSteers()).toHaveLength(1);
  });

  it("resetTaskSteers clears registrations", () => {
    steer({ when: "runStart", message: "gone" });
    resetTaskSteers();
    expect(getTaskSteers()).toEqual([]);
  });

  it("registry is empty on a fresh reset", () => {
    expect(getTaskSteers()).toEqual([]);
  });
});
