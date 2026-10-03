import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectMcpServers,
  resolveMcpServerPaths,
  type McpServerConfig,
} from "../src/agent-task/checks/mcp-tools.ts";

/**
 * `connectMcpServers` — the adapter-side MCP connect helper. The
 * agent under test is not apo's to budget, so unlike the judge toolset this
 * returns RAW namespaced tools; everything else (transports, filtering,
 * namespacing, cleanup) is shared plumbing, proven here against the same
 * real stdio fixture server as the judge tests.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FACTS_SERVER = join(__dirname, "fixtures", "mcp-facts-server.mjs");

let tmpDir: string;
let savedPidFile: string | undefined;

function factsServerConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "facts",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [FACTS_SERVER],
      env: { FACTS_PID_FILE: "${FACTS_PID_FILE}" },
    },
    ...overrides,
  };
}

async function waitForExit(pid: number, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
  }
  return true;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adapter-mcp-"));
  savedPidFile = process.env.FACTS_PID_FILE;
  process.env.FACTS_PID_FILE = join(tmpDir, "facts.pid");
});

afterEach(() => {
  if (savedPidFile === undefined) delete process.env.FACTS_PID_FILE;
  else process.env.FACTS_PID_FILE = savedPidFile;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("connectMcpServers — adapter-side MCP helper", () => {
  it("returns raw namespaced tools and byServer info from a real server", async () => {
    const toolset = await connectMcpServers([factsServerConfig()]);

    expect(Object.keys(toolset.tools).sort()).toEqual([
      "mcp__facts__big_fact",
      "mcp__facts__get_fact",
      "mcp__facts__slow_fact",
    ]);
    expect(toolset.byServer.facts?.sort()).toEqual(["big_fact", "get_fact", "slow_fact"]);

    const getFact = toolset.tools.mcp__facts__get_fact as {
      execute: (input: unknown) => Promise<unknown>;
    };
    const result = (await getFact.execute({ topic: "adapters" })) as { content?: Array<{ text?: string }> };
    expect(result.content?.[0]?.text).toBe("fact: adapters is 42");

    await toolset.cleanup();
  });

  it("cleanup terminates the spawned server process", async () => {
    const toolset = await connectMcpServers([factsServerConfig()]);
    const pid = Number(readFileSync(process.env.FACTS_PID_FILE!, "utf-8"));
    expect(Number.isInteger(pid)).toBe(true);

    await toolset.cleanup();
    expect(await waitForExit(pid)).toBe(false);
  });

  it("applies allow/deny filtering to the exposed tool record", async () => {
    const toolset = await connectMcpServers([factsServerConfig({ tools: ["get_fact"] })]);

    expect(Object.keys(toolset.tools)).toEqual(["mcp__facts__get_fact"]);
    expect(toolset.byServer.facts).toEqual(["get_fact"]);

    await toolset.cleanup();
  });

  it("throws on duplicate server names before connecting", async () => {
    await expect(connectMcpServers([factsServerConfig(), factsServerConfig()])).rejects.toThrow(
      /duplicate names: "facts"/,
    );
  });

  it("rejects server names containing the __ namespacing separator", async () => {
    await expect(connectMcpServers([factsServerConfig({ name: "my__geo" })])).rejects.toThrow(
      /must not contain "__"/,
    );
  });

  it("resolves path-like stdio entries against the base dir; bare names stay bare", () => {
    const resolved = resolveMcpServerPaths(
      [
        {
          name: "a",
          transport: { type: "stdio", command: "node", args: ["./mcp/server.mjs", "--port", "../other.mjs"] },
        },
        { name: "b", transport: { type: "http", url: "https://example.com/mcp" } },
      ],
      "/tasks/demo",
    );

    const a = resolved[0]!.transport as { command: string; args: string[] };
    expect(a.command).toBe("node");
    expect(a.args[0]).toBe("/tasks/demo/mcp/server.mjs");
    expect(a.args[1]).toBe("--port");
    expect(a.args[2]).toBe("/tasks/other.mjs");
    expect(resolved[1]).toMatchObject({ transport: { type: "http" } });
  });

  it("is exported from the package entry", async () => {
    const pub = await import("../src/agent-task/public.ts");
    expect(typeof pub.connectMcpServers).toBe("function");
  });
});
