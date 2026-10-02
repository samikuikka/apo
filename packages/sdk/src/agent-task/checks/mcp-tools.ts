/**
 * MCP plumbing for apo's two tool planes. The judge's budgeted toolset
 * (`createMcpToolset`) wraps user-declared MCP servers into `t.agent`
 * sessions under the same budget ledger and evidence-manifest discipline as
 * the built-in evidence tools. `connectMcpServers` is the raw connect core
 * shared with adapters — the agent under test is not apo's to budget, so
 * adapters merge the namespaced `mcp__<server>__<tool>` tools themselves.
 *
 * Judge config layers exactly like the judge model config
 * (`resolveJudgeConfig`): env/file (APO_JUDGE_MCP) ← runTask({ judgeTools })
 * ← task.judgeTools ← per-call `t.agent(..., { tools: { mcp } })` — most
 * specific wins, arrays replace, never concat. Task-level `mcpServers`
 * (adapter plane) is a separate declaration honored by adapters that choose
 * to (see TaskDefinition.mcpServers).
 *
 * The MCP client (`@ai-sdk/mcp`) is lazy-loaded: suites that never configure
 * MCP servers must never pay for the dependency (pinned by the
 * lazy-isolation test in tests/judge-mcp.test.ts).
 */

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
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
    const native = record as unknown as McpServerConfig;
    validateMcpServerConfig(native, where);
    return native;
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

/**
 * Structural validation of one {@link McpServerConfig}: non-empty name
 * without the "__" separator, a typed transport with its required field,
 * string-array filter options, and a positive timeoutMs. The single
 * enforcement point for eval-file declarations, the APO_JUDGE_MCP file
 * layer, and adapter-side configs — a malformed entry must fail HERE with
 * a clear message, not later as a confusing connect error.
 */
export function validateMcpServerConfig(server: unknown, where: string): void {
  if (server === null || typeof server !== "object") {
    throw new Error(`MCP server entry must be an object (${where})`);
  }
  const record = server as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new Error(`MCP server entry must have a non-empty string 'name' (${where})`);
  }
  if (record.name.includes("__")) {
    throw new Error(`MCP server names must not contain "__" (namespacing separator): "${record.name}" (${where})`);
  }
  const transport = record.transport;
  if (transport === null || typeof transport !== "object") {
    throw new Error(`MCP server "${record.name}" needs a 'transport' object (${where})`);
  }
  const t = transport as Record<string, unknown>;
  if (t.type === "stdio") {
    if (typeof t.command !== "string" || t.command.length === 0) {
      throw new Error(`MCP server "${record.name}" stdio transport needs a non-empty 'command' (${where})`);
    }
  } else if (t.type === "http") {
    if (typeof t.url !== "string" || t.url.length === 0) {
      throw new Error(`MCP server "${record.name}" http transport needs a non-empty 'url' (${where})`);
    }
  } else {
    throw new Error(`MCP server "${record.name}" transport.type must be "stdio" or "http" (${where})`);
  }
  // Filter options must be arrays of tool names, or tool filtering silently
  // degrades: `config.tools.includes(name)` on a string does substring
  // matching against every raw tool name. timeoutMs bounds every call made
  // through the server, so a non-positive value is a misconfiguration.
  for (const key of ["tools", "excludeTools"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new Error(
        `MCP server "${record.name}" '${key}' must be an array of tool names (${where})`,
      );
    }
  }
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== "number" || !Number.isFinite(record.timeoutMs) || record.timeoutMs <= 0) {
      throw new Error(`MCP server "${record.name}" 'timeoutMs' must be a positive number (${where})`);
    }
  }
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

// ── Path resolution (one contract for both planes) ─────────────────────────

/**
 * Resolve path-like stdio values against a base directory (the task dir):
 * absolute values, "./" and "../" prefixes resolve; bare names stay bare so
 * the spawn resolves them from PATH. Applied to TaskDefinition.mcpServers
 * by adapters AND to layered judgeTools by runTask — "./mcp/server.mjs"
 * means the same thing on both planes, independent of the runner's cwd.
 */
export function resolveMcpServerPaths(
  servers: McpServerConfig[],
  baseDir: string,
): McpServerConfig[] {
  const resolveIfPathlike = (value: string): string =>
    isAbsolute(value) || value.startsWith("./") || value.startsWith("../")
      ? resolve(baseDir, value)
      : value;

  return servers.map((server) => {
    if (server.transport.type !== "stdio") return server;
    return {
      ...server,
      transport: {
        ...server.transport,
        command: resolveIfPathlike(server.transport.command),
        ...(server.transport.args
          ? { args: server.transport.args.map(resolveIfPathlike) }
          : {}),
      },
    };
  });
}

// ── The connect core (shared by the judge toolset and adapters) ────────────

/**
 * Connects one client per declared server and returns the RAW namespaced
 * tools — no budget wrapping, because the agent under test is not apo's to
 * budget (that discipline is judge-only, in `createMcpToolset` below).
 * Adapters that drive an AI-SDK agent loop merge `tools` into their own tool
 * record; `byServer` maps each server name to its exposed raw tool names.
 *
 * Connect failures throw naming the server after closing what already
 * connected. Duplicate server names throw before anything spawns.
 */
export async function connectMcpServers(
  servers: McpServerConfig[],
  opts?: { clientFactory?: McpClientFactory },
): Promise<{
  tools: Record<string, unknown>;
  byServer: Record<string, string[]>;
  cleanup: () => Promise<void>;
}> {
  const seen = new Set<string>();
  for (const server of servers) {
    // Single enforcement point: shape, non-empty name without the "__"
    // namespacing separator, typed transport with its required field.
    validateMcpServerConfig(server, "connectMcpServers");
    if (seen.has(server.name)) {
      throw new Error(`MCP servers have duplicate names: "${server.name}"`);
    }
    seen.add(server.name);
  }

  const factory = opts?.clientFactory ?? defaultMcpClientFactory;
  const clients: McpClientLike[] = [];
  const tools: Record<string, unknown> = {};
  const byServer: Record<string, string[]> = {};

  for (const server of servers) {
    const timeoutMs = server.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    let client: McpClientLike;
    let raw: Record<string, McpRawTool>;
    try {
      client = await factory({ server, timeoutMs });
      clients.push(client);
      raw = await client.tools();
    } catch (error) {
      // Close what already connected before surfacing the failure.
      await Promise.allSettled(clients.map((c) => c.close()));
      throw new Error(
        `MCP server "${server.name}" failed to connect: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const exposed: string[] = [];
    for (const rawName of filterToolNames(Object.keys(raw), server)) {
      const def = raw[rawName];
      if (!def) continue;
      const toolName = namespaceToolName(server.name, rawName);
      // Backstop for exotic raw tool names: "__" collisions must not
      // silently drop a tool from either plane.
      if (toolName in tools) {
        // Same discipline as connect failures: close every spawned client
        // before surfacing the collision.
        await Promise.allSettled(clients.map((c) => c.close()));
        throw new Error(
          `MCP tool name collision on "${toolName}" — two servers/tools namespaced to the same key`,
        );
      }
      tools[toolName] = def;
      exposed.push(rawName);
    }
    byServer[server.name] = exposed;
  }

  return {
    tools,
    byServer,
    cleanup: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

// ── The judge toolset ──────────────────────────────────────────────────────

/**
 * The judge's budgeted view of the user's MCP servers: connects via
 * {@link connectMcpServers}, then wraps every exposed tool with the
 * session's budget discipline — the shared tool-call guard, read-byte
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

  const connected = await connectMcpServers(
    servers,
    args.clientFactory ? { clientFactory: args.clientFactory } : undefined,
  );

  const timeoutByServer = new Map(
    servers.map((s) => [s.name, s.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS] as const),
  );
  const tools: Record<string, unknown> = {};
  // Iterate byServer (exact server → tool names), never re-derive the server
  // from the namespaced tool name — names can contain "__"-adjacent shapes
  // that would misattribute the per-server timeout.
  for (const [serverName, rawNames] of Object.entries(connected.byServer)) {
    const timeoutMs = timeoutByServer.get(serverName) ?? DEFAULT_TOOL_TIMEOUT_MS;
    for (const rawName of rawNames) {
      const toolName = namespaceToolName(serverName, rawName);
      tools[toolName] = wrapMcpTool({
        toolName,
        def: connected.tools[toolName] as McpRawTool,
        timeoutMs,
        ops,
      });
    }
  }

  const briefingLines = Object.entries(connected.byServer)
    .filter(([, toolNames]) => toolNames.length > 0)
    .map(([name, toolNames]) => `${name}: ${toolNames.map((t) => namespaceToolName(name, t)).join(", ")}`);

  return { tools, briefingLines, cleanup: connected.cleanup };
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
