const DEFAULT_REDIRECT = "/"
const BLOCKED_SCHEMES = ["javascript:", "data:", "vbscript:", "file:"]

export function getSafeRedirectPath(targetPath: string | undefined | null): string {
  if (!targetPath) return DEFAULT_REDIRECT

  // Strip leading/trailing whitespace and control characters
  // eslint-disable-next-line no-control-regex
  const trimmed = targetPath.replace(/[\x00-\x1f\x7f]/g, "").trim()
  if (!trimmed) return DEFAULT_REDIRECT

  // Must start with a single forward slash
  if (!trimmed.startsWith("/")) return DEFAULT_REDIRECT

  // Block protocol-relative URLs and backslash tricks
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return DEFAULT_REDIRECT

  // Block dangerous schemes (defense-in-depth, already caught by startsWith)
  const lower = trimmed.toLowerCase()
  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme) || lower.startsWith("/" + scheme)) return DEFAULT_REDIRECT
  }

  // Collapse multiple consecutive slashes (prevents //evil.com via /\evil.com)
  return trimmed.replace(/\/{2,}/g, "/")
}
