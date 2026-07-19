export interface ToolDefinition {
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
}

export function extractTools(data: unknown): ToolDefinition[] {
  if (!data || typeof data !== "object") return [];

  let obj = data;
  if (typeof data === "string") {
    try {
      obj = JSON.parse(data);
    } catch {
      return [];
    }
  }

  const tools = (obj as Record<string, unknown>).tools;
  if (Array.isArray(tools) && tools.length > 0) {
    return tools.filter(
      (t) => t && typeof t === "object" && (t as Record<string, unknown>).function,
    );
  }

  return [];
}

export function countToolInvocations(
  messages: Array<{ tool_calls?: Array<{ function?: { name?: string } }> }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    if (!msg.tool_calls) continue;
    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      if (name) {
        counts[name] = (counts[name] ?? 0) + 1;
      }
    }
  }
  return counts;
}
