export interface ToolDefinition {
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
}

/** The model-facing context a call carried: the OTel GenAI
 *  `gen_ai.tool.definitions` / `gen_ai.system_instructions` attributes, which
 *  the backend serves as `metadata.tool_definitions` /
 *  `metadata.system_instructions` on the calls whose span emitted them. */
export interface CallContext {
  tools: ToolDefinition[];
  systemInstructions: string | null;
}

export function extractCallContext(
  metadata: Record<string, unknown> | null | undefined,
): CallContext {
  if (!metadata) return { tools: [], systemInstructions: null };
  return {
    tools: toToolDefinitions(metadata.tool_definitions),
    systemInstructions: toInstructionText(metadata.system_instructions),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Semconv tools are flat (`{type, name, description, parameters}`); OpenAI
 *  tools nest under `function`. Both become the shape the section renders. */
function toToolDefinitions(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value)) return [];
  const tools: ToolDefinition[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const source = isRecord(item.function) ? item.function : item;
    if (typeof source.name !== "string" || !source.name) continue;
    tools.push({
      function: {
        name: source.name,
        description: typeof source.description === "string" ? source.description : undefined,
        parameters: source.parameters,
      },
    });
  }
  return tools;
}

function instructionPartText(part: unknown): string {
  if (typeof part === "string") return part;
  if (isRecord(part)) {
    if (typeof part.content === "string") return part.content;
    if (typeof part.text === "string") return part.text;
  }
  return JSON.stringify(part, null, 2) ?? "";
}

function toInstructionText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parts = Array.isArray(value) ? value : [value];
  const text = parts.map(instructionPartText).filter(Boolean).join("\n\n");
  return text || null;
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
