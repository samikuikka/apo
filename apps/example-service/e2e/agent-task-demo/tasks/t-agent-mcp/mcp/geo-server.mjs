#!/usr/bin/env node
/**
 * geo — a deliberately tiny stdio MCP server, zero dependencies.
 *
 * Serves the "authoritative" elevation figures for the t-agent-mcp demo
 * task. It speaks the MCP JSON-RPC protocol over stdin/stdout by hand
 * (newline-delimited JSON-RPC 2.0: initialize → tools/list → tools/call)
 * to demonstrate that a task-declared MCP server can be ANY conforming
 * process — no SDK, no framework, ~100 lines.
 *
 * The data is the task's ground truth: the agent can only obtain these
 * numbers by actually calling the tool.
 */
import { createInterface } from "node:readline";

const ELEVATIONS_M = {
  helsinki: 26,
  tallinn: 9,
  rovaniemi: 82,
  tampere: 34,
};

const TOOLS = [
  {
    name: "get_elevation",
    description: "Get the authoritative elevation (in meters) of a supported city.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string", description: "City name, e.g. Helsinki" } },
      required: ["city"],
    },
  },
  {
    name: "list_cities",
    description: "List the cities this service knows the elevation of.",
    inputSchema: { type: "object", properties: {} },
  },
];

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "geo", version: "1.0.0" },
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "get_elevation") {
        // Case-insensitive lookup: a lowercased city name from the model
        // must not burn a turn (and an ERROR span) on a retry.
        const city = String(args.city ?? "");
        const elevation = ELEVATIONS_M[city.trim().toLowerCase()];
        if (elevation === undefined) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `unknown city: ${city}. Call list_cities for supported names.` }],
              isError: true,
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: textResult(JSON.stringify({ city, elevation_m: elevation })),
        };
      }
      if (name === "list_cities") {
        return {
          jsonrpc: "2.0",
          id,
          // Capitalized display names; lookups accept any case.
          result: textResult(JSON.stringify({ cities: ["Helsinki", "Tallinn", "Rovaniemi", "Tampere"] })),
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool: ${name}` },
      };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } };
  }
}

const stdout = process.stdout;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // Not JSON — ignore rather than kill the session.
  }
  // Notifications (no id) get no response per JSON-RPC 2.0.
  if (message.id === undefined || message.id === null) return;
  const response = handleRequest(message);
  if (response) stdout.write(`${JSON.stringify(response)}\n`);
});
rl.on("close", () => process.exit(0));
