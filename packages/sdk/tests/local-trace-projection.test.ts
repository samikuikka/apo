import { describe, it, expect } from "vitest";
import { createLocalTraceProjectionRecorder } from "../src/agent-task/trace-projection/local-recorder.ts";
import { TraceView } from "../src/agent-task/trace-projection/view.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

describe("LocalTraceProjectionRecorder", () => {
  it("produces a source=local snapshot with a traceId", async () => {
    const recorder = createLocalTraceProjectionRecorder();
    const captured = await recorder.capture(
      { project: "p", flow_name: "test-flow" },
      async () => 42,
    );
    expect(captured.value).toBe(42);
    expect(captured.snapshot.source).toBe("local");
    expect(captured.traceId).toBe(captured.snapshot.trace.traceId);
    expect(captured.snapshot.schemaVersion).toBe(1);
  });

  it("records a tool span via createSpan/endSpan", async () => {
    const recorder = createLocalTraceProjectionRecorder();
    const captured = await recorder.capture(
      { project: "p", flow_name: "test-flow" },
      async (trace) => {
        const id = trace.createSpan({
          task_id: "tool.read_file",
          step_name: "read_file",
          observation_type: "TOOL",
          input: { path: "a.txt" },
        });
        trace.endSpan(id, {
          output: { content: "hello" },
          level: "DEFAULT",
          metadata: { tool_name: "read_file", tool_parameters: { path: "a.txt" }, tool_result: { content: "hello" } },
        });
        return "done";
      },
    );
    const tools = captured.snapshot.observations.filter((o) => o.type === "TOOL");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolName: "read_file",
      toolParameters: { path: "a.txt" },
      toolResult: { content: "hello" },
      status: "ok",
    });
  });

  it("records an erroring tool span with status error", async () => {
    const recorder = createLocalTraceProjectionRecorder();
    const captured = await recorder.capture(
      { project: "p", flow_name: "test-flow" },
      async (trace) => {
        const id = trace.createSpan({
          task_id: "tool.bad",
          step_name: "bad",
          observation_type: "TOOL",
        });
        trace.endSpan(id, { level: "ERROR", status_message: "boom" });
        return "done";
      },
    );
    const tools = captured.snapshot.observations.filter((o) => o.type === "TOOL");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe("error");
    expect(tools[0]!.errorMessage).toBe("boom");
  });

  it("declares timing available (uses a real clock)", async () => {
    const recorder = createLocalTraceProjectionRecorder();
    const captured = await recorder.capture(
      { project: "p", flow_name: "test-flow" },
      async () => 1,
    );
    expect(captured.snapshot.capabilities.timing).toBe("available");
    expect(captured.snapshot.trace.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks the trace complete after capture", async () => {
    const recorder = createLocalTraceProjectionRecorder();
    const captured = await recorder.capture(
      { project: "p", flow_name: "test-flow" },
      async () => 1,
    );
    expect(captured.snapshot.trace.complete).toBe(true);
    expect(captured.snapshot.trace.endedAt).toBeTruthy();
  });

  describe("Test 8 — local recorder matches canonical contract (equivalent facts)", () => {
    it("produces equivalent TraceView facts for a generation + tool + error scenario", async () => {
      const recorder = createLocalTraceProjectionRecorder();
      const captured = await recorder.capture(
        { project: "p", flow_name: "review", taskRunId: "run-1" },
        async (trace) => {
          // A generation (assistant message)
          const gen = trace.createSpan({
            task_id: "gen",
            step_name: "gen",
            observation_type: "GENERATION",
            model: "gpt-4",
          });
          trace.endSpan(gen, { output: { text: "I reviewed the code" } });
          // A successful tool
          const t1 = trace.createSpan({
            task_id: "tool.read",
            step_name: "read_file",
            observation_type: "TOOL",
          });
          trace.endSpan(t1, { level: "DEFAULT", metadata: { tool_name: "read_file" } });
          // A failing tool
          const t2 = trace.createSpan({
            task_id: "tool.write",
            step_name: "write_file",
            observation_type: "TOOL",
          });
          trace.endSpan(t2, { level: "ERROR", status_message: "denied" });
          return "ok";
        },
      );

      // Equivalent "canonical" fixture — same facts, built by hand. The
      // observations mirror the local capture's types/statuses; we give them
      // the local startedAt timestamps so both views sort identically.
      const localTools = captured.snapshot.observations.filter((o) => o.type === "TOOL");
      const localGen = captured.snapshot.observations.find((o) => o.type === "GENERATION");
      const canonical: TraceProjectionSnapshot = {
        schemaVersion: 1,
        projectionVersion: 1,
        source: "canonical",
        trace: {
          traceId: "canonical-trace",
          taskRunId: "run-1",
          complete: true,
          startedAt: captured.snapshot.trace.startedAt,
          endedAt: captured.snapshot.trace.endedAt,
        },
        capabilities: captured.snapshot.capabilities,
        observations: [
          { spanId: "c-gen", type: "GENERATION", name: "gen", status: "unset", model: "gpt-4", startedAt: localGen?.startedAt },
          { spanId: "c-t1", type: "TOOL", name: "read_file", status: "ok", toolName: "read_file", startedAt: localTools[0]?.startedAt },
          { spanId: "c-t2", type: "TOOL", name: "write_file", status: "error", errorMessage: "denied", toolName: "write_file", startedAt: localTools[1]?.startedAt },
        ],
      };

      const localView = new TraceView(captured.snapshot);
      const canonicalView = new TraceView(canonical);

      // Equivalent assertion facts:
      expect(localView.toolNamesInOrder).toEqual(canonicalView.toolNamesInOrder);
      expect(localView.failedActions).toBe(canonicalView.failedActions);
      expect(localView.requireCapability("tools")).toBe(canonicalView.requireCapability("tools"));
      expect(localView.requireCapability("errors")).toBe(canonicalView.requireCapability("errors"));
      expect(localView.requireCapability("timing")).toBe(canonicalView.requireCapability("timing"));
    });
  });

  it("taskRunId threads through to the snapshot", async () => {
    const recorder = createLocalTraceProjectionRecorder();
    const captured = await recorder.capture(
      { project: "p", flow_name: "f", taskRunId: "tr-99" },
      async () => 1,
    );
    expect(captured.snapshot.trace.taskRunId).toBe("tr-99");
  });

  it("parentSpanId is recorded for child spans", async () => {
    const recorder = createLocalTraceProjectionRecorder();
    const captured = await recorder.capture(
      { project: "p", flow_name: "f" },
      async (trace) => {
        const child = trace.createSpan({
          parent_call_id: trace.rootSpanId,
          task_id: "child",
          step_name: "child",
          observation_type: "TOOL",
        });
        trace.endSpan(child, {});
        return 1;
      },
    );
    const child = captured.snapshot.observations.find((o) => o.type === "TOOL");
    expect(child?.parentSpanId).toBeDefined();
  });
});
