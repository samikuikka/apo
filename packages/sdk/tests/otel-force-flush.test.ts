/**
 * Force-flush integration test for the official OTLP exporter (SPEC-129 Track 4).
 *
 * This is the gating condition for SPEC-130 Track C: "The standard TypeScript
 * OTLP exporter is proven by a force-flushed HTTP integration test."
 *
 * The official `OTLPTraceExporter` uses Node's `http` module (not fetch), so it
 * cannot be mocked via `globalThis.fetch`. Instead we spin up a real
 * `http.createServer` that accepts OTLP/JSON POSTs, configure
 * `configureApoTelemetry` against it, create spans via `withApoTrace`, and
 * assert the server received them after `shutdown()` force-flushes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { type Server } from "node:http";

const RECEIVED_BODIES: string[] = [];
let server: Server | undefined;
let serverUrl = "";

async function startServer(): Promise<void> {
  const http = await import("node:http");
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      RECEIVED_BODIES.push(body);
      // Return the standard OTLP success response.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
    });
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address && typeof address === "object") {
    serverUrl = `http://127.0.0.1:${address.port}/v1/traces`;
  }
}

async function stopServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
}

describe("OTLP exporter force-flush integration (SPEC-129 Track 4)", () => {
  afterEach(async () => {
    RECEIVED_BODIES.length = 0;
    await stopServer();
  });

  it("force-flushes spans to a real HTTP server via the official exporter", async () => {
    await startServer();
    expect(serverUrl).toBeTruthy();

    const { configureApoTelemetry, withApoTrace } = await import(
      "../src/otel/index.ts"
    );

    const handle = await configureApoTelemetry({
      takeOwnership: true,
      endpoint: serverUrl,
      serviceName: "force-flush-test",
      headers: {},
    });

    // Create a root span and a child span through the real tracer.
    await withApoTrace(
      { name: "agent-task.run", attributes: { "apo.task.run.id": "task-run-42" } },
      handle.tracer,
      async (rootSpan) => {
        rootSpan.setAttribute("apo.task.id", "my-task");
        await withApoTrace(
          { name: "tool.read_file", attributes: { "gen_ai.tool.name": "read_file" } },
          handle.tracer,
          async () => "file-contents",
        );
        return "done";
      },
    );

    // shutdown() force-flushes the BatchSpanProcessor before destroying the
    // provider. Without forceFlush the batched exporter might hold the spans.
    await handle.shutdown();

    // The real server must have received at least one OTLP/JSON POST.
    expect(RECEIVED_BODIES.length).toBeGreaterThanOrEqual(1);

    // The exported payload must contain our spans with their attributes.
    const combined = RECEIVED_BODIES.join("\n");
    expect(combined).toContain("agent-task.run");
    expect(combined).toContain("tool.read_file");
    expect(combined).toContain("apo.task.run.id");
    expect(combined).toContain("task-run-42");
    expect(combined).toContain("read_file");
  });

  it("shutdown does not hang when the server is unreachable", async () => {
    // Point at a port nothing is listening on.
    const { configureApoTelemetry, withApoTrace } = await import(
      "../src/otel/index.ts"
    );

    const handle = await configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:1/v1/traces",
      serviceName: "unreachable-test",
      headers: {},
    });

    await withApoTrace(
      { name: "will-not-arrive" },
      handle.tracer,
      async () => "ok",
    );

    // Must resolve within the 2-second bound in shutdown(), not hang.
    const start = Date.now();
    await handle.shutdown();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});
