import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createOtelAgentTaskTraceClient } from "../src/agent-task/otel-trace-client.ts";
import type { TraceRunOptions } from "../src/types.ts";

describe("agent-task official OTLP export", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("flushes the claimed task trace before traceRun resolves", async () => {
    let requestPath = "";
    let authorization = "";
    let contentType = "";
    let bodyLength = 0;
    server = createServer((request, response) => {
      requestPath = request.url ?? "";
      authorization = String(request.headers.authorization ?? "");
      contentType = String(request.headers["content-type"] ?? "");
      request.on("data", (chunk: Buffer) => { bodyLength += chunk.length; });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end(Buffer.alloc(0));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const client = createOtelAgentTaskTraceClient({
      endpoint: `http://127.0.0.1:${port}`,
      project: "agent-http-project",
      authToken: "task-service-token",
      requirePersistence: true,
    });
    const options = {
      project: "agent-http-project",
      flow_name: "http-agent",
      task_id: "task-42",
      taskRunId: "task-run-42",
    } as TraceRunOptions & { taskRunId: string };

    await client.traceRun(options, async (traceContext) => {
      await traceContext.step({ step_name: "tool-child" }, async () => "done");
      return "complete";
    });

    // The export reached the canonical OTLP endpoint with the service token.
    expect(requestPath).toBe("/api/public/otel/v1/traces");
    expect(authorization).toBe("Bearer task-service-token");
    // The official OTLP exporter sends protobuf or JSON (not the old custom
    // apo wire format). Either standard encoding is acceptable.
    expect(contentType).toMatch(/^application\/(x-protobuf|json)/);
    // A non-empty body was flushed before traceRun resolved.
    expect(bodyLength).toBeGreaterThan(0);
  });
});
