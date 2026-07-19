import type { LoggedCall } from "./contexts";

export type SemanticType =
  | "TRACE"
  | "GENERATION"
  | "TOOL"
  | "AGENT"
  | "EMBEDDING"
  | "RETRIEVER"
  | "SPAN";

export function getEventType(call: LoggedCall): string | null {
  return call.metadata &&
    typeof call.metadata === "object" &&
    "eventType" in call.metadata &&
    typeof call.metadata.eventType === "string"
    ? call.metadata.eventType
    : null;
}

export function getSemanticType(call: LoggedCall | null): SemanticType {
  if (!call) return "SPAN";
  const eventType = getEventType(call);
  if (call.tool_name || eventType === "tool_use") return "TOOL";
  if (call.model && call.model !== "unknown") return "GENERATION";
  const rawType = call.call_type?.toLowerCase();
  if (rawType === "agent") return "AGENT";
  if (rawType === "embedding") return "EMBEDDING";
  if (rawType === "retriever") return "RETRIEVER";
  return "SPAN";
}

type ColorPair = { background: string; border: string };

const SEMANTIC_COLORS: Record<SemanticType, { light: ColorPair; dark: ColorPair }> = {
  TRACE: {
    light: { background: "#dbeafe", border: "#2563eb" },
    dark: { background: "#1e3a5f", border: "#60a5fa" },
  },
  GENERATION: {
    light: { background: "#dbeafe", border: "#2563eb" },
    dark: { background: "#172554", border: "#60a5fa" },
  },
  TOOL: {
    light: { background: "#fef3c7", border: "#d97706" },
    dark: { background: "#422006", border: "#fbbf24" },
  },
  AGENT: {
    light: { background: "#d1fae5", border: "#059669" },
    dark: { background: "#064e3b", border: "#34d399" },
  },
  EMBEDDING: {
    light: { background: "#e0e7ff", border: "#4f46e5" },
    dark: { background: "#312e81", border: "#818cf8" },
  },
  RETRIEVER: {
    light: { background: "#f3f4f6", border: "#6b7280" },
    dark: { background: "#1f2937", border: "#9ca3af" },
  },
  SPAN: {
    light: { background: "#f3f4f6", border: "#6b7280" },
    dark: { background: "#1f2937", border: "#9ca3af" },
  },
};

export function getSemanticTypeGraphColors(
  semanticType: SemanticType,
  isDark: boolean,
): ColorPair {
  return SEMANTIC_COLORS[semanticType][isDark ? "dark" : "light"];
}
