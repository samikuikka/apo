/**
 * MCP evidence tools for the agentic judge — the configurable tool surface of
 * `t.agent`. Users declare their own MCP servers (stdio or HTTP) and the
 * judge session gains their tools, namespaced `mcp__<server>__<tool>`, under
 * the same budget ledger and evidence-manifest discipline as the built-in
 * evidence tools: an MCP server must not become an unbounded evidence
 * firehose, and every result keeps its content-hash identity for
 * reproducibility.
 *
 * Config layers exactly like the judge model config (`resolveJudgeConfig`):
 * env/file (APO_JUDGE_MCP) ← runTask({ judgeTools }) ← task.judgeTools ←
 * per-call `t.agent(..., { tools: { mcp } })` — most specific wins, arrays
 * replace, never concat.
 *
 * The MCP client (`@ai-sdk/mcp`) is lazy-loaded: suites that never configure
 * MCP servers must never pay for the dependency (pinned by the
 * lazy-isolation test in tests/judge-mcp.test.ts).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { EvidenceFingerprint } from "../run/types.ts";
import type { JudgeTracer } from "../tracing.ts";

// ── Public types ───────────────────────────────────────────────────────────

/** Stdio transport: the judge's machine spawns the server process. */
export type McpStdioTransport = {
  type: "stdio";
  command: string;
  args?: string[];
  /**
   * Environment for the spawned process. Values support `${VAR}` expansion
   * from the judge process's environment at connect time; an unset variable
   * is a load error, never an empty string.
   */
  env?: Record<string, string>;
};

/** HTTP transport: an already-running remote server (Streamable HTTP). */
export type McpHttpTransport = {
  type: "http";
  url: string;
  /** Header values support `${VAR}` expansion like stdio env values. */
  headers?: Record<string, string>;
};

/** One user MCP server the judge may call. Mirrors the industry shape. */
export type McpServerConfig = {
  /** Unique server name; its tools are exposed as `mcp__<name>__<tool>`. */
  name: string;
  transport: McpStdioTransport | McpHttpTransport;
  /** Allowlist of raw server tool names (applied before namespacing). */
  tools?: string[];
  /** Denylist applied after the allowlist. */
  excludeTools?: string[];
  /** Per-tool-call timeout in ms. Default 30_000. */
  timeoutMs?: number;
};

/** Layered judge-tools config, sibling of `JudgeConfig`. */
export type JudgeToolsConfig = {
  mcp?: McpServerConfig[];
};

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/**
 * Connect/initialize handshake budget — deliberately generous and separate
 * from the per-call timeout: spawning a Node stdio server and importing its
 * dependencies routinely costs hundreds of ms, and that one-time cost must
 * not be bounded by a tool-call timeout the user tuned for hung requests.
 */
const INIT_TIMEOUT_MS = 10_000;
/** Max bytes of one MCP result actually served to the model. */
const MCP_RESULT_LIMIT = 64 * 1024;

// ── Pure helpers ───────────────────────────────────────────────────────────

/** `mcp__<server>__<tool>` — the industry namespacing convention. */
export function namespaceToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Apply the allowlist, then the denylist. No filters = everything. */
export function filterToolNames(
  names: string[],
  config: Pick<McpServerConfig, "tools" | "excludeTools">,
): string[] {
  const allowed = config.tools ? names.filter((n) => config.tools!.includes(n)) : names;
  return config.excludeTools ? allowed.filter((n) => !config.excludeTools!.includes(n)) : allowed;
}

/**
 * Expand `${VAR}` placeholders in secret-bearing string maps (stdio env,
 * HTTP headers). Unset variables throw naming the variable — a missing
 * credential must fail visibly at load time, never collapse to "".
 */
export function expandSecretPlaceholders(values: Record<string, string>): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    expanded[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = process.env[name];
      if (resolved === undefined) throw new Error(`MCP config references unset environment variable ${match}`);
      return resolved;
    });
  }
  return expanded;
}

/**
 * Resolves the judge-tools config by merging field-by-field, most specific
 * layer winning: ``run-level (runTask({ judgeTools })) ← task-level
 * (TaskDefinition.judgeTools)``. Per-call `tools.mcp` is applied later,
 * inside the agent method. Arrays replace, never concat.
 */
export function resolveJudgeTools(
  runLevel: JudgeToolsConfig | undefined,
  taskLevel: JudgeToolsConfig | undefined,
): JudgeToolsConfig | undefined {
  const mcp = taskLevel?.mcp ?? runLevel?.mcp;
  return mcp ? { mcp } : undefined;
}

/**
 * Env/file layer: `APO_JUDGE_MCP=<path>` pointing at a JSON file holding
 * either the industry map form `{"mcpServers": {"<name>": {command,args,env}
 * | {url,headers}}}` (the shape of Claude/Cursor `.mcp.json` files, so users
 * can point at one they already have) or a bare `{ "mcp": [...] }` / array in
 * the native {@link McpServerConfig} shape. Seeds the run-level layer, so
 * explicit config always wins. Undefined when the variable is unset.
 */
export async function resolveJudgeToolsFromEnv(): Promise<JudgeToolsConfig | undefined> {
  const path = process.env.APO_JUDGE_MCP;
  if (!path) return undefined;

  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (error) {
    throw new Error(
      `APO_JUDGE_MCP points at an unreadable file (${path}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `APO_JUDGE_MCP file is not valid JSON (${path}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalizeJudgeToolsFile(parsed, path);
}

// ── File-form normalization ────────────────────────────────────────────────

/** Accepts the native array, `{ mcp: [...] }`, or `{ mcpServers: {name: …} }`. */
function normalizeJudgeToolsFile(parsed: unknown, path: string): JudgeToolsConfig {
  if (Array.isArray(parsed)) {
    return { mcp: parsed.map((entry, i) => normalizeServerEntry(entry, `${path}[${i}]`)) };
  }
  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.mcp)) {
      return { mcp: record.mcp.map((entry, i) => normalizeServerEntry(entry, `${path}.mcp[${i}]`)) };
    }
    if (record.mcpServers !== null && typeof record.mcpServers === "object") {
      const entries = Object.entries(record.mcpServers as Record<string, unknown>);
      return {
        mcp: entries.map(([name, value], i) =>
          normalizeServerEntry({ ...(value as object), name }, `${path}.mcpServers[${i}]`),
        ),
      };
    }
  }
  throw new Error(
    `APO_JUDGE_MCP file must hold { "mcpServers": {…} }, { "mcp": […] }, or a bare array (${path})`,
  );
}

/** Accepts the native nested-transport form or the flat {command|url} form. */
function normalizeServerEntry(entry: unknown, where: string): McpServerConfig {
  if (entry === null || typeof entry !== "object") {
    throw new Error(`MCP server entry must be an object (${where})`);
  }
  const record = entry as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`MCP server entry must have a non-empty string 'name' (${where})`);
  }
  if (record.transport !== null && typeof record.transport === "object") {
    return record as unknown as McpServerConfig;
  }
  // Flat industry form: {command,args,env} or {url,headers}.
  if (typeof record.command === "string") {
    return {
      name,
      transport: {
        type: "stdio",
        command: record.command,
        ...(Array.isArray(record.args) ? { args: record.args as string[] } : {}),
        ...(record.env && typeof record.env === "object" ? { env: record.env as Record<string, string> } : {}),
      },
      ...(Array.isArray(record.tools) ? { tools: record.tools as string[] } : {}),
      ...(Array.isArray(record.excludeTools) ? { excludeTools: record.excludeTools as string[] } : {}),
      ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
    };
  }
  if (typeof record.url === "string") {
    return {
      name,
      transport: {
        type: "http",
        url: record.url,
        ...(record.headers && typeof record.headers === "object"
          ? { headers: record.headers as Record<string, string> }
          : {}),
      },
      ...(Array.isArray(record.tools) ? { tools: record.tools as string[] } : {}),
      ...(Array.isArray(record.excludeTools) ? { excludeTools: record.excludeTools as string[] } : {}),
      ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
    };
  }
  throw new Error(`MCP server "${name}" needs a nested 'transport', a 'command', or a 'url' (${where})`);
}

// ── Client facade ──────────────────────────────────────────────────────────

/**
 * Narrow, locally-owned view of an MCP client, mirroring the engine-facade
 * discipline in agent-session.ts: never let tsc instantiate the library's
 * generics. The real `@ai-sdk/mcp` client is structurally compatible.
 */
type McpRawTool = { description?: unknown; inputSchema?: unknown; execute?: unknown };
export type McpClientLike = {
  tools: () => Promise<Record<string, McpRawTool>>;
  close: () => Promise<void>;
};
export type McpClientFactory = (args: {
  server: McpServerConfig;
  timeoutMs: number;
}) => Promise<McpClientLike>;

/** The shared budget plumbing a toolset draws from (owned by the session). */
export type McpLedgerOps = {
  /** Increments and enforces the session's shared maxToolCalls budget. */
  guardToolCall: () => string | null;
  maxReadBytes: number;
  ledger: { readBytesUsed: number; manifest: EvidenceFingerprint[] };
  stepIndexOf: () => number;
  tracer?: JudgeTracer;
};

// ── Small helpers ──────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Locally-owned view of the stdio transport module. The `@ai-sdk/mcp/mcp-stdio`
 * subpath is exports-mapped only, invisible to this package's classic Node
 * moduleResolution — so it is resolved via a runtime specifier and typed here,
 * same facade discipline as the engine types in agent-session.ts.
 */
type StdioTransportModule = {
  Experimental_StdioMCPTransport: new (server: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }) => object;
};

async function loadStdioTransportModule(): Promise<StdioTransportModule> {
  const specifier = "@ai-sdk/mcp/mcp-stdio";
  return (await import(specifier)) as StdioTransportModule;
}

/** Default factory: real `@ai-sdk/mcp` client over the declared transport. */
async function defaultMcpClientFactory(args: {
  server: McpServerConfig;
  timeoutMs: number;
}): Promise<McpClientLike> {
  const { createMCPClient } = await import("@ai-sdk/mcp");
  const server = args.server;
  const transport =
    server.transport.type === "stdio"
      ? new (await loadStdioTransportModule()).Experimental_StdioMCPTransport({
          command: server.transport.command,
          ...(server.transport.args ? { args: server.transport.args } : {}),
          ...(server.transport.env
            ? { env: expandSecretPlaceholders(server.transport.env) }
            : {}),
        })
      : {
          type: "http" as const,
          url: server.transport.url,
          ...(server.transport.headers
            ? { headers: expandSecretPlaceholders(server.transport.headers) }
            : {}),
        };
  const client = await createMCPClient({
    transport,
    initializationOptions: { timeout: INIT_TIMEOUT_MS },
  } as unknown as Parameters<typeof createMCPClient>[0]);
  return client as unknown as McpClientLike;
}

// ── The toolset ────────────────────────────────────────────────────────────

/**
 * Connects one client per declared server and wraps every exposed tool with
 * the session's budget discipline: the shared tool-call guard, read-byte
 * accounting (the FULL result is fingerprinted; only the capped slice is
 * served to the model), and a TOOL span per execution. Transport config,
 * headers, and env values never appear in any recorded surface — only server
 * and tool names do.
 *
 * Connect failures throw naming the server; `createAgentMethod` records them
 * as check failures (fail-closed, like every other pre-engine setup error).
 */
export async function createMcpToolset(args: {
  servers: McpServerConfig[];
  ops: McpLedgerOps;
  clientFactory?: McpClientFactory;
}): Promise<{
  tools: Record<string, unknown>;
  cleanup: () => Promise<void>;
  /** Briefing lines: names and tool names only, never transport config. */
  briefingLines: string[];
}> {
  const { servers, ops } = args;

  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server.name)) {
      throw new Error(`MCP judge servers have duplicate names: "${server.name}"`);
    }
    seen.add(server.name);
  }

  const factory = args.clientFactory ?? defaultMcpClientFactory;
  const clients: McpClientLike[] = [];
  const tools: Record<string, unknown> = {};
  const briefingLines: string[] = [];

  for (const server of servers) {
    const timeoutMs = server.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    let client: McpClientLike;
    try {
      client = await factory({ server, timeoutMs });
    } catch (error) {
      // Close what already connected before surfacing the failure.
      await Promise.allSettled(clients.map((c) => c.close()));
      throw new Error(
        `MCP judge server "${server.name}" failed to connect: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    clients.push(client);

    const raw = await client.tools();
    const exposed: string[] = [];
    for (const rawName of filterToolNames(Object.keys(raw), server)) {
      const def = raw[rawName];
      if (!def) continue;
      const toolName = namespaceToolName(server.name, rawName);
      tools[toolName] = wrapMcpTool({
        toolName,
        def,
        timeoutMs,
        ops,
      });
      exposed.push(toolName);
    }
    if (exposed.length > 0) {
      briefingLines.push(`${server.name}: ${exposed.join(", ")}`);
    }
  }

  return {
    tools,
    briefingLines,
    cleanup: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

/** Budget-guarded, byte-accounted, spanned execution around one MCP tool. */
function wrapMcpTool(args: {
  toolName: string;
  def: McpRawTool;
  timeoutMs: number;
  ops: McpLedgerOps;
}): unknown {
  const { toolName, def, timeoutMs, ops } = args;

  if (typeof def.execute !== "function") {
    // Schema-only tool (MCP always provides execute; kept defensive).
    return { description: def.description, inputSchema: def.inputSchema };
  }
  const execute = def.execute as (input: unknown) => Promise<unknown>;

  const span = <T>(input: unknown, fn: () => Promise<T>): Promise<T> =>
    ops.tracer ? ops.tracer.traceTool(toolName, input as Record<string, unknown>, fn) : fn();

  return {
    description: def.description,
    inputSchema: def.inputSchema,
    execute: (input: never) =>
      span(input, async () => {
        const guard = ops.guardToolCall();
        if (guard) return { error: guard };

        let result: unknown;
        try {
          result = await withTimeout(execute(input), timeoutMs, `mcp tool ${toolName}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { error: `mcp tool ${toolName} failed: ${message}` };
        }

        const full = renderValue(result);
        const served =
          full.length <= MCP_RESULT_LIMIT
            ? full
            : `${full.slice(0, MCP_RESULT_LIMIT)}…[truncated ${full.length - MCP_RESULT_LIMIT} chars]`;

        ops.ledger.readBytesUsed += served.length;
        ops.ledger.manifest.push({
          step: ops.stepIndexOf(),
          tool: toolName,
          args_sha256: sha256(renderValue(input)),
          result_sha256: sha256(full),
          result_bytes: full.length,
        });
        if (ops.ledger.readBytesUsed > ops.maxReadBytes) {
          return { error: `read budget exhausted (${ops.maxReadBytes} bytes); call finish_verdict now` };
        }
        // Intact results keep their structured shape; only oversized ones
        // degrade to the capped string.
        return full.length <= MCP_RESULT_LIMIT ? result : served;
      }),
  };
}
