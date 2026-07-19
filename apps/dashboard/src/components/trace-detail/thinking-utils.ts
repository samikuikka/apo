export function extractThinkingContent(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;

  const msg = message as Record<string, unknown>;

  if (typeof msg.thinking === "string" && msg.thinking.trim()) {
    return msg.thinking;
  }

  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    return msg.reasoning_content;
  }

  if (
    msg.metadata &&
    typeof msg.metadata === "object" &&
    msg.metadata !== null
  ) {
    const meta = msg.metadata as Record<string, unknown>;
    if (typeof meta.thinking === "string" && meta.thinking.trim()) {
      return meta.thinking;
    }
  }

  return null;
}
