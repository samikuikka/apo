import { describe, expect, it } from "vitest";
import { toPublishedTask } from "../src/lib/task-catalog.ts";

/** The publication boundary: the eval's declared description crosses it,
 *  absence stays absent — the server treats a missing key and an explicit
 *  null identically, so the wire payload omits it entirely. */
describe("toPublishedTask", () => {
  it("carries the description when the task declares one", () => {
    const published = toPublishedTask({
      id: "chat/alpha",
      folderPath: "chat",
      adapter: "chatAdapter",
      hasChecks: true,
      description: "Grades the Q3 summary against its work log.",
    });

    expect(published.description).toBe("Grades the Q3 summary against its work log.");
    expect(published.task_id).toBe("chat/alpha");
    expect(published.display_name).toBe("alpha");
  });

  it("omits the description key when the task declares none", () => {
    const published = toPublishedTask({
      id: "chat/alpha",
      folderPath: "chat",
      adapter: "chatAdapter",
      hasChecks: true,
      description: null,
    });

    expect(published.description).toBeUndefined();
    expect("description" in published).toBe(false);
  });
});
