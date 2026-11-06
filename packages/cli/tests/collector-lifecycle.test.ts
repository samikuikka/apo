/**
 * Collector lifecycle across concurrent apo commands, against a real child
 * process (tests/fixtures/fake-otelcol.mjs) on real loopback ports.
 *
 * The bug these pin: the command that SPAWNED the collector stopped it at its
 * own exit, under sibling commands that had reused it. Their exporters then hit
 * a dead port for the rest of the run, and the run failed trace persistence.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectorPaths, startCollector, type CollectorHandle } from "../src/lib/collector.ts";

const FAKE_BIN = join(import.meta.dirname, "fixtures", "fake-otelcol.mjs");
const USER_SCRIPT = join(import.meta.dirname, "fixtures", "collector-user.mts");
const CLI_DIR = join(import.meta.dirname, "..");
const ENV_KEYS = [
  "APO_COLLECTOR_DATA_DIR",
  "APO_COLLECTOR_BIN",
  "APO_COLLECTOR_PORT",
  "APO_COLLECTOR_HEALTH_PORT",
  "APO_COLLECTOR_METRICS_PORT",
  "APO_COLLECTOR_WATCHDOG_MS",
  "APO_COLLECTOR_SPAWN_CONFIRM_MS",
  "APO_COLLECTOR_SETTLE_MS",
  "APO_COLLECTOR_EMPTY_WINDOW_MS",
  "FAKE_OTELCOL_START_DELAY_MS",
  "TEST_BACKEND_URL",
] as const;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

function recordedPid(): number {
  return Number.parseInt(readFileSync(collectorPaths().pid, "utf8"), 10);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Another apo command, in its own process, holding a collector handle. */
async function otherProcessUser(): Promise<{ child: ChildProcess; reused: boolean; stopped: Promise<string> }> {
  // One process (not the tsx wrapper, which forks the script into a child), so
  // a signal reaches the process holding the handle.
  const child = spawn(process.execPath, ["--import", "tsx", USER_SCRIPT], {
    cwd: CLI_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  let out = "";
  const lines = new Promise<void>((resolve) => child.stdout!.on("data", (chunk) => {
    out += String(chunk);
    if (out.includes("ready")) resolve();
  }));
  await lines;
  const stopped = new Promise<string>((resolve) => child.on("exit", () => resolve(/stopped (\S+)/.exec(out)?.[1] ?? "none")));
  return { child, reused: out.includes("ready true"), stopped };
}

let dataDir: string;
let handles: CollectorHandle[] = [];
let children: ChildProcess[] = [];
let backend: Server;
let backendUrl: string;
let healthPort: number;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "apo-collector-test-"));
  healthPort = await freePort();
  process.env.APO_COLLECTOR_DATA_DIR = dataDir;
  process.env.APO_COLLECTOR_BIN = FAKE_BIN;
  process.env.APO_COLLECTOR_PORT = String(await freePort());
  process.env.APO_COLLECTOR_HEALTH_PORT = String(healthPort);
  process.env.APO_COLLECTOR_METRICS_PORT = String(await freePort());
  process.env.APO_COLLECTOR_WATCHDOG_MS = "200";
  // Shrink the lifecycle padding windows the way WATCHDOG_MS above does:
  // real child processes on real ports, but the bind-loser grace after a
  // spawn, the pre-drain settle, and the sustained-empty drain window run
  // at test scale instead of the production defaults (1s / 2.5s / 1s).
  process.env.APO_COLLECTOR_SPAWN_CONFIRM_MS = "250";
  process.env.APO_COLLECTOR_SETTLE_MS = "100";
  process.env.APO_COLLECTOR_EMPTY_WINDOW_MS = "250";
  backend = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  backendUrl = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  process.env.TEST_BACKEND_URL = backendUrl;
});

afterEach(async () => {
  // Release every handle while the test env is still in place: a leaked
  // watchdog reads the env at tick time and would otherwise reach ~/.apo.
  await Promise.all(handles.splice(0).map((handle) => handle.stop().catch(() => undefined)));
  for (const child of children.splice(0)) child.kill("SIGKILL");
  // Never leave a collector process behind, whatever the test did.
  try {
    process.kill(Number.parseInt(readFileSync(collectorPaths().pid, "utf8"), 10), "SIGKILL");
  } catch {
    // none running
  }
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const start = async (): Promise<CollectorHandle> => {
  const handle = await startCollector({ backendUrl, authHeader: "Bearer test-key" });
  handles.push(handle);
  return handle;
};

describe("collector shared by concurrent commands", () => {
  it("keeps running when the spawner finishes while another command still uses it", async () => {
    const spawner = await start();
    const sibling = await start();
    expect(spawner.reused).toBe(false);
    expect(sibling.reused).toBe(true);

    expect(await spawner.stop()).toBe("left-running");
    expect(await answers(healthPort)).toBe(true);

    expect(await sibling.stop()).toBe("stopped");
    expect(await eventually(async () => !(await answers(healthPort)))).toBe(true);
  }, 30_000);

  it("is stopped by the last user even when that user only reused it", async () => {
    const spawner = await start();
    const sibling = await start();

    expect(await sibling.stop()).toBe("left-running");
    expect(await spawner.stop()).toBe("stopped");
    expect(await eventually(async () => !(await answers(healthPort)))).toBe(true);
  }, 30_000);

  it("keeps running when a spawner in another process finishes before this command", async () => {
    const other = await otherProcessUser();
    expect(other.reused).toBe(false);
    const handle = await start();
    expect(handle.reused).toBe(true);

    other.child.kill("SIGTERM");
    expect(await other.stopped).toBe("left-running");
    expect(await answers(healthPort)).toBe(true);

    expect(await handle.stop()).toBe("stopped");
  }, 60_000);

  it("does not let a command that died without stopping keep it running", async () => {
    const other = await otherProcessUser();
    const handle = await start();
    other.child.kill("SIGKILL"); // never runs its stop()
    await other.stopped;
    // And a leftover user file from long ago, whose pid is gone.
    writeFileSync(join(collectorPaths().users, "2147483646-1"), "");

    expect(await handle.stop()).toBe("stopped");
  }, 60_000);

  it("restarts the collector when it disappears under a live command", async () => {
    const handle = await start();
    process.kill(Number.parseInt(readFileSync(collectorPaths().pid, "utf8"), 10), "SIGKILL");
    expect(await eventually(async () => !(await answers(healthPort)), 2_000)).toBe(true);

    expect(await eventually(() => answers(healthPort))).toBe(true);
    expect(await handle.stop()).toBe("stopped");
  }, 30_000);

  it("records the serving collector's pid when several users restart it at once, and leaves none behind", async () => {
    // Real otelcol loads its config before binding: a spawn that starts while
    // another is still loading sees the health check answered by the other one.
    // Staggered watchdog periods put the users' restarts out of phase.
    process.env.FAKE_OTELCOL_START_DELAY_MS = "600";
    const users: CollectorHandle[] = [];
    for (const period of ["1000", "1300", "1600"]) {
      process.env.APO_COLLECTOR_WATCHDOG_MS = period;
      users.push(await start());
    }
    process.kill(recordedPid(), "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    expect(await answers(healthPort)).toBe(true);
    expect(alive(recordedPid())).toBe(true);
    const outcomes = [];
    for (const user of users) outcomes.push(await user.stop());
    expect(outcomes).toEqual(["left-running", "left-running", "stopped"]);
    expect(await eventually(async () => !(await answers(healthPort)))).toBe(true);
  }, 90_000);

  it("does not let a command for another backend take over a collector that is still starting", async () => {
    process.env.FAKE_OTELCOL_START_DELAY_MS = "600";
    const first = start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const other = startCollector({ backendUrl, authHeader: "Bearer another-project" });

    expect((await first).reused).toBe(false);
    await expect(other).rejects.toThrow(/different backend\/credential/);
    // The recorded target is still the first command's: a later same-target
    // command reuses it, a mismatched one is still turned away.
    expect((await start()).reused).toBe(true);
  }, 60_000);

  it("takes over a spawn lock left by a holder whose pid now belongs to an unrelated live process", async () => {
    // pid 1 is always alive (and not ours to signal): a dead holder's recycled pid.
    mkdirSync(collectorPaths().home, { recursive: true });
    writeFileSync(collectorPaths().spawnLock, "1\n");
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(collectorPaths().spawnLock, longAgo, longAgo);

    const started = Date.now();
    const handle = await start();
    expect(handle.reused).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});
