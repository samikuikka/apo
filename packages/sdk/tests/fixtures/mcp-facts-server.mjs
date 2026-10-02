/**
 * Minimal stdio MCP server for the judge-mcp tests: a deterministic "facts"
 * service. Spawned by the real @ai-sdk/mcp client during integration tests,
 * so the full JSON-RPC handshake, tool listing, and tool execution are
 * exercised for real — no network, no API keys.
 *
 * Writes its pid to $FACTS_PID_FILE on boot so tests can prove the client
 * cleanup actually terminated the child process.
 */
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.FACTS_PID_FILE) {
  writeFileSync(process.env.FACTS_PID_FILE, String(process.pid));
}

const server = new McpServer({ name: "facts", version: "1.0.0" });

server.registerTool(
  "get_fact",
  {
    description: "Get the canonical fact about a topic.",
    inputSchema: { topic: z.string() },
  },
  async ({ topic }) => ({
    content: [{ type: "text", text: `fact: ${topic} is 42` }],
  }),
);

server.registerTool(
  "big_fact",
  {
    description: "Get a fact with a very large payload (~200 KB).",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: `fact: padded is ${"x".repeat(200_000)}` }],
  }),
);

server.registerTool(
  "slow_fact",
  {
    description: "Get a fact slowly (sleeps 2 s before answering).",
    inputSchema: {},
  },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return { content: [{ type: "text", text: "fact: patience is a virtue" }] };
  },
);

server.registerTool(
  "error_fact",
  {
    description: "Always fails: exercises the JSON-RPC error path end to end.",
    inputSchema: {},
  },
  async () => {
    throw new Error("facts service exploded");
  },
);

await server.connect(new StdioServerTransport());
