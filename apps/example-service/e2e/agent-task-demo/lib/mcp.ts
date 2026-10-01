/**
 * Shared MCP helpers for the demo adapters. Path resolution and secret
 * expansion come from the SDK (one contract for both planes — runTask
 * resolves layered judgeTools the same way); what stays local is the mapping
 * onto the Claude Agent SDK's own mcpServers option, since that adapter
 * delegates spawning to the SDK itself instead of connecting a client.
 */
import {
  expandSecretPlaceholders,
  resolveMcpServerPaths,
  type McpServerConfig,
} from "@apo-ai/sdk/agent-task";

/**
 * Structural view of the Claude Agent SDK's mcpServers option shape — kept
 * local so this helper has zero claude-agent-sdk dependency (consumers that
 * only use the ai-sdk path never install it). Assignability to the SDK's own
 * McpServerConfig is pinned by the claude adapter's usage.
 */
export type ClaudeMcpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      timeout?: number;
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      timeout?: number;
    };

export { resolveMcpServerPaths };

/**
 * Map apo's McpServerConfig[] onto the Claude Agent SDK's option shape.
 * Parity rules (adversarial review finding): secret-bearing values expand
 * `${VAR}` exactly like the SDK's own client path, and `tools`/`excludeTools`
 * fail closed — the Claude Agent SDK's per-tool policy cannot express
 * visibility filtering, so a load-bearing allowlist must refuse to run
 * rather than silently expose everything.
 */
export function toClaudeMcpServers(
  servers: McpServerConfig[],
): Record<string, ClaudeMcpServerConfig> {
  const out: Record<string, ClaudeMcpServerConfig> = {};
  for (const server of servers) {
    if (server.tools?.length || server.excludeTools?.length) {
      throw new Error(
        `MCP server "${server.name}" declares tools/excludeTools, which the Claude Agent SDK ` +
          `plane cannot enforce (its per-tool policy gates permission, not visibility). ` +
          `Remove the filter or run this task through an adapter that applies it.`,
      );
    }
    if (server.transport.type === "stdio") {
      out[server.name] = {
        type: "stdio",
        command: server.transport.command,
        ...(server.transport.args ? { args: server.transport.args } : {}),
        ...(server.transport.env ? { env: expandSecretPlaceholders(server.transport.env) } : {}),
        ...(server.timeoutMs !== undefined ? { timeout: server.timeoutMs } : {}),
      };
    } else {
      out[server.name] = {
        type: "http",
        url: server.transport.url,
        ...(server.transport.headers
          ? { headers: expandSecretPlaceholders(server.transport.headers) }
          : {}),
        ...(server.timeoutMs !== undefined ? { timeout: server.timeoutMs } : {}),
      };
    }
  }
  return out;
}
