/**
 * Credential resolution for apo backends — the one implementation every
 * exporter (the OTel trace client, transcript-replay capture, CLI import)
 * authenticates through. Dependency-free on purpose: both the otel and
 * agent-task entries import it without pulling each other's weight in.
 *
 * - ``APO_PUBLIC_KEY`` + ``APO_SECRET_KEY`` → Basic auth (two-key API key;
 *   both halves required — a public identifier alone is not a credential)
 * - ``APO_AUTH_TOKEN`` → Bearer (attempt/service token)
 *
 * Explicit arguments win over the environment; when nothing resolves, the
 * caller decides whether unauthenticated (`{}`) or "no headers" (undefined)
 * is the right shape.
 */

export function resolveApoAuthHeaders(
  publicKey?: string,
  secretKey?: string,
  authToken?: string,
): Record<string, string> {
  const pk = publicKey ?? process.env.APO_PUBLIC_KEY;
  const sk = secretKey ?? process.env.APO_SECRET_KEY;
  const token = authToken ?? process.env.APO_AUTH_TOKEN;
  if (pk && sk) {
    const credentials = typeof btoa === "function"
      ? btoa(`${pk}:${sk}`)
      : Buffer.from(`${pk}:${sk}`).toString("base64");
    return { Authorization: `Basic ${credentials}` };
  }
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}
