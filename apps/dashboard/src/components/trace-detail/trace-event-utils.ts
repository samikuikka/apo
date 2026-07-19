export type TraceEventKind =
  | "tool_call"
  | "tool_result"
  | "assistant_reasoning"
  | "assistant_message"
  | "result"
  | "unknown";

export function detectTraceEventKind(data: any): TraceEventKind {
  if (!data || typeof data !== "object") {
    return "unknown";
  }

  if (typeof data.tool_name === "string") {
    return "tool_call";
  }

  if (data.data && typeof data.data === "object" && typeof data.data.tool_name === "string") {
    return "tool_call";
  }

  const type = extractType(data);
  if (type === "assistant_reasoning") {
    return "assistant_reasoning";
  }
  if (type === "assistant_message") {
    return "assistant_message";
  }
  if (type === "tool_result") {
    return "tool_result";
  }
  if (type === "result") {
    return "result";
  }

  return "unknown";
}

function extractType(data: any): string | undefined {
  if (typeof data?.type === "string") {
    return data.type;
  }

  if (typeof data?.metadata?.eventType === "string") {
    return data.metadata.eventType;
  }

  if (typeof data?.data?.type === "string") {
    return data.data.type;
  }

  return undefined;
}
