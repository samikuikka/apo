/**
 * Shared builder for apo backend auth headers.
 *
 * One place resolves the runner's credential env contract so every exporter
 * (the OTel trace client, transcript-replay capture, future importers)
 * authenticates identically:
 *
 * - ``APO_PUBLIC_KEY`` + ``APO_SECRET_KEY`` → Basic auth (two-key API key)
 * - ``APO_AUTH_TOKEN`` → Bearer (attempt/service token)
 */

export function buildApoAuthHeaders(): Record<string, string> | undefined {
  const pk = process.env.APO_PUBLIC_KEY;
  const sk = process.env.APO_SECRET_KEY;
  if (pk && sk) {
    const creds = typeof btoa === "function"
      ? btoa(`${pk}:${sk}`)
      : Buffer.from(`${pk}:${sk}`).toString("base64");
    return { Authorization: `Basic ${creds}` };
  }
  const token = process.env.APO_AUTH_TOKEN;
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return undefined;
}
