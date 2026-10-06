/**
 * Unit tests for the local span-durability collector sidecar.
 *
 * Covers the pure decision/render logic and the fallback contract: any
 * collector failure must degrade to direct export (traceEndpoint null),
 * never throw out of maybeStartCollector.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APO_TRACES_PATH,
  COLLECTOR_VERSION,
  collectorDownloadUrls,
  collectorPaths,
  collectorPlatform,
  decideCollectorEnabled,
  ensureCollectorBinary,
  maybeStartCollector,
  renderCollectorConfig,
} from "../src/lib/collector.ts";

const COLLECTOR_ENV_KEYS = [
  "APO_COLLECTOR",
  "APO_COLLECTOR_BIN",
  "APO_COLLECTOR_PORT",
  "APO_COLLECTOR_HEALTH_PORT",
  "APO_COLLECTOR_MAX_QUEUE_BYTES",
  "APO_COLLECTOR_DATA_DIR",
  "APO_COLLECTOR_HEALTH_TIMEOUT_MS",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of COLLECTOR_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of COLLECTOR_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("decideCollectorEnabled", () => {
  it("is off for localhost backends", () => {
    expect(decideCollectorEnabled("http://localhost:8000")).toBe(false);
    expect(decideCollectorEnabled("http://127.0.0.1:8000")).toBe(false);
  });

  it("is on for remote backends", () => {
    expect(decideCollectorEnabled("https://apo.example.com")).toBe(true);
  });

  it("APO_COLLECTOR forces the decision both ways", () => {
    process.env.APO_COLLECTOR = "1";
    expect(decideCollectorEnabled("http://localhost:8000")).toBe(true);
    process.env.APO_COLLECTOR = "0";
    expect(decideCollectorEnabled("https://apo.example.com")).toBe(false);
    process.env.APO_COLLECTOR = "true";
    expect(decideCollectorEnabled("http://localhost:8000")).toBe(true);
    process.env.APO_COLLECTOR = "false";
    expect(decideCollectorEnabled("https://apo.example.com")).toBe(false);
  });

  it("treats an unparseable backend URL as off", () => {
    expect(decideCollectorEnabled("not a url")).toBe(false);
  });
});

describe("renderCollectorConfig", () => {
  const rendered = renderCollectorConfig({
    backendUrl: "https://apo.example.com/",
    otlpPort: 14318,
    healthPort: 13133,
    metricsPort: 18888,
    queueDir: "/home/user/.apo/collector/queue",
    maxQueueBytes: 512 * 1024 * 1024,
  });

  it("impersonates apo's ingest path so one env var redirects a run", () => {
    expect(rendered).toContain(`traces_url_path: ${APO_TRACES_PATH}`);
  });

  it("listens on the dedicated port, not the OTLP-conventional 4318", () => {
    expect(rendered).toContain("endpoint: 127.0.0.1:14318");
    expect(rendered).not.toContain("127.0.0.1:4318");
  });

  it("exposes the queue-depth metrics stop() drains on", () => {
    expect(rendered).toContain("port: 18888");
  });

  it("exports to the backend's full traces URL", () => {
    expect(rendered).toContain(
      `traces_endpoint: https://apo.example.com${APO_TRACES_PATH}`,
    );
  });

  it("keeps the auth header out of the file — env placeholder only", () => {
    expect(rendered).toContain('Authorization: "${env:APO_COLLECTOR_AUTH}"');
    expect(rendered).not.toMatch(/Bearer [A-Za-z0-9_-]+/);
  });

  it("pins the queue to disk with a hard cap", () => {
    expect(rendered).toContain("storage: file_storage");
    expect(rendered).toContain("max_size: 536870912");
    expect(rendered).toContain("directory: /home/user/.apo/collector/queue");
  });

  it("retries forever — the queue bounds are the only limit", () => {
    expect(rendered).toContain("max_elapsed_time: 0s");
  });

  it("names the validated collector version", () => {
    expect(rendered).toContain(`otelcol-contrib ${COLLECTOR_VERSION}`);
  });
});

describe("collectorPlatform / download urls", () => {
  it("builds the pinned upstream release URL for the current platform", () => {
    const platform = collectorPlatform();
    if (!platform) return; // unsupported platform: nothing to assert
    const urls = collectorDownloadUrls();
    expect(urls?.tarball).toBe(
      `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download` +
        `/v${COLLECTOR_VERSION}/otelcol-contrib_${COLLECTOR_VERSION}_${platform.os}_${platform.arch}.tar.gz`,
    );
  });
});

describe("ensureCollectorBinary", () => {
  it("installs the downloaded release where collectorPaths().bin expects it", async () => {
    // The shared-ownership split moved the running collector's state under
    // <root>/shared while the binary stayed at <root>/bin to remain shared
    // with older CLIs. The installer must extract to the recorded bin path —
    // a tarball extracted under paths.home leaves paths.bin missing, so every
    // start re-downloads ~95 MB and the collector never comes up.
    const dataDir = mkdtempSync(join(tmpdir(), "apo-collector-bin-test-"));
    process.env.APO_COLLECTOR_DATA_DIR = dataDir;
    // A tiny tarball standing in for the ~95 MB release. The installer itself
    // shells out to tar, so tar being present is a precondition already.
    const staging = mkdtempSync(join(tmpdir(), "apo-collector-tarball-"));
    writeFileSync(join(staging, "otelcol-contrib"), "#!/bin/sh\n", { mode: 0o755 });
    const tar = spawnSync("tar", ["-czf", "release.tar.gz", "otelcol-contrib"], { cwd: staging });
    expect(tar.status).toBe(0);
    const tarball = readFileSync(join(staging, "release.tar.gz"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith(".sha256")
          // Checksum unreachable: the install proceeds unverified (noticed).
          ? new Response(null, { status: 404 })
          : new Response(tarball)),
    );

    try {
      const bin = await ensureCollectorBinary();
      expect(bin).toBe(collectorPaths().bin);
      expect(existsSync(collectorPaths().bin)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

describe("maybeStartCollector", () => {
  it("is a no-op for localhost backends — no fetch, no spawn", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await maybeStartCollector({
      backendUrl: "http://localhost:8000",
      authHeader: "Bearer test-key",
    });
    expect(result.traceEndpoint).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await result.stop();
  });

  it("degrades to direct export when the collector cannot start", async () => {
    process.env.APO_COLLECTOR = "1";
    process.env.APO_COLLECTOR_HEALTH_TIMEOUT_MS = "50";
    process.env.APO_COLLECTOR_BIN = "/nonexistent/otelcol";
    const warnings: string[] = [];
    // Both probes fail: nothing listens anywhere.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("refused"))));

    const result = await maybeStartCollector({
      backendUrl: "http://localhost:8000",
      authHeader: "Bearer test-key",
      warn: (line) => warnings.push(line),
    });

    expect(result.traceEndpoint).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("exporting traces directly");
    await result.stop();
  });

  it("stays off without a credential to forward", async () => {
    process.env.APO_COLLECTOR = "1";
    const warnings: string[] = [];
    const result = await maybeStartCollector({
      backendUrl: "http://localhost:8000",
      authHeader: null,
      warn: (line) => warnings.push(line),
    });
    expect(result.traceEndpoint).toBeNull();
    expect(warnings[0]).toContain("no stored credential");
    await result.stop();
  });
});
