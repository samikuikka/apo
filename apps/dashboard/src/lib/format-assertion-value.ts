/** Recorded strings may be replaced by a bounded preview during storage. */
export function formatAssertionValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    if ("kind" in value && value.kind === "truncated" &&
        "preview" in value && typeof value.preview === "string") {
      return `${value.preview}… [truncated]`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}
